/**
 * AgentSession - Orchestrates a Claude conversation session
 *
 * Uses STREAMING INPUT mode - a single persistent SDK query with AsyncGenerator
 * that continuously yields messages from a queue.
 *
 * REFACTORED: Now delegates to extracted components for better maintainability:
 * - MessageQueue: Message queueing and AsyncGenerator
 * - ProcessingStateManager: State machine and phases
 * - ContextTracker: Real-time context window usage
 * - SDKMessageHandler: SDK message processing
 * - QueryRunner: Query execution and abort handling
 * - InterruptHandler: Interrupt logic
 * - SDKRuntimeConfig: Runtime SDK configuration
 * - EventSubscriptionSetup: Event subscriptions
 * - QueryModeHandler: Manual/Auto-queue mode
 * - SlashCommandManager: Slash command caching
 * - MessageRecoveryHandler: Orphaned message recovery
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type {
	AgentProcessingState,
	MessageContent,
	Session,
	ContextInfo,
	QuestionDraftResponse,
	PendingUserQuestion,
	MessageHub,
	CurrentModelInfo,
} from '@liuboer/shared';
import type { DaemonHub } from '../daemon-hub';
import { Database } from '../../storage/database';
import { ErrorCategory, ErrorManager } from '../error-manager';
import { Logger } from '../logger';
import { SettingsManager } from '../settings-manager';
import { validateAndRepairSDKSession } from '../sdk-session-file-manager';

// Extracted components
import { MessageQueue } from './message-queue';
import { ProcessingStateManager } from './processing-state-manager';
import { ContextTracker } from './context-tracker';
import { SDKMessageHandler } from './sdk-message-handler';
import { QueryOptionsBuilder } from './query-options-builder';
import { QueryLifecycleManager } from './query-lifecycle-manager';
import { ModelSwitchHandler } from './model-switch-handler';
import { AskUserQuestionHandler } from './ask-user-question-handler';
import { QueryRunner } from './query-runner';
import { InterruptHandler } from './interrupt-handler';
import { SDKRuntimeConfig } from './sdk-runtime-config';
import { EventSubscriptionSetup } from './event-subscription-setup';
import { QueryModeHandler } from './query-mode-handler';
import { SlashCommandManager } from './slash-command-manager';
import { MessageRecoveryHandler } from './message-recovery-handler';

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
 */
export class AgentSession {
	// Core components
	private messageQueue: MessageQueue;
	private stateManager: ProcessingStateManager;
	private contextTracker: ContextTracker;
	private messageHandler: SDKMessageHandler;
	private lifecycleManager: QueryLifecycleManager;
	private modelSwitchHandler: ModelSwitchHandler;
	private askUserQuestionHandler: AskUserQuestionHandler;

	// Extracted handlers
	private queryRunner: QueryRunner;
	private interruptHandler: InterruptHandler;
	private sdkRuntimeConfig: SDKRuntimeConfig;
	private eventSubscriptionSetup: EventSubscriptionSetup;
	private queryModeHandler: QueryModeHandler;
	private slashCommandManager: SlashCommandManager;

	// SDK query state
	private queryObject: Query | null = null;
	private queryPromise: Promise<void> | null = null;
	private queryGeneration = 0;
	private queryAbortController: AbortController | null = null;
	private firstMessageReceived = false;
	private startupTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
	private originalEnvVars: OriginalEnvVars = {};

	// Session state
	private isCleaningUp = false;
	private pendingRestartReason: 'settings.local.json' | null = null;

	// Services
	private errorManager: ErrorManager;
	private settingsManager: SettingsManager;
	private logger: Logger;

