/**
 * Message RPC Handlers
 */

import type { MessageHub } from '@liuboer/shared';
import type { SessionManager } from '../session-manager';

export function setupMessageHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
	messageHub.handle('message.sdkMessages', async (data) => {
		const {
			sessionId: targetSessionId,
			limit,
			before,
			since,
		} = data as {
			sessionId: string;
			limit?: number;
			before?: number; // Cursor: get messages older than this timestamp
			since?: number; // Get messages newer than this timestamp
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);

		if (!agentSession) {
			throw new Error('Session not found');
		}

		const sdkMessages = agentSession.getSDKMessages(limit, before, since);
		return { sdkMessages };
	});

	// Get total message count for a session (useful for pagination UI)
	messageHub.handle('message.count', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);

		if (!agentSession) {
			throw new Error('Session not found');
		}

		const count = agentSession.getSDKMessageCount();
		return { count };
	});
}
