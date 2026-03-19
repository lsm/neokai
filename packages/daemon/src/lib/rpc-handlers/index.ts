/**
 * RPC Handler Registration
 *
 * Registers all RPC handlers on MessageHub.
 * Organized by domain for better maintainability.
 */

import type { MessageHub } from '@neokai/shared';
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
import type { SpaceManager } from '../space/managers/space-manager';
import { SpaceTaskManager } from '../space/managers/space-task-manager';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';

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
}

const log = new Logger('rpc-handlers');

/**
 * Cleanup function type for RPC handlers
 */
export type RPCHandlerCleanup = () => void;

/**
 * Register all RPC handlers on MessageHub
 * Returns a cleanup function that should be called to stop background services
 */
export function setupRPCHandlers(deps: RPCHandlerDependencies): RPCHandlerCleanup {
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

	setupSpaceHandlers(
		deps.messageHub,
		deps.spaceManager,
		spaceTaskRepo,
		spaceWorkflowRunRepo,
		deps.daemonHub
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

	// Return cleanup function to stop background services
	return () => {
		roomRuntimeService.stop();
	};
}
