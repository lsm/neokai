import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
	AgentProcessingState,
	Message,
	MessageContent,
	MessageImage,
	Session,
} from '@liuboer/shared';
import type { EventBus, MessageHub } from '@liuboer/shared';
import type { Query, SDKMessage, SDKUserMessage, SlashCommand } from '@liuboer/shared/sdk';
import {
	isSDKResultSuccess,
	isSDKAssistantMessage,
	isToolUseBlock,
} from '@liuboer/shared/sdk/type-guards';
import type { UUID } from 'crypto';
import {
	type CurrentModelInfo,
	generateUUID,
	getModelInfo,
	isValidModel,
	resolveModelAlias,
} from '@liuboer/shared';
import { Database } from '../storage/database';
import { ErrorCategory, ErrorManager } from './error-manager';
import { Logger } from './logger';

/**
 * Queued message waiting to be sent to Claude
 */
interface QueuedMessage {
	id: string;
	content: string | MessageContent[];
	timestamp: string;
	resolve: (messageId: string) => void;
	reject: (error: Error) => void;
	internal?: boolean; // If true, don't save to DB or emit to client
}

/**
 * SDK query object with control methods
 */
type SDKQueryObject = Query | null;

/**
 * Agent Session - wraps a single session with Claude using Claude Agent SDK
 *
 * Uses STREAMING INPUT mode - a single persistent SDK query with AsyncGenerator
 * that continuously yields messages from a queue. This enables:
 * - Natural conversation flow
 * - Image upload support
 * - Message queueing
 * - Proper interruption handling
 */
export class AgentSession {
	private conversationHistory: Message[] = [];
	private abortController: AbortController | undefined = undefined;

	// Message queue for streaming input
	private messageQueue: QueuedMessage[] = [];
	private queryRunning: boolean = false;
	private messageWaiters: Array<() => void> = [];

	// SDK query object with control methods
	private queryObject: SDKQueryObject = null;
	private slashCommands: string[] = [];

	// PHASE 3 FIX: Store unsubscribe functions to prevent memory leaks
	private unsubscribers: Array<() => void> = [];

	// FIX: Track query promise for proper cleanup
	private queryPromise: Promise<void> | null = null;

	// Error manager for structured error handling
	private errorManager: ErrorManager;

	// Delta versioning for state channels
	private messageDeltaVersion: number = 0;
	private sdkMessageDeltaVersion: number = 0;

	// FIX: Agent processing state (server-side state for push-based sync)
	private processingState: AgentProcessingState = { status: 'idle' };
	private logger: Logger;

	constructor(
		private session: Session,
		private db: Database,
		private messageHub: MessageHub,
		private eventBus: EventBus, // EventBus for state change notifications
		private getApiKey: () => Promise<string | null> // Function to get current API key
	) {
		// Initialize error manager and logger
		this.errorManager = new ErrorManager(this.messageHub);
		this.logger = new Logger(`AgentSession ${session.id}`);

		// Load existing messages into conversation history
		this.loadConversationHistory();

		// Setup event listeners for incoming messages
		this.setupEventListeners();

		// Start the streaming query immediately
		this.startStreamingQuery().catch(async (error) => {
			this.logger.error(`Failed to start streaming query:`, error);
			await this.errorManager.handleError(
				this.session.id,
				error as Error,
				ErrorCategory.SESSION,
				'Failed to initialize session. Please try again.'
			);
		});
	}

	/**
	 * Load existing messages from database into conversation history
	 */
	private loadConversationHistory(): void {
		const messages = this.db.getMessages(this.session.id);
		this.conversationHistory = messages;
	}

	/**
	 * Setup MessageHub listeners for incoming messages and controls
	 * PHASE 3 FIX: Store unsubscribe functions for cleanup
	 *
	 * NOTE: We don't subscribe to events server-side anymore.
	 * Instead, RPC handlers in session-handlers.ts call handleMessageSend() and handleInterrupt() directly.
	 * This prevents server-side subscription timeout issues.
	 */
	private setupEventListeners(): void {
		// No subscriptions needed - RPC handlers will call methods directly
	}

