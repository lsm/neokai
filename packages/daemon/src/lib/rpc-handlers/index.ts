/**
 * RPC Handler Registration
 *
 * Registers all RPC handlers on MessageHub.
 * Organized by domain for better maintainability.
 */

import type { MessageHub, MessageDeliveryMode } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SessionManager } from '../session-manager';
import type { AuthManager } from '../auth-manager';
import type { SettingsManager } from '../settings-manager';
import type { Config } from '../../config';
import type { Database } from '../../storage/database';

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
import { setupDialogHandlers } from './dialog-handlers';
// Space handlers
import { setupSpaceHandlers } from './space-handlers';
import { setupSpaceTaskHandlers, type SpaceTaskManagerFactory } from './space-task-handlers';
import { setupSpaceTaskMessageHandlers } from './space-task-message-handlers';
import { TaskAgentManager } from '../space/runtime/task-agent-manager';
import { setupSpaceWorkflowHandlers } from './space-workflow-handlers';
import type { SpaceManager } from '../space/managers/space-manager';
import { SpaceTaskManager } from '../space/managers/space-task-manager';
import { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceAgentLookup } from '../space/managers/space-workflow-manager';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import { setupSpaceAgentHandlers } from './space-agent-handlers';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
import { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository';
import { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { setupSpaceWorkflowRunHandlers } from './space-workflow-run-handlers';
import type { SpaceWorkflowRunTaskManagerFactory } from './space-workflow-run-handlers';
import { setupSpaceExportImportHandlers } from './space-export-import-handlers';
import { provisionGlobalSpacesAgent } from '../space/provision-global-agent';
import { setupGlobalSpacesHandlers } from './global-spaces-handlers';
import type { GlobalSpacesState } from '../space/tools/global-spaces-tools';

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
}

/**
 * Register all RPC handlers on MessageHub
 * Returns a result with cleanup function and exposed services
 */
export function setupRPCHandlers(deps: RPCHandlerDependencies): RPCHandlerSetupResult {
	// Room handlers (create roomManager first as session handlers depend on it)
	const roomManager = new RoomManager(deps.db.getDatabase());

	// Create factory function for per-room goal managers
	const goalManagerFactory: GoalManagerFactory = (roomId: string) => {
		return new GoalManager(deps.db.getDatabase(), roomId);
	};

	// Create factory function for per-room task managers (used by goal review handlers)
	const goalTaskManagerFactory: GoalTaskManagerFactory = (roomId: string) => {
		return new TaskManager(deps.db.getDatabase(), roomId);
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
	registerMcpHandlers(deps.messageHub, deps.sessionManager);
	registerSettingsHandlers(deps.messageHub, deps.settingsManager, deps.daemonHub, deps.db);
	setupConfigHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub);
	setupTestHandlers(deps.messageHub, deps.db);
	setupRewindHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub);

	// Room handlers
	setupRoomHandlers(
		deps.messageHub,
		roomManager,
		deps.daemonHub,
		deps.config.workspaceRoot,
		deps.sessionManager
	);

	// Room Runtime Service (must be created before task/goal handlers — messaging + task approval need it)
	const roomRuntimeService = new RoomRuntimeService({
		db: deps.db,
		messageHub: deps.messageHub,
		daemonHub: deps.daemonHub,
		getApiKey: () => deps.authManager.getCurrentApiKey(),
		roomManager,
		sessionManager: deps.sessionManager,
		defaultWorkspacePath: deps.config.workspaceRoot,
		defaultModel: deps.config.defaultModel,
		getGlobalSettings: () => deps.settingsManager.getGlobalSettings(),
	});
	roomRuntimeService.start().catch((error) => {
		log.error('Failed to start RoomRuntimeService:', error);
	});

	// Wire question handlers now that roomRuntimeService is available.
	// Pass its session lookup so question.respond reaches the correct live AgentSession
	// (room worker/leader sessions are stored in RoomRuntimeService.agentSessions,
	// not in SessionManager's cache).
	setupQuestionHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub, (sessionId) =>
		roomRuntimeService.getAgentSession(sessionId)
	);

	setupRoomRuntimeHandlers(deps.messageHub, deps.daemonHub, roomRuntimeService);
	setupTaskHandlers(
		deps.messageHub,
		roomManager,
		deps.daemonHub,
		deps.db,
		undefined,
		roomRuntimeService
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

	// Space handlers (spaceManager injected from deps — single instance shared with DaemonAppContext)
	const spaceTaskRepo = new SpaceTaskRepository(deps.db.getDatabase());
	const spaceWorkflowRunRepo = new SpaceWorkflowRunRepository(deps.db.getDatabase());

	// Space workflow manager — created early so space.create can call seedBuiltInWorkflows
	const spaceWorkflowRepo = new SpaceWorkflowRepository(deps.db.getDatabase());
	const spaceAgentRepo = new SpaceAgentRepository(deps.db.getDatabase());
	const agentLookup: SpaceAgentLookup = {
		getAgentById(spaceId: string, id: string) {
			const agent = spaceAgentRepo.getById(id);
			if (!agent || agent.spaceId !== spaceId) return null;
			return { id: agent.id, name: agent.name, role: agent.role };
		},
	};
	const spaceWorkflowManager = new SpaceWorkflowManager(spaceWorkflowRepo, agentLookup);

	setupSpaceHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceTaskRepo,
		spaceWorkflowRunRepo,
		deps.daemonHub,
		deps.spaceAgentManager,
		spaceWorkflowManager
	);

	const spaceTaskManagerFactory: SpaceTaskManagerFactory = (spaceId: string) => {
		return new SpaceTaskManager(deps.db.getDatabase(), spaceId);
	};

	setupSpaceTaskHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceTaskManagerFactory,
		deps.daemonHub
	);

	// Space agent handlers
	setupSpaceAgentHandlers(deps.messageHub, deps.daemonHub, deps.spaceAgentManager);

	setupSpaceWorkflowHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceWorkflowManager,
		deps.daemonHub
	);

	// Space Runtime Service — wraps SpaceRuntime with per-space lifecycle API.
	// Not started yet: TaskAgentManager is created next and injected before start().
	const spaceRuntimeService = new SpaceRuntimeService({
		db: deps.db.getDatabase(),
		spaceManager: deps.spaceManager,
		spaceAgentManager: deps.spaceAgentManager,
		spaceWorkflowManager,
		workflowRunRepo: spaceWorkflowRunRepo,
		taskRepo: spaceTaskRepo,
	});

	// Task Agent Manager — manages Task Agent session lifecycle and message injection.
	// Must be created after spaceRuntimeService so it can get WorkflowExecutors via
	// spaceRuntimeService.createOrGetRuntime(spaceId).
	const taskAgentManager = new TaskAgentManager({
		db: deps.db,
		sessionManager: deps.sessionManager,
		spaceManager: deps.spaceManager,
		spaceAgentManager: deps.spaceAgentManager,
		spaceWorkflowManager,
		spaceRuntimeService,
		taskRepo: spaceTaskRepo,
		workflowRunRepo: spaceWorkflowRunRepo,
		daemonHub: deps.daemonHub,
		messageHub: deps.messageHub,
		getApiKey: () => deps.authManager.getCurrentApiKey(),
		defaultModel: deps.config.defaultModel,
	});

	// Wire TaskAgentManager into the SpaceRuntime so the tick loop can spawn
	// Task Agent sessions for pending tasks. Resolves circular dependency:
	// SpaceRuntimeService → SpaceRuntime needed TaskAgentManager, which in turn
	// needed SpaceRuntimeService. Both are now created; inject via setter.
	spaceRuntimeService.setTaskAgentManager(taskAgentManager);
	spaceRuntimeService.start();

	// Human ↔ Task Agent message routing handlers (require taskAgentManager)
	setupSpaceTaskMessageHandlers(deps.messageHub, taskAgentManager, deps.db);

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
		return new SpaceTaskManager(deps.db.getDatabase(), spaceId);
	};
	setupSpaceWorkflowRunHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceWorkflowManager,
		spaceWorkflowRunRepo,
		spaceRuntimeService,
		spaceWorkflowRunTaskManagerFactory,
		deps.daemonHub
	);

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
				opts?: { deliveryMode?: MessageDeliveryMode }
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
		};

		provisionGlobalSpacesAgent({
			sessionManager: deps.sessionManager,
			spaceManager: deps.spaceManager,
			spaceAgentManager: deps.spaceAgentManager,
			spaceWorkflowManager,
			spaceRuntimeService,
			sessionFactory: globalSessionFactory,
			taskRepo: spaceTaskRepo,
			workflowRunRepo: spaceWorkflowRunRepo,
			db: deps.db.getDatabase(),
			state: globalSpacesState,
			daemonHub: deps.daemonHub,
		}).catch((error) => {
			log.error('Failed to provision global spaces agent:', error);
		});
	}

	// Return result with cleanup function and exposed services
	return {
		cleanup: () => {
			roomRuntimeService.stop();
			spaceRuntimeService.stop();
		},
		spaceRuntimeService,
		taskAgentManager,
	};
}