	constructor(
		private session: Session,
		private db: Database,
		private messageHub: MessageHub,
		private daemonHub: DaemonHub,
		private getApiKey: () => Promise<string | null>
	) {
		this.errorManager = new ErrorManager(this.messageHub, this.daemonHub);
		this.logger = new Logger(`AgentSession ${session.id}`);
		this.settingsManager = new SettingsManager(this.db, this.session.workspacePath);

		// Initialize core components
		this.messageQueue = new MessageQueue();
		this.stateManager = new ProcessingStateManager(session.id, daemonHub, db);
		this.contextTracker = new ContextTracker(
			session.id,
			session.config.model,
			daemonHub,
			(contextInfo: ContextInfo) => {
				this.session.metadata.lastContextInfo = contextInfo;
				this.db.updateSession(this.session.id, { metadata: this.session.metadata });
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

		// Initialize lifecycle manager
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

		// Initialize model switch handler
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
			restartQuery: () => this.lifecycleManager.restart(),
		});

		// Initialize AskUserQuestion handler
		this.askUserQuestionHandler = new AskUserQuestionHandler(
			session.id,
			this.stateManager,
			this.daemonHub
		);

		// Initialize QueryOptionsBuilder
		const optionsBuilder = new QueryOptionsBuilder(this.session, this.settingsManager);

		// Initialize QueryRunner
		this.queryRunner = new QueryRunner({
			session: this.session,
			db: this.db,
			messageHub: this.messageHub,
			messageQueue: this.messageQueue,
			stateManager: this.stateManager,
			errorManager: this.errorManager,
			logger: this.logger,
			optionsBuilder,
			askUserQuestionHandler: this.askUserQuestionHandler,
			getQueryGeneration: () => this.queryGeneration,
			incrementQueryGeneration: () => ++this.queryGeneration,
			getFirstMessageReceived: () => this.firstMessageReceived,
			setFirstMessageReceived: (v) => {
				this.firstMessageReceived = v;
			},
			setQueryObject: (q) => {
				this.queryObject = q;
			},
			setQueryPromise: (p) => {
				this.queryPromise = p;
			},
			setQueryAbortController: (c) => {
				this.queryAbortController = c;
			},
			getQueryAbortController: () => this.queryAbortController,
			setStartupTimeoutTimer: (t) => {
				this.startupTimeoutTimer = t;
			},
			getStartupTimeoutTimer: () => this.startupTimeoutTimer,
			setOriginalEnvVars: (v) => {
				this.originalEnvVars = v;
			},
			getOriginalEnvVars: () => this.originalEnvVars,
			isCleaningUp: () => this.isCleaningUp,
			onSDKMessage: (msg) => this.messageHandler.handleMessage(msg),
			onSlashCommandsFetched: () => this.slashCommandManager.fetchAndCache(),
			onModelsFetched: () => this.fetchAndCacheModels(),
			onMarkApiSuccess: () => Promise.resolve(this.errorManager.markApiSuccess()),
		});

		// Initialize InterruptHandler
		this.interruptHandler = new InterruptHandler({
			sessionId: session.id,
			messageHub: this.messageHub,
			messageQueue: this.messageQueue,
			stateManager: this.stateManager,
			logger: this.logger,
			getQueryObject: () => this.queryObject,
			setQueryObject: (q) => {
				this.queryObject = q;
			},
			getQueryPromise: () => this.queryPromise,
			getQueryAbortController: () => this.queryAbortController,
			setQueryAbortController: (c) => {
				this.queryAbortController = c;
			},
		});

		// Initialize SDKRuntimeConfig
		this.sdkRuntimeConfig = new SDKRuntimeConfig({
			session: this.session,
			db: this.db,
			daemonHub: this.daemonHub,
			settingsManager: this.settingsManager,
			messageQueue: this.messageQueue,
			logger: this.logger,
			getQueryObject: () => this.queryObject,
			isTransportReady: () => this.firstMessageReceived,
			restartQuery: () => this.restartQuery(),
		});

		// Initialize EventSubscriptionSetup
		this.eventSubscriptionSetup = new EventSubscriptionSetup(
			session.id,
			this.daemonHub,
			this.logger
		);

		// Initialize QueryModeHandler
		this.queryModeHandler = new QueryModeHandler({
			session: this.session,
			db: this.db,
			daemonHub: this.daemonHub,
			messageQueue: this.messageQueue,
			logger: this.logger,
			ensureQueryStarted: () => this.ensureQueryStarted(),
		});

		// Initialize SlashCommandManager
		this.slashCommandManager = new SlashCommandManager({
			session: this.session,
			db: this.db,
			daemonHub: this.daemonHub,
			logger: this.logger,
			getQueryObject: () => this.queryObject,
		});

		// Set callbacks
		this.messageHandler.setQueueMessageCallback(async (content: string, internal: boolean) => {
			return await this.messageQueue.enqueue(content, internal);
		});
		this.messageHandler.setCircuitBreakerTripCallback(async (reason, userMessage) => {
			await this.handleCircuitBreakerTrip(reason, userMessage);
		});
		this.stateManager.setOnIdleCallback(async () => {
			await this.executeDeferredRestartIfPending();
		});

		// Restore persisted state
		if (session.metadata?.lastContextInfo) {
			this.contextTracker.restoreFromMetadata(session.metadata.lastContextInfo);
		}
		this.stateManager.restoreFromDatabase();

		// Recover orphaned messages
		const recoveryHandler = new MessageRecoveryHandler(session, db, this.logger);
		recoveryHandler.recoverOrphanedSentMessages();

		// Setup event subscriptions
		this.eventSubscriptionSetup.setup({
			onModelSwitchRequest: (model) => this.modelSwitchHandler.switchModel(model),
			onInterruptRequest: () => this.interruptHandler.handleInterrupt(),
			onResetRequest: (restartQuery) => this.resetQuery({ restartQuery }),
			onMessagePersisted: (messageId, content) =>
				this.startQueryAndEnqueue(messageId, content as string | MessageContent[]),
			onQueryTrigger: () => this.queryModeHandler.handleQueryTrigger(),
			onSendQueuedOnTurnEnd: () => this.queryModeHandler.sendQueuedMessagesOnTurnEnd(),
		});
	}