	/**
	 * Update and broadcast the agent processing state
	 * NEW: Uses EventBus to notify StateManager, which broadcasts unified session state
	 */
	private async setProcessingState(newState: AgentProcessingState): Promise<void> {
		this.processingState = newState;

		// Emit event via EventBus (StateManager will broadcast unified session state)
		await this.eventBus.emit('agent-state:changed', {
			sessionId: this.session.id,
			state: newState,
		});

		this.logger.log(`Agent state changed:`, newState);
	}

	/**
	 * Get current processing state
	 * Used when clients subscribe/reconnect to get immediate snapshot
	 */
	getProcessingState(): AgentProcessingState {
		return this.processingState;
	}

	/**
	 * Fetch and cache slash commands from SDK
	 * Used internally to update slash commands after query creation
	 */
	private async fetchAndCacheSlashCommands(): Promise<void> {
		if (!this.queryObject || typeof this.queryObject.supportedCommands !== 'function') {
			return;
		}

		try {
			const commands = await this.queryObject.supportedCommands();
			this.slashCommands = commands.map((cmd: SlashCommand) => cmd.name);

			// Add built-in commands that the SDK supports but doesn't advertise
			// These commands work but aren't returned by supportedCommands()
			const builtInCommands = ['clear', 'help'];
			this.slashCommands = [...new Set([...this.slashCommands, ...builtInCommands])];

			this.logger.log(`Fetched slash commands:`, this.slashCommands);

			// Emit event via EventBus (StateManager will broadcast unified session state)
			await this.eventBus.emit('commands:updated', {
				sessionId: this.session.id,
				commands: this.slashCommands,
			});
		} catch (error) {
			this.logger.warn(`Failed to fetch slash commands:`, error);
		}
	}

	/**
	 * Build message content with text and optional images
	 */
	private buildMessageContent(text: string, images?: MessageImage[]): string | MessageContent[] {
		if (!images || images.length === 0) {
			return text;
		}

		return [
			{ type: 'text' as const, text },
			...images.map((img) => ({
				type: 'image' as const,
				source: {
					type: 'base64' as const,
					media_type: img.media_type,
					data: img.data,
				},
			})),
		];
	}

	/**
	 * Enqueue a message to be sent to Claude via the streaming query
	 */
	async enqueueMessage(
		content: string | MessageContent[],
		internal: boolean = false
	): Promise<string> {
		const messageId = generateUUID();

		return new Promise((resolve, reject) => {
			const queuedMessage: QueuedMessage = {
				id: messageId,
				content,
				timestamp: new Date().toISOString(),
				resolve,
				reject,
				internal,
			};

			this.messageQueue.push(queuedMessage);

			// Wake up any waiting message generators
			this.messageWaiters.forEach((waiter) => waiter());
			this.messageWaiters = [];
		});
	}

	/**
	 * DEPRECATED: Use enqueueMessage instead
	 * Kept temporarily for HTTP endpoint backward compatibility
	 */
	async sendMessage(content: string): Promise<string> {
		// Just delegate to enqueueMessage
		return this.enqueueMessage(content);
	}

	/**
	 * Handle message.send RPC call
	 * Called by RPC handler in session-handlers.ts
	 */
	async handleMessageSend(data: {
		content: string;
		images?: MessageImage[];
	}): Promise<{ messageId: string }> {
		try {
			const { content, images } = data;
			const messageContent = this.buildMessageContent(content, images);
			const messageId = await this.enqueueMessage(messageContent);

			// Update state to 'queued' (broadcasts agent.state event)
			await this.setProcessingState({ status: 'queued', messageId });

			return { messageId };
		} catch (error) {
			this.logger.error(`Error handling message.send:`, error);
			await this.errorManager.handleError(
				this.session.id,
				error as Error,
				ErrorCategory.MESSAGE,
				'Failed to send message. Please try again.'
			);
			throw error;
		}
	}

