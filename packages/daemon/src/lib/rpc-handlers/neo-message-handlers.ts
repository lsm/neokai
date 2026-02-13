/**
 * Neo Message RPC Handlers
 *
 * RPC handlers for Neo message operations:
 * - neo.message.send - Send message to room's Neo
 * - neo.message.history - Get conversation history
 *
 * These are kept with neo.* prefix since they are specific to Neo AI functionality.
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { RoomManager } from '../neo/room-manager';
import type { Database } from '../../storage/database';
import { getOrCreateRoomNeo } from './task-handlers';

export function setupNeoMessageHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub,
	db: Database
): void {
	// neo.message.send - Send message to room's Neo
	messageHub.onRequest('neo.message.send', async (data) => {
		const params = data as {
			roomId: string;
			content: string;
			sessionId?: string;
			taskId?: string;
			source?: 'human' | 'system';
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.content) {
			throw new Error('Message content is required');
		}

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		await neo.sendMessage(params.content, {
			sessionId: params.sessionId,
			taskId: params.taskId,
			source: params.source,
		});

		return { success: true };
	});

	// neo.message.history - Get conversation history
	messageHub.onRequest('neo.message.history', async (data) => {
		const params = data as { roomId: string; limit?: number };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		const messages = await neo.getHistory(params.limit);

		return { messages };
	});
}
