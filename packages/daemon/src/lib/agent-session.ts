import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type {
	AgentProcessingState,
	MessageContent,
	MessageImage,
	Session,
	ContextInfo,
} from '@liuboer/shared';
import type { EventBus, MessageHub, CurrentModelInfo } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import type { SDKMessage, SlashCommand } from '@liuboer/shared/sdk';
import { Database } from '../storage/database';
import { ErrorCategory, ErrorManager } from './error-manager';
import { Logger } from './logger';
import { isValidModel, resolveModelAlias, getModelInfo } from './model-service';

// New extracted components
import { MessageQueue } from './message-queue';
import { ProcessingStateManager } from './processing-state-manager';
import { ContextTracker } from './context-tracker';
import { SDKMessageHandler } from './sdk-message-handler';

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
 *
 * REFACTORED: Now uses extracted components for better maintainability:
 * - MessageQueue: Handles message queueing and AsyncGenerator
 * - ProcessingStateManager: Manages state machine and phases
 * - ContextTracker: Tracks real-time context window usage
 * - SDKMessageHandler: Processes incoming SDK messages
 */
export class AgentSession {
	// Extracted components
	private messageQueue: MessageQueue;
	private stateManager: ProcessingStateManager;
	private contextTracker: ContextTracker;
	private messageHandler: SDKMessageHandler;

	// SDK query object with control methods
	private queryObject: SDKQueryObject = null;
	private slashCommands: string[] = [];
	private commandsFetchedFromSDK = false; // Track if we've fetched from SDK to avoid duplicates

	// Unsubscribe functions to prevent memory leaks
	private unsubscribers: Array<() => void> = [];

	// Track query promise for proper cleanup
	private queryPromise: Promise<void> | null = null;

	// Error manager for structured error handling
	private errorManager: ErrorManager;

	private logger: Logger;

	constructor(
		private session: Session,
		private db: Database,
		private messageHub: MessageHub,
		private eventBus: EventBus,
		private getApiKey: () => Promise<string | null>
	) {
		// Initialize error manager and logger
		this.errorManager = new ErrorManager(this.messageHub);
		this.logger = new Logger(`AgentSession ${session.id}`);

		// Initialize extracted components
		this.messageQueue = new MessageQueue();
		this.stateManager = new ProcessingStateManager(session.id, eventBus, db);
		this.contextTracker = new ContextTracker(
			session.id,
			session.config.model,
			eventBus,
			// Callback to persist context info to session metadata
			(contextInfo: ContextInfo) => {
				this.session.metadata.lastContextInfo = contextInfo;
				this.db.updateSession(this.session.id, {
					metadata: this.session.metadata,
				});
			}
		);
		this.messageHandler = new SDKMessageHandler(
			session,
			db,
			messageHub,
			eventBus,
			this.stateManager,
			this.contextTracker
		);

		// Set queue callback for automatic /context fetching
		this.messageHandler.setQueueMessageCallback(async (content: string, internal: boolean) => {
			return await this.messageQueue.enqueue(content, internal);
		});

		// Restore persisted context info from session metadata (if available)
		if (session.metadata?.lastContextInfo) {
			this.contextTracker.restoreFromMetadata(session.metadata.lastContextInfo);
			this.logger.log('Restored context info from session metadata');
		}

		// Restore persisted slash commands from session (if available)
		// These are used as initial cache until SDK query is available
		if (session.availableCommands && session.availableCommands.length > 0) {
			this.slashCommands = session.availableCommands;
			this.logger.log(`Restored ${this.slashCommands.length} slash commands from session data`);
		}

		// Restore persisted processing state from database (if available)
		this.stateManager.restoreFromDatabase();

		// LAZY START: Don't start the streaming query here.
		// Query will be started on first message send via ensureQueryStarted()
	}

	/**
	 * Get current processing state
	 * Used when clients subscribe/reconnect to get immediate snapshot
	 */
	getProcessingState(): AgentProcessingState {
		return this.stateManager.getState();
	}

	/**
	 * Get current context info
	 * Used when clients subscribe/reconnect to get immediate snapshot
	 */
	getContextInfo(): ContextInfo | null {
		return this.contextTracker.getContextInfo();
	}