	// ============================================================================
	// Query Lifecycle
	// ============================================================================

	private async startStreamingQuery(): Promise<void> {
		await this.queryRunner.start();
	}

	private async ensureQueryStarted(): Promise<void> {
		// Wait for any pending interrupt
		const interruptPromise = this.interruptHandler.getInterruptPromise();
		if (interruptPromise) {
			this.logger.log('Waiting for interrupt to complete before starting query...');
			try {
				await Promise.race([interruptPromise, new Promise((r) => setTimeout(r, 5000))]);
			} catch (error) {
				this.logger.warn('Error waiting for interrupt:', error);
			}
		}

		if (this.messageQueue.isRunning()) {
			return;
		}

		// Validate SDK session file
		if (this.session.sdkSessionId) {
			validateAndRepairSDKSession(
				this.session.workspacePath,
				this.session.sdkSessionId,
				this.session.id,
				this.db
			);
		}

		this.logger.log('Lazy-starting streaming query...');
		await this.startStreamingQuery();
	}

	async startQueryAndEnqueue(
		messageId: string,
		messageContent: string | MessageContent[]
	): Promise<void> {
		await this.ensureQueryStarted();
		await this.stateManager.setQueued(messageId);

		this.messageQueue.enqueueWithId(messageId, messageContent).catch(async (error) => {
			if (error instanceof Error && error.message === 'Interrupted by user') {
				return;
			}

			const isTimeoutError = error instanceof Error && error.name === 'MessageQueueTimeoutError';
			await this.errorManager.handleError(
				this.session.id,
				error as Error,
				isTimeoutError ? ErrorCategory.TIMEOUT : ErrorCategory.MESSAGE,
				isTimeoutError
					? 'The SDK is not responding. Click "Reset Agent" to recover.'
					: 'Failed to process message. Please try again.',
				this.stateManager.getState(),
				{ messageId }
			);

			if (isTimeoutError) {
				try {
					await this.resetQuery({ restartQuery: true });
					await this.stateManager.setQueued(messageId);
					this.messageQueue.enqueueWithId(messageId, messageContent).catch(async () => {
						await this.stateManager.setIdle();
					});
				} catch {
					await this.stateManager.setIdle();
				}
			} else {
				await this.stateManager.setIdle();
			}
		});

		this.daemonHub.emit('message.sent', { sessionId: this.session.id }).catch(() => {});
	}

	// ============================================================================
	// Interrupt and Reset
	// ============================================================================

	async handleInterrupt(): Promise<void> {
		await this.interruptHandler.handleInterrupt();
	}

	async resetQuery(options?: {
		restartQuery?: boolean;
	}): Promise<{ success: boolean; error?: string }> {
		const { restartQuery = true } = options ?? {};

		if (!this.queryObject && !this.queryPromise) {
			this.messageQueue.clear();
			this.pendingRestartReason = null;
			this.messageHandler.resetCircuitBreaker();
			await this.stateManager.setIdle();
			return { success: true };
		}

		return await this.lifecycleManager.reset({
			restartAfter: restartQuery,
			onBeforeStop: async () => {
				const lastSdkCost = this.session.metadata?.lastSdkCost || 0;
				const costBaseline = this.session.metadata?.costBaseline || 0;
				if (lastSdkCost > 0) {
					this.session.metadata = {
						...this.session.metadata,
						costBaseline: costBaseline + lastSdkCost,
						lastSdkCost: 0,
					};
					this.db.updateSession(this.session.id, { metadata: this.session.metadata });
				}
				this.messageQueue.clear();
				this.pendingRestartReason = null;
				this.messageHandler.resetCircuitBreaker();
				await this.daemonHub.emit('session.errorClear', { sessionId: this.session.id });
			},
			onAfterStop: async () => {
				this.firstMessageReceived = false;
				await this.stateManager.setIdle();
			},
			onAfterRestart: async () => {
				await this.messageHub.publish(
					'session.reset',
					{ message: 'Agent has been reset and is ready for new messages' },
					{ sessionId: this.session.id }
				);
			},
		});
	}