	/**
	 * AsyncGenerator that yields messages continuously from the queue
	 * This is the heart of streaming input mode!
	 *
	 * FIX: Do NOT replay conversation history to SDK when re-entering session.
	 * The Claude Agent SDK is a long-running process that accumulates state.
	 * When a session is destroyed and re-created, the SDK loses all context.
	 * Re-sending historical messages would cause the SDK to process them as
	 * NEW messages, leading to duplicate responses.
	 *
	 * Conversation history is kept in the database for display purposes only.
	 */
	private async *messageGenerator(): AsyncGenerator<SDKUserMessage> {
		this.logger.log(`Message generator started`);

		// FIX: Do NOT replay conversation history!
		// History is loaded from DB for display only, not to be re-sent to SDK.
		// If we re-send history, SDK will process all user messages again as NEW messages.
		if (this.conversationHistory.length > 0) {
			this.logger.log(
				`Loaded ${this.conversationHistory.length} historical messages from DB (for display only, NOT replaying to SDK)`
			);
		}

		// Continuously yield new messages from queue
		while (this.queryRunning) {
			const queuedMessage = await this.waitForNextMessage();

			if (!queuedMessage) {
				this.logger.log(`No more messages, stopping generator`);
				break;
			}

			this.logger.log(
				`Yielding queued message: ${queuedMessage.id}${queuedMessage.internal ? ' (internal)' : ''}`
			);

			// Only save and emit if NOT internal (reserved for future use)
			if (!queuedMessage.internal) {
				// Save user message to DB
				const sdkUserMessage: SDKUserMessage = {
					type: 'user' as const,
					uuid: queuedMessage.id as UUID,
					session_id: this.session.id,
					parent_tool_use_id: null,
					message: {
						role: 'user' as const,
						content:
							typeof queuedMessage.content === 'string'
								? [{ type: 'text' as const, text: queuedMessage.content }]
								: queuedMessage.content,
					},
				};

				this.db.saveSDKMessage(this.session.id, sdkUserMessage);

				// Emit user message
				await this.messageHub.publish('sdk.message', sdkUserMessage, {
					sessionId: this.session.id,
				});

				// Update state to 'processing' (broadcasts agent.state event)
				await this.setProcessingState({
					status: 'processing',
					messageId: queuedMessage.id,
				});

				// Add to conversation history
				const userMessage: Message = {
					id: queuedMessage.id,
					sessionId: this.session.id,
					role: 'user',
					content:
						typeof queuedMessage.content === 'string'
							? queuedMessage.content
							: JSON.stringify(queuedMessage.content),
					timestamp: queuedMessage.timestamp,
				};
				this.conversationHistory.push(userMessage);

				// Broadcast message delta for user message
				await this.messageHub.publish(
					'state.messages.delta',
					{
						added: [userMessage],
						timestamp: Date.now(),
						version: ++this.messageDeltaVersion,
					},
					{ sessionId: this.session.id }
				);
			}

			// Yield to SDK
			yield {
				type: 'user' as const,
				uuid: queuedMessage.id as UUID,
				session_id: this.session.id,
				parent_tool_use_id: null,
				message: {
					role: 'user' as const,
					content: queuedMessage.content,
				},
			};

			// Resolve the promise to indicate message was sent
			queuedMessage.resolve(queuedMessage.id);
		}

		this.logger.log(`Message generator ended`);
	}

	/**
	 * Wait for the next message to be enqueued
	 */
	private async waitForNextMessage(): Promise<QueuedMessage | null> {
		while (this.queryRunning && this.messageQueue.length === 0) {
			// Wait for message to be enqueued
			await new Promise<void>((resolve) => {
				this.messageWaiters.push(resolve);
				// Also wake up after timeout to check queryRunning status
				setTimeout(resolve, 1000);
			});

			if (!this.queryRunning) return null;
		}

		return this.messageQueue.shift() || null;
	}

	/**
	 * Start the long-running streaming query with AsyncGenerator
	 */
	private async startStreamingQuery(): Promise<void> {
		if (this.queryRunning) {
			this.logger.log(`Query already running, skipping start`);
			return;
		}

		this.logger.log(`Starting streaming query...`);
		this.queryRunning = true;
		this.abortController = new AbortController();

		// FIX: Store query promise for cleanup
		this.queryPromise = this.runQuery();
	}

