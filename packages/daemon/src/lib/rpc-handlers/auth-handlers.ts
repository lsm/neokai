/**
 * Auth RPC Handlers
 */

import type { MessageHub } from '@neokai/shared';
import type { AuthManager } from '../auth-manager';

export function setupAuthHandlers(messageHub: MessageHub, authManager: AuthManager): void {
	messageHub.onQuery('auth.status', async () => {
		const authStatus = await authManager.getAuthStatus();
		return { authStatus };
	});
}