	/**
	 * Fetch and cache slash commands from SDK
	 * Used internally to update slash commands after query creation
	 *
	 * DB-FIRST PATTERN: Save to DB, then broadcast via EventBus
	 */
	private async fetchAndCacheSlashCommands(): Promise<void> {
		if (!this.queryObject || typeof this.queryObject.supportedCommands !== 'function') {
			return;
		}

		// Skip if we've already fetched from SDK
		if (this.commandsFetchedFromSDK) {
			return;
		}

		try {
			const commands = await this.queryObject.supportedCommands();
			const commandNames = commands.map((cmd: SlashCommand) => cmd.name);

			// Add built-in commands that the SDK supports but doesn't advertise
			const builtInCommands = ['clear', 'help'];
			const allCommands = [...new Set([...commandNames, ...builtInCommands])];

			this.slashCommands = allCommands;
			this.commandsFetchedFromSDK = true;

			this.logger.log(`Fetched ${this.slashCommands.length} slash commands from SDK`);

			// DB-FIRST: Save to database FIRST
			this.session.availableCommands = this.slashCommands;
			this.db.updateSession(this.session.id, {
				availableCommands: this.slashCommands,
			});

			// THEN emit event via EventBus (StateManager will broadcast unified session state)
			await this.eventBus.emit('commands:updated', {
				sessionId: this.session.id,
				commands: this.slashCommands,
			});
		} catch (error) {
			this.logger.warn(`Failed to fetch slash commands:`, error);
		}
	}

