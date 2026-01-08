/**
 * RPC Handler Registration
 *
 * Registers all RPC handlers on MessageHub.
 * Organized by domain for better maintainability.
 */

import type { MessageHub } from '@liuboer/shared';
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
import { setupSubSessionHandlers } from './sub-session-handlers';
import { setupConfigHandlers } from './config-handlers';

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
	setupSessionHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub);
	setupMessageHandlers(deps.messageHub, deps.sessionManager);
	setupCommandHandlers(deps.messageHub, deps.sessionManager);
	setupFileHandlers(deps.messageHub, deps.sessionManager);
	setupSystemHandlers(deps.messageHub, deps.sessionManager, deps.authManager, deps.config);
	setupAuthHandlers(deps.messageHub, deps.authManager);
	setupQuestionHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub);
	registerMcpHandlers(deps.messageHub, deps.sessionManager);
	registerSettingsHandlers(deps.messageHub, deps.settingsManager, deps.daemonHub, deps.db);
	setupSubSessionHandlers(deps.messageHub, deps.sessionManager);
	setupConfigHandlers(deps.messageHub, deps.sessionManager, deps.daemonHub);
}
