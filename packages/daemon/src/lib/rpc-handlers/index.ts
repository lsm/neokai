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
import { setupRoomHandlers } from './room-handlers';
import { setupTaskHandlers } from './task-handlers';
import { setupLobbyHandlers } from './lobby-handlers';
import { setupGitHubHandlers } from './github-handlers';
import type { GitHubService } from '../github/github-service';
// New handlers for goals
import { setupGoalHandlers, type GoalManagerFactory } from './goal-handlers';
import { createGitHubAdapter } from '../lobby/adapters/github-adapter';
import { LobbyAgentService } from '../lobby/lobby-agent-service';
import { Logger } from '../logger';
import { GoalManager } from '../room/goal-manager';
import { setupDialogHandlers } from './dialog-handlers';
// PHASE 3: Telemetry and feature flags
import { registerTelemetryHandlers } from './telemetry-handlers';
import { getFeatureFlagService } from '../config';
import { WorkerTelemetry } from '../telemetry';

export interface RPCHandlerDependencies {
	messageHub: MessageHub;
	sessionManager: SessionManager;
	authManager: AuthManager;
	settingsManager: SettingsManager;
	config: Config;
	daemonHub: DaemonHub;
	db: Database;
	gitHubService?: GitHubService;
	/** Lobby agent service for lobby AI interaction */
	lobbyAgentService?: LobbyAgentService;
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

	setupSessionHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub, roomManager);
	setupMessageHandlers(deps.messageHub, deps.sessionManager);
	setupCommandHandlers(deps.messageHub, deps.sessionManager);
	setupFileHandlers(deps.messageHub, deps.sessionManager);
	setupSystemHandlers(deps.messageHub, deps.sessionManager, deps.authManager, deps.config);
	setupAuthHandlers(deps.messageHub, deps.authManager);
	setupQuestionHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub);
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
	setupTaskHandlers(deps.messageHub, roomManager, deps.daemonHub, deps.db);

	// Goal handlers
	setupGoalHandlers(deps.messageHub, deps.daemonHub, goalManagerFactory);

	// Create LobbyAgentService if authenticated
	let lobbyAgentService: LobbyAgentService | undefined = deps.lobbyAgentService;
	if (!lobbyAgentService) {
		try {
			const apiKey =
				deps.config.anthropicApiKey ||
				deps.config.claudeCodeOAuthToken ||
				deps.config.anthropicAuthToken;
			if (apiKey) {
				lobbyAgentService = new LobbyAgentService({
					db: deps.db,
					rawDb: deps.db.getDatabase(),
					daemonHub: deps.daemonHub,
					messageHub: deps.messageHub,
					getApiKey: () => deps.authManager.getCurrentApiKey(),
					roomManager,
					defaultWorkspacePath: deps.config.workspaceRoot,
					defaultModel: deps.config.defaultModel,
				});

				// Register GitHub adapter if GitHub is configured
				if (deps.gitHubService) {
					const gitHubAdapter = createGitHubAdapter({
						db: deps.db,
						daemonHub: deps.daemonHub,
						config: deps.config,
						apiKey,
						githubToken: process.env.GITHUB_TOKEN,
						onMessage: async (msg) => {
							await lobbyAgentService!.processMessage(msg);
						},
					});
					lobbyAgentService.registerAdapter(gitHubAdapter);
				}

				// Start the lobby agent
				lobbyAgentService.start().catch((error) => {
					log.error('Failed to start LobbyAgentService:', error);
				});
			}
		} catch (error) {
			log.error('Failed to initialize LobbyAgentService:', error);
		}
	}

	// Lobby handlers
	setupLobbyHandlers(deps.messageHub, deps.daemonHub, lobbyAgentService);

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

	// PHASE 3: Initialize feature flag service
	const featureFlagService = getFeatureFlagService(deps.db);

	// PHASE 3: Initialize worker telemetry
	const workerTelemetry = new WorkerTelemetry(deps.daemonHub);

	// PHASE 3: Register telemetry and feature flag RPC handlers
	registerTelemetryHandlers({
		messageHub: deps.messageHub,
		daemonHub: deps.daemonHub,
		featureFlagService,
		workerTelemetry,
	});

	// Return cleanup function to stop background services
	return () => {
		// TODO: Cleanup telemetry services if needed
	};
}
