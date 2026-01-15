/**
 * Test RPC Handlers
 *
 * These handlers are ONLY available in test mode and are used
 * to inject test data or simulate specific scenarios.
 */

import type { MessageHub } from '@liuboer/shared';
import type { Database } from '../../storage/database';
import type { SDKMessage } from '@liuboer/shared/sdk';

export function setupTestHandlers(messageHub: MessageHub, db: Database): void {
	// Inject an SDK message directly into the database (bypasses normal message flow)
	// This is used by E2E tests to simulate agent working in background
	messageHub.handle('test.injectSDKMessage', async (data) => {
		const { sessionId, message } = data as {
			sessionId: string;
			message: SDKMessage;
		};

		// Save to database
		db.saveSDKMessage(sessionId, message);

		// Broadcast the new message via state channel (simulates real agent behavior)
		// IMPORTANT: Add timestamp to the message (just like DB retrieval does)
		// This ensures the client's merge logic can detect newer messages
		const messageWithTimestamp = {
			...message,
			timestamp: Date.now(),
		} as SDKMessage & { timestamp: number };

		await messageHub.publish(
			'state.sdkMessages.delta',
			{
				added: [messageWithTimestamp],
				timestamp: messageWithTimestamp.timestamp,
			},
			{ sessionId }
		);

		return { success: true, uuid: message.uuid };
	});

	// Broadcast a delta update directly to a state channel
	// Used to test delta synchronization scenarios
	messageHub.handle('test.broadcastDelta', async (data) => {
		const {
			sessionId,
			channel,
			data: deltaData,
		} = data as {
			sessionId: string;
			channel: string;
			data: unknown;
		};

		await messageHub.publish(channel, deltaData, { sessionId });

		return { success: true };
	});
}