	// ============================================================================
	// Question Handling
	// ============================================================================

	async handleQuestionResponse(
		toolUseId: string,
		responses: QuestionDraftResponse[]
	): Promise<void> {
		const currentState = this.stateManager.getState();
		let pendingQuestion: PendingUserQuestion | null = null;
		if (currentState.status === 'waiting_for_input') {
			pendingQuestion = currentState.pendingQuestion;
		}

		await this.askUserQuestionHandler.handleQuestionResponse(toolUseId, responses);

		if (pendingQuestion) {
			const resolvedQuestions = { ...this.session.metadata?.resolvedQuestions };
			resolvedQuestions[toolUseId] = {
				question: pendingQuestion,
				state: 'submitted',
				responses,
				resolvedAt: Date.now(),
			};
			this.updateMetadata({ metadata: { ...this.session.metadata, resolvedQuestions } });
		}
	}

	async updateQuestionDraft(draftResponses: QuestionDraftResponse[]): Promise<void> {
		await this.askUserQuestionHandler.updateQuestionDraft(draftResponses);
	}

	async handleQuestionCancel(toolUseId: string): Promise<void> {
		const currentState = this.stateManager.getState();
		let pendingQuestion: PendingUserQuestion | null = null;
		if (currentState.status === 'waiting_for_input') {
			pendingQuestion = currentState.pendingQuestion;
		}

		await this.askUserQuestionHandler.handleQuestionCancel(toolUseId);

		if (pendingQuestion) {
			const resolvedQuestions = { ...this.session.metadata?.resolvedQuestions };
			resolvedQuestions[toolUseId] = {
				question: pendingQuestion,
				state: 'cancelled',
				responses: [],
				resolvedAt: Date.now(),
			};
			this.updateMetadata({ metadata: { ...this.session.metadata, resolvedQuestions } });
		}
	}

	// ============================================================================
	// Circuit Breaker
	// ============================================================================

	private async handleCircuitBreakerTrip(reason: string, userMessage: string): Promise<void> {
		this.logger.log(`Handling circuit breaker trip: ${reason}`);
		try {
			await this.resetQuery({ restartQuery: false });
			await this.queryRunner.displayErrorAsAssistantMessage(
				`⚠️ **Session Stopped: Error Loop Detected**\n\n${userMessage}\n\n` +
					`The agent has been automatically stopped to prevent further errors.`
			);
			await this.errorManager.handleError(
				this.session.id,
				new Error(`Circuit breaker tripped: ${reason}`),
				ErrorCategory.SYSTEM,
				userMessage,
				this.stateManager.getState(),
				{ circuitBreakerReason: reason }
			);
		} catch (error) {
			this.logger.error('Error handling circuit breaker trip:', error);
			await this.stateManager.setIdle();
		}
	}

	// ============================================================================
	// Model Switching
	// ============================================================================

	async handleModelSwitch(
		newModel: string
	): Promise<{ success: boolean; model: string; error?: string }> {
		return this.modelSwitchHandler.switchModel(newModel);
	}

	getCurrentModel(): CurrentModelInfo {
		return this.modelSwitchHandler.getCurrentModel();
	}

	// ============================================================================
	// SDK Runtime Config
	// ============================================================================

	async setMaxThinkingTokens(tokens: number | null): Promise<{ success: boolean; error?: string }> {
		return this.sdkRuntimeConfig.setMaxThinkingTokens(tokens);
	}

	async setPermissionMode(mode: string): Promise<{ success: boolean; error?: string }> {
		return this.sdkRuntimeConfig.setPermissionMode(mode);
	}

	async getMcpServerStatus(): Promise<Array<{ name: string; status: string; error?: string }>> {
		return this.sdkRuntimeConfig.getMcpServerStatus();
	}

