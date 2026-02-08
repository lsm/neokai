/**
 * System RPC Handlers
 */

import type { MessageHub } from '@neokai/shared';
import type { SessionManager } from '../session-manager';
import type { AuthManager } from '../auth-manager';
import type { Config } from '../../config';
import type { HealthStatus, DaemonConfig } from '@neokai/shared';

const VERSION = '0.1.1';
const CLAUDE_SDK_VERSION = '0.1.37'; // TODO: Get dynamically
const startTime = Date.now();

export function setupSystemHandlers(
	messageHub: MessageHub,
	sessionManager: SessionManager,
	authManager: AuthManager,
	config: Config
): void {
	messageHub.onQuery('system.health', async () => {
		const response: HealthStatus = {
			status: 'ok',
			version: VERSION,
			uptime: Date.now() - startTime,
			sessions: {
				active: sessionManager.getActiveSessions(),
				total: sessionManager.getTotalSessions(),
			},
		};

		return response;
	});

	messageHub.onQuery('system.config', async () => {
		const authStatus = await authManager.getAuthStatus();

		const response: DaemonConfig = {
			version: VERSION,
			claudeSDKVersion: CLAUDE_SDK_VERSION,
			defaultModel: config.defaultModel,
			maxSessions: config.maxSessions,
			storageLocation: config.dbPath,
			authMethod: authStatus.method,
			authStatus,
		};

		return response;
	});

	// Echo handler for testing WebSocket pub/sub flow
	// 1. Receives a message
	// 2. Publishes an event with the message
	// 3. Returns the message
	messageHub.onQuery('test.echo', async (data: { message: string }) => {
		const echoMessage = data.message || 'echo';

		// Publish event to all subscribers of 'test.echo' on 'global' session
		messageHub.event('test.echo', { echo: echoMessage }, { room: 'global' });

		return { echoed: echoMessage };
	});
}
