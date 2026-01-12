import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { UUID } from 'crypto';
import type {
	AgentProcessingState,
	MessageContent,
	Session,
	ContextInfo,
	QuestionDraftResponse,
	PendingUserQuestion,
} from '@liuboer/shared';
import type { MessageHub, CurrentModelInfo } from '@liuboer/shared';
import type { DaemonHub } from '../daemon-hub';
import { generateUUID } from '@liuboer/shared';
import type { SDKMessage, SlashCommand } from '@liuboer/shared/sdk';
import { isSDKUserMessage } from '@liuboer/shared/sdk/type-guards';
import { Database } from '../../storage/database';
import { ErrorCategory, ErrorManager } from '../error-manager';
import { Logger } from '../logger';
import { SettingsManager } from '../settings-manager';

// Extracted components (same folder)
import { MessageQueue } from './message-queue';
import { ProcessingStateManager } from './processing-state-manager';
import { ContextTracker } from './context-tracker';
import { SDKMessageHandler } from './sdk-message-handler';
import { QueryOptionsBuilder } from './query-options-builder';
import { QueryLifecycleManager } from './query-lifecycle-manager';
import { ModelSwitchHandler } from './model-switch-handler';
import { AskUserQuestionHandler } from './ask-user-question-handler';
import { getBuiltInCommandNames } from '../built-in-commands';
import { validateAndRepairSDKSession } from '../sdk-session-file-manager';

/**
 * SDK query object with control methods
 */
type SDKQueryObject = Query | null;

/**
 * Original environment variables for restoration after SDK query
 */