	/**
	 * Run the query (extracted for promise tracking)
	 */
	private async runQuery(): Promise<void> {
		try {
			// Verify authentication
			const hasAuth = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
			if (!hasAuth) {
				const authError = new Error(
					'No authentication configured. Please set up OAuth or API key.'
				);
				await this.errorManager.handleError(
					this.session.id,
					authError,
					ErrorCategory.AUTHENTICATION
				);
				throw authError;
			}

			// Ensure workspace exists
			const fs = await import('fs/promises');
			await fs.mkdir(this.session.workspacePath, { recursive: true });

			this.logger.log(`Creating streaming query with AsyncGenerator`);

			// Create query with AsyncGenerator!
			this.queryObject = query({
				prompt: this.messageGenerator(), // <-- AsyncGenerator!
				options: {
					model: this.session.config.model,
					cwd: this.session.workspacePath,
					abortController: this.abortController,
					permissionMode: 'bypassPermissions',
					allowDangerouslySkipPermissions: true,
					maxTurns: Infinity, // Run forever!
				},
			});

			// Fetch and cache slash commands
			await this.fetchAndCacheSlashCommands();

			// Process SDK messages
			this.logger.log(`Processing SDK stream...`);
			for await (const message of this.queryObject) {
				await this.handleSDKMessage(message);
			}

			this.logger.log(`SDK stream ended`);
		} catch (error) {
			this.logger.error(`Streaming query error:`, error);

			// Reject all pending messages
			for (const msg of this.messageQueue) {
				msg.reject(error instanceof Error ? error : new Error(String(error)));
			}
			this.messageQueue = [];

			// Determine error category based on error message
			let category = ErrorCategory.SYSTEM;
			const errorMessage = error instanceof Error ? error.message : String(error);

			if (
				errorMessage.includes('401') ||
				errorMessage.includes('unauthorized') ||
				errorMessage.includes('invalid_api_key')
			) {
				category = ErrorCategory.AUTHENTICATION;
			} else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
				category = ErrorCategory.CONNECTION;
			} else if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
				category = ErrorCategory.RATE_LIMIT;
			} else if (errorMessage.includes('timeout')) {
				category = ErrorCategory.TIMEOUT;
			} else if (errorMessage.includes('model_not_found')) {
				category = ErrorCategory.MODEL;
			}

