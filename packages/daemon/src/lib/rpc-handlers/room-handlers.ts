/**
 * Room RPC Handlers
 *
 * RPC handlers for room operations:
 * - room.create - Create a room
 * - room.list - List all rooms
 * - room.get - Get room details
 * - room.update - Update room
 * - room.archive - Archive room
 * - room.overview - Get room overview with related data
 * - room.status - Get status for a specific room
 *
 * Renamed from neo.room.* to room.* for cleaner API.
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { RoomManager } from '../neo/room-manager';

export function setupRoomHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub
): void {
	// room.create - Create a new room
	messageHub.onRequest('room.create', async (data) => {
		const params = data as {
			name: string;
			description?: string;
			defaultWorkspace?: string;
			defaultModel?: string;
		};

		if (!params.name) {
			throw new Error('Room name is required');
		}

		const room = roomManager.createRoom({
			name: params.name,
			description: params.description,
			defaultWorkspace: params.defaultWorkspace,
			defaultModel: params.defaultModel,
		});

		// Broadcast room creation event
		daemonHub
			.emit('room.created', {
				sessionId: 'global',
				roomId: room.id,
				room,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		return { room };
	});

	// room.list - List all rooms
	messageHub.onRequest('room.list', async (data) => {
		const params = data as { includeArchived?: boolean };
		const rooms = roomManager.listRooms(params.includeArchived ?? false);
		return { rooms };
	});

	// room.get - Get a room by ID
	messageHub.onRequest('room.get', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const room = roomManager.getRoom(params.roomId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { room };
	});

	// room.update - Update a room
	messageHub.onRequest('room.update', async (data) => {
		const params = data as {
			roomId: string;
			name?: string;
			description?: string;
			defaultWorkspace?: string;
			defaultModel?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const room = roomManager.updateRoom(params.roomId, {
			name: params.name,
			description: params.description,
			defaultWorkspace: params.defaultWorkspace,
			defaultModel: params.defaultModel,
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
			.catch(() => {
				// Event emission error - non-critical, continue
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
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		return { room };
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

	// neo.status - Get global Neo status (kept for backward compatibility)
	messageHub.onRequest('neo.status', async () => {
		const status = roomManager.getGlobalStatus();
		return { status };
	});
}