	async updateToolsConfig(
		tools: Session['config']['tools']
	): Promise<{ success: boolean; error?: string }> {
		return this.sdkRuntimeConfig.updateToolsConfig(tools);
	}

	// ============================================================================
	// Config and Metadata
	// ============================================================================

	async updateConfig(configUpdates: Partial<Session['config']>): Promise<void> {
		this.session.config = { ...this.session.config, ...configUpdates };
		this.db.updateSession(this.session.id, { config: this.session.config });
		await this.daemonHub.emit('session.updated', {
			sessionId: this.session.id,
			source: 'config-update',
			session: { config: this.session.config },
		});
	}

	updateMetadata(updates: Partial<Session>): void {
		if (updates.title) this.session.title = updates.title;
		if (updates.workspacePath) {
			this.session.workspacePath = updates.workspacePath;
			this.settingsManager = new SettingsManager(this.db, updates.workspacePath);
		}
		if (updates.status) this.session.status = updates.status;
		if (updates.metadata) {
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
		if (updates.archivedAt !== undefined) this.session.archivedAt = updates.archivedAt;
		if (updates.worktree !== undefined) this.session.worktree = updates.worktree;
		this.db.updateSession(this.session.id, updates);
	}

	// ============================================================================
	// Getters
	// ============================================================================

	getProcessingState(): AgentProcessingState {
		return this.stateManager.getState();
	}

	getContextInfo(): ContextInfo | null {
		return this.contextTracker.getContextInfo();
	}

	getQueryObject(): Query | null {
		return this.queryObject;
	}

	getFirstMessageReceived(): boolean {
		return this.firstMessageReceived;
	}

	getSessionData(): Session {
		return this.session;
	}

	getSDKMessages(limit?: number, before?: number, since?: number) {
		return this.db.getSDKMessages(this.session.id, limit, before, since);
	}

	getSDKMessageCount(): number {
		return this.db.getSDKMessageCount(this.session.id);
	}

	getSDKSessionId(): string | null {
		if (!this.queryObject || !('sessionId' in this.queryObject)) return null;
		return this.queryObject.sessionId as string;
	}

	async getSlashCommands(): Promise<string[]> {
		return this.slashCommandManager.getSlashCommands();
	}

	async handleQueryTrigger(): Promise<{ success: boolean; messageCount: number; error?: string }> {
		return this.queryModeHandler.handleQueryTrigger();
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private async fetchAndCacheModels(): Promise<void> {
		if (!this.queryObject) return;
		try {
			const { getSupportedModelsFromQuery } = await import('../model-service');
			await getSupportedModelsFromQuery(this.queryObject, this.session.id);
		} catch (error) {
			this.logger.warn('Failed to fetch models from SDK:', error);
		}
	}

	private async restartQuery(): Promise<void> {
		if (!this.messageQueue.isRunning() || !this.queryObject) return;

		const currentState = this.stateManager.getState();
		if (currentState.status === 'processing') {
			this.pendingRestartReason = 'settings.local.json';
			return;
		}

		await this.lifecycleManager.restart();
	}

	private async executeDeferredRestartIfPending(): Promise<void> {
		if (!this.pendingRestartReason) return;

		const reason = this.pendingRestartReason;
		this.pendingRestartReason = null;

		this.logger.log(`Agent became idle, executing deferred restart (reason: ${reason})`);
		try {
			await this.lifecycleManager.restart();
		} catch (error) {
			this.logger.error(`Deferred restart failed (${reason}):`, error);
		}
	}

	// ============================================================================
	// Cleanup
	// ============================================================================

	async cleanup(): Promise<void> {
		const cleanupStart = Date.now();
		this.logger.log('[AgentSession] Starting cleanup...');
		this.isCleaningUp = true;

		// Phase 1: Unsubscribe from events
		this.eventSubscriptionSetup.cleanup();

		// Phase 2: Clear models cache
		try {
			const { clearModelsCache } = await import('../model-service');
			clearModelsCache(this.session.id);
		} catch {}

		// Phase 3: Stop query
		try {
			await this.lifecycleManager.stop({ timeoutMs: 15000, catchQueryErrors: true });
			await new Promise((r) => setTimeout(r, 1000));
		} catch (error) {
			this.logger.error('[AgentSession] Error during query stop:', error);
		}

		this.logger.log(`[AgentSession] Cleanup complete (${Date.now() - cleanupStart}ms total)`);
	}
}