			await this.errorManager.handleError(this.session.id, error as Error, category);
		} finally {
			this.queryRunning = false;
			this.logger.log(`Streaming query stopped`);
		}
	}

	/**
	 * Handle incoming SDK messages
	 */
	private async handleSDKMessage(message: unknown): Promise<void> {
		// Cast unknown to SDKMessage - messages come from SDK which provides proper typing
		const sdkMessage = message as SDKMessage;

		// Emit and save message
		await this.messageHub.publish('sdk.message', sdkMessage, { sessionId: this.session.id });

		// Save to DB
		this.db.saveSDKMessage(this.session.id, sdkMessage);

		// Broadcast SDK message delta
		await this.messageHub.publish(
			'state.sdkMessages.delta',
			{
				added: [sdkMessage],
				timestamp: Date.now(),
				version: ++this.sdkMessageDeltaVersion,
			},
			{ sessionId: this.session.id }
		);

		// Handle specific message types
		if (isSDKResultSuccess(sdkMessage)) {
			// FIX: Set state back to 'idle' when result received
			await this.setProcessingState({ status: 'idle' });

			// Update session metadata with token usage and costs
			const usage = sdkMessage.usage;
			const totalTokens = usage.input_tokens + usage.output_tokens;
			const cost = sdkMessage.total_cost_usd || 0;

			this.session.lastActiveAt = new Date().toISOString();
			this.session.metadata = {
				...this.session.metadata,
				messageCount: (this.session.metadata?.messageCount || 0) + 1,
				totalTokens: (this.session.metadata?.totalTokens || 0) + totalTokens,
				inputTokens: (this.session.metadata?.inputTokens || 0) + usage.input_tokens,
				outputTokens: (this.session.metadata?.outputTokens || 0) + usage.output_tokens,
				totalCost: (this.session.metadata?.totalCost || 0) + cost,
				toolCallCount: this.session.metadata?.toolCallCount || 0, // Will be updated separately
			};
			this.db.updateSession(this.session.id, {
				lastActiveAt: this.session.lastActiveAt,
				metadata: this.session.metadata,
			});
		}

		// Track tool calls
		if (isSDKAssistantMessage(sdkMessage)) {
			const toolCalls = sdkMessage.message.content.filter(isToolUseBlock);
			if (toolCalls.length > 0) {
				this.session.metadata = {
					...this.session.metadata,
					toolCallCount: (this.session.metadata?.toolCallCount || 0) + toolCalls.length,
				};
				this.db.updateSession(this.session.id, {
					metadata: this.session.metadata,
				});
			}
		}
	}

	/**
	 * Handle interrupt request - clear queue and abort
	 * Called by RPC handler in session-handlers.ts
	 */
	async handleInterrupt(): Promise<void> {
		this.logger.log(`Handling interrupt...`);

		// FIX: Set state to 'interrupted'
		await this.setProcessingState({ status: 'interrupted' });

		// Clear pending messages
		for (const msg of this.messageQueue) {
			msg.reject(new Error('Interrupted by user'));
		}
		this.messageQueue = [];

		// Abort current query
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = undefined;
		}

		await this.messageHub.publish(
			'session.interrupted',
			{},
			{
				sessionId: this.session.id,
			}
		);

		// FIX: Set state back to 'idle' after interrupt completes
		await this.setProcessingState({ status: 'idle' });
	}

	/**
	 * Switch to a different Claude model mid-session
	 * Called by RPC handler in session-handlers.ts
	 *
	 * This will:
	 * 1. Validate the new model
	 * 2. Stop the current query
	 * 3. Update session config
	 * 4. Restart query with new model
	 * 5. Preserve conversation history (displayed to user, but NOT replayed to SDK)
	 *
	 * ⚠️ WARNING: Switching models increases token consumption because
	 * the new model must process the entire conversation history.
	 */
	async handleModelSwitch(
		newModel: string
	): Promise<{ success: boolean; model: string; error?: string }> {
		this.logger.log(`Handling model switch to: ${newModel}`);

		try {
			// Validate the model
			if (!isValidModel(newModel)) {
				const error = `Invalid model: ${newModel}. Use a valid model ID or alias.`;
				this.logger.error(`${error}`);
				return { success: false, model: this.session.config.model, error };
			}

			// Resolve alias to full model ID
			const resolvedModel = resolveModelAlias(newModel);
			const modelInfo = getModelInfo(resolvedModel);

			// Check if already using this model
			if (this.session.config.model === resolvedModel) {
				this.logger.log(`Already using model: ${resolvedModel}`);
				return {
					success: true,
					model: resolvedModel,
					error: `Already using ${modelInfo?.name || resolvedModel}`,
				};
			}

			const previousModel = this.session.config.model;

			// Emit model switching event
			await this.messageHub.publish(
				'session.model-switching',
				{
					from: previousModel,
					to: resolvedModel,
				},
				{ sessionId: this.session.id }
			);

			// Step 1: Stop the current query gracefully
			this.logger.log(`Stopping current query...`);
			this.queryRunning = false;

			// Abort current query
			if (this.abortController) {
				this.abortController.abort();
				this.abortController = undefined;
			}

			// Wait for query to fully stop (with timeout)
			if (this.queryPromise) {
				try {
					await Promise.race([
						this.queryPromise,
						new Promise((resolve) => setTimeout(resolve, 3000)), // 3s timeout
					]);
				} catch (error) {
					this.logger.warn(`Query cleanup warning:`, error);
				}
				this.queryPromise = null;
			}

			// Step 2: Update session config with new model
			this.session.config.model = resolvedModel;
			this.db.updateSession(this.session.id, {
				config: this.session.config,
			});

			this.logger.log(`Updated config to model: ${resolvedModel}`);

			// Step 3: Restart the streaming query with new model
			this.logger.log(`Restarting query with new model...`);
			await this.startStreamingQuery();

			// Emit success event
			await this.messageHub.publish(
				'session.model-switched',
				{
					from: previousModel,
					to: resolvedModel,
					modelInfo: modelInfo || null,
				},
				{ sessionId: this.session.id }
			);

			this.logger.log(`Model switched successfully to: ${resolvedModel}`);

			return {
				success: true,
				model: resolvedModel,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Model switch failed:`, error);

			await this.errorManager.handleError(
				this.session.id,
				error as Error,
				ErrorCategory.MODEL,
				`Failed to switch model: ${errorMessage}`
			);

			return {
				success: false,
				model: this.session.config.model,
				error: errorMessage,
			};
		}
	}

	/**
	 * Get current model information
	 */
	getCurrentModel(): CurrentModelInfo {
		return {
			id: this.session.config.model,
			info: getModelInfo(this.session.config.model) || null,
		};
	}

	/**
	 * Get messages for this session
	 */
	getMessages(limit?: number, offset?: number): Message[] {
		return this.db.getMessages(this.session.id, limit, offset);
	}

	/**
	 * Get SDK messages for this session
	 */
	getSDKMessages(limit?: number, offset?: number, since?: number) {
		return this.db.getSDKMessages(this.session.id, limit, offset, since);
	}

	/**
	 * Get session data
	 */
	getSessionData(): Session {
		return this.session;
	}

	/**
	 * Update session metadata
	 */
	updateMetadata(updates: Partial<Session>): void {
		if (updates.title) this.session.title = updates.title;
		if (updates.workspacePath) {
			this.session.workspacePath = updates.workspacePath;
		}
		if (updates.status) this.session.status = updates.status;
		if (updates.metadata) this.session.metadata = updates.metadata;

		this.db.updateSession(this.session.id, updates);
	}

	/**
	 * Clear conversation history (for testing or reset)
	 */
	clearHistory(): void {
		this.conversationHistory = [];
	}

	/**
	 * Reload conversation history from database
	 * Useful after clearing messages or external updates
	 */
	reloadHistory(): void {
		this.loadConversationHistory();
	}

	/**
	 * Abort current query (delegates to handleInterrupt)
	 */
	abort(): void {
		this.handleInterrupt();
	}

	/**
	 * Cleanup resources when session is destroyed
	 *
	 * FIX: Made async and waits for query to stop properly
	 * PHASE 3 FIX: Unsubscribe from all MessageHub subscriptions to prevent memory leaks
	 */
	async cleanup(): Promise<void> {
		this.logger.log(`Cleaning up resources...`);

		// Unsubscribe from all MessageHub events
		for (const unsubscribe of this.unsubscribers) {
			try {
				unsubscribe();
			} catch (error) {
				this.logger.error(`Error during unsubscribe:`, error);
			}
		}
		this.unsubscribers = [];

		// Signal query to stop
		this.queryRunning = false;

		// Abort any running query
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = undefined;
		}

		// FIX: Wait for query to fully stop (with timeout)
		if (this.queryPromise) {
			try {
				await Promise.race([
					this.queryPromise,
					new Promise((resolve) => setTimeout(resolve, 5000)), // 5s timeout
				]);
			} catch (error) {
				// Ignore errors during cleanup
				this.logger.warn(`Query cleanup error:`, error);
			}
			this.queryPromise = null;
		}

		// Clear state
		this.messageQueue = [];
		this.messageWaiters = [];

		this.logger.log(`Cleanup complete`);
	}

	/**
	 * Get available slash commands for this session
	 * Returns cached commands or fetches from SDK if not yet available
	 */
	async getSlashCommands(): Promise<string[]> {
		// Return cached if available
		if (this.slashCommands.length > 0) {
			return this.slashCommands;
		}

		// Try to fetch from SDK query object
		await this.fetchAndCacheSlashCommands();
		return this.slashCommands;
	}
}
