import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { UUID } from 'crypto';
import type {
	AgentProcessingState,
	MessageContent,
	MessageImage,
	Session,
	ContextInfo,
} from '@liuboer/shared';
import type { EventBus, MessageHub, CurrentModelInfo } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import type { SDKMessage, SDKUserMessage, SlashCommand } from '@liuboer/shared/sdk';
import { Database } from '../storage/database';
import { ErrorCategory, ErrorManager } from './error-manager';
import { Logger } from './logger';
import { isValidModel, resolveModelAlias, getModelInfo } from './model-service';
import { SettingsManager } from './settings-manager';

// New extracted components
import { MessageQueue } from './message-queue';
import { ProcessingStateManager } from './processing-state-manager';
import { ContextTracker } from './context-tracker';
import { SDKMessageHandler } from './sdk-message-handler';
import { expandBuiltInCommand, getBuiltInCommandNames } from './built-in-commands';

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

	// Pending restart flag - tracks if restart is needed after agent becomes idle
	// Reason: 'settings.local.json' when MCP configuration changed
	private pendingRestartReason: 'settings.local.json' | null = null;

	// Error manager for structured error handling
	private errorManager: ErrorManager;

	// Session-specific settings manager (created per-session for worktree isolation)
	private settingsManager: SettingsManager;

	private logger: Logger;

	constructor(
		private session: Session,
		private db: Database,
		private messageHub: MessageHub,
		private eventBus: EventBus,
		private getApiKey: () => Promise<string | null>
	) {
		// Initialize error manager and logger (with EventBus for internal events)
		this.errorManager = new ErrorManager(this.messageHub, this.eventBus);
		this.logger = new Logger(`AgentSession ${session.id}`);

		// CRITICAL: Create session-specific SettingsManager with session's workspace path
		// This ensures worktree sessions write settings to their own .claude/settings.local.json
		// instead of the root workspace (fixes worktree isolation bug)
		this.settingsManager = new SettingsManager(this.db, this.session.workspacePath);

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

		// Set callback to execute deferred restarts when agent becomes idle
		this.stateManager.setOnIdleCallback(async () => {
			await this.executeDeferredRestartIfPending();
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
	 * Check and execute deferred restart if pending
	 *
	 * Called after agent becomes idle to check if there's a pending restart.
	 * This is invoked from the message processing loop when state transitions to idle.
	 */
	private async executeDeferredRestartIfPending(): Promise<void> {
		// If no pending restart, nothing to do
		if (!this.pendingRestartReason) {
			return;
		}

		const reason = this.pendingRestartReason;
		this.pendingRestartReason = null; // Clear flag before executing

		this.logger.log(`Agent became idle, executing deferred restart (reason: ${reason})`);

		try {
			await this.doActualRestart();
			this.logger.log(`Deferred restart completed successfully (${reason})`);
		} catch (error) {
			this.logger.error(`Deferred restart failed (${reason}):`, error);
			// Don't re-throw - already logged
		}
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

			// Add SDK built-in commands that SDK supports but doesn't advertise
			const sdkBuiltInCommands = ['clear', 'help'];
			// Add Liuboer built-in commands
			const liuboerBuiltInCommands = getBuiltInCommandNames();
			const allCommands = [
				...new Set([...commandNames, ...sdkBuiltInCommands, ...liuboerBuiltInCommands]),
			];

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
	 * Persist user message to DB and publish to UI immediately (instant UX)
	 * Does NOT start SDK query - caller must call startQueryAndEnqueue() separately
	 * after workspace initialization is complete.
	 *
	 * @returns messageId and processed message content for later enqueuing
	 */
	async persistUserMessage(data: {
		content: string;
		images?: MessageImage[];
	}): Promise<{ messageId: string; messageContent: string | MessageContent[] }> {
		let { content, images } = data;

		// Expand built-in commands to their full prompts
		const expandedContent = expandBuiltInCommand(content);
		if (expandedContent) {
			this.logger.log(`Expanding built-in command: ${content.trim()}`);
			content = expandedContent;
		}

		const messageContent = this.buildMessageContent(content, images);
		const messageId = generateUUID();

		// Create SDK user message
		const sdkUserMessage: SDKUserMessage = {
			type: 'user' as const,
			uuid: messageId as UUID,
			session_id: this.session.id,
			parent_tool_use_id: null,
			message: {
				role: 'user' as const,
				content:
					typeof messageContent === 'string'
						? [{ type: 'text' as const, text: messageContent }]
						: messageContent,
			},
		};

		// Save to database
		this.db.saveSDKMessage(this.session.id, sdkUserMessage);

		// Publish to UI immediately via state.sdkMessages.delta (fire-and-forget to avoid blocking RPC)
		// This prevents "Message send timed out" errors when WebSocket is slow
		this.messageHub
			.publish(
				'state.sdkMessages.delta',
				{ added: [sdkUserMessage], timestamp: Date.now() },
				{ sessionId: this.session.id }
			)
			.catch(async (err) => {
				this.logger.error('Failed to publish user message to UI:', err);
				// Report to UI via error manager (non-fatal warning)
				await this.errorManager.handleError(
					this.session.id,
					err as Error,
					ErrorCategory.CONNECTION,
					'Failed to display your message in real-time. The message was saved and will be processed.',
					this.stateManager.getState()
				);
			});

		this.logger.log(`User message ${messageId} persisted and publishing to UI`);

		return { messageId, messageContent };
	}

	/**
	 * Start SDK query (if not started) and enqueue message for processing
	 * Call this AFTER workspace initialization is complete to ensure
	 * the SDK query uses the correct worktree path as cwd.
	 */
	async startQueryAndEnqueue(
		messageId: string,
		messageContent: string | MessageContent[]
	): Promise<void> {
		// Lazy start the query (uses correct worktree path now)
		await this.ensureQueryStarted();

		// Set state to 'queued'
		await this.stateManager.setQueued(messageId);

		// Enqueue for SDK processing (fire-and-forget)
		this.messageQueue.enqueueWithId(messageId, messageContent).catch(async (error) => {
			if (error instanceof Error && error.message === 'Interrupted by user') {
				this.logger.log(`Message ${messageId} interrupted by user`);
			} else {
				this.logger.error(`Queue error for message ${messageId}:`, error);

				// Determine error category and user message based on error type
				const isTimeoutError = error instanceof Error && error.name === 'MessageQueueTimeoutError';
				const category = isTimeoutError ? ErrorCategory.TIMEOUT : ErrorCategory.MESSAGE;
				const userMessage = isTimeoutError
					? 'The SDK is not responding. This may be due to an internal SDK error. Click "Reset Agent" in the menu to recover, or try again.'
					: 'Failed to process message. Please try again.';

				await this.errorManager.handleError(
					this.session.id,
					error as Error,
					category,
					userMessage,
					this.stateManager.getState(),
					{ messageId }
				);

				// On timeout, attempt auto-recovery by resetting the query
				if (isTimeoutError) {
					this.logger.log(`Auto-recovering from timeout by resetting query...`);
					try {
						await this.resetQuery({ restartQuery: true });
						this.logger.log(`Auto-recovery from timeout successful`);

						// Re-enqueue the timed-out message so user doesn't have to re-send
						this.logger.log(`Re-enqueuing timed-out message ${messageId}...`);
						await this.stateManager.setQueued(messageId);
						this.messageQueue.enqueueWithId(messageId, messageContent).catch(async (retryError) => {
							this.logger.error(`Retry of message ${messageId} also failed:`, retryError);
							await this.stateManager.setIdle();
						});
					} catch (resetError) {
						this.logger.error(`Auto-recovery from timeout failed:`, resetError);
						await this.stateManager.setIdle();
					}
				} else {
					await this.stateManager.setIdle();
				}
			}
		});

		// Emit event for title generation (decoupled via EventBus)
		this.eventBus.emit('message:sent', { sessionId: this.session.id }).catch((err) => {
			this.logger.warn('Failed to emit message:sent event:', err);
		});
	}

	/**
	 * Persist user message to DB and UI, then queue for SDK processing
	 *
	 * This method provides instant user feedback by saving and publishing the message
	 * BEFORE any long-running operations (workspace init, SDK processing, etc.)
	 *
	 * UX Flow:
	 * 1. Generate message ID
	 * 2. Save to DB and publish to UI (<10ms) ← User sees message instantly
	 * 3. Set processing state to 'queued'
	 * 4. Enqueue for SDK processing (may block on workspace init)
	 *
	 * @returns Promise<{ messageId: string }>
	 */
	async persistAndQueueMessage(data: {
		content: string;
		images?: MessageImage[];
	}): Promise<{ messageId: string }> {
		try {
			// Lazy start the query on first message
			await this.ensureQueryStarted();

			let { content, images } = data;

			// Expand built-in commands to their full prompts
			const expandedContent = expandBuiltInCommand(content);
			if (expandedContent) {
				this.logger.log(`Expanding built-in command: ${content.trim()}`);
				content = expandedContent;
			}

			const messageContent = this.buildMessageContent(content, images);

			// Generate message ID early
			const messageId = generateUUID();

			// STEP 1: Create and persist the SDK user message IMMEDIATELY
			// This ensures instant UI feedback before any blocking operations
			const sdkUserMessage: SDKUserMessage = {
				type: 'user' as const,
				uuid: messageId as UUID,
				session_id: this.session.id,
				parent_tool_use_id: null,
				message: {
					role: 'user' as const,
					content:
						typeof messageContent === 'string'
							? [{ type: 'text' as const, text: messageContent }]
							: messageContent,
				},
			};

			// Save to database
			this.db.saveSDKMessage(this.session.id, sdkUserMessage);

			// Publish to UI immediately via state.sdkMessages.delta
			await this.messageHub.publish(
				'state.sdkMessages.delta',
				{ added: [sdkUserMessage], timestamp: Date.now() },
				{ sessionId: this.session.id }
			);

			this.logger.log(`User message ${messageId} persisted and published for instant UI display`);

			// STEP 2: Set state to 'queued' and enqueue for processing
			await this.stateManager.setQueued(messageId);

			// Enqueue for SDK processing (fire-and-forget)
			// NOTE: Message is already saved to DB and published to UI above.
			// We don't await here to prevent RPC timeout - SDK processing can take
			// longer than the RPC timeout (10s default). Errors are handled via .catch().
			this.messageQueue.enqueueWithId(messageId, messageContent).catch(async (error) => {
				// Handle queue errors (e.g., interrupted by user, timeout)
				// Don't log "Interrupted by user" as error - it's expected behavior
				if (error instanceof Error && error.message === 'Interrupted by user') {
					this.logger.log(`Message ${messageId} interrupted by user`);
				} else {
					// Surface non-interrupt errors to the UI
					this.logger.error(`Queue error for message ${messageId}:`, error);

					// Determine error category and user message based on error type
					const isTimeoutError =
						error instanceof Error && error.name === 'MessageQueueTimeoutError';
					const category = isTimeoutError ? ErrorCategory.TIMEOUT : ErrorCategory.MESSAGE;
					const userMessage = isTimeoutError
						? 'The SDK is not responding. This may be due to an internal SDK error. Click "Reset Agent" in the menu to recover, or try again.'
						: 'Failed to process message. Please try again.';

					await this.errorManager.handleError(
						this.session.id,
						error as Error,
						category,
						userMessage,
						this.stateManager.getState(),
						{ messageId }
					);

					// On timeout, attempt auto-recovery by resetting the query
					// This terminates the stuck query and starts a fresh one
					if (isTimeoutError) {
						this.logger.log(`Auto-recovering from timeout by resetting query...`);
						try {
							await this.resetQuery({ restartQuery: true });
							this.logger.log(`Auto-recovery from timeout successful`);

							// Re-enqueue the timed-out message so user doesn't have to re-send
							// The message is already saved to DB and shown in UI
							this.logger.log(`Re-enqueuing timed-out message ${messageId}...`);
							await this.stateManager.setQueued(messageId);
							// Fire-and-forget: don't await to avoid nested timeout handling
							this.messageQueue
								.enqueueWithId(messageId, messageContent)
								.catch(async (retryError) => {
									// If retry also fails, just log and reset to idle
									// Don't infinite loop - user can manually click Reset Agent
									this.logger.error(`Retry of message ${messageId} also failed:`, retryError);
									await this.stateManager.setIdle();
								});
						} catch (resetError) {
							this.logger.error(`Auto-recovery from timeout failed:`, resetError);
							// Reset to idle anyway so user can try manually
							await this.stateManager.setIdle();
						}
					} else {
						// Reset state to idle so user can retry
						await this.stateManager.setIdle();
					}
				}
			});

			// Emit event for title generation (decoupled via EventBus)
			this.eventBus.emit('message:sent', { sessionId: this.session.id }).catch((err) => {
				this.logger.warn('Failed to emit message:sent event:', err);
			});

			return { messageId };
		} catch (error) {
			this.logger.error(`Error in persistAndQueueMessage:`, error);

			const processingState = this.stateManager.getState();
			await this.stateManager.setIdle();

			await this.errorManager.handleError(
				this.session.id,
				error as Error,
				ErrorCategory.MESSAGE,
				'Failed to send message. Please try again.',
				processingState
			);
			throw error;
		}
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
	 * Called by RPC handler in session-handlers.ts or directly by tests
	 */
	async handleMessageSend(data: {
		content: string;
		images?: MessageImage[];
	}): Promise<{ messageId: string }> {
		try {
			// TITLE GENERATION: Trigger async title generation on first message
			// This handles direct calls (e.g., tests) that bypass the RPC handler.
			// The RPC path handles this via the user-message:persisted event handler,
			// but direct calls need to trigger title generation here.
			// NOTE: Workspace (worktree) is already created during session creation,
			// so this only triggers title generation and branch renaming.
			if (!this.session.metadata.titleGenerated) {
				this.logger.log(`Triggering title generation for first message...`);
				const userMessageText = typeof data.content === 'string' ? data.content : '';
				// Emit event with skipQueryStart=true since we handle query start below
				// Fire-and-forget: title generation runs in parallel with SDK query
				this.eventBus
					.emit('user-message:persisted', {
						sessionId: this.session.id,
						messageId: '', // Will be generated below
						messageContent: data.content,
						userMessageText,
						needsWorkspaceInit: true, // Signals first message - triggers title generation
						hasDraftToClear: false,
						skipQueryStart: true,
					})
					.catch((error) => {
						this.logger.log(`Title generation failed (non-fatal): ${error}`);
					});
				// Note: We don't await or refresh session here anymore
				// Title generation runs in parallel and updates session asynchronously
			}

			// LAZY START: Start the query on first message
			await this.ensureQueryStarted();

			let { content, images } = data;

			// Expand built-in commands to their full prompts
			const expandedContent = expandBuiltInCommand(content);
			if (expandedContent) {
				this.logger.log(`Expanding built-in command: ${content.trim()}`);
				content = expandedContent;
			}

			const messageContent = this.buildMessageContent(content, images);

			// Generate message ID before enqueuing so we can set state BEFORE the message starts processing
			const messageId = generateUUID();

			// Save user message to DB BEFORE enqueuing (required for title generation and persistence)
			const sdkUserMessage: SDKUserMessage = {
				type: 'user' as const,
				uuid: messageId as UUID,
				session_id: this.session.id,
				parent_tool_use_id: null,
				message: {
					role: 'user' as const,
					content:
						typeof messageContent === 'string'
							? [{ type: 'text' as const, text: messageContent }]
							: messageContent,
				},
			};
			this.db.saveSDKMessage(this.session.id, sdkUserMessage);

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

			// Capture processing state before reset for error context
			const processingState = this.stateManager.getState();

			// Reset state to idle on error to prevent session from getting stuck
			await this.stateManager.setIdle();

			await this.errorManager.handleError(
				this.session.id,
				error as Error,
				ErrorCategory.MESSAGE,
				'Failed to send message. Please try again.',
				processingState
			);
			throw error;
		}
	}

	/**
	 * Handle API validation errors (400-level) by displaying them as assistant messages
	 * Returns true if the error was handled, false otherwise
	 */
	private async handleApiValidationError(error: unknown): Promise<boolean> {
		try {
			const errorMessage = error instanceof Error ? error.message : String(error);

			// Check if this looks like an API error (starts with status code)
			// Format: "400 {...}" or "422 {...}"
			const apiErrorMatch = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);
			if (!apiErrorMatch) {
				return false; // Not an API error
			}

			const [, statusCode, jsonBody] = apiErrorMatch;

			// Try to parse the JSON error body
			let errorBody: { type?: string; error?: { type?: string; message?: string } };
			try {
				errorBody = JSON.parse(jsonBody);
			} catch {
				return false; // Invalid JSON
			}

			// Extract the error message
			const apiErrorMessage = errorBody.error?.message || errorMessage;
			const apiErrorType = errorBody.error?.type || 'api_error';

			this.logger.log(`Handling API validation error as assistant message: ${statusCode}`);

			// Create a synthetic assistant message to display the error in chat
			const assistantMessage: Extract<SDKMessage, { type: 'assistant' }> = {
				type: 'assistant' as const,
				uuid: generateUUID() as UUID,
				session_id: this.session.id,
				parent_tool_use_id: null,
				error: 'invalid_request' as const, // Mark this as an error message
				message: {
					role: 'assistant' as const,
					content: [
						{
							type: 'text' as const,
							text: `**API Error (${statusCode})**: ${apiErrorType}

${apiErrorMessage}

This error occurred while processing your request. Please review the error message above and adjust your request accordingly.`,
						},
					],
				},
			};

			// Save to database
			this.db.saveSDKMessage(this.session.id, assistantMessage);

			// Broadcast to UI via state.sdkMessages.delta
			await this.messageHub.publish(
				'state.sdkMessages.delta',
				{ added: [assistantMessage], timestamp: Date.now() },
				{ sessionId: this.session.id }
			);

			this.logger.log(`API validation error displayed as assistant message`);
			return true; // Error was handled
		} catch (err) {
			// If anything goes wrong, let the caller handle it as a system error
			this.logger.warn(`Failed to handle API validation error:`, err);
			return false;
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
					ErrorCategory.AUTHENTICATION,
					undefined, // userMessage - will use default
					this.stateManager.getState()
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

			// Build query options based on tools config
			const toolsConfig = this.session.config.tools;

			// ============================================================================
			// System Prompt Configuration
			// SDK option: systemPrompt
			// ============================================================================
			// Build system prompt based on useClaudeCodePreset config
			// When true: Use Claude Code preset with optional worktree append
			// When false: Use minimal system prompt (or undefined to let SDK use default)
			let systemPromptConfig: Options['systemPrompt'];

			// Check if Claude Code preset is enabled (default: true for backward compat)
			const useClaudeCodePreset = toolsConfig?.useClaudeCodePreset ?? true;

			if (useClaudeCodePreset) {
				systemPromptConfig = {
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
			} else {
				// No Claude Code preset - use minimal system prompt or undefined
				// When worktree is used, still append isolation instructions
				if (this.session.worktree) {
					systemPromptConfig = `
You are an AI assistant helping with coding tasks.

IMPORTANT: Git Worktree Isolation

This session is running in an isolated git worktree at:
${this.session.worktree.worktreePath}

Branch: ${this.session.worktree.branch}
Main repository: ${this.session.worktree.mainRepoPath}

CRITICAL RULES:
1. ALL file operations MUST stay within the worktree directory: ${this.session.worktree.worktreePath}
2. NEVER modify files in the main repository at: ${this.session.worktree.mainRepoPath}
3. Your current working directory (cwd) is already set to the worktree path
`.trim();
				}
				// If no worktree, systemPromptConfig remains undefined (SDK default behavior)
			}

			// ============================================================================
			// Tool Configuration
			// ============================================================================
			// CRITICAL: Use disallowedTools to REMOVE tools from context (saves tokens)
			// vs allowedTools which only auto-approves tools (they're still in context!)
			//
			// SDK docs:
			// - allowedTools: "auto-allowed without prompting for permission" (still in context)
			// - disallowedTools: "removed from the model's context" (actually removes them)
			//
			// Strategy:
			// - MCP tools: Controlled via file-based settings (disabledMcpServers → settings.local.json)
			// - SDK built-in tools: Always enabled (not configurable)
			// - Liuboer tools: Based on liuboerTools config

			const disallowedTools: string[] = [];

			// MCP Tools: Controlled via file-based settings (disabledMcpServers)
			// SDK reads .claude/settings.local.json and applies filtering automatically
			// No disallowedTools needed for MCP - SDK handles it via disabledMcpjsonServers

			// Disable Liuboer memory tool if not enabled
			if (!toolsConfig?.liuboerTools?.memory) {
				disallowedTools.push('liuboer__memory__*');
			}

			// ============================================================================
			// Setting Sources Configuration
			// SDK option: settingSources
			// ============================================================================
			// Determine setting sources: include 'project' if setting sources loading is enabled
			// This controls CLAUDE.md and .claude/settings.json loading
			// Note: loadSettingSources replaces the old loadProjectSettings for clarity
			const loadSettingSources = toolsConfig?.loadSettingSources ?? true;
			const settingSources: Options['settingSources'] = loadSettingSources
				? ['project', 'local']
				: ['local'];

			// ============================================================================
			// MCP Servers Configuration (Direct 1:1 UI→SDK Mapping)
			// ============================================================================
			// MCP server enable/disable is controlled via file-based settings:
			// - disabledMcpServers → written to .claude/settings.local.json as disabledMcpjsonServers
			// - SDK reads this file at query initialization time
			// - Always let SDK auto-load from .mcp.json, filtering applied via settings.local.json
			//
			// mcpServers option is always undefined to allow SDK auto-loading
			const mcpServers: Options['mcpServers'] = undefined;

			// ============================================================================
			// Prepare Settings (File-only + SDK Options)
			// ============================================================================
			// This writes file-only settings to .claude/settings.local.json and returns
			// SDK-supported options to merge with query options
			// IMPORTANT: Pass session's disabledMcpServers so it gets written to the file
			const sdkSettingsOptions = await this.settingsManager.prepareSDKOptions({
				disabledMcpServers: toolsConfig?.disabledMcpServers ?? [],
			});

			// ============================================================================
			// Worktree Directory Isolation
			// ============================================================================
			// For worktree sessions: Restrict SDK file access to ONLY the worktree directory
			// This prevents the agent from accidentally modifying files in the main repo
			// or accessing files outside the worktree boundary
			//
			// SDK option: additionalDirectories
			// - undefined (default): SDK can access any file on the system
			// - [] (empty array): SDK can ONLY access files within cwd
			//
			// Strategy:
			// - Worktree sessions: Set to [] to enforce strict isolation
			// - Non-worktree sessions: Leave undefined for backward compatibility
			const additionalDirectories: string[] | undefined = this.session.worktree ? [] : undefined;

			// ============================================================================
			// Build Final Query Options
			// ============================================================================
			// First merge settings-derived options, then override with session-specific options
			// Session-specific options take precedence over global settings
			const queryOptions: Options = {
				// Start with settings-derived options (from global settings)
				...sdkSettingsOptions,
				// Override with session-specific options (these take precedence)
				model: this.session.config.model, // Session model always wins
				cwd: this.session.worktree
					? this.session.worktree.worktreePath
					: this.session.workspacePath,
				additionalDirectories, // Enforce worktree isolation
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
				maxTurns: Infinity,
				settingSources, // Session settingSources always wins
				systemPrompt: systemPromptConfig,
				disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
				mcpServers,
			};

			// DEBUG: Log query options for verification
			this.logger.log(`[AgentSession ${this.session.id}] Query options:`, {
				model: queryOptions.model,
				useClaudeCodePreset,
				settingSources: queryOptions.settingSources,
				disallowedTools: queryOptions.disallowedTools,
				mcpServers: queryOptions.mcpServers === undefined ? 'auto-load' : 'disabled',
				additionalDirectories:
					queryOptions.additionalDirectories === undefined
						? 'unrestricted'
						: `restricted to cwd (${queryOptions.additionalDirectories.length} additional dirs)`,
				toolsConfig,
			});

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

					// Capture state before reset
					const processingState = this.stateManager.getState();

					// Reset state to idle on message handling error
					await this.stateManager.setIdle();

					// Report error with rich context
					await this.errorManager.handleError(
						this.session.id,
						error as Error,
						ErrorCategory.MESSAGE,
						'Error processing SDK message. The session has been reset.',
						processingState,
						{
							messageType: (message as SDKMessage).type,
						}
					);
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
				// Check if this is an API validation error (400-level errors)
				// These should be displayed in chat as assistant messages, not as system errors
				const apiErrorHandled = await this.handleApiValidationError(error);

				if (!apiErrorHandled) {
					// Not an API validation error - handle as system error
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

					// Capture state before reset
					const processingState = this.stateManager.getState();

					await this.errorManager.handleError(
						this.session.id,
						error as Error,
						category,
						undefined, // userMessage - will use default
						processingState,
						{
							errorMessage,
							queueSize: this.messageQueue.size(),
						}
					);
				}

				// Reset state to idle on error
				await this.stateManager.setIdle();
			}
		} finally {
			this.messageQueue.stop();

			// Ensure state is reset to idle when streaming stops (normal or error)
			await this.stateManager.setIdle();

			this.logger.log(`Streaming query stopped`);
		}
	}

	/**
	 * Create wrapper for MessageQueue's AsyncGenerator
	 * Updates processing state and yields messages to SDK
	 *
	 * NOTE: User messages are now saved to DB and published to UI in persistAndQueueMessage()
	 * BEFORE being enqueued. This wrapper only handles state transitions and yielding to SDK.
	 *
	 * Internal messages (like automatic /context fetching) are NOT saved or published - they're
	 * invisible background operations.
	 */
	private async *createMessageGeneratorWrapper() {
		for await (const { message, onSent } of this.messageQueue.messageGenerator(this.session.id)) {
			// Check if this is an internal message (e.g., automatic /context command)
			const queuedMessage = message as typeof message & { internal?: boolean };
			const isInternal = queuedMessage.internal || false;

			// Internal messages are NOT saved to DB or published to UI
			// They're invisible background operations (e.g., automatic /context fetching)
			// Regular user messages are already saved in persistAndQueueMessage()

			// Update state to 'processing' in 'initializing' phase
			// Skip state update for internal messages to avoid UI flicker
			if (!isInternal) {
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

		// Mark successful API interaction (resets connection error count)
		await this.errorManager.markApiSuccess();
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

				// Emit session:updated event - include data for decoupled state management
				await this.eventBus.emit('session:updated', {
					sessionId: this.session.id,
					source: 'model-switch',
					session: { config: this.session.config },
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

				// Emit session:updated event - include data for decoupled state management
				await this.eventBus.emit('session:updated', {
					sessionId: this.session.id,
					source: 'model-switch',
					session: { config: this.session.config },
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
				`Failed to switch model: ${errorMessage}`,
				this.stateManager.getState(),
				{
					requestedModel: newModel,
					currentModel: this.session.config.model,
				}
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
	 * Get the SDK session ID from the query object
	 * This is used to locate the .jsonl file in ~/.claude/projects/
	 */
	getSDKSessionId(): string | null {
		if (!this.queryObject || !('sessionId' in this.queryObject)) {
			return null;
		}
		return this.queryObject.sessionId as string;
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
			// CRITICAL: Recreate SettingsManager with new workspace path
			// This ensures worktree sessions write settings to correct location
			this.settingsManager = new SettingsManager(this.db, updates.workspacePath);
			this.logger.log(`Updated SettingsManager workspacePath to: ${updates.workspacePath}`);
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
		// Handle archivedAt field for archived sessions
		if (updates.archivedAt !== undefined) {
			this.session.archivedAt = updates.archivedAt;
		}
		// Handle worktree field updates (including clearing worktree on archive)
		if (updates.worktree !== undefined) {
			this.session.worktree = updates.worktree;
		}

		this.db.updateSession(this.session.id, updates);
	}

	/**
	 * Update tools configuration and restart query to apply changes
	 *
	 * This is a blocking operation that:
	 * 1. Updates session config in memory and DB
	 * 2. Stops the current query (if running)
	 * 3. Restarts the query with new config
	 *
	 * Timeout: 10 seconds for the entire operation
	 */
	async updateToolsConfig(
		tools: Session['config']['tools']
	): Promise<{ success: boolean; error?: string }> {
		try {
			this.logger.log(`Updating tools config:`, tools);

			// 1. Update session config in memory and DB
			const newConfig = { ...this.session.config, tools };
			this.session.config = newConfig;
			this.db.updateSession(this.session.id, { config: newConfig });

			// 2. Write MCP settings to .claude/settings.local.json (file-based approach)
			// Then restart query to reload settings (SDK only reads settings at initialization)
			if (tools?.disabledMcpServers !== undefined) {
				this.logger.log(
					`Writing disabledMcpServers to settings.local.json:`,
					tools.disabledMcpServers
				);
				await this.settingsManager.setDisabledMcpServers(tools.disabledMcpServers);

				// Restart query to reload MCP settings (SDK only reads settings files at query init)
				await this.restartQuery();
			}

			// 3. Queue /context to get updated context breakdown (if query is running)
			// This shows the user what changed in their tools
			if (this.messageQueue.isRunning()) {
				try {
					this.logger.log(`Queuing /context for updated context breakdown...`);
					await this.messageQueue.enqueue('/context', true);
				} catch (contextError) {
					// Non-critical - just log the error
					this.logger.warn(`Failed to queue /context after tools update:`, contextError);
				}
			}

			// 4. Emit event for StateManager to broadcast updated session state
			// Include data for decoupled state management
			await this.eventBus.emit('session:updated', {
				sessionId: this.session.id,
				source: 'config',
				session: { config: this.session.config },
			});

			this.logger.log(`Tools config updated successfully`);
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.logger.error(`Failed to update tools config:`, error);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Restart SDK query to reload settings from .claude/settings.local.json
	 *
	 * This is necessary when MCP configuration changes (enabling/disabling servers)
	 * because the SDK only reads settings files at query initialization time.
	 *
	 * Smart restart strategy:
	 * - If agent is IDLE: Restart immediately
	 * - If agent is PROCESSING: Queue restart, execute when agent becomes idle
	 *
	 * This ensures we never interrupt active agent responses.
	 */
	private async restartQuery(): Promise<void> {
		this.logger.log(`Restart requested to reload settings.local.json`);

		// If query hasn't started yet, no need to restart
		if (!this.messageQueue.isRunning() || !this.queryObject) {
			this.logger.log(`Query not running, skipping restart`);
			return;
		}

		// Check current processing state
		const currentState = this.stateManager.getState();

		// If agent is actively processing, queue the restart for later
		if (currentState.status === 'processing') {
			this.logger.log(
				`Agent is processing (phase: ${currentState.phase}), queuing restart for when idle`
			);
			this.pendingRestartReason = 'settings.local.json';
			return;
		}

		// Agent is idle or queued, restart immediately
		this.logger.log(`Agent is ${currentState.status}, restarting immediately`);
		await this.doActualRestart();
	}

	/**
	 * Execute the actual query restart
	 *
	 * This method does the heavy lifting:
	 * 1. Stop the message queue
	 * 2. Interrupt current query
	 * 3. Wait for termination
	 * 4. Clear query object
	 * 5. Start fresh query (SDK re-reads settings.local.json)
	 */
	private async doActualRestart(): Promise<void> {
		this.logger.log(`Executing query restart...`);

		try {
			// 1. Stop the message queue (no new messages processed)
			this.messageQueue.stop();
			this.logger.log(`Message queue stopped`);

			// 2. Interrupt current query using SDK method
			if (this.queryObject && typeof this.queryObject.interrupt === 'function') {
				try {
					await this.queryObject.interrupt();
					this.logger.log(`Query interrupted successfully`);
				} catch (interruptError) {
					this.logger.warn(`Query interrupt failed:`, interruptError);
					// Continue - query might already be stopped
				}
			}

			// 3. Wait for query promise to resolve (with timeout)
			if (this.queryPromise) {
				try {
					await Promise.race([
						this.queryPromise,
						new Promise((resolve) => setTimeout(resolve, 5000)), // 5s timeout
					]);
					this.logger.log(`Previous query terminated`);
				} catch (error) {
					this.logger.warn(`Error waiting for query termination:`, error);
				}
			}

			// 4. Clear query object and promise
			this.queryObject = null;
			this.queryPromise = null;

			// 5. Start new query (SDK will re-read settings.local.json)
			// This calls runQuery() which creates a fresh query with updated MCP settings
			await this.startStreamingQuery();

			this.logger.log(`Query restarted successfully with fresh MCP settings`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.logger.error(`Failed to restart query:`, error);
			throw new Error(`Query restart failed: ${errorMessage}`);
		}
	}

	/**
	 * Reset the SDK query - terminates current query and starts fresh
	 *
	 * PUBLIC API: Called by RPC handler when user clicks "Reset Agent" button.
	 * This is a forceful reset that:
	 * 1. Clears any pending messages in the queue
	 * 2. Interrupts the current query
	 * 3. Resets state to idle
	 * 4. Starts a fresh query (ready to receive new messages)
	 *
	 * Use cases:
	 * - User wants to recover from stuck "queued" state
	 * - SDK is unresponsive
	 * - User wants to clear SDK context and start fresh
	 *
	 * @param options.restartQuery - If true (default), starts a new query after reset.
	 *                               If false, leaves query stopped (user must send message to restart).
	 */
	async resetQuery(options?: {
		restartQuery?: boolean;
	}): Promise<{ success: boolean; error?: string }> {
		const { restartQuery = true } = options ?? {};
		this.logger.log(`User-initiated query reset (restartQuery: ${restartQuery})...`);

		try {
			// 1. Clear any pending messages (reject with interrupt error)
			const queueSize = this.messageQueue.size();
			if (queueSize > 0) {
				this.logger.log(`Clearing ${queueSize} pending messages`);
				this.messageQueue.clear();
			}

			// 2. Clear any pending restart flag
			this.pendingRestartReason = null;

			// 3. If query hasn't started yet, just reset state
			if (!this.queryObject && !this.queryPromise) {
				this.logger.log(`Query not started, just resetting state`);
				await this.stateManager.setIdle();
				return { success: true };
			}

			// 4. Stop the message queue
			this.messageQueue.stop();
			this.logger.log(`Message queue stopped`);

			// 5. Interrupt current query
			if (this.queryObject && typeof this.queryObject.interrupt === 'function') {
				try {
					await this.queryObject.interrupt();
					this.logger.log(`Query interrupted successfully`);
				} catch (interruptError) {
					this.logger.warn(`Query interrupt failed (may be expected):`, interruptError);
				}
			}

			// 6. Wait for query promise to resolve (with short timeout)
			if (this.queryPromise) {
				try {
					await Promise.race([
						this.queryPromise,
						new Promise((resolve) => setTimeout(resolve, 3000)), // 3s timeout
					]);
					this.logger.log(`Previous query terminated`);
				} catch (error) {
					this.logger.warn(`Error waiting for query termination:`, error);
				}
			}

			// 7. Clear query object and promise
			this.queryObject = null;
			this.queryPromise = null;

			// 8. Reset state to idle
			await this.stateManager.setIdle();

			// 9. Optionally start a new query
			if (restartQuery) {
				this.logger.log(`Starting fresh query...`);
				await this.startStreamingQuery();
				this.logger.log(`Fresh query started successfully`);
			}

			// 10. Notify clients
			await this.messageHub.publish(
				'session.reset',
				{ message: 'Agent has been reset and is ready for new messages' },
				{ sessionId: this.session.id }
			);

			this.logger.log(`Query reset completed successfully`);
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.logger.error(`Query reset failed:`, error);
			return { success: false, error: errorMessage };
		}
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
	 * Always includes Liuboer built-in commands even if SDK hasn't started
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

		// Fallback: If SDK fetch failed or query not started, return at least built-in commands
		if (this.slashCommands.length === 0) {
			const liuboerBuiltInCommands = getBuiltInCommandNames();
			this.slashCommands = liuboerBuiltInCommands;
		}

		return this.slashCommands;
	}
}