interface OriginalEnvVars {
	ANTHROPIC_AUTH_TOKEN?: string;
	ANTHROPIC_BASE_URL?: string;
	API_TIMEOUT_MS?: string;
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
	ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
	ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
	ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
}

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
	private lifecycleManager: QueryLifecycleManager;
	private modelSwitchHandler: ModelSwitchHandler;
	private askUserQuestionHandler: AskUserQuestionHandler;

	// SDK query object with control methods
	private queryObject: SDKQueryObject = null;
	private slashCommands: string[] = [];
	private commandsFetchedFromSDK = false; // Track if we've fetched from SDK to avoid duplicates

	// Track if SDK has sent at least one message (indicates ProcessTransport is ready)
	private firstMessageReceived = false;

	// Unsubscribe functions to prevent memory leaks
	private unsubscribers: Array<() => void> = [];

	// Track query promise for proper cleanup
	private queryPromise: Promise<void> | null = null;

	// Flag indicating cleanup has started - prevents DB writes after cleanup
	private isCleaningUp = false;

	// Pending restart flag - tracks if restart is needed after agent becomes idle
	// Reason: 'settings.local.json' when MCP configuration changed
	private pendingRestartReason: 'settings.local.json' | null = null;

	// Error manager for structured error handling
	private errorManager: ErrorManager;

	// Session-specific settings manager (created per-session for worktree isolation)
	private settingsManager: SettingsManager;

	// Original env vars to restore after SDK query completes
	private originalEnvVars: OriginalEnvVars = {};

	private logger: Logger;

	constructor(
		private session: Session,
		private db: Database,
		private messageHub: MessageHub,
		private daemonHub: DaemonHub,
		private getApiKey: () => Promise<string | null>
	) {
		// Initialize error manager and logger (with DaemonHub for internal events)
		this.errorManager = new ErrorManager(this.messageHub, this.daemonHub);
		this.logger = new Logger(`AgentSession ${session.id}`);

		// CRITICAL: Create session-specific SettingsManager with session's workspace path
		// This ensures worktree sessions write settings to their own .claude/settings.local.json
		// instead of the root workspace (fixes worktree isolation bug)
		this.settingsManager = new SettingsManager(this.db, this.session.workspacePath);

		// Initialize extracted components
		this.messageQueue = new MessageQueue();
		this.stateManager = new ProcessingStateManager(session.id, daemonHub, db);
		this.contextTracker = new ContextTracker(
			session.id,
			session.config.model,
			daemonHub,
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
			daemonHub,
			this.stateManager,
			this.contextTracker
		);

		// Initialize lifecycle manager with callbacks
		this.lifecycleManager = new QueryLifecycleManager(
			session.id,
			this.messageQueue,
			() => this.queryObject,
			(q) => {
				this.queryObject = q;
			},
			() => this.queryPromise,
			(p) => {
				this.queryPromise = p;
			},
			() => this.startStreamingQuery(),
			() => this.firstMessageReceived
		);

		// Initialize model switch handler with dependencies
		// Pass restartQuery callback for cross-provider model switches
		this.modelSwitchHandler = new ModelSwitchHandler({
			session: this.session,
			db: this.db,
			messageHub: this.messageHub,
			daemonHub: this.daemonHub,
			contextTracker: this.contextTracker,
			stateManager: this.stateManager,
			errorManager: this.errorManager,
			logger: this.logger,
			getQueryObject: () => this.queryObject,
			isTransportReady: () => this.firstMessageReceived,
			// Cross-provider switches (e.g., Claude ↔ GLM) require query restart
			// because the SDK subprocess needs different env vars (ANTHROPIC_BASE_URL, etc.)
			restartQuery: () => this.lifecycleManager.restart(),
		});

		// Initialize AskUserQuestion handler for interactive tool handling
		// This handler manages the canUseTool callback for AskUserQuestion
		this.askUserQuestionHandler = new AskUserQuestionHandler(
			session.id,
			this.stateManager,
			this.daemonHub
		);

		// Set queue callback for automatic /context fetching
		this.messageHandler.setQueueMessageCallback(async (content: string, internal: boolean) => {
			return await this.messageQueue.enqueue(content, internal);
		});

		// Set circuit breaker callback to handle fatal API errors
		this.messageHandler.setCircuitBreakerTripCallback(async (reason, userMessage) => {
			await this.handleCircuitBreakerTrip(reason, userMessage);
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

		// Subscribe to EventBus events for this session
		// This implements the EventBus-centric architecture pattern:
		// RPC handlers emit events → AgentSession subscribes with sessionId filtering
		this.setupEventSubscriptions();

		// LAZY START: Don't start the streaming query here.
		// Query will be started on first message send via ensureQueryStarted()
	}

	/**
	 * Setup EventBus subscriptions for this session
	 *
	 * ARCHITECTURE: EventBus-centric pattern
	 * - RPC handlers emit events (fire-and-forget)
	 * - AgentSession subscribes with sessionId filtering
	 * - Results are emitted back via EventBus for StateManager to broadcast
	 *
	 * This decouples RPC handlers from AgentSession internals.
	 */
	private setupEventSubscriptions(): void {
		// Model switch request handler
		// ARCHITECTURE: Uses DaemonHub native session filtering (no manual if-check needed)
		const unsubModelSwitch = this.daemonHub.on(
			'model.switchRequest',
			async ({ sessionId, model }) => {
				this.logger.log(`Received model.switchRequest for model: ${model}`);
				const result = await this.modelSwitchHandler.switchModel(model);

				// Emit result for StateManager/clients
				await this.daemonHub.emit('model.switched', {
					sessionId,
					success: result.success,
					model: result.model,
					error: result.error,
				});
			},
			{ sessionId: this.session.id }
		);
		this.unsubscribers.push(unsubModelSwitch);

		// Interrupt request handler
		const unsubInterrupt = this.daemonHub.on(
			'agent.interruptRequest',
			async ({ sessionId }) => {
				this.logger.log(`Received agent.interruptRequest`);
				await this.handleInterrupt();

				// Emit completion event
				await this.daemonHub.emit('agent.interrupted', { sessionId });
			},
			{ sessionId: this.session.id }
		);
		this.unsubscribers.push(unsubInterrupt);

		// Reset query request handler
		const unsubReset = this.daemonHub.on(
			'agent.resetRequest',
			async ({ sessionId, restartQuery }) => {
				this.logger.log(`Received agent.resetRequest (restartQuery: ${restartQuery})`);
				const result = await this.resetQuery({ restartQuery });

				// Emit result for StateManager/clients
				await this.daemonHub.emit('agent.reset', {
					sessionId,
					success: result.success,
					error: result.error,
				});
			},
			{ sessionId: this.session.id }
		);
		this.unsubscribers.push(unsubReset);

		// Message persisted handler (for query feeding)
		// ARCHITECTURE: SessionManager emits this after persisting message to DB
		const unsubMessagePersisted = this.daemonHub.on(
			'message.persisted',
			async (data) => {
				this.logger.log(`Received message.persisted event (messageId: ${data.messageId})`);

				// Start query and enqueue message for processing
				await this.startQueryAndEnqueue(data.messageId, data.messageContent);
			},
			{ sessionId: this.session.id }
		);
		this.unsubscribers.push(unsubMessagePersisted);

		// Query trigger handler (for Manual mode)
		// When user explicitly triggers sending saved messages
		const unsubQueryTrigger = this.daemonHub.on(
			'query.trigger',
			async () => {
				this.logger.log(`Received query.trigger event`);
				await this.handleQueryTrigger();
			},
			{ sessionId: this.session.id }
		);
		this.unsubscribers.push(unsubQueryTrigger);

		// Send queued messages on turn end (Auto-queue mode)
		// When agent finishes a turn, automatically send any queued messages
		const unsubSendQueuedOnTurnEnd = this.daemonHub.on(
			'query.sendQueuedOnTurnEnd',
			async () => {
				this.logger.log(`Received query.sendQueuedOnTurnEnd event`);
				await this.sendQueuedMessagesOnTurnEnd();
			},
			{ sessionId: this.session.id }
		);
		this.unsubscribers.push(unsubSendQueuedOnTurnEnd);

		this.logger.log(`DaemonHub subscriptions initialized with session filtering`);
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

			// THEN emit event via DaemonHub (StateManager will broadcast unified session state)
			await this.daemonHub.emit('commands.updated', {
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
			const { getSupportedModelsFromQuery } = await import('../model-service');
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

		// Emit event for title generation (decoupled via DaemonHub)
		this.daemonHub.emit('message.sent', { sessionId: this.session.id }).catch((err) => {
			this.logger.warn('Failed to emit message.sent event:', err);
		});
	}

	/**
	 * Ensure the streaming query is started (lazy initialization)
	 * Called on first message send to avoid connecting to SDK until needed
	 */
	private async ensureQueryStarted(): Promise<void> {
		if (this.messageQueue.isRunning() || this.queryPromise) {
			return; // Already started
		}

		// Validate and auto-repair SDK session file before resuming
		// This fixes orphaned tool_result blocks caused by SDK context compaction
		if (this.session.sdkSessionId) {
			validateAndRepairSDKSession(
				this.session.workspacePath,
				this.session.sdkSessionId,
				this.session.id,
				this.db
			);
			// Note: We proceed even if repair fails - the SDK will report the error
			// and the user can manually fix or start a new session
		}

		this.logger.log(`Lazy-starting streaming query...`);
		await this.startStreamingQuery();
	}

	/**
	 * Create and display a synthetic assistant message for errors
	 *
	 * Shared logic for error display:
	 * 1. Create assistant message with formatted error text
	 * 2. Save to database
	 * 3. Broadcast to UI
	 */
	private async displayErrorAsAssistantMessage(
		text: string,
		options?: { markAsError?: boolean }
	): Promise<void> {
		const assistantMessage: SDKMessage = {
			type: 'assistant' as const,
			uuid: generateUUID() as UUID,
			session_id: this.session.id,
			parent_tool_use_id: null,
			...(options?.markAsError ? { error: 'invalid_request' as const } : {}),
			message: {
				role: 'assistant' as const,
				content: [{ type: 'text' as const, text }],
			},
		};

		// Save to database
		this.db.saveSDKMessage(this.session.id, assistantMessage);

		// Broadcast to UI
		await this.messageHub.publish(
			'state.sdkMessages.delta',
			{ added: [assistantMessage], timestamp: Date.now() },
			{ sessionId: this.session.id }
		);
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

			await this.displayErrorAsAssistantMessage(
				`**API Error (${statusCode})**: ${apiErrorType}\n\n${apiErrorMessage}\n\nThis error occurred while processing your request. Please review the error message above and adjust your request accordingly.`,
				{ markAsError: true }
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
			// Verify authentication - check for any available provider credentials
			// Supports Anthropic (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) and GLM (GLM_API_KEY, ZHIPU_API_KEY)
			const { getProviderService } = await import('../provider-service');
			const providerService = getProviderService();

			const hasAnthropicAuth = !!(
				process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY
			);
			const hasGlmAuth = providerService.isGlmAvailable();
			const hasAuth = hasAnthropicAuth || hasGlmAuth;

			if (!hasAuth) {
				const authError = new Error(
					'No authentication configured. Please set up API key for Anthropic or GLM.'
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

			// Build query options using QueryOptionsBuilder
			const optionsBuilder = new QueryOptionsBuilder(this.session, this.settingsManager);

			// Set the canUseTool callback for AskUserQuestion handling
			// This enables interactive question prompts in the UI
			optionsBuilder.setCanUseTool(this.askUserQuestionHandler.createCanUseToolCallback());

			let queryOptions = await optionsBuilder.build();

			// Add session state options (resume, thinking tokens)
			queryOptions = optionsBuilder.addSessionStateOptions(queryOptions);

			// DEBUG: Log query options before creating SDK query
			console.log('[AgentSession] Creating SDK query with options:', {
				model: queryOptions.model,
				env: queryOptions.env ? Object.keys(queryOptions.env) : 'none',
				permissionMode: queryOptions.permissionMode,
				allowDangerouslySkipPermissions: queryOptions.allowDangerouslySkipPermissions,
				// Don't log the actual env values to avoid leaking secrets
			});

			// IMPORTANT: Apply provider env vars to process.env before creating SDK query
			// This is required for GLM to work - the SDK subprocess inherits these env vars
			const modelId = this.session.config.model || 'default';
			this.originalEnvVars = providerService.applyEnvVarsToProcess(modelId);

			// Log if we're using GLM (for debugging)
			if (providerService.isGlmModel(modelId)) {
				this.logger.log(`Applied GLM env vars for model ${modelId} to process.env`);
			}

			// Create query with AsyncGenerator from MessageQueue
			console.log('[AgentSession] About to call query() function...');
			this.queryObject = query({
				prompt: this.createMessageGeneratorWrapper(),
				options: queryOptions,
			});
			console.log('[AgentSession] Query object created successfully!');

			// Process SDK messages - MUST start immediately!
			// The SDK methods (supportedCommands, supportedModels) require the query to be
			// actively consumed, so we start processing first and fetch metadata in the background.
			this.logger.log(`Processing SDK stream...`);
			console.log('[AgentSession] About to iterate over queryObject...');

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

			console.log('[AgentSession] Starting for-await loop over queryObject...');
			let messageCount = 0;

			for await (const message of this.queryObject) {
				messageCount++;
				console.log(
					`[AgentSession] SDK message #${messageCount} received - type: ${(message as SDKMessage).type}`
				);

				// Mark that we've received at least one message from SDK
				// This indicates ProcessTransport is ready for control methods (setModel, interrupt, etc.)
				this.firstMessageReceived = true;

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
			console.log(`[AgentSession] SDK stream ended normally`);
		} catch (error) {
			console.log(`[AgentSession] SDK stream error:`, error);
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
					} else if (
						errorMessage.includes('cannot be run as root') ||
						errorMessage.includes('dangerously-skip-permissions') ||
						errorMessage.includes('permission') ||
						errorMessage.includes('Exit code: 1')
					) {
						category = ErrorCategory.PERMISSION;
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

			// Clear queryPromise so ensureQueryStarted() can restart if needed
			// This is essential for multi-message sequences where the SDK query
			// finishes after first message and needs to restart for subsequent messages
			this.queryPromise = null;

			// Restore original env vars after SDK query completes
			// This is critical for GLM support - we apply provider env vars before
			// the query and must restore them after to avoid affecting other sessions
			if (Object.keys(this.originalEnvVars).length > 0) {
				// Re-import getProviderService since we're in a different scope
				const { getProviderService: getProviderServiceRestore } =
					await import('../provider-service');
				const providerServiceRestore = getProviderServiceRestore();
				providerServiceRestore.restoreEnvVars(this.originalEnvVars);
				this.originalEnvVars = {};
				this.logger.log('Restored original environment variables after SDK query');
			}

			// Ensure state is reset to idle when streaming stops (normal or error)
			// Skip if cleanup is in progress to avoid "closed database" errors
			if (!this.isCleaningUp) {
				await this.stateManager.setIdle();
			}

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
	 * Handle user's response to an AskUserQuestion tool call
	 *
	 * Delegates to AskUserQuestionHandler which resolves the pending Promise
	 * in the canUseTool callback, allowing the SDK to continue.
	 *
	 * @param toolUseId - The tool use ID from the AskUserQuestion call
	 * @param responses - Array of user responses for each question
	 */
	async handleQuestionResponse(
		toolUseId: string,
		responses: QuestionDraftResponse[]
	): Promise<void> {
		// Get the pending question before handling (needed for saving resolved state)
		const currentState = this.stateManager.getState();
		let pendingQuestion: PendingUserQuestion | null = null;
		if (currentState.status === 'waiting_for_input') {
			pendingQuestion = currentState.pendingQuestion;
		}

		// Handle the response (this resolves the Promise in canUseTool)
		await this.askUserQuestionHandler.handleQuestionResponse(toolUseId, responses);

		// Save the resolved question to session metadata for persistence
		if (pendingQuestion) {
			const resolvedQuestions = { ...this.session.metadata?.resolvedQuestions };
			resolvedQuestions[toolUseId] = {
				question: pendingQuestion,
				state: 'submitted',
				responses,
				resolvedAt: Date.now(),
			};
			// updateMetadata handles partial metadata merges internally
			this.updateMetadata({
				metadata: {
					...this.session.metadata,
					resolvedQuestions,
				},
			});
			this.logger.log(`Saved resolved question (submitted): ${toolUseId}`);
		}
	}

	/**
	 * Update draft responses for pending question (for saving partial input)
	 * Called by question.saveDraft RPC to preserve user selections before submit
	 */
	async updateQuestionDraft(draftResponses: QuestionDraftResponse[]): Promise<void> {
		await this.askUserQuestionHandler.updateQuestionDraft(draftResponses);
	}

	/**
	 * Handle user cancelling a pending question
	 *
	 * Delegates to AskUserQuestionHandler which denies the tool use,
	 * telling Claude the user declined to answer.
	 */
	async handleQuestionCancel(toolUseId: string): Promise<void> {
		// Get the pending question before handling (needed for saving resolved state)
		const currentState = this.stateManager.getState();
		let pendingQuestion: PendingUserQuestion | null = null;
		if (currentState.status === 'waiting_for_input') {
			pendingQuestion = currentState.pendingQuestion;
		}

		// Handle the cancellation (this denies the tool use)
		await this.askUserQuestionHandler.handleQuestionCancel(toolUseId);

		// Save the resolved question to session metadata for persistence
		if (pendingQuestion) {
			const resolvedQuestions = { ...this.session.metadata?.resolvedQuestions };
			resolvedQuestions[toolUseId] = {
				question: pendingQuestion,
				state: 'cancelled',
				responses: [],
				resolvedAt: Date.now(),
			};
			// updateMetadata handles partial metadata merges internally
			this.updateMetadata({
				metadata: {
					...this.session.metadata,
					resolvedQuestions,
				},
			});
			this.logger.log(`Saved resolved question (cancelled): ${toolUseId}`);
		}
	}

	/**
	 * Handle circuit breaker trip - stops the query and notifies the user
	 *
	 * Called when the circuit breaker detects repeated API errors (like "prompt too long")
	 * that would otherwise cause an infinite retry loop.
	 *
	 * This method:
	 * 1. Resets the query to stop the error loop
	 * 2. Creates a synthetic assistant message to explain the error
	 * 3. Emits an error event for logging/monitoring
	 */
	private async handleCircuitBreakerTrip(reason: string, userMessage: string): Promise<void> {
		this.logger.log(`Handling circuit breaker trip: ${reason}`);

		try {
			// 1. Reset the query to stop the error loop
			// Use restartQuery: false since we don't want to immediately restart
			// User needs to address the issue (e.g., start new session, compact context)
			await this.resetQuery({ restartQuery: false });

			// 2. Display error message to user
			await this.displayErrorAsAssistantMessage(
				`⚠️ **Session Stopped: Error Loop Detected**\n\n${userMessage}\n\n` +
					`**What happened:** The same API error occurred multiple times in quick succession, indicating the request cannot succeed in its current state.\n\n` +
					`**What to do:**\n` +
					`- Use \`/compact\` to reduce the conversation context\n` +
					`- Start a new session if the context is too large\n` +
					`- Click "Reset Agent" in the menu to try again\n\n` +
					`The agent has been automatically stopped to prevent further errors.`
			);

			// 3. Emit error event for monitoring
			await this.errorManager.handleError(
				this.session.id,
				new Error(`Circuit breaker tripped: ${reason}`),
				ErrorCategory.SYSTEM,
				userMessage,
				this.stateManager.getState(),
				{ circuitBreakerReason: reason }
			);

			this.logger.log(`Circuit breaker trip handled successfully`);
		} catch (error) {
			this.logger.error(`Error handling circuit breaker trip:`, error);
			// Ensure we at least reset to idle state
			await this.stateManager.setIdle();
		}
	}

	/**
	 * Switch to a different Claude model mid-session
	 * Delegates to ModelSwitchHandler for the actual logic
	 */
	async handleModelSwitch(
		newModel: string
	): Promise<{ success: boolean; model: string; error?: string }> {
		return this.modelSwitchHandler.switchModel(newModel);
	}

	/**
	 * Get current model ID for this session
	 */
	getCurrentModel(): CurrentModelInfo {
		return this.modelSwitchHandler.getCurrentModel();
	}

	/**
	 * Get the current SDK query object (for testing)
	 * Returns null if query hasn't been created yet
	 */
	getQueryObject(): Query | null {
		return this.queryObject;
	}

	/**
	 * Check if first message has been received from SDK
	 * This indicates ProcessTransport is ready for control methods
	 */
	getFirstMessageReceived(): boolean {
		return this.firstMessageReceived;
	}

	// ============================================================================
	// SDK Config Runtime Methods
	// These methods allow changing SDK configuration at runtime
	// ============================================================================

	/**
	 * Set max thinking tokens at runtime
	 * Uses SDK's native setMaxThinkingTokens() method
	 *
	 * @param tokens - Max tokens for thinking (null to disable)
	 * @returns Success status with optional error message
	 */
	async setMaxThinkingTokens(tokens: number | null): Promise<{ success: boolean; error?: string }> {
		this.logger.log(`Setting max thinking tokens to: ${tokens}`);

		try {
			// If query not running or transport not ready, just update config
			if (!this.queryObject || !this.firstMessageReceived) {
				this.session.config.maxThinkingTokens = tokens;
				this.db.updateSession(this.session.id, { config: this.session.config });
				this.logger.log(`Max thinking tokens saved to config (query not active)`);
				return { success: true };
			}

			// Use SDK's native method
			if ('setMaxThinkingTokens' in this.queryObject) {
				await (
					this.queryObject as Query & { setMaxThinkingTokens: (t: number | null) => Promise<void> }
				).setMaxThinkingTokens(tokens);
			}

			// Update config
			this.session.config.maxThinkingTokens = tokens;
			this.db.updateSession(this.session.id, { config: this.session.config });

			// Emit event for UI update
			await this.daemonHub.emit('session.updated', {
				sessionId: this.session.id,
				source: 'thinking-tokens',
				session: { config: this.session.config },
			});

			this.logger.log(`Max thinking tokens set successfully`);
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to set max thinking tokens:`, error);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Set permission mode at runtime
	 * Uses SDK's native setPermissionMode() method
	 *
	 * @param mode - Permission mode to set
	 * @returns Success status with optional error message
	 */
	async setPermissionMode(mode: string): Promise<{ success: boolean; error?: string }> {
		this.logger.log(`Setting permission mode to: ${mode}`);

		try {
			// If query not running or transport not ready, just update config
			if (!this.queryObject || !this.firstMessageReceived) {
				this.session.config.permissionMode = mode as Session['config']['permissionMode'];
				this.db.updateSession(this.session.id, { config: this.session.config });
				this.logger.log(`Permission mode saved to config (query not active)`);
				return { success: true };
			}

			// Use SDK's native method
			if ('setPermissionMode' in this.queryObject) {
				await (
					this.queryObject as Query & { setPermissionMode: (m: string) => Promise<void> }
				).setPermissionMode(mode);
			}

			// Update config
			this.session.config.permissionMode = mode as Session['config']['permissionMode'];
			this.db.updateSession(this.session.id, { config: this.session.config });

			// Emit event for UI update
			await this.daemonHub.emit('session.updated', {
				sessionId: this.session.id,
				source: 'permission-mode',
				session: { config: this.session.config },
			});

			this.logger.log(`Permission mode set successfully`);
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to set permission mode:`, error);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Get MCP server status from SDK
	 *
	 * @returns Array of MCP server statuses, or empty array if not available
	 */
	async getMcpServerStatus(): Promise<Array<{ name: string; status: string; error?: string }>> {
		if (!this.queryObject || !this.firstMessageReceived) {
			return [];
		}

		try {
			if ('mcpServerStatus' in this.queryObject) {
				const status = await (
					this.queryObject as Query & { mcpServerStatus: () => Promise<unknown[]> }
				).mcpServerStatus();
				return status as Array<{ name: string; status: string; error?: string }>;
			}
			return [];
		} catch (error) {
			this.logger.warn(`Failed to get MCP server status:`, error);
			return [];
		}
	}

	/**
	 * Update session config and persist to database
	 *
	 * @param configUpdates - Partial config updates to merge
	 */
	async updateConfig(configUpdates: Partial<Session['config']>): Promise<void> {
		this.session.config = { ...this.session.config, ...configUpdates };
		this.db.updateSession(this.session.id, { config: this.session.config });

		// Emit event for UI update
		await this.daemonHub.emit('session.updated', {
			sessionId: this.session.id,
			source: 'config-update',
			session: { config: this.session.config },
		});
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
			await this.daemonHub.emit('session.updated', {
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
	 * Delegates to QueryLifecycleManager for shared restart logic
	 */
	private async doActualRestart(): Promise<void> {
		await this.lifecycleManager.restart();
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

		// Handle case where query hasn't started yet
		if (!this.queryObject && !this.queryPromise) {
			this.logger.log(`Query not started, just resetting state`);
			// Still clear pending messages and reset circuit breaker
			const queueSize = this.messageQueue.size();
			if (queueSize > 0) {
				this.logger.log(`Clearing ${queueSize} pending messages`);
				this.messageQueue.clear();
			}
			this.pendingRestartReason = null;
			this.messageHandler.resetCircuitBreaker();
			await this.stateManager.setIdle();
			return { success: true };
		}

		// Delegate to lifecycle manager with callbacks for reset-specific actions
		return await this.lifecycleManager.reset({
			restartAfter: restartQuery,
			onBeforeStop: async () => {
				// IMPORTANT: Save current SDK cost to baseline before reset
				// This handles the case where new run's cost exceeds old run's cost
				// (which we can't detect from cost decrease alone)
				const lastSdkCost = this.session.metadata?.lastSdkCost || 0;
				const costBaseline = this.session.metadata?.costBaseline || 0;
				if (lastSdkCost > 0) {
					const newCostBaseline = costBaseline + lastSdkCost;
					this.logger.log(
						`Reset: saving cost baseline ${costBaseline} + ${lastSdkCost} = ${newCostBaseline}`
					);
					this.session.metadata = {
						...this.session.metadata,
						costBaseline: newCostBaseline,
						lastSdkCost: 0, // Reset for new SDK run
						// totalCost stays as-is (baseline + 0 = same value)
					};
					this.db.updateSession(this.session.id, { metadata: this.session.metadata });
				}

				// Clear pending messages
				const queueSize = this.messageQueue.size();
				if (queueSize > 0) {
					this.logger.log(`Clearing ${queueSize} pending messages`);
					this.messageQueue.clear();
				}
				// Clear pending restart flag
				this.pendingRestartReason = null;
				// Reset circuit breaker
				this.messageHandler.resetCircuitBreaker();

				// Clear any stale session errors on reset
				// This prevents "unexpected error" from showing repeatedly when opening the session
				await this.daemonHub.emit('session.errorClear', { sessionId: this.session.id });
			},
			onAfterStop: async () => {
				// Reset transport readiness flag AFTER stop completes
				// This flag is checked by stop() to decide whether to call interrupt()
				// so it must be reset AFTER that check, not before
				this.firstMessageReceived = false;
				// Reset state to idle
				await this.stateManager.setIdle();
			},
			onAfterRestart: async () => {
				// Notify clients
				await this.messageHub.publish(
					'session.reset',
					{ message: 'Agent has been reset and is ready for new messages' },
					{ sessionId: this.session.id }
				);
				this.logger.log(`Query reset completed successfully`);
			},
		});
	}

	/**
	 * Cleanup resources when session is destroyed
	 */
	async cleanup(): Promise<void> {
		this.logger.log(`Cleaning up resources...`);

		// Set cleanup flag to prevent DB writes from runQuery finally block
		this.isCleaningUp = true;

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
			const { clearModelsCache } = await import('../model-service');
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

	// ============================================================================
	// Query Mode Methods
	// ============================================================================

	/**
	 * Handle manual query trigger (Manual mode)
	 *
	 * Retrieves all 'saved' messages from the database and sends them to Claude.
	 * Called when user explicitly clicks "Send" in Manual mode.
	 */
	async handleQueryTrigger(): Promise<{ success: boolean; messageCount: number; error?: string }> {
		this.logger.log(`Handling query trigger (Manual mode)`);

		try {
			// Get all saved messages for this session
			const savedMessages = this.db.getMessagesByStatus(this.session.id, 'saved');

			if (savedMessages.length === 0) {
				this.logger.log(`No saved messages to send`);
				return { success: true, messageCount: 0 };
			}

			this.logger.log(`Found ${savedMessages.length} saved messages to send`);

			// Update status to 'queued' before sending
			const dbIds = savedMessages.map((m) => m.dbId);
			this.db.updateMessageStatus(dbIds, 'queued');

			// Emit status change event
			await this.daemonHub.emit('messages.statusChanged', {
				sessionId: this.session.id,
				messageIds: dbIds,
				status: 'queued',
			});

			// Ensure query is started
			await this.ensureQueryStarted();

			// Enqueue each message for processing
			for (const msg of savedMessages) {
				// Only process user messages - skip system messages, etc.
				if (!isSDKUserMessage(msg)) {
					continue;
				}

				const content = msg.message.content;
				if (content) {
					// Extract text content from the message
					const textContent =
						typeof content === 'string'
							? content
							: Array.isArray(content)
								? content
										.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
										.map((c) => c.text)
										.join('\n')
								: '';

					if (textContent) {
						await this.messageQueue.enqueueWithId(msg.uuid as string, textContent);
					}
				}
			}

			// Update status to 'sent' after enqueuing
			this.db.updateMessageStatus(dbIds, 'sent');

			// Emit status change event
			await this.daemonHub.emit('messages.statusChanged', {
				sessionId: this.session.id,
				messageIds: dbIds,
				status: 'sent',
			});

			this.logger.log(`Successfully triggered ${savedMessages.length} messages`);
			return { success: true, messageCount: savedMessages.length };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.logger.error(`Failed to trigger query:`, error);
			return { success: false, messageCount: 0, error: errorMessage };
		}
	}

	/**
	 * Send queued messages when agent turn ends (Auto-queue mode)
	 *
	 * Called after agent finishes processing a turn. Checks for any 'queued' messages
	 * that were added during processing and sends them automatically.
	 */
	async sendQueuedMessagesOnTurnEnd(): Promise<void> {
		this.logger.log(`Checking for queued messages on turn end`);

		try {
			// Get all queued messages for this session
			const queuedMessages = this.db.getMessagesByStatus(this.session.id, 'queued');

			if (queuedMessages.length === 0) {
				this.logger.log(`No queued messages to send on turn end`);
				return;
			}

			this.logger.log(`Found ${queuedMessages.length} queued messages to send on turn end`);

			// Enqueue each message for processing
			for (const msg of queuedMessages) {
				// Only process user messages - skip system messages, etc.
				if (!isSDKUserMessage(msg)) {
					continue;
				}

				const content = msg.message.content;
				if (content) {
					// Extract text content from the message
					const textContent =
						typeof content === 'string'
							? content
							: Array.isArray(content)
								? content
										.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
										.map((c) => c.text)
										.join('\n')
								: '';

					if (textContent) {
						await this.messageQueue.enqueueWithId(msg.uuid as string, textContent);
					}
				}
			}

			// Update status to 'sent' after enqueuing
			const dbIds = queuedMessages.map((m) => m.dbId);
			this.db.updateMessageStatus(dbIds, 'sent');

			// Emit status change event
			await this.daemonHub.emit('messages.statusChanged', {
				sessionId: this.session.id,
				messageIds: dbIds,
				status: 'sent',
			});

			this.logger.log(`Successfully sent ${queuedMessages.length} queued messages on turn end`);
		} catch (error) {
			this.logger.error(`Failed to send queued messages on turn end:`, error);
		}
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