	/**
	 * Fetch and cache available models from SDK
	 * Used internally to update model list after query creation
	 */
	private async fetchAndCacheModels(): Promise<void> {
		if (!this.queryObject) {
			return;
		}

		try {
			const { getSupportedModelsFromQuery } = await import('./model-service');
			const models = await getSupportedModelsFromQuery(this.queryObject, this.session.id);

			if (models.length > 0) {
				this.logger.log(`Fetched ${models.length} models from SDK for session ${this.session.id}`);
			} else {
				this.logger.log(`No models fetched from SDK, will use static fallback`);
			}
		} catch (error) {
			this.logger.warn(`Failed to fetch models from SDK:`, error);
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
	 * DEPRECATED: Use enqueueMessage instead
	 * Kept temporarily for HTTP endpoint backward compatibility
	 */
	async sendMessage(content: string): Promise<string> {
		return this.messageQueue.enqueue(content);
	}

	/**
	 * Ensure the streaming query is started (lazy initialization)
	 * Called on first message send to avoid connecting to SDK until needed
	 */
	private async ensureQueryStarted(): Promise<void> {
		if (this.messageQueue.isRunning() || this.queryPromise) {
			return; // Already started
		}

		this.logger.log(`Lazy-starting streaming query...`);
		await this.startStreamingQuery();
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
			// LAZY START: Start the query on first message
			await this.ensureQueryStarted();

			const { content, images } = data;
			const messageContent = this.buildMessageContent(content, images);

			// Generate message ID before enqueuing so we can set state BEFORE the message starts processing
			const messageId = generateUUID();

			// Set state to 'queued' BEFORE enqueue, because enqueue() blocks until the message
			// is actually sent to the SDK, by which time state should transition to 'processing'
			await this.stateManager.setQueued(messageId);

			// enqueue() waits for the message to be yielded to the SDK and onSent() called
			// During this time, state transitions: queued -> processing -> ...
			await this.messageQueue.enqueueWithId(messageId, messageContent);

			// Emit event for title generation (decoupled via EventBus)
			// Fire-and-forget - don't wait for title generation
			this.eventBus.emit('message:sent', { sessionId: this.session.id }).catch((err) => {
				this.logger.warn('Failed to emit message:sent event:', err);
			});

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
	 * Start the long-running streaming query with AsyncGenerator
	 */
	private async startStreamingQuery(): Promise<void> {
		if (this.messageQueue.isRunning()) {
			this.logger.log(`Query already running, skipping start`);
			return;
		}

		this.logger.log(`Starting streaming query...`);
		this.messageQueue.start();

		// Store query promise for cleanup
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

			// CRITICAL: Log the exact workspace path being passed to SDK
			// This is the cwd that should be used for ALL file operations
			this.logger.log(`SDK cwd (session.workspacePath): ${this.session.workspacePath}`);
			if (this.session.worktree) {
				this.logger.log(`Session uses worktree:`);
				this.logger.log(`  - Worktree path: ${this.session.worktree.worktreePath}`);
				this.logger.log(`  - Main repo: ${this.session.worktree.mainRepoPath}`);
				this.logger.log(`  - Branch: ${this.session.worktree.branch}`);
			} else {
				this.logger.log(`Session uses shared workspace (no worktree)`);
			}

			// Build system prompt with worktree instructions if applicable
			const systemPromptConfig: Options['systemPrompt'] = {
				type: 'preset',
				preset: 'claude_code',
			};

			// Append worktree instructions if session uses a worktree
			if (this.session.worktree) {
				systemPromptConfig.append = `
IMPORTANT: Git Worktree Isolation

This session is running in an isolated git worktree at:
${this.session.worktree.worktreePath}

Branch: ${this.session.worktree.branch}
Main repository: ${this.session.worktree.mainRepoPath}

CRITICAL RULES:
1. ALL file operations MUST stay within the worktree directory: ${this.session.worktree.worktreePath}
2. NEVER modify files in the main repository at: ${this.session.worktree.mainRepoPath}
3. Your current working directory (cwd) is already set to the worktree path
4. Do NOT attempt to access or modify files outside the worktree path

ALLOWED GIT OPERATIONS ON ROOT REPOSITORY:
To merge changes from this session branch into the main branch of the root repository:

git --git-dir=${this.session.worktree.mainRepoPath}/.git --work-tree=${this.session.worktree.mainRepoPath} merge ${this.session.worktree.branch}

To push the main branch to remote:

git --git-dir=${this.session.worktree.mainRepoPath}/.git --work-tree=${this.session.worktree.mainRepoPath} push origin main

These commands operate on the root repository without violating worktree isolation.
This isolation ensures concurrent sessions don't conflict with each other.
`.trim();
			}

			// Build query options
			const queryOptions: Options = {
				model: this.session.config.model,
				cwd: this.session.workspacePath,
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
				maxTurns: Infinity,
				settingSources: ['project', 'local'],
				systemPrompt: systemPromptConfig,
			};

			// Add resume parameter if SDK session ID exists (session resumption)
			if (this.session.sdkSessionId) {
				queryOptions.resume = this.session.sdkSessionId;
				this.logger.log(`Resuming SDK session: ${this.session.sdkSessionId}`);
			} else {
				this.logger.log(`Starting new SDK session`);
			}

			// Create query with AsyncGenerator from MessageQueue
			this.queryObject = query({
				prompt: this.createMessageGeneratorWrapper(),
				options: queryOptions,
			});

			// Process SDK messages - MUST start immediately!
			// The SDK methods (supportedCommands, supportedModels) require the query to be
			// actively consumed, so we start processing first and fetch metadata in the background.
			this.logger.log(`Processing SDK stream...`);

			// Fire-and-forget: fetch slash commands and models in background
			// These don't block message processing and will complete when the SDK is ready
			this.fetchAndCacheSlashCommands().catch((e) =>
				this.logger.warn('Background fetch of slash commands failed:', e)
			);
			this.fetchAndCacheModels().catch((e) =>
				this.logger.warn('Background fetch of models failed:', e)
			);

			// TypeScript safety: ensure queryObject is not null
			if (!this.queryObject) {
				throw new Error('Query object is null after initialization');
			}

			for await (const message of this.queryObject) {
				try {
					await this.handleSDKMessage(message);
				} catch (error) {
					// Catch individual message handling errors to prevent stream death
					this.logger.error(`Error handling SDK message:`, error);
					this.logger.error(`Message type:`, (message as SDKMessage).type);
				}
			}

			this.logger.log(`SDK stream ended`);
		} catch (error) {
			this.logger.error(`Streaming query error:`, error);

			// Clear pending messages
			this.messageQueue.clear();

			// Don't broadcast AbortError to clients - it's intentional
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isAbortError = error instanceof Error && error.name === 'AbortError';

			if (!isAbortError) {
				// Determine error category based on error message
				let category = ErrorCategory.SYSTEM;

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
			}
		} finally {
			this.messageQueue.stop();
			this.logger.log(`Streaming query stopped`);
		}
	}

	/**
	 * Create wrapper for MessageQueue's AsyncGenerator
	 * Handles saving user messages to DB and updating processing state
	 */
	private async *createMessageGeneratorWrapper() {
		for await (const { message, onSent } of this.messageQueue.messageGenerator(this.session.id)) {
			// Check if this is an internal message (don't save or emit)
			const queuedMessage = message as typeof message & { internal?: boolean };
			const isInternal = queuedMessage.internal || false;

			// Save and emit only if NOT internal
			if (!isInternal) {
				// Save user message to DB
				this.db.saveSDKMessage(this.session.id, message);

				// Emit user message as SDK message event
				await this.messageHub.publish('sdk.message', message, {
					sessionId: this.session.id,
				});

				// Update state to 'processing' in 'initializing' phase
				await this.stateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
			}

			// Yield the full SDKUserMessage to SDK (not just message.message!)
			// The SDK expects AsyncIterable<SDKUserMessage>, which includes type, uuid, session_id, etc.
			yield message;

			// Mark as sent
			onSent();
		}
	}

	/**
	 * Handle incoming SDK messages
	 * Delegates to SDKMessageHandler for processing
	 */
	private async handleSDKMessage(message: unknown): Promise<void> {
		const sdkMessage = message as SDKMessage;

		// Delegate to message handler
		await this.messageHandler.handleMessage(sdkMessage);
	}

	/**
	 * Handle interrupt request - uses official SDK interrupt() method
	 * Called by RPC handler in session-handlers.ts
	 */
	async handleInterrupt(): Promise<void> {
		const currentState = this.stateManager.getState();
		this.logger.log(`Handling interrupt (current state: ${currentState.status})...`);

		// Edge case: already idle or interrupted - no-op
		if (currentState.status === 'idle' || currentState.status === 'interrupted') {
			this.logger.log(`Already ${currentState.status}, skipping interrupt`);
			return;
		}

		// Set state to 'interrupted' immediately for UI feedback
		await this.stateManager.setInterrupted();

		// Clear pending messages in queue
		const queueSize = this.messageQueue.size();
		if (queueSize > 0) {
			this.logger.log(`Clearing ${queueSize} queued messages`);
			this.messageQueue.clear();
		}

		// Use official SDK interrupt() method if query is running
		if (this.queryObject && typeof this.queryObject.interrupt === 'function') {
			try {
				this.logger.log(`Calling SDK interrupt()...`);
				await this.queryObject.interrupt();
				this.logger.log(`SDK interrupt() completed successfully`);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.logger.warn(`SDK interrupt() failed (may be expected):`, errorMessage);
			}
		} else {
			this.logger.log(`No query object, interrupt complete (queue cleared)`);
		}

		// Publish interrupt event for clients
		await this.messageHub.publish(
			'session.interrupted',
			{},
			{
				sessionId: this.session.id,
			}
		);

		// Set state back to 'idle' after interrupt completes
		await this.stateManager.setIdle();
		this.logger.log(`Interrupt complete, state reset to idle`);
	}

	/**
	 * Switch to a different Claude model mid-session
	 * Called by RPC handler in session-handlers.ts
	 */
	async handleModelSwitch(
		newModel: string
	): Promise<{ success: boolean; model: string; error?: string }> {
		this.logger.log(`Handling model switch to: ${newModel}`);

		try {
			// Validate the model
			const isValid = await isValidModel(newModel);
			if (!isValid) {
				const error = `Invalid model: ${newModel}. Use a valid model ID or alias.`;
				this.logger.error(`${error}`);
				return { success: false, model: this.session.config.model, error };
			}

			// Resolve alias to full model ID
			const resolvedModel = await resolveModelAlias(newModel);
			const modelInfo = await getModelInfo(resolvedModel);

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

			// Check if query is running
			if (!this.queryObject) {
				// Query not started yet - just update config
				this.logger.log(`Query not started yet, updating config only`);
				this.session.config.model = resolvedModel;
				this.db.updateSession(this.session.id, {
					config: this.session.config,
				});

				// Update context tracker model
				this.contextTracker.setModel(resolvedModel);

				// Emit session:updated event
				await this.eventBus.emit('session:updated', {
					sessionId: this.session.id,
					updates: { config: this.session.config },
				});
			} else {
				// Use SDK's native setModel() method
				this.logger.log(`Using SDK setModel() to switch to: ${resolvedModel}`);
				await this.queryObject.setModel(resolvedModel);

				// Update session config
				this.session.config.model = resolvedModel;
				this.db.updateSession(this.session.id, {
					config: this.session.config,
				});

				// Update context tracker model
				this.contextTracker.setModel(resolvedModel);

				// Emit session:updated event
				await this.eventBus.emit('session:updated', {
					sessionId: this.session.id,
					updates: { config: this.session.config },
				});

				this.logger.log(`Model switched via SDK to: ${resolvedModel}`);
			}

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
	 * Get current model ID for this session
	 */
	getCurrentModel(): CurrentModelInfo {
		return {
			id: this.session.config.model,
			info: null, // Model info is fetched asynchronously by RPC handler
		};
	}

	/**
	 * Get SDK messages for this session
	 */
	getSDKMessages(limit?: number, before?: number, since?: number) {
		return this.db.getSDKMessages(this.session.id, limit, before, since);
	}

	/**
	 * Get the total count of SDK messages for this session
	 */
	getSDKMessageCount(): number {
		return this.db.getSDKMessageCount(this.session.id);
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
		if (updates.metadata) {
			// Merge partial metadata updates (consistent with database.updateSession behavior)
			// Filter out undefined/null values to allow clearing fields
			const mergedMetadata = { ...this.session.metadata };
			for (const [key, value] of Object.entries(updates.metadata)) {
				if (value === undefined || value === null) {
					delete mergedMetadata[key as keyof typeof mergedMetadata];
				} else {
					(mergedMetadata as Record<string, unknown>)[key] = value;
				}
			}
			this.session.metadata = mergedMetadata;
		}
		if (updates.config) {
			this.session.config = { ...this.session.config, ...updates.config };
		}

		this.db.updateSession(this.session.id, updates);
	}

	/**
	 * Cleanup resources when session is destroyed
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

		// Clear models cache for this session
		try {
			const { clearModelsCache } = await import('./model-service');
			clearModelsCache(this.session.id);
		} catch {
			// Ignore - not critical
		}

		// Signal queue to stop
		this.messageQueue.stop();

		// Interrupt query using SDK method (best-effort, don't wait)
		if (this.queryObject && typeof this.queryObject.interrupt === 'function') {
			try {
				this.queryObject.interrupt().catch((error) => {
					this.logger.warn(`Interrupt during cleanup failed:`, error);
				});
			} catch (error) {
				this.logger.warn(`Error calling interrupt during cleanup:`, error);
			}
		}

		// Wait for query to fully stop (with timeout)
		if (this.queryPromise) {
			try {
				await Promise.race([
					this.queryPromise,
					new Promise((resolve) => setTimeout(resolve, 5000)), // 5s timeout
				]);
			} catch (error) {
				this.logger.warn(`Query cleanup error:`, error);
			}
			this.queryPromise = null;
		}

		this.logger.log(`Cleanup complete`);
	}

	/**
	 * Get available slash commands for this session
	 * Returns DB-persisted commands immediately, refreshes from SDK if available
	 */
	async getSlashCommands(): Promise<string[]> {
		// Return cached/DB-persisted commands if available
		if (this.slashCommands.length > 0) {
			// Fire-and-forget: refresh from SDK in background if not yet fetched
			if (!this.commandsFetchedFromSDK && this.queryObject) {
				this.fetchAndCacheSlashCommands().catch((e) =>
					this.logger.warn('Background refresh of slash commands failed:', e)
				);
			}
			return this.slashCommands;
		}

		// No cached commands - try to fetch from SDK query object
		await this.fetchAndCacheSlashCommands();
		return this.slashCommands;
	}
}
