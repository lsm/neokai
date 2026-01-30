/**
 * AgentSession - Pure Facade/Orchestrator for Claude Agent SDK Sessions
 *
 * ## Architecture: Handler Context Pattern
 *
 * This class is a thin orchestrator that delegates ALL business logic to handlers.
 * AgentSession itself contains NO implementation code - only:
 * 1. Handler instantiation and wiring
 * 2. Public API methods that delegate to handlers
 * 3. Context interface implementation (getters/setters for handler access)
 *
 * ## How to Add New Features
 *
 * 1. Create a new handler file: `my-feature-handler.ts`
 * 2. Define a context interface with required dependencies:
 *    ```typescript
 *    export interface MyFeatureHandlerContext {
 *      readonly session: Session;
 *      readonly db: Database;
 *      // ... other needed properties
 *    }
 *    ```
 * 3. Create handler class that takes context:
 *    ```typescript
 *    export class MyFeatureHandler {
 *      constructor(private ctx: MyFeatureHandlerContext) {}
 *      myMethod() { ... }
 *    }
 *    ```
 * 4. Add `MyFeatureHandlerContext` to AgentSession implements list
 * 5. Add handler property and instantiate in constructor
 * 6. Add delegation method: `myMethod() { return this.myFeatureHandler.myMethod(); }`
 *
 * ## Handler Categories
 *
 * **Core Components** (stateful, used by multiple handlers):
 * - MessageQueue: Message queueing with AsyncGenerator
 * - ProcessingStateManager: State machine for processing phases
 * - ContextTracker: Real-time context window usage
 * - CheckpointTracker: Rewind checkpoint tracking
 *
 * **Business Logic Handlers**:
 * - QueryLifecycleManager: Query start/stop/restart/cleanup
 * - SDKMessageHandler: SDK message processing, circuit breaker
 * - AskUserQuestionHandler: User question/answer flow
 * - ModelSwitchHandler: Runtime model switching
 * - RewindHandler: Checkpoint rewind operations
 * - SessionConfigHandler: Config and metadata updates
 * - InterruptHandler: User interrupt handling
 *
 * **Infrastructure Handlers**:
 * - QueryRunner: Low-level query execution
 * - QueryOptionsBuilder: SDK options construction
 * - SDKRuntimeConfig: Runtime SDK settings
 * - EventSubscriptionSetup: DaemonHub event wiring
 * - QueryModeHandler: Manual/auto-queue mode
 * - SlashCommandManager: Slash command caching
 * - MessageRecoveryHandler: Orphaned message recovery
 *
 * ## SDK Mode
 *
 * Uses STREAMING INPUT mode - a single persistent SDK query with AsyncGenerator
 * that continuously yields messages from a queue.
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type {
	AgentProcessingState,
	MessageContent,
	Session,
	ContextInfo,
	QuestionDraftResponse,
	MessageHub,
	CurrentModelInfo,
	Checkpoint,
	RewindPreview,
	RewindResult,
	RewindMode,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import { Database } from '../../storage/database';
import { ErrorManager } from '../error-manager';
import { Logger } from '../logger';
import { SettingsManager } from '../settings-manager';

// Extracted components
import { MessageQueue } from './message-queue';
import { ProcessingStateManager } from './processing-state-manager';
import { ContextTracker } from './context-tracker';
import { SDKMessageHandler, type SDKMessageHandlerContext } from './sdk-message-handler';
import { QueryOptionsBuilder, type QueryOptionsBuilderContext } from './query-options-builder';
import {
	QueryLifecycleManager,
	type QueryLifecycleManagerContext,
} from './query-lifecycle-manager';
import { ModelSwitchHandler, type ModelSwitchHandlerContext } from './model-switch-handler';
import {
	AskUserQuestionHandler,
	type AskUserQuestionHandlerContext,
} from './ask-user-question-handler';
import { QueryRunner, type QueryRunnerContext, type OriginalEnvVars } from './query-runner';
import { InterruptHandler, type InterruptHandlerContext } from './interrupt-handler';
import { SDKRuntimeConfig, type SDKRuntimeConfigContext } from './sdk-runtime-config';
import {
	EventSubscriptionSetup,
	type EventSubscriptionSetupContext,
} from './event-subscription-setup';
import { QueryModeHandler, type QueryModeHandlerContext } from './query-mode-handler';
import { SlashCommandManager, type SlashCommandManagerContext } from './slash-command-manager';
import { MessageRecoveryHandler } from './message-recovery-handler';
import { CheckpointTracker } from './checkpoint-tracker';
import { RewindHandler, type RewindHandlerContext } from './rewind-handler';
import { SessionConfigHandler, type SessionConfigHandlerContext } from './session-config-handler';

/**
 * AgentSession - Pure facade that delegates to specialized handlers
 *
 * Implements all handler context interfaces so handlers can access state directly.
 * This class should contain NO business logic - only delegation and wiring.
 */
