import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
	AgentProcessingState,
	MessageContent,
	MessageImage,
	Session,
	ContextInfo,
	ContextCategoryBreakdown,
	ContextAPIUsage,
} from '@liuboer/shared';
import type { EventBus, MessageHub } from '@liuboer/shared';
import type {
	Query,
	SDKMessage,
	SDKUserMessage,
	SlashCommand,
	ModelUsage,
} from '@liuboer/shared/sdk';
import {
	isSDKResultSuccess,
	isSDKAssistantMessage,
	isToolUseBlock,
	isSDKStatusMessage,
	isSDKCompactBoundary,
} from '@liuboer/shared/sdk/type-guards';
import type { UUID } from 'crypto';
import { generateUUID, type CurrentModelInfo } from '@liuboer/shared';
import { Database } from '../storage/database';
import { ErrorCategory, ErrorManager } from './error-manager';
import { Logger } from './logger';
import { isValidModel, resolveModelAlias, getModelInfo } from './model-service';
import { generateTitle } from './title-generator';

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
	private sdkMessageDeltaVersion: number = 0;

	// FIX: Agent processing state (server-side state for push-based sync)
	private processingState: AgentProcessingState = { status: 'idle' };

	// Streaming phase tracking
	private streamingPhase: 'initializing' | 'thinking' | 'streaming' | 'finalizing' = 'initializing';
	private streamingStartedAt: number | null = null;

	// ========================================
	// Context Tracking State
	// ========================================
	// Tracks real-time context window usage during streaming
	// Updated on message_start (input tokens) and message_delta (output tokens)

	/**
	 * Current context info - the latest snapshot of context window usage
	 * Updated in real-time during streaming for live UI updates
	 */
	private currentContextInfo: ContextInfo | null = null;

	/**
	 * Context window size for the current model (in tokens)
	 * Set from SDK's modelUsage when available, defaults to 200K
	 */
	private contextWindowSize: number = 200000; // Default for Claude models

	/**
	 * Current turn's input tokens (from message_start)
	 * This represents TOTAL context being sent to Claude for this turn:
	 * system prompt + tools + conversation history + current input
	 */
	private currentTurnInputTokens: number = 0;

	/**
	 * Current turn's output tokens (from message_delta, cumulative)
	 * Updated during streaming
	 */
	private currentTurnOutputTokens: number = 0;

	/**
	 * Throttle interval for context updates during streaming (ms)
	 * Prevents flooding clients with updates
	 */
	private contextUpdateThrottleMs: number = 250;
	private lastContextUpdateTime: number = 0;

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

		// Restore persisted context info from session metadata (if available)
		if (session.metadata?.lastContextInfo) {
			this.currentContextInfo = session.metadata.lastContextInfo;
			this.logger.log('Restored context info from session metadata');
		}

		// Setup event listeners for incoming messages
		this.setupEventListeners();

		// LAZY START: Don't start the streaming query here.
		// Query will be started on first message send via ensureQueryStarted()
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
	 * Enhanced with streaming phase tracking
	 */
	private async setProcessingState(newState: AgentProcessingState): Promise<void> {
		// If transitioning to idle or interrupted, reset phase tracking
		if (newState.status === 'idle' || newState.status === 'interrupted') {
			this.streamingPhase = 'initializing';
			this.streamingStartedAt = null;
		}

		this.processingState = newState;

		// Emit event via EventBus (StateManager will broadcast unified session state)
		await this.eventBus.emit('agent-state:changed', {
			sessionId: this.session.id,
			state: newState,
		});

		this.logger.log(`Agent state changed:`, newState);
	}

	/**
	 * Update the streaming phase and broadcast state change
	 * This allows fine-grained tracking of query execution progress
	 */
	private async updateStreamingPhase(
		phase: 'initializing' | 'thinking' | 'streaming' | 'finalizing'
	): Promise<void> {
		this.streamingPhase = phase;

		// Track when streaming actually started
		if (phase === 'streaming' && !this.streamingStartedAt) {
			this.streamingStartedAt = Date.now();
		}

		// Update state if currently processing
		if (this.processingState.status === 'processing') {
			this.processingState = {
				status: 'processing',
				messageId: this.processingState.messageId,
				phase: this.streamingPhase,
				streamingStartedAt: this.streamingStartedAt ?? undefined,
			};

			// Broadcast updated state
			await this.eventBus.emit('agent-state:changed', {
				sessionId: this.session.id,
				state: this.processingState,
			});

			this.logger.log(`Streaming phase changed to: ${phase}`);
		}
	}

	/**
	 * Get current processing state
	 * Used when clients subscribe/reconnect to get immediate snapshot
	 */
	getProcessingState(): AgentProcessingState {
		return this.processingState;
	}

	// ========================================
	// Context Tracking Methods
	// ========================================

	/**
	 * Get current context info
	 * Used when clients subscribe/reconnect to get immediate snapshot
	 */
	getContextInfo(): ContextInfo | null {
		return this.currentContextInfo;
	}

	/**
	 * Handle message_start stream event
	 * This contains the TOTAL input tokens for this turn (system + tools + history + current)
	 * This is THE key insight - input_tokens at message_start = total context being consumed
	 */
	private async handleMessageStartUsage(usage: {
		input_tokens: number;
		output_tokens: number;
	}): Promise<void> {
		this.currentTurnInputTokens = usage.input_tokens;
		this.currentTurnOutputTokens = usage.output_tokens; // Usually 1 at start

		// Build and broadcast initial context info for this turn
		await this.buildAndBroadcastContextInfo('message_start');
	}

	/**
	 * Handle message_delta stream event
	 * This contains the cumulative output tokens for this turn
	 */
	private async handleMessageDeltaUsage(usage: { output_tokens: number }): Promise<void> {
		this.currentTurnOutputTokens = usage.output_tokens; // Cumulative

		// Throttled broadcast to avoid flooding
		await this.buildAndBroadcastContextInfo('message_delta', true);
	}

	/**
	 * Handle result message with complete token usage
	 * This is the authoritative source - use it to calibrate our estimates
	 */
	private async handleResultUsage(
		usage: {
			input_tokens: number;
			output_tokens: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		},
		modelUsage?: Record<string, ModelUsage>
	): Promise<void> {
		// Update context window size if SDK provides it
		if (modelUsage) {
			const modelName = Object.keys(modelUsage)[0];
			if (modelName && modelUsage[modelName]?.contextWindow) {
				this.contextWindowSize = modelUsage[modelName].contextWindow;
				this.logger.log(`Updated context window size from SDK: ${this.contextWindowSize}`);
			}
		}

		// Store accurate final values for this turn
		this.currentTurnInputTokens = usage.input_tokens;
		this.currentTurnOutputTokens = usage.output_tokens;

		// Build context info with cache information
		const apiUsage: ContextAPIUsage = {
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadTokens: usage.cache_read_input_tokens || 0,
			cacheCreationTokens: usage.cache_creation_input_tokens || 0,
		};

		// Force broadcast (not throttled) since this is the final accurate data
		await this.buildAndBroadcastContextInfo('result', false, apiUsage);
	}

	/**
	 * Build ContextInfo and broadcast to clients
	 *
	 * KEY INSIGHT: At message_start, input_tokens represents the TOTAL tokens
	 * being sent to Claude for this turn. This includes:
	 * - System prompt
	 * - Tool definitions
	 * - Complete conversation history
	 * - Current user input
	 *
	 * This is exactly what we need to calculate context window usage!
	 *
	 * PERSISTENCE: Context info is saved to session metadata so it survives:
	 * - Page refreshes
	 * - Session reconnects
	 * - Server restarts
	 */
	private async buildAndBroadcastContextInfo(
		source: 'message_start' | 'message_delta' | 'result',
		throttle: boolean = false,
		apiUsage?: ContextAPIUsage
	): Promise<void> {
		// Throttle check
		if (throttle) {
			const now = Date.now();
			if (now - this.lastContextUpdateTime < this.contextUpdateThrottleMs) {
				return; // Skip this update, too soon
			}
			this.lastContextUpdateTime = now;
		}

		// Calculate total tokens in use
		// input_tokens = everything being sent to Claude
		// output_tokens = Claude's response (cumulative during streaming)
		const totalUsed = this.currentTurnInputTokens + this.currentTurnOutputTokens;
		const percentUsed = (totalUsed / this.contextWindowSize) * 100;

		// Build breakdown (using only accurate data)
		const breakdown = this.calculateBreakdown(totalUsed);

		// Create context info
		this.currentContextInfo = {
			model: this.session.config.model,
			totalUsed,
			totalCapacity: this.contextWindowSize,
			percentUsed: Math.min(percentUsed, 100), // Cap at 100%
			breakdown,
			apiUsage,
		};

		// Persist to session metadata (so it survives page refresh)
		this.session.metadata.lastContextInfo = this.currentContextInfo;
		this.db.updateSession(this.session.id, {
			metadata: this.session.metadata,
		});

		// Emit context update event via EventBus
		// StateManager will broadcast this via state.session channel
		await this.eventBus.emit('context:updated', {
			sessionId: this.session.id,
			contextInfo: this.currentContextInfo,
		});

		// Log for debugging (only on result or significant changes)
		if (source === 'result' || (source === 'message_start' && this.currentTurnInputTokens > 0)) {
			this.logger.log(
				`Context updated (${source}): ${totalUsed}/${this.contextWindowSize} tokens (${percentUsed.toFixed(1)}%)`
			);
		}
	}

	/**
	 * Calculate category breakdown for context usage
	 *
	 * Uses ONLY accurate data from SDK - no estimates:
	 * - Input: Total tokens sent to Claude (system + tools + conversation)
	 * - Output: Tokens generated by Claude
	 * - Free Space: Remaining context window
	 *
	 * This approach ensures the breakdown is always accurate and never misleading.
	 */
	private calculateBreakdown(totalUsed: number): Record<string, ContextCategoryBreakdown> {
		const freeSpace = this.contextWindowSize - totalUsed;

		// Calculate percentages relative to capacity
		const calcPercent = (tokens: number) => (tokens / this.contextWindowSize) * 100;

		return {
			'Input Context': {
				tokens: this.currentTurnInputTokens,
				percent: calcPercent(this.currentTurnInputTokens),
			},
			'Output Tokens': {
				tokens: this.currentTurnOutputTokens,
				percent: calcPercent(this.currentTurnOutputTokens),
			},
			'Free Space': {
				tokens: Math.max(0, freeSpace),
				percent: Math.max(0, calcPercent(freeSpace)),
			},
		};
	}

	/**
	 * Extract usage from RawMessageStreamEvent
	 * Handles the different event types from Anthropic's streaming API
	 */
	private async processStreamEventForContext(event: unknown): Promise<void> {
		// Type guard for the event structure
		const streamEvent = event as {
			type: string;
			message?: {
				usage?: { input_tokens: number; output_tokens: number };
			};
			usage?: { output_tokens: number };
		};

		try {
			// message_start: Contains initial input_tokens (total context)
			if (streamEvent.type === 'message_start' && streamEvent.message?.usage) {
				await this.handleMessageStartUsage(streamEvent.message.usage);
			}

			// message_delta: Contains cumulative output_tokens
			if (streamEvent.type === 'message_delta' && streamEvent.usage) {
				await this.handleMessageDeltaUsage(streamEvent.usage);
			}
		} catch (error) {
			// Don't let context tracking errors break the main flow
			this.logger.warn('Error processing stream event for context:', error);
		}
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
	 * Fetch and cache available models from SDK
	 * Used internally to update model list after query creation
	 * Models are cached per session for the session lifetime
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
			// Not critical - will fall back to static models
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
	/**
	 * Ensure the streaming query is started (lazy initialization)
	 * Called on first message send to avoid connecting to SDK until needed
	 */
	private async ensureQueryStarted(): Promise<void> {
		if (this.queryRunning || this.queryPromise) {
			return; // Already started
		}

		this.logger.log(`Lazy-starting streaming query...`);
		await this.startStreamingQuery();
	}

	async handleMessageSend(data: {
		content: string;
		images?: MessageImage[];
	}): Promise<{ messageId: string }> {
		try {
			// LAZY START: Start the query on first message
			await this.ensureQueryStarted();

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

				// Emit user message as SDK message event
				await this.messageHub.publish('sdk.message', sdkUserMessage, {
					sessionId: this.session.id,
				});

				// Update state to 'processing' (broadcasts agent.state event)
				// Start in 'initializing' phase
				await this.setProcessingState({
					status: 'processing',
					messageId: queuedMessage.id,
					phase: 'initializing',
				});
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
			// Note: No abortController needed - SDK interrupt() method handles cancellation
			this.queryObject = query({
				prompt: this.messageGenerator(), // <-- AsyncGenerator!
				options: {
					model: this.session.config.model,
					cwd: this.session.workspacePath,
					permissionMode: 'bypassPermissions',
					allowDangerouslySkipPermissions: true,
					maxTurns: Infinity, // Run forever!
					// Load project-level settings from .claude/settings.json and .claude/settings.local.json
					// Also loads CLAUDE.md files when using the claude_code system prompt preset
					settingSources: ['project', 'local'],
					// Use Claude Code's system prompt to enable CLAUDE.md project instructions
					systemPrompt: {
						type: 'preset',
						preset: 'claude_code',
					},
				},
			});

			// Fetch and cache slash commands
			await this.fetchAndCacheSlashCommands();

			// Fetch and cache available models from SDK
			await this.fetchAndCacheModels();

			// Process SDK messages
			this.logger.log(`Processing SDK stream...`);
			for await (const message of this.queryObject) {
				try {
					await this.handleSDKMessage(message);
				} catch (error) {
					// FIX: Catch individual message handling errors to prevent stream death
					this.logger.error(`Error handling SDK message:`, error);
					this.logger.error(`Message type:`, (message as SDKMessage).type);

					// Continue processing other messages - don't let one error kill the stream
					// This ensures messages continue to be saved even if one fails
				}
			}

			this.logger.log(`SDK stream ended`);
		} catch (error) {
			this.logger.error(`Streaming query error:`, error);

			// Reject all pending messages
			for (const msg of this.messageQueue) {
				msg.reject(error instanceof Error ? error : new Error(String(error)));
			}
			this.messageQueue = [];

			// Don't broadcast AbortError to clients - it's an intentional cleanup/interruption
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
			this.queryRunning = false;
			this.logger.log(`Streaming query stopped`);
		}
	}

	/**
	 * Handle incoming SDK messages
	 * Enhanced with automatic phase detection for streaming state tracking
	 */
	private async handleSDKMessage(message: unknown): Promise<void> {
		// Cast unknown to SDKMessage - messages come from SDK which provides proper typing
		const sdkMessage = message as SDKMessage;

		// ========================================
		// CONTEXT TRACKING: Extract usage from stream events
		// ========================================
		// Process stream events for real-time context tracking
		// This extracts token counts from message_start and message_delta events
		if (sdkMessage.type === 'stream_event') {
			// Extract the raw stream event and process for context info
			const streamEventMessage = sdkMessage as { event: unknown };
			await this.processStreamEventForContext(streamEventMessage.event);
		}

		// PHASE DETECTION LOGIC
		// Automatically update streaming phase based on message type
		if (this.processingState.status === 'processing') {
			if (sdkMessage.type === 'stream_event') {
				// We're actively streaming content deltas
				if (this.streamingPhase !== 'streaming') {
					await this.updateStreamingPhase('streaming');
				}
			} else if (isSDKAssistantMessage(sdkMessage)) {
				// Assistant message indicates thinking/tool use phase
				const hasToolUse = sdkMessage.message.content.some(isToolUseBlock);

				if (hasToolUse && this.streamingPhase === 'initializing') {
					// Transition from initializing to thinking when we see tool use
					await this.updateStreamingPhase('thinking');
				} else if (
					!hasToolUse &&
					this.streamingPhase === 'initializing' &&
					sdkMessage.message.content.some(
						(block: unknown) =>
							typeof block === 'object' &&
							block !== null &&
							'type' in block &&
							block.type === 'text'
					)
				) {
					// If we get a text response without tool use, we're likely about to stream
					// (or this is a short response that won't stream)
					await this.updateStreamingPhase('thinking');
				}
			} else if (sdkMessage.type === 'result') {
				// Final result - move to finalizing phase briefly before idle
				if (this.streamingPhase !== 'finalizing') {
					await this.updateStreamingPhase('finalizing');
				}
			}
		}

		// Mark all user messages from SDK as synthetic
		// Real user messages are saved in the message generator, not here
		// SDK only emits user messages for synthetic purposes (compaction, subagent context, etc.)
		if (sdkMessage.type === 'user') {
			(sdkMessage as SDKMessage & { isSynthetic: boolean }).isSynthetic = true;
		}

		// FIX: Save to DB FIRST before broadcasting to clients
		// This ensures we only broadcast messages that are successfully persisted
		const savedSuccessfully = this.db.saveSDKMessage(this.session.id, sdkMessage);

		if (!savedSuccessfully) {
			// Log warning but continue - message is already in SDK's memory
			this.logger.warn(`Failed to save message to DB (type: ${sdkMessage.type})`);
			// Don't broadcast to clients if DB save failed
			// This prevents UI from showing messages that won't survive a refresh
			return;
		}

		// Only broadcast if successfully saved to DB
		await this.messageHub.publish('sdk.message', sdkMessage, { sessionId: this.session.id });

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

			// ========================================
			// CONTEXT TRACKING: Final accurate update from result
			// ========================================
			// Use the authoritative usage data from result message
			// This includes modelUsage which has the context window size
			await this.handleResultUsage(
				{
					input_tokens: usage.input_tokens,
					output_tokens: usage.output_tokens,
					cache_read_input_tokens: usage.cache_read_input_tokens,
					cache_creation_input_tokens: usage.cache_creation_input_tokens,
				},
				sdkMessage.modelUsage
			);

			// ========================================
			// AUTO-GENERATE TITLE: After any result response
			// ========================================
			// Generate a title using Haiku if we haven't already
			if (!this.session.metadata.titleGenerated) {
				this.logger.log('Auto-generating session title...');

				// Get messages to find first user and assistant messages
				const messages = this.db.getSDKMessages(this.session.id, 10);
				const firstUserMsg = messages.find((m) => m.type === 'user');
				const firstAssistantMsg = messages.find((m) => isSDKAssistantMessage(m));

				if (firstUserMsg && firstAssistantMsg) {
					try {
						const generatedTitle = await generateTitle(firstUserMsg, firstAssistantMsg);
						if (generatedTitle) {
							// Update session title and flag in memory and database
							this.session.title = generatedTitle;
							this.session.metadata.titleGenerated = true;

							this.db.updateSession(this.session.id, {
								title: generatedTitle,
								metadata: this.session.metadata,
							});

							// Emit session:updated event so StateManager broadcasts the change
							await this.eventBus.emit('session:updated', {
								sessionId: this.session.id,
								updates: { title: generatedTitle },
							});

							this.logger.log(`Session title updated to: "${generatedTitle}"`);
						}
					} catch (error) {
						// Don't throw - title generation is non-critical
						this.logger.warn('Failed to generate session title:', error);
					}
				}
			}
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

		// ========================================
		// COMPACTION EVENTS: Detect and emit compaction start/end
		// ========================================
		// Status message with status='compacting' indicates compaction is in progress
		if (isSDKStatusMessage(sdkMessage)) {
			const statusMsg = sdkMessage as { status: string | null };
			if (statusMsg.status === 'compacting') {
				this.logger.log('Context compaction started (auto)');
				await this.eventBus.emit('context:compacting', {
					sessionId: this.session.id,
					trigger: 'auto' as const, // Status messages are from auto-compaction
				});
			}
		}

		// Compact boundary message indicates compaction completed
		if (isSDKCompactBoundary(sdkMessage)) {
			const compactMsg = sdkMessage as {
				compact_metadata: {
					trigger: 'manual' | 'auto';
					pre_tokens: number;
				};
			};
			this.logger.log(
				`Context compaction completed (${compactMsg.compact_metadata.trigger}), ` +
					`pre-tokens: ${compactMsg.compact_metadata.pre_tokens}`
			);
			await this.eventBus.emit('context:compacted', {
				sessionId: this.session.id,
				trigger: compactMsg.compact_metadata.trigger,
				preTokens: compactMsg.compact_metadata.pre_tokens,
			});
		}
	}

	/**
	 * Handle interrupt request - uses official SDK interrupt() method
	 * Called by RPC handler in session-handlers.ts
	 *
	 * Edge cases handled:
	 * - Already idle: no-op, returns immediately
	 * - Queued state: clears queue and returns to idle
	 * - Processing state: calls SDK interrupt() and clears queue
	 * - Multiple rapid calls: idempotent, safe to call multiple times
	 */
	async handleInterrupt(): Promise<void> {
		const currentState = this.processingState;
		this.logger.log(`Handling interrupt (current state: ${currentState.status})...`);

		// Edge case: already idle or interrupted - no-op
		if (currentState.status === 'idle' || currentState.status === 'interrupted') {
			this.logger.log(`Already ${currentState.status}, skipping interrupt`);
			return;
		}

		// Set state to 'interrupted' immediately for UI feedback
		await this.setProcessingState({ status: 'interrupted' });

		// Clear pending messages in queue (not yet sent to SDK)
		const queuedCount = this.messageQueue.length;
		if (queuedCount > 0) {
			this.logger.log(`Clearing ${queuedCount} queued messages`);
			for (const msg of this.messageQueue) {
				msg.reject(new Error('Interrupted by user'));
			}
			this.messageQueue = [];
		}

		// Use official SDK interrupt() method if query is running
		// This gracefully stops the current turn without killing the query
		if (this.queryObject && typeof this.queryObject.interrupt === 'function') {
			try {
				this.logger.log(`Calling SDK interrupt()...`);
				await this.queryObject.interrupt();
				this.logger.log(`SDK interrupt() completed successfully`);
			} catch (error) {
				// Log error but don't throw - interrupt is best-effort
				// SDK might have already completed when we called interrupt
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.logger.warn(`SDK interrupt() failed (may be expected):`, errorMessage);
			}
		} else {
			// Query not started yet - just clearing queue is enough
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
		await this.setProcessingState({ status: 'idle' });
		this.logger.log(`Interrupt complete, state reset to idle`);
	}

	/**
	 * Switch to a different Claude model mid-session
	 * Called by RPC handler in session-handlers.ts
	 *
	 * Uses Claude Agent SDK's native setModel() method for seamless model switching
	 * without interrupting the streaming query or losing state.
	 *
	 * This will:
	 * 1. Validate the new model
	 * 2. Use SDK's setModel() to switch models (streaming input mode only)
	 * 3. Update session config in database
	 * 4. Preserve all query state and conversation history
	 */
	async handleModelSwitch(
		newModel: string
	): Promise<{ success: boolean; model: string; error?: string }> {
		this.logger.log(`Handling model switch to: ${newModel}`);

		try {
			// Validate the model (async - checks against SDK models)
			const isValid = await isValidModel(newModel);
			if (!isValid) {
				const error = `Invalid model: ${newModel}. Use a valid model ID or alias.`;
				this.logger.error(`${error}`);
				return { success: false, model: this.session.config.model, error };
			}

			// Resolve alias to full model ID (async - uses SDK models)
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

				// Emit session:updated event so StateManager broadcasts the change
				await this.eventBus.emit('session:updated', {
					sessionId: this.session.id,
					updates: { config: this.session.config },
				});
			} else {
				// Use SDK's native setModel() method (only available in streaming input mode)
				this.logger.log(`Using SDK setModel() to switch to: ${resolvedModel}`);
				await this.queryObject.setModel(resolvedModel);

				// Update session config in database
				this.session.config.model = resolvedModel;
				this.db.updateSession(this.session.id, {
					config: this.session.config,
				});

				// Emit session:updated event so StateManager broadcasts the change
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
	 * Get current model information
	 */
	/**
	 * Get current model ID for this session
	 * Note: This returns the model ID synchronously. To get full model info,
	 * use the model-service.getModelInfo() function asynchronously.
	 */
	getCurrentModel(): CurrentModelInfo {
		return {
			id: this.session.config.model,
			info: null, // Model info is fetched asynchronously by RPC handler
		};
	}

	/**
	 * Get SDK messages for this session
	 *
	 * @param limit - Maximum number of messages to return
	 * @param before - Cursor: get messages older than this timestamp (milliseconds)
	 * @param since - Get messages newer than this timestamp (milliseconds)
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
		if (updates.metadata) this.session.metadata = updates.metadata;
		if (updates.config) {
			this.session.config = { ...this.session.config, ...updates.config };
		}

		this.db.updateSession(this.session.id, updates);
	}

	/**
	 * Abort current query (delegates to handleInterrupt)
	 * @deprecated Use handleInterrupt() instead
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

		// Clear models cache for this session
		try {
			const { clearModelsCache } = await import('./model-service');
			clearModelsCache(this.session.id);
		} catch {
			// Ignore - not critical
		}

		// Signal query to stop
		this.queryRunning = false;

		// Interrupt query using SDK method (best-effort, don't wait)
		if (this.queryObject && typeof this.queryObject.interrupt === 'function') {
			try {
				// Don't await - this is cleanup, we want it to be fast
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
