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
import { RoomManager, SessionBridge, SessionPairManager } from '../room';
// New split handlers for Neo functionality
import { setupRoomHandlers } from './room-handlers';
import { setupTaskHandlers } from './task-handlers';
import { setupMemoryHandlers } from './memory-handlers';
import { setupRoomMessageHandlers } from './room-message-handlers';

export interface RPCHandlerDependencies {
	messageHub: MessageHub;
	sessionManager: SessionManager;
	authManager: AuthManager;
	settingsManager: SettingsManager;
	config: Config;
	daemonHub: DaemonHub;
	db: Database;
}

/**
 * Register all RPC handlers on MessageHub
 */
export function setupRPCHandlers(deps: RPCHandlerDependencies): void {
	// Room handlers (create roomManager first as session handlers depend on it)
	const roomManager = new RoomManager(deps.db.getDatabase());

	// Create SessionPairManager with required dependencies
	const sessionPairManager = new SessionPairManager(
		deps.db.getDatabase(),
		deps.sessionManager.getSessionLifecycle(),
		roomManager,
		deps.daemonHub
	);

	// Create SessionBridge for Worker-Manager session coordination
	const sessionBridge = new SessionBridge(
		deps.messageHub,
		deps.daemonHub,
		sessionPairManager,
		deps.sessionManager,
		deps.db.getSDKMessageRepo()
	);

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
		sessionPairManager,
		sessionBridge
	);
	setupTaskHandlers(deps.messageHub, roomManager, deps.daemonHub, deps.db);
	setupMemoryHandlers(deps.messageHub, roomManager, deps.daemonHub, deps.db);
	setupRoomMessageHandlers(deps.messageHub, roomManager, deps.daemonHub, deps.db);
}
