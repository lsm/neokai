/**
 * RPC Handler Registration
 *
 * Registers all RPC handlers on MessageHub.
 * Organized by domain for better maintainability.
 */

import type { MessageHub, MessageDeliveryMode, MessageOrigin } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SessionManager } from '../session-manager';
import type { AuthManager } from '../auth-manager';
import type { SettingsManager } from '../settings-manager';
import type { Config } from '../../config';
import type { Database } from '../../storage/database';
import type { ReactiveDatabase } from '../../storage/reactive-database';

import { setupSessionHandlers } from './session-handlers';
import { setupMessageHandlers } from './message-handlers';
import { setupFileHandlers } from './file-handlers';
import { setupSystemHandlers } from './system-handlers';
import { setupAuthHandlers } from './auth-handlers';
import { setupCommandHandlers } from './command-handlers';
import { setupQuestionHandlers } from './question-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { setupConfigHandlers } from './config-handlers';
import { setupTestHandlers } from './test-handlers';
import { setupRewindHandlers } from './rewind-handlers';
import { RoomManager } from '../room';
// New split handlers for Neo functionality
import { setupRoomHandlers, setupRoomRuntimeHandlers } from './room-handlers';
import { setupTaskHandlers } from './task-handlers';
import { setupGitHubHandlers } from './github-handlers';
import type { GitHubService } from '../github/github-service';
// New handlers for goals
import {
	setupGoalHandlers,
	type GoalManagerFactory,
	type TaskManagerFactory as GoalTaskManagerFactory,
} from './goal-handlers';
import { RoomRuntimeService } from '../room/runtime/room-runtime-service';
import { Logger } from '../logger';
import { GoalManager } from '../room/managers/goal-manager';
import { TaskManager } from '../room/managers/task-manager';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { setupDialogHandlers } from './dialog-handlers';
// Space handlers
import { setupSpaceHandlers } from './space-handlers';
import { setupSpaceTaskHandlers, type SpaceTaskManagerFactory } from './space-task-handlers';
import { setupSpaceTaskMessageHandlers } from './space-task-message-handlers';
import { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository';
import { TaskAgentManager } from '../space/runtime/task-agent-manager';
import { SpaceWorktreeManager } from '../space/managers/space-worktree-manager';
import { setupSpaceWorkflowHandlers } from './space-workflow-handlers';
import type { SpaceManager } from '../space/managers/space-manager';
import { SpaceTaskManager } from '../space/managers/space-task-manager';
import { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceAgentLookup } from '../space/managers/space-workflow-manager';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import { GateDataRepository } from '../../storage/repositories/gate-data-repository';
import { ChannelCycleRepository } from '../../storage/repositories/channel-cycle-repository';
import { setupSpaceAgentHandlers } from './space-agent-handlers';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
import { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { JobQueueProcessor } from '../../storage/job-queue-processor';
import { enqueueRoomTick } from '../job-handlers/room-tick.handler';
import { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { setupSpaceWorkflowRunHandlers } from './space-workflow-run-handlers';
import type { SpaceWorkflowRunTaskManagerFactory } from './space-workflow-run-handlers';
import { setupNodeExecutionHandlers } from './space-node-execution-handlers';
import { setupSpaceExportImportHandlers } from './space-export-import-handlers';
import { provisionGlobalSpacesAgent } from '../space/provision-global-agent';
import { setupGlobalSpacesHandlers } from './global-spaces-handlers';
import { setupLiveQueryHandlers } from './live-query-handlers';
import { setupReferenceHandlers } from './reference-handlers';
import { FileIndex } from '../file-index';
import { LiveQueryEngine } from '../../storage/live-query';
import type { AppMcpLifecycleManager } from '../mcp';
import { registerAppMcpHandlers, setupAppMcpHandlers } from './app-mcp-handlers';
import { registerSkillHandlers } from './skill-handlers';
import type { SkillsManager } from '../skills-manager';
import { setupNeoHandlers } from './neo-handlers';
import type { NeoAgentManager } from '../neo/neo-agent-manager';
import { NeoActivityLogger } from '../neo/activity-logger';
import { PendingActionStore } from '../neo/security-tier';
import type { NeoToolsConfig } from '../neo/tools/neo-query-tools';
import type { NeoActionToolsConfig, NeoWorkflowRun } from '../neo/tools/neo-action-tools';
import {
	createGlobalSpacesToolHandlers,
	type GlobalSpacesState,
} from '../space/tools/global-spaces-tools';

export interface RPCHandlerDependencies {
	messageHub: MessageHub;
	sessionManager: SessionManager;
	authManager: AuthManager;
	settingsManager: SettingsManager;
	config: Config;
	daemonHub: DaemonHub;
	db: Database;
	gitHubService?: GitHubService;
	/** Space manager instance — shared with DaemonAppContext (single source of truth) */
	spaceManager: SpaceManager;
	spaceAgentManager: SpaceAgentManager;
	/**
	 * Persistent job queue repository.
	 * TODO: consumed by Milestones 2–5 handlers (session title generation,
	 * GitHub polling, room tick, cleanup jobs).
	 */
	jobQueue: JobQueueRepository;
	/**
	 * Persistent job queue processor.
	 * TODO: consumed by Milestones 2–5 handlers for registering queue handlers.
	 */
	jobProcessor: JobQueueProcessor;
	/** Reactive database wrapper for change event emission */
	reactiveDb: ReactiveDatabase;
	/** Live query engine for reactive SQL subscriptions */
	liveQueries: LiveQueryEngine;
	/** Application-level MCP lifecycle manager */
	appMcpManager: AppMcpLifecycleManager;
	/** Application-level Skills manager */
	skillsManager: SkillsManager;
	/** Neo agent manager — singleton global AI assistant */
	neoAgentManager: NeoAgentManager;
}

const log = new Logger('rpc-handlers');

/**
 * Cleanup function type for RPC handlers
 */
export type RPCHandlerCleanup = () => void;

/**
 * Result returned by setupRPCHandlers — includes both the cleanup function
 * and any services that need to be surfaced in DaemonAppContext.
 */
export interface RPCHandlerSetupResult {
	cleanup: RPCHandlerCleanup;
	spaceRuntimeService: SpaceRuntimeService;
	taskAgentManager: TaskAgentManager;
	spaceWorktreeManager: SpaceWorktreeManager;
}

/**
 * Register all RPC handlers on MessageHub
 * Returns a result with cleanup function and exposed services
 */
export function setupRPCHandlers(deps: RPCHandlerDependencies): RPCHandlerSetupResult {
	// Room handlers (create roomManager first as session handlers depend on it)
	const roomManager = new RoomManager(deps.db.getDatabase(), deps.reactiveDb);

	// Create factory function for per-room goal managers
	const goalManagerFactory: GoalManagerFactory = (roomId: string) => {
		return new GoalManager(
			deps.db.getDatabase(),
			roomId,
			deps.reactiveDb,
			deps.db.getShortIdAllocator()
		);
	};

	// Create factory function for per-room task managers (used by goal review handlers)
	const goalTaskManagerFactory: GoalTaskManagerFactory = (roomId: string) => {
		const taskManager = new TaskManager(
			deps.db.getDatabase(),
			roomId,
			deps.reactiveDb,
			deps.db.getShortIdAllocator()
		);
		const taskRepo = new TaskRepository(deps.db.getDatabase(), deps.reactiveDb);
		return { taskManager, taskRepo };
	};

	setupSessionHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub, roomManager);
	setupMessageHandlers(deps.messageHub, deps.sessionManager, deps.db);
	setupCommandHandlers(deps.messageHub, deps.sessionManager);
	setupFileHandlers(deps.messageHub, deps.sessionManager);
	setupSystemHandlers(deps.messageHub, deps.sessionManager, deps.authManager, deps.config);
	setupAuthHandlers(deps.messageHub, deps.authManager);
	// Note: setupQuestionHandlers is called after roomRuntimeService is created below
	// so that it can receive a runtime session lookup function. Room worker/leader
	// sessions live in RoomRuntimeService.agentSessions (separate from SessionManager),
	// so the handler needs to check the runtime pool first.
	registerMcpHandlers(deps.messageHub, deps.sessionManager, deps.appMcpManager);
	registerSettingsHandlers(deps.messageHub, deps.settingsManager, deps.daemonHub, deps.db);
	setupConfigHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub);
	// Use reactiveDb.db so test-injected sdk_messages rows also invalidate LiveQuery.
	setupTestHandlers(deps.messageHub, deps.reactiveDb.db);
	setupRewindHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub);

	// Room Runtime Service (must be created before task/goal handlers — messaging + task approval need it)
	// Also created before setupRoomHandlers so the hasActiveTaskGroups callback can reference it.
	const roomRuntimeService = new RoomRuntimeService({
		// Use reactiveDb.db (proxied Database facade) so sdk_messages writes from
		// room worker/leader sessions trigger LiveQuery invalidation immediately.
		db: deps.reactiveDb.db,
		messageHub: deps.messageHub,
		daemonHub: deps.daemonHub,
		getApiKey: () => deps.authManager.getCurrentApiKey(),
		roomManager,
		sessionManager: deps.sessionManager,
		defaultWorkspacePath: deps.config.workspaceRoot,
		defaultModel: deps.config.defaultModel,
		getGlobalSettings: () => deps.settingsManager.getGlobalSettings(),
		settingsManager: deps.settingsManager,
		appMcpManager: deps.appMcpManager,
		reactiveDb: deps.reactiveDb,
		jobQueue: deps.jobQueue,
		jobProcessor: deps.jobProcessor,
		skillsManager: deps.skillsManager,
		appMcpServerRepo: deps.reactiveDb.db.appMcpServers,
		roomSkillOverrideRepo: deps.reactiveDb.db.roomSkillOverrides,
		dbPath: deps.db.getDatabasePath(),
		disableGoalProcessing: deps.config.disableGoalProcessing,
	});

	// Seed an initial room.tick job for every room after startup, and for each
	// newly created room. The handler's finally block keeps the loop going; this
	// is the only bootstrap call needed.
	const seedRoomTick = (roomId: string) => enqueueRoomTick(roomId, deps.jobQueue);

	roomRuntimeService
		.start()
		.then(() => {
			for (const room of roomManager.listRooms()) {
				seedRoomTick(room.id);
			}
		})
		.catch((error) => {
			log.error('Failed to start RoomRuntimeService:', error);
		});

	// Seed a tick for rooms created after startup.
	const unsubRoomCreated = deps.daemonHub.on(
		'room.created',
		(event) => {
			seedRoomTick(event.room.id);
		},
		{ sessionId: 'global' }
	);

	// Room handlers — registered after roomRuntimeService so hasActiveTaskGroups callback
	// can reference the service (which queries the DB for active groups, not in-memory state).
	setupRoomHandlers(
		deps.messageHub,
		roomManager,
		deps.daemonHub,
		deps.sessionManager,
		deps.jobQueue,
		deps.db,
		{ hasActiveTaskGroups: (roomId) => roomRuntimeService.hasActiveTaskGroups(roomId) }
	);

	// Wire question handlers now that roomRuntimeService is available.
	// Pass its session lookup so question.respond reaches the correct live AgentSession
	// (room worker/leader sessions are stored in RoomRuntimeService.agentSessions,
	// not in SessionManager's cache).
	setupQuestionHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub, (sessionId) =>
		roomRuntimeService.getAgentSession(sessionId)
	);

	setupRoomRuntimeHandlers(deps.messageHub, deps.daemonHub, roomRuntimeService, deps.jobQueue);
	setupTaskHandlers(
		deps.messageHub,
		roomManager,
		deps.daemonHub,
		deps.db,
		deps.reactiveDb,
		undefined,
		roomRuntimeService,
		deps.sessionManager
	);

	// Goal handlers (after runtime service — task.approve/task.reject need runtimeService)
	setupGoalHandlers(
		deps.messageHub,
		deps.daemonHub,
		goalManagerFactory,
		goalTaskManagerFactory,
		roomRuntimeService
	);

	// GitHub handlers
	setupGitHubHandlers(
		deps.messageHub,
		deps.daemonHub,
		deps.db,
		roomManager,
		deps.gitHubService ?? null
	);

	// Dialog handlers (native OS dialogs)
	setupDialogHandlers(deps.messageHub);

	// Reference handlers (@ mention system — search + resolve tasks, goals, files, folders)
	const fileIndex = new FileIndex(deps.config.workspaceRoot);
	fileIndex.init().catch((err) => {
		log.warn('FileIndex init failed:', err);
	});
	setupReferenceHandlers(deps.messageHub, {
		db: deps.db.getDatabase(),
		reactiveDb: deps.reactiveDb,
		shortIdAllocator: deps.db.getShortIdAllocator(),
		sessionManager: deps.sessionManager,
		taskRepo: new TaskRepository(deps.db.getDatabase(), deps.reactiveDb),
		goalRepo: deps.db.getGoalRepo(),
		workspaceRoot: deps.config.workspaceRoot,
		fileIndex,
		getRoomDefaultPath: (roomId: string) => roomManager.getRoom(roomId)?.defaultPath ?? undefined,
	});

	// LiveQuery subscribe/unsubscribe handlers
	const unsubLiveQuery = setupLiveQueryHandlers(
		deps.messageHub,
		deps.liveQueries,
		deps.db.getDatabase()
	);

	// App-level MCP registry handlers
	registerAppMcpHandlers(deps.messageHub, {
		db: deps.db,
		daemonHub: deps.daemonHub,
	});

	// Per-room MCP enablement RPC handlers
	setupAppMcpHandlers(deps.messageHub, deps.daemonHub, deps.db);

	// Skills registry RPC handlers
	registerSkillHandlers(
		deps.messageHub,
		deps.skillsManager,
		deps.daemonHub,
		deps.config.workspaceRoot
	);

	// Neo global agent RPC handlers
	// The PendingActionStore is created here (application lifecycle) so it is
	// shared across confirmAction / cancelAction calls in the same daemon process.
	const neoPendingActions = new PendingActionStore();
	setupNeoHandlers(
		deps.messageHub,
		deps.neoAgentManager,
		deps.sessionManager,
		deps.settingsManager,
		deps.db,
		neoPendingActions
	);

	// Space handlers (spaceManager injected from deps — single instance shared with DaemonAppContext)
	const spaceTaskRepo = new SpaceTaskRepository(deps.db.getDatabase(), deps.reactiveDb);
	const spaceWorkflowRunRepo = new SpaceWorkflowRunRepository(deps.db.getDatabase());
	const gateDataRepo = new GateDataRepository(deps.db.getDatabase());
	const channelCycleRepo = new ChannelCycleRepository(deps.db.getDatabase());

	// Space workflow manager — created early so space.create can call seedBuiltInWorkflows
	const spaceWorkflowRepo = new SpaceWorkflowRepository(deps.db.getDatabase());
	const spaceAgentRepo = new SpaceAgentRepository(deps.db.getDatabase());
	const agentLookup: SpaceAgentLookup = {
		getAgentById(spaceId: string, id: string) {
			const agent = spaceAgentRepo.getById(id);
			if (!agent || agent.spaceId !== spaceId) return null;
			return { id: agent.id, name: agent.name };
		},
	};
	const spaceWorkflowManager = new SpaceWorkflowManager(spaceWorkflowRepo, agentLookup);

	// Wire Neo query tools — must happen before neoAgentManager.provision() is called
	// in app.ts (setupRPCHandlers runs first). The in-process neo-query server is merged
	// with registry-sourced servers; in-process wins on name collision.
	const neoToolsConfig: NeoToolsConfig = {
		roomManager,
		goalRepository: deps.db.getGoalRepo(),
		taskRepository: deps.db.getTaskRepo(),
		sessionManager: deps.sessionManager,
		settingsManager: deps.settingsManager,
		authManager: deps.authManager,
		mcpServerRepository: deps.db.appMcpServers,
		skillsManager: deps.skillsManager,
		workspaceRoot: deps.config.workspaceRoot,
		appVersion: '0.1.1', // TODO: centralise into a shared VERSION constant (same value in system-handlers.ts and state-manager.ts)
		startedAt: Date.now(),
		spaceManager: deps.spaceManager,
		spaceAgentManager: deps.spaceAgentManager,
		spaceWorkflowManager,
		workflowRunRepository: spaceWorkflowRunRepo,
		spaceTaskRepository: spaceTaskRepo,
	};
	deps.neoAgentManager.setToolsConfig(neoToolsConfig, deps.appMcpManager);
	deps.neoAgentManager.setDbPath(deps.db.getDatabasePath());

	const spaceTaskManagerFactory: SpaceTaskManagerFactory = (spaceId: string) => {
		return new SpaceTaskManager(deps.db.getDatabase(), spaceId, deps.reactiveDb);
	};

	setupSpaceTaskHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceTaskManagerFactory,
		deps.daemonHub
	);

	// Space agent handlers
	setupSpaceAgentHandlers(
		deps.messageHub,
		deps.daemonHub,
		deps.spaceAgentManager,
		deps.spaceManager
	);

	setupSpaceWorkflowHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceWorkflowManager,
		deps.daemonHub
	);

	// Space Runtime Service — wraps SpaceRuntime with per-space lifecycle API.
	// Not started yet: TaskAgentManager is created next and injected before start().
	// gateDataRepo is injected so notifyGateDataChanged() can trigger lazy node activation
	// after gate data is written externally (e.g. approveGate RPC, writeGateData RPC).
	// sessionManager and daemonHub are injected so space:chat:${spaceId} sessions are
	// provisioned with MCP tools and system prompts on startup and on space.created.
	const nodeExecutionRepo = new NodeExecutionRepository(deps.db.getDatabase());
	const spaceRuntimeService = new SpaceRuntimeService({
		db: deps.db.getDatabase(),
		dbPath: deps.db.getDatabasePath(),
		spaceManager: deps.spaceManager,
		spaceAgentManager: deps.spaceAgentManager,
		spaceWorkflowManager,
		workflowRunRepo: spaceWorkflowRunRepo,
		taskRepo: spaceTaskRepo,
		nodeExecutionRepo,
		reactiveDb: deps.reactiveDb,
		gateDataRepo,
		channelCycleRepo,
		sessionManager: deps.sessionManager,
		daemonHub: deps.daemonHub,
	});

	// Register Space RPC handlers now that spaceRuntimeService exists.
	// spaceRuntimeService is passed so space.create can call setupSpaceAgentSession()
	// directly after session creation, avoiding reliance on the daemonHub event.
	setupSpaceHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceTaskRepo,
		spaceWorkflowRunRepo,
		deps.daemonHub,
		deps.spaceAgentManager,
		spaceWorkflowManager,
		deps.sessionManager,
		spaceRuntimeService
	);

	// Space Worktree Manager — one worktree per task, shared by all node agents.
	const spaceWorktreeManager = new SpaceWorktreeManager(deps.db.getDatabase());

	// Task Agent Manager — manages Task Agent session lifecycle and message injection.
	// Must be created after spaceRuntimeService so it can get WorkflowExecutors via
	// spaceRuntimeService.createOrGetRuntime(spaceId).
	const taskAgentManager = new TaskAgentManager({
		// Use reactiveDb.db so Task Agent session writes invalidate LiveQuery tables.
		db: deps.reactiveDb.db,
		sessionManager: deps.sessionManager,
		reactiveDb: deps.reactiveDb,
		spaceManager: deps.spaceManager,
		spaceAgentManager: deps.spaceAgentManager,
		spaceWorkflowManager,
		spaceRuntimeService,
		taskRepo: spaceTaskRepo,
		workflowRunRepo: spaceWorkflowRunRepo,
		gateDataRepo,
		channelCycleRepo,
		daemonHub: deps.daemonHub,
		messageHub: deps.messageHub,
		getApiKey: () => deps.authManager.getCurrentApiKey(),
		defaultModel: deps.config.defaultModel,
		appMcpManager: deps.appMcpManager,
		worktreeManager: spaceWorktreeManager,
		skillsManager: deps.skillsManager,
		appMcpServerRepo: deps.reactiveDb.db.appMcpServers,
		nodeExecutionRepo,
		dbPath: deps.db.getDatabasePath(),
	});

	// Wire TaskAgentManager into the SpaceRuntime so the tick loop can spawn
	// Task Agent sessions for pending tasks. Resolves circular dependency:
	// SpaceRuntimeService → SpaceRuntime needed TaskAgentManager, which in turn
	// needed SpaceRuntimeService. Both are now created; inject via setter.
	spaceRuntimeService.setTaskAgentManager(taskAgentManager);
	spaceRuntimeService.start();

	// Wire Neo action tools — must happen before neoAgentManager.provision() in app.ts.
	// spaceRuntimeService.start() must be called first so getSharedRuntime() is available.
	// Neo uses its own GlobalSpacesState (activeSpaceId stays null — Neo always passes
	// space_id explicitly in tool calls, never relies on an ambient active-space context).
	const neoSpacesState: GlobalSpacesState = { activeSpaceId: null };
	const neoActionToolsConfig: NeoActionToolsConfig = {
		roomManager,
		managerFactory: {
			getGoalManager: (roomId: string) =>
				new GoalManager(
					deps.db.getDatabase(),
					roomId,
					deps.reactiveDb,
					deps.db.getShortIdAllocator()
				),
			getTaskManager: (roomId: string) =>
				new TaskManager(
					deps.db.getDatabase(),
					roomId,
					deps.reactiveDb,
					deps.db.getShortIdAllocator()
				),
		},
		runtimeService: roomRuntimeService,
		pendingStore: neoPendingActions,
		workspaceRoot: deps.config.workspaceRoot,
		getSecurityMode: () => deps.neoAgentManager.getSecurityMode(),
		spaceHandlers: createGlobalSpacesToolHandlers(
			{
				spaceManager: deps.spaceManager,
				spaceAgentManager: deps.spaceAgentManager,
				runtime: spaceRuntimeService.getSharedRuntime(),
				workflowManager: spaceWorkflowManager,
				taskRepo: spaceTaskRepo,
				nodeExecutionRepo,
				workflowRunRepo: spaceWorkflowRunRepo,
				db: deps.db.getDatabase(),
			},
			neoSpacesState
		),
		workflowRunRepo: spaceWorkflowRunRepo,
		spaceTaskManagerFactory: {
			getTaskManager: (spaceId: string) => new SpaceTaskManager(deps.db.getDatabase(), spaceId),
		},
		gateDataRepo,
		onGateChanged: async (runId: string, gateId: string) => {
			await spaceRuntimeService.notifyGateDataChanged(runId, gateId);
		},
		onWorkflowRunUpdated: (spaceId: string, runId: string, run: NeoWorkflowRun) => {
			deps.daemonHub
				.emit('space.workflowRun.updated', {
					sessionId: 'global',
					spaceId,
					runId,
					// NeoWorkflowRun is a subset of SpaceWorkflowRun — cast for hub emission
					run: run as unknown as Record<string, unknown>,
				})
				.catch((err) => {
					log.warn('Neo: failed to emit space.workflowRun.updated:', err);
				});
		},
		onGateDataUpdated: (
			spaceId: string,
			runId: string,
			gateId: string,
			data: Record<string, unknown>
		) => {
			deps.daemonHub
				.emit('space.gateData.updated', {
					sessionId: 'global',
					spaceId,
					runId,
					gateId,
					data,
				})
				.catch((err) => {
					log.warn('Neo: failed to emit space.gateData.updated:', err);
				});
		},
		mcpManager: {
			createMcpServer: (params) => deps.db.appMcpServers.create(params),
			updateMcpServer: (id, updates) => deps.db.appMcpServers.update(id, updates),
			deleteMcpServer: (id) => deps.db.appMcpServers.delete(id),
			getMcpServer: (id) => deps.db.appMcpServers.get(id),
			getMcpServerByName: (name) => deps.db.appMcpServers.getByName(name),
		},
		skillsManager: deps.skillsManager,
		settingsManager: deps.settingsManager,
		sessionManager: {
			injectMessage: (sessionId: string, message: string) =>
				deps.sessionManager.injectMessage(sessionId, message),
			getActiveSessionForRoom: (roomId: string) => {
				// Room sessions use a predictable ID: room:${roomId}.
				// Verify the session exists before returning it so callers receive
				// null (→ clean error) instead of injecting into a non-existent session.
				const sessionId = `room:${roomId}`;
				return deps.sessionManager.getSession(sessionId) !== null ? sessionId : null;
			},
			getActiveSessionForTask: (taskId: string) => {
				// Look up the task agent session ID stored on the SpaceTask record.
				const task = spaceTaskRepo.getTask(taskId);
				return task?.taskAgentSessionId ?? null;
			},
		},
	};
	// Wire Neo activity logger — records every tool invocation for the Activity Feed.
	const neoActivityLogger = new NeoActivityLogger(deps.db.neoActivityLog);
	neoActionToolsConfig.activityLogger = neoActivityLogger;
	deps.neoAgentManager.setActionToolsConfig(neoActionToolsConfig);
	deps.neoAgentManager.setActivityLogger(neoActivityLogger);

	// Human ↔ Task Agent message routing handlers (require taskAgentManager)
	setupSpaceTaskMessageHandlers(deps.messageHub, taskAgentManager, deps.db, deps.daemonHub);

	// Space export/import handlers
	setupSpaceExportImportHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceAgentRepo,
		spaceWorkflowRepo,
		spaceWorkflowManager,
		deps.db.getDatabase(),
		deps.daemonHub
	);

	// Space workflow run handlers — reuse the same factory pattern as spaceTask handlers
	const spaceWorkflowRunTaskManagerFactory: SpaceWorkflowRunTaskManagerFactory = (spaceId) => {
		return new SpaceTaskManager(deps.db.getDatabase(), spaceId, deps.reactiveDb);
	};
	setupSpaceWorkflowRunHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceWorkflowManager,
		spaceWorkflowRunRepo,
		gateDataRepo,
		spaceRuntimeService,
		spaceWorkflowRunTaskManagerFactory,
		deps.daemonHub
	);

	// Node execution handlers
	setupNodeExecutionHandlers(deps.messageHub, nodeExecutionRepo, spaceWorkflowRunRepo);

	// Provision the Global Spaces Agent session (spaces:global)
	// Create shared state synchronously so the RPC handler is available immediately.
	// The actual session creation and MCP wiring happens asynchronously.
	// Skip provisioning in tests to avoid side-effects on session counts.
	// Set NEOKAI_ENABLE_SPACES_AGENT=1 to opt in (e.g., online tests that need spaces:global).
	const globalSpacesState: GlobalSpacesState = { activeSpaceId: null };
	setupGlobalSpacesHandlers(deps.messageHub, globalSpacesState);

	if (process.env.NODE_ENV !== 'test' || process.env.NEOKAI_ENABLE_SPACES_AGENT === '1') {
		// Build a minimal SessionFactory adapter so SessionNotificationSink can inject messages
		// into the spaces:global session. The adapter delegates to SessionManager.injectMessage()
		// which handles DB persistence, UI publishing, and SDK query feeding.
		const globalSessionFactory = {
			injectMessage: (
				sessionId: string,
				message: string,
				opts?: { deliveryMode?: MessageDeliveryMode; origin?: MessageOrigin }
			) => deps.sessionManager.injectMessage(sessionId, message, opts),
			hasSession: (sessionId: string) => deps.sessionManager.getSession(sessionId) !== null,
			// Remaining SessionFactory methods are not needed for notification injection
			createAndStartSession: async () => {},
			answerQuestion: async () => false as const,
			createWorktree: async () => null,
			restoreSession: async () => false as const,
			startSession: async () => false as const,
			setSessionMcpServers: () => false as const,
			removeWorktree: async () => false as const,
			getProcessingState: (_sessionId: string) => undefined,
			switchModel: async (_sessionId: string, _model: string, _provider: string) => ({
				success: false,
				model: '',
				error: 'switchModel not supported for global session factory',
			}),
			getCurrentModel: async (_sessionId: string) => null,
		};

		provisionGlobalSpacesAgent({
			sessionManager: deps.sessionManager,
			spaceManager: deps.spaceManager,
			spaceAgentManager: deps.spaceAgentManager,
			spaceWorkflowManager,
			spaceRuntimeService,
			sessionFactory: globalSessionFactory,
			taskRepo: spaceTaskRepo,
			nodeExecutionRepo,
			workflowRunRepo: spaceWorkflowRunRepo,
			db: deps.db.getDatabase(),
			state: globalSpacesState,
			daemonHub: deps.daemonHub,
			appMcpManager: deps.appMcpManager,
		}).catch((error) => {
			log.error('Failed to provision global spaces agent:', error);
		});
	}

	// Return result with cleanup function and exposed services
	return {
		cleanup: () => {
			unsubRoomCreated();
			unsubLiveQuery();
			roomRuntimeService.stop();
			spaceRuntimeService.stop();
			fileIndex.dispose();
		},
		spaceRuntimeService,
		taskAgentManager,
		spaceWorktreeManager,
	};
}
