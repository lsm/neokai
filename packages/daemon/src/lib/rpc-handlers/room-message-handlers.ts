/**
 * Room Message RPC Handlers
 *
 * RPC handlers for room message operations:
 * - room.message.send - Send message to room (supports both 'user' and 'assistant' roles)
 * - room.message.history - Get conversation history
 *
 * Generic API - both humans and Neo use the same endpoints.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub } from '@neokai/shared';
import type { Database } from '../../storage/database';
import type { DaemonHub } from '../daemon-hub';
import { ContextManager } from '../room';

/**
 * Create a ContextManager instance for a room
 */
function createContextManager(db: Database, roomId: string): ContextManager {
	const rawDb = (db as unknown as { db: BunDatabase }).db;
	return new ContextManager(rawDb, roomId);
}

export function setupRoomMessageHandlers(
	messageHub: MessageHub,
	_roomManager: unknown,
	daemonHub: DaemonHub,
	db: Database
): void {
	// room.message.send - Send message to room (supports both 'user' and 'assistant' roles)
	messageHub.onRequest('room.message.send', async (data) => {
		const params = data as {
			roomId: string;
			content: string;
			role: 'user' | 'assistant';
			sessionId?: string;
			taskId?: string;
			metadata?: { sessionId?: string; taskId?: string };
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.content) {
			throw new Error('Message content is required');
		}
		if (!params.role || !['user', 'assistant'].includes(params.role)) {
			throw new Error("Role must be 'user' or 'assistant'");
		}

		const contextManager = createContextManager(db, params.roomId);

		// Determine source based on role
		const source = params.role === 'user' ? 'human' : 'neo';

		// Store the message in context
		const savedMessage = await contextManager.addMessage(params.role, params.content, {
			sessionId: params.sessionId ?? params.metadata?.sessionId,
			taskId: params.taskId ?? params.metadata?.taskId,
		});

		// Emit room.message event for clients to receive
		daemonHub
			.emit('room.message', {
				sessionId: 'global',
				roomId: params.roomId,
				message: {
					id: savedMessage.id,
					role: params.role,
					content: params.content,
					timestamp: savedMessage.timestamp,
				},
				source,
			})
			.catch(() => {});

		return { success: true, messageId: savedMessage.id };
	});

	// room.message.history - Get conversation history
	messageHub.onRequest('room.message.history', async (data) => {
		const params = data as { roomId: string; limit?: number };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const contextManager = createContextManager(db, params.roomId);
		const messages = await contextManager.getRecentMessages(params.limit);

		return { messages };
	});
}
