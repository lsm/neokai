/**
 * System RPC Handlers
 */

import type { MessageHub } from '@liuboer/shared';
import type { SessionManager } from '../session-manager';
import type { AuthManager } from '../auth-manager';
import type { Config } from '../../config';
import type { HealthStatus, DaemonConfig } from '@liuboer/shared';

const VERSION = '0.1.0';
const CLAUDE_SDK_VERSION = '0.1.37'; // TODO: Get dynamically
const startTime = Date.now();

export function setupSystemHandlers(
	messageHub: MessageHub,
	sessionManager: SessionManager,
	authManager: AuthManager,
	config: Config
): void {
	messageHub.handle('system.health', async () => {
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

	messageHub.handle('system.config', async () => {
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

	// Echo handler for testing IPC pub/sub flow
	// 1. Receives a message
	// 2. Publishes an event with the message
	// 3. Returns the message
	messageHub.handle('test.echo', async (data: { message: string }) => {
		const echoMessage = data.message || 'echo';

		// Publish event to all subscribers of 'test.echo' on 'global' session
		await messageHub.publish('test.echo', { echo: echoMessage }, { sessionId: 'global' });

		return { echoed: echoMessage };
	});
}