export class AgentSession
	implements
		RewindHandlerContext,
		InterruptHandlerContext,
		SDKRuntimeConfigContext,
		QueryModeHandlerContext,
		SlashCommandManagerContext,
		ModelSwitchHandlerContext,
		QueryRunnerContext,
		SDKMessageHandlerContext,
		QueryLifecycleManagerContext,
		AskUserQuestionHandlerContext,
		QueryOptionsBuilderContext,
		EventSubscriptionSetupContext,
		SessionConfigHandlerContext
{
	// Core components (accessible to handlers via context interfaces)
	readonly messageQueue: MessageQueue;
	readonly stateManager: ProcessingStateManager;
	readonly contextTracker: ContextTracker;
	readonly messageHandler: SDKMessageHandler;
	readonly lifecycleManager: QueryLifecycleManager;
	readonly modelSwitchHandler: ModelSwitchHandler;
	readonly askUserQuestionHandler: AskUserQuestionHandler;
	readonly optionsBuilder: QueryOptionsBuilder;

	// Extracted handlers (accessible to EventSubscriptionSetupContext)
	private queryRunner: QueryRunner;
	readonly interruptHandler: InterruptHandler;
	private sdkRuntimeConfig: SDKRuntimeConfig;
	private eventSubscriptionSetup: EventSubscriptionSetup;
	readonly queryModeHandler: QueryModeHandler;
	private slashCommandManager: SlashCommandManager;

	// Rewind support (accessible to handlers)
	readonly checkpointTracker: CheckpointTracker;
	private rewindHandler: RewindHandler;

	// Config handler
	private sessionConfigHandler: SessionConfigHandler;

	// SDK query state (accessible to handlers via context interfaces)
	queryObject: Query | null = null;
	queryPromise: Promise<void> | null = null;
	private _queryGeneration = 0;
	queryAbortController: AbortController | null = null;
	firstMessageReceived = false;
	startupTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
	originalEnvVars: OriginalEnvVars = {};

	// Session state
	private _isCleaningUp = false;
	pendingRestartReason: 'settings.local.json' | null = null;

	// Services (accessible to handlers)
	readonly errorManager: ErrorManager;
	settingsManager: SettingsManager;
	readonly logger: Logger;

	constructor(
		readonly session: Session,
		readonly db: Database,
		readonly messageHub: MessageHub,
		readonly daemonHub: DaemonHub,
		private getApiKey: () => Promise<string | null>
	) {
		this.errorManager = new ErrorManager(this.messageHub, this.daemonHub);
		this.logger = new Logger(`AgentSession ${session.id}`);
		this.settingsManager = new SettingsManager(this.db, this.session.workspacePath);

		// Initialize core components (order matters - some handlers depend on earlier ones)
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

		// Initialize CheckpointTracker early (needed by SDKMessageHandler)
		this.checkpointTracker = new CheckpointTracker(session.id, this.daemonHub);

		// Initialize SDKMessageHandler (handlers take AgentSession context directly)
		this.messageHandler = new SDKMessageHandler(this);

		// Initialize QueryLifecycleManager (handlers take AgentSession context directly)
		this.lifecycleManager = new QueryLifecycleManager(this);

		// Initialize model switch handler (handlers take AgentSession context directly)
		this.modelSwitchHandler = new ModelSwitchHandler(this);

		// Initialize AskUserQuestion handler (handlers take AgentSession context directly)
		this.askUserQuestionHandler = new AskUserQuestionHandler(this);

		// Initialize QueryOptionsBuilder (handlers take AgentSession context directly)
		this.optionsBuilder = new QueryOptionsBuilder(this);

		// Initialize QueryRunner (handlers take AgentSession context directly)
		this.queryRunner = new QueryRunner(this);

		// Initialize InterruptHandler (handlers take AgentSession context directly)
		this.interruptHandler = new InterruptHandler(this);

		// Initialize SDKRuntimeConfig (handlers take AgentSession context directly)
		this.sdkRuntimeConfig = new SDKRuntimeConfig(this);

		// Initialize QueryModeHandler (handlers take AgentSession context directly)
		this.queryModeHandler = new QueryModeHandler(this);

		// Initialize SlashCommandManager (handlers take AgentSession context directly)
		this.slashCommandManager = new SlashCommandManager(this);

		// Initialize RewindHandler (handlers take AgentSession context directly)
		this.rewindHandler = new RewindHandler(this);

		// Initialize SessionConfigHandler (handlers take AgentSession context directly)
		this.sessionConfigHandler = new SessionConfigHandler(this);

		// Initialize EventSubscriptionSetup (handlers take AgentSession context directly)
		// Must be last since it needs other handlers to be initialized
		this.eventSubscriptionSetup = new EventSubscriptionSetup(this);

		// Set state manager callback - delegates to lifecycleManager
		this.stateManager.setOnIdleCallback(async () => {
			await this.lifecycleManager.executeDeferredRestartIfPending();
		});

		// Restore persisted state
		if (session.metadata?.lastContextInfo) {
			this.contextTracker.restoreFromMetadata(session.metadata.lastContextInfo);
		}
		this.stateManager.restoreFromDatabase();

		// Recover orphaned messages
		const recoveryHandler = new MessageRecoveryHandler(session, db, this.logger);
		recoveryHandler.recoverOrphanedSentMessages();

		// Setup event subscriptions (moved callbacks into EventSubscriptionSetup)
		this.eventSubscriptionSetup.setup();
	}

	// ============================================================================
	// Query Lifecycle
	// ============================================================================

	async startStreamingQuery(): Promise<void> {
		await this.queryRunner.start();
	}

	async ensureQueryStarted(): Promise<void> {
		await this.lifecycleManager.ensureQueryStarted();
	}

	async startQueryAndEnqueue(
		messageId: string,
		messageContent: string | MessageContent[]
	): Promise<void> {
		await this.lifecycleManager.startQueryAndEnqueue(messageId, messageContent);
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
		return await this.lifecycleManager.reset({ restartAfter: options?.restartQuery });
	}

	// ============================================================================
	// Question Handling (delegated to AskUserQuestionHandler)
	// ============================================================================

	async handleQuestionResponse(
		toolUseId: string,
		responses: QuestionDraftResponse[]
	): Promise<void> {
		await this.askUserQuestionHandler.handleQuestionResponse(toolUseId, responses);
	}

	async updateQuestionDraft(draftResponses: QuestionDraftResponse[]): Promise<void> {
		await this.askUserQuestionHandler.updateQuestionDraft(draftResponses);
	}

	async handleQuestionCancel(toolUseId: string): Promise<void> {
		await this.askUserQuestionHandler.handleQuestionCancel(toolUseId);
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
	// Config and Metadata (delegated to SessionConfigHandler)
	// ============================================================================

	async updateConfig(configUpdates: Partial<Session['config']>): Promise<void> {
		await this.sessionConfigHandler.updateConfig(configUpdates);
	}

	updateMetadata(updates: Partial<Session>): void {
		this.sessionConfigHandler.updateMetadata(updates);
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

	async restartQuery(): Promise<void> {
		await this.lifecycleManager.restartQuery();
	}

	// ============================================================================
	// Rewind Feature (delegated to RewindHandler)
	// ============================================================================

	getCheckpoints(): Checkpoint[] {
		return this.rewindHandler.getCheckpoints();
	}

	previewRewind(checkpointId: string): Promise<RewindPreview> {
		return this.rewindHandler.previewRewind(checkpointId);
	}

	executeRewind(checkpointId: string, mode: RewindMode): Promise<RewindResult> {
		return this.rewindHandler.executeRewind(checkpointId, mode);
	}

	// ============================================================================
	// QueryRunnerContext methods
	// ============================================================================

	incrementQueryGeneration(): number {
		return ++this._queryGeneration;
	}

	getQueryGeneration(): number {
		return this._queryGeneration;
	}

	isCleaningUp(): boolean {
		return this._isCleaningUp;
	}

	async onSDKMessage(message: import('@neokai/shared/sdk').SDKMessage): Promise<void> {
		await this.messageHandler.handleMessage(message);
	}

	async onSlashCommandsFetched(): Promise<void> {
		await this.slashCommandManager.fetchAndCache();
	}

	async onModelsFetched(): Promise<void> {
		if (!this.queryObject) return;
		try {
			const { getSupportedModelsFromQuery } = await import('../model-service');
			await getSupportedModelsFromQuery(this.queryObject, this.session.id);
		} catch (error) {
			this.logger.warn('Failed to fetch models from SDK:', error);
		}
	}

	async onMarkApiSuccess(): Promise<void> {
		this.errorManager.markApiSuccess();
	}

	// ============================================================================
	// QueryLifecycleManagerContext methods
	// ============================================================================

	setCleaningUp(value: boolean): void {
		this._isCleaningUp = value;
	}

	cleanupEventSubscriptions(): void {
		this.eventSubscriptionSetup.cleanup();
	}

	async clearModelsCache(): Promise<void> {
		const { clearModelsCache } = await import('../model-service');
		clearModelsCache(this.session.id);
	}

	// ============================================================================
	// Cleanup (delegated to QueryLifecycleManager)
	// ============================================================================

	async cleanup(): Promise<void> {
		await this.lifecycleManager.cleanup();
	}
}
