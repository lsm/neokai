/**
 * Room RPC Handlers
 *
 * RPC handlers for room operations:
 * - room.create - Create a room
 * - room.list - List all rooms
 * - room.get - Get room details
 * - room.update - Update room
 * - room.archive - Archive room
 * - room.delete - Delete room
 * - room.overview - Get room overview with related data
 * - room.status - Get status for a specific room
 * - neo.status - Get global status (all rooms, sessions)
 */

import type { MessageHub, WorkspacePath } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { RoomManager } from '../room/room-manager';
import type { SessionManager } from '../session-manager';
import { Logger } from '../logger';

const log = new Logger('room-handlers');

export function setupRoomHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub,
	workspaceRoot?: string,
	sessionManager?: SessionManager
): void {
	// room.create - Create a new room
	messageHub.onRequest('room.create', async (data) => {
		const params = data as {
			name: string;
			background?: string;
			allowedPaths?: WorkspacePath[];
			defaultPath?: string;
		};

		if (!params.name) {
			throw new Error('Room name is required');
		}

		// Auto-populate workspace paths from workspaceRoot if not provided
		const allowedPaths = params.allowedPaths ?? (workspaceRoot ? [{ path: workspaceRoot }] : []);
		const defaultPath = params.defaultPath ?? (workspaceRoot ? workspaceRoot : undefined);

		const room = roomManager.createRoom({
			name: params.name,
			background: params.background,
			allowedPaths,
			defaultPath,
		});

		// Create the room's user-facing chat session
		// Session ID format: room:chat:${roomId}
		if (sessionManager) {
			const roomChatSessionId = `room:chat:${room.id}`;
			try {
				await sessionManager.createSession({
					sessionId: roomChatSessionId,
					title: room.name,
					workspacePath: defaultPath ?? allowedPaths[0]?.path,
					config: {
						model: room.defaultModel,
					},
					sessionType: 'room_chat',
					roomId: room.id,
				});

				// Explicitly assign the room chat session to the room
				roomManager.assignSession(room.id, roomChatSessionId);
			} catch (error) {
				log.warn(`Failed to create room chat session for room ${room.id}:`, error);
			}
		}

		// Broadcast room creation event
		daemonHub
			.emit('room.created', {
				sessionId: 'global',
				roomId: room.id,
				room,
			})
			.catch((error) => {
				log.warn(`Failed to emit room.created for room ${room.id}:`, error);
			});

		return { room };
	});

	// room.list - List all rooms
	messageHub.onRequest('room.list', async (data) => {
		const params = data as { includeArchived?: boolean };
		const rooms = roomManager.listRooms(params.includeArchived ?? false);
		return { rooms };
	});

	// room.get - Get room overview with related data
	messageHub.onRequest('room.get', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const overview = roomManager.getRoomOverview(params.roomId);
		if (!overview) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return overview; // Returns RoomOverview directly (not wrapped in { room })
	});

	// room.update - Update a room
	messageHub.onRequest('room.update', async (data) => {
		const params = data as {
			roomId: string;
			name?: string;
			allowedPaths?: WorkspacePath[];
			defaultPath?: string;
			defaultModel?: string;
			allowedModels?: string[];
			background?: string;
			instructions?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const room = roomManager.updateRoom(params.roomId, {
			name: params.name,
			allowedPaths: params.allowedPaths,
			defaultPath: params.defaultPath,
			defaultModel: params.defaultModel,
			allowedModels: params.allowedModels,
			background: params.background,
			instructions: params.instructions,
		});

		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// Broadcast room update event
		daemonHub
			.emit('room.updated', {
				sessionId: 'global',
				roomId: room.id,
				room,
			})
			.catch((error) => {
				log.warn(`Failed to emit room.updated for room ${room.id}:`, error);
			});

		return { room };
	});

	// room.archive - Archive a room
	messageHub.onRequest('room.archive', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const room = roomManager.archiveRoom(params.roomId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// Broadcast room archive event
		daemonHub
			.emit('room.archived', {
				sessionId: 'global',
				roomId: room.id,
			})
			.catch((error) => {
				log.warn(`Failed to emit room.archived for room ${room.id}:`, error);
			});

		return { room };
	});

	// room.delete - Permanently delete a room
	messageHub.onRequest('room.delete', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const room = roomManager.getRoom(params.roomId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// Broadcast room deletion event before deleting
		await daemonHub
			.emit('room.deleted', {
				sessionId: 'global',
				roomId: room.id,
			})
			.catch((error) => {
				log.warn(`Failed to emit room.deleted for room ${room.id}:`, error);
			});

		// Permanently delete the room (CASCADE will delete related data)
		const deleted = roomManager.deleteRoom(params.roomId);
		if (!deleted) {
			throw new Error(`Failed to delete room: ${params.roomId}`);
		}

		return { success: true };
	});

	// room.overview - Get room overview with related data
	messageHub.onRequest('room.overview', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const overview = roomManager.getRoomOverview(params.roomId);
		if (!overview) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { overview };
	});

	// room.status - Get status for a specific room
	messageHub.onRequest('room.status', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const status = roomManager.getRoomStatus(params.roomId);
		if (!status) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { status };
	});

	// neo.status - Get global status (all rooms, sessions)
	messageHub.onRequest('neo.status', async () => {
		return roomManager.getGlobalStatus();
	});

	// room.assignSession - Assign a session to a room
	messageHub.onRequest('room.assignSession', async (data) => {
		const params = data as { roomId: string; sessionId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.sessionId) {
			throw new Error('Session ID is required');
		}

		const room = roomManager.assignSession(params.roomId, params.sessionId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { room };
	});

	// room.unassignSession - Unassign a session from a room
	messageHub.onRequest('room.unassignSession', async (data) => {
		const params = data as { roomId: string; sessionId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.sessionId) {
			throw new Error('Session ID is required');
		}

		const room = roomManager.unassignSession(params.roomId, params.sessionId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { room };
	});

	// room.addPath - Add an allowed path to a room
	messageHub.onRequest('room.addPath', async (data) => {
		const params = data as { roomId: string; path: string; description?: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.path) {
			throw new Error('Path is required');
		}

		const room = roomManager.addAllowedPath(params.roomId, params.path, params.description);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { room };
	});

	// room.removePath - Remove an allowed path from a room
	messageHub.onRequest('room.removePath', async (data) => {
		const params = data as { roomId: string; path: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.path) {
			throw new Error('Path is required');
		}

		const room = roomManager.removeAllowedPath(params.roomId, params.path);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { room };
	});
}
