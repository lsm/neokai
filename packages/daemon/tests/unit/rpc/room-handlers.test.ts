/**
 * Tests for Room RPC Handlers
 *
 * Tests the RPC handlers for room operations:
 * - room.create - Create a room
 * - room.list - List all rooms
 * - room.get - Get room details
 * - room.update - Update room
 * - room.archive - Archive room
 * - room.overview - Get room overview with related data
 * - room.status - Get status for a specific room
 * - room.assignSession - Assign a session to a room
 * - room.unassignSession - Unassign a session from a room
 * - room.addPath - Add an allowed path to a room
 * - room.removePath - Remove an allowed path from a room
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupRoomHandlers } from '../../../src/lib/rpc-handlers/room-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { Room, RoomOverview, NeoStatus } from '@neokai/shared';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Helper to create a minimal mock MessageHub that captures handlers
function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

// Helper to create mock DaemonHub
function createMockDaemonHub(): {
	daemonHub: DaemonHub;
	emitMock: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emitMock };
}

// Helper to create mock RoomManager
function createMockRoomManager(): {
	roomManager: RoomManager;
	mocks: {
		createRoom: ReturnType<typeof mock>;
		listRooms: ReturnType<typeof mock>;
		getRoom: ReturnType<typeof mock>;
		getRoomOverview: ReturnType<typeof mock>;
		updateRoom: ReturnType<typeof mock>;
		archiveRoom: ReturnType<typeof mock>;
		deleteRoom: ReturnType<typeof mock>;
		getRoomStatus: ReturnType<typeof mock>;
		assignSession: ReturnType<typeof mock>;
		unassignSession: ReturnType<typeof mock>;
		addAllowedPath: ReturnType<typeof mock>;
		removeAllowedPath: ReturnType<typeof mock>;
	};
} {
	const mockRoom: Room = {
		id: 'room-123',
		name: 'Test Room',
		background: 'A test room',
		allowedPaths: [],
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const mockRoomOverview: RoomOverview = {
		room: mockRoom,
		sessions: [],
		activeTasks: [],
	};

	const mockRoomStatus: NeoStatus = {
		roomId: 'room-123',
		activeTaskCount: 0,
	};

	const mocks = {
		createRoom: mock(() => mockRoom),
		listRooms: mock(() => [mockRoom]),
		getRoom: mock(() => mockRoom),
		getRoomOverview: mock(() => mockRoomOverview),
		updateRoom: mock(() => mockRoom),
		archiveRoom: mock(() => ({ ...mockRoom, archivedAt: new Date().toISOString() })),
		deleteRoom: mock(() => true),
		getRoomStatus: mock(() => mockRoomStatus),
		assignSession: mock(() => mockRoom),
		unassignSession: mock(() => mockRoom),
		addAllowedPath: mock(() => mockRoom),
		removeAllowedPath: mock(() => mockRoom),
	};

	return {
		roomManager: {
			...mocks,
		} as unknown as RoomManager,
		mocks,
	};
}

describe('Room RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	let roomManagerData: ReturnType<typeof createMockRoomManager>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();
		roomManagerData = createMockRoomManager();

		// Setup handlers with mocked dependencies
		setupRoomHandlers(messageHubData.hub, roomManagerData.roomManager, daemonHubData.daemonHub);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('room.create', () => {
		it('creates a room with required name', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			const result = (await handler!({ name: 'New Room' }, {})) as { room: Room };

			expect(result.room).toBeDefined();
			expect(roomManagerData.mocks.createRoom).toHaveBeenCalledWith(
				expect.objectContaining({ name: 'New Room' })
			);
		});

		it('creates a room with background', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await handler!(
				{
					name: 'Full Room',
					background: 'A full featured room',
				},
				{}
			);

			expect(roomManagerData.mocks.createRoom).toHaveBeenCalledWith({
				name: 'Full Room',
				background: 'A full featured room',
				allowedPaths: [],
				defaultPath: undefined,
			});
		});

		it('throws error when name is missing', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await expect(handler!({ description: 'No name' }, {})).rejects.toThrow(
				'Room name is required'
			);
		});

		it('broadcasts room.created event', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await handler!({ name: 'New Room' }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'room.created',
				expect.objectContaining({
					sessionId: 'global',
					roomId: 'room-123',
				})
			);
		});
	});

	describe('room.list', () => {
		it('returns list of rooms', async () => {
			const handler = messageHubData.handlers.get('room.list');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as { rooms: Room[] };

			expect(result.rooms).toBeDefined();
			expect(Array.isArray(result.rooms)).toBe(true);
		});

		it('passes includeArchived parameter', async () => {
			const handler = messageHubData.handlers.get('room.list');
			expect(handler).toBeDefined();

			await handler!({ includeArchived: true }, {});

			expect(roomManagerData.mocks.listRooms).toHaveBeenCalledWith(true);
		});

		it('defaults includeArchived to false', async () => {
			const handler = messageHubData.handlers.get('room.list');
			expect(handler).toBeDefined();

			await handler!({}, {});

			expect(roomManagerData.mocks.listRooms).toHaveBeenCalledWith(false);
		});
	});

	describe('room.get', () => {
		it('returns room overview', async () => {
			const handler = messageHubData.handlers.get('room.get');
			expect(handler).toBeDefined();

			const result = await handler!({ roomId: 'room-123' }, {});

			expect(result).toBeDefined();
			expect(roomManagerData.mocks.getRoomOverview).toHaveBeenCalledWith('room-123');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.get');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('room.get');
			expect(handler).toBeDefined();

			roomManagerData.mocks.getRoomOverview.mockReturnValueOnce(null);

			await expect(handler!({ roomId: 'non-existent' }, {})).rejects.toThrow(
				'Room not found: non-existent'
			);
		});
	});

	describe('room.update', () => {
		it('updates room with all parameters', async () => {
			const handler = messageHubData.handlers.get('room.update');
			expect(handler).toBeDefined();

			await handler!(
				{
					roomId: 'room-123',
					name: 'Updated Name',
					background: 'Updated background',
					allowedPaths: [{ path: '/new-path' }],
					defaultPath: '/new-default',
					defaultModel: 'claude-opus',
				},
				{}
			);

			expect(roomManagerData.mocks.updateRoom).toHaveBeenCalledWith('room-123', {
				name: 'Updated Name',
				background: 'Updated background',
				allowedPaths: [{ path: '/new-path' }],
				defaultPath: '/new-default',
				defaultModel: 'claude-opus',
			});
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.update');
			expect(handler).toBeDefined();

			await expect(handler!({ name: 'New Name' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('room.update');
			expect(handler).toBeDefined();

			roomManagerData.mocks.updateRoom.mockReturnValueOnce(null);

			await expect(handler!({ roomId: 'non-existent', name: 'New' }, {})).rejects.toThrow(
				'Room not found: non-existent'
			);
		});

		it('broadcasts room.updated event', async () => {
			const handler = messageHubData.handlers.get('room.update');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', name: 'New Name' }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'room.updated',
				expect.objectContaining({
					sessionId: 'global',
					roomId: 'room-123',
				})
			);
		});
	});

	describe('room.archive', () => {
		it('archives a room', async () => {
			const handler = messageHubData.handlers.get('room.archive');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123' }, {})) as { room: Room };

			expect(result.room).toBeDefined();
			expect(roomManagerData.mocks.archiveRoom).toHaveBeenCalledWith('room-123');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.archive');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('room.archive');
			expect(handler).toBeDefined();

			roomManagerData.mocks.archiveRoom.mockReturnValueOnce(null);

			await expect(handler!({ roomId: 'non-existent' }, {})).rejects.toThrow(
				'Room not found: non-existent'
			);
		});

		it('broadcasts room.archived event', async () => {
			const handler = messageHubData.handlers.get('room.archive');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123' }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'room.archived',
				expect.objectContaining({
					sessionId: 'global',
					roomId: 'room-123',
				})
			);
		});
	});

	describe('room.delete', () => {
		it('deletes an existing room', async () => {
			const handler = messageHubData.handlers.get('room.delete');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123' }, {})) as { success: boolean };

			expect(result.success).toBe(true);
			expect(roomManagerData.mocks.getRoom).toHaveBeenCalledWith('room-123');
			expect(roomManagerData.mocks.deleteRoom).toHaveBeenCalledWith('room-123');
		});

		it('throws when room deletion fails', async () => {
			const handler = messageHubData.handlers.get('room.delete');
			expect(handler).toBeDefined();

			roomManagerData.mocks.deleteRoom.mockReturnValueOnce(false);

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow(
				'Failed to delete room: room-123'
			);
		});
	});

	describe('room.overview', () => {
		it('returns room overview', async () => {
			const handler = messageHubData.handlers.get('room.overview');
			expect(handler).toBeDefined();

			const result = await handler!({ roomId: 'room-123' }, {});

			expect(result).toBeDefined();
			expect(result).toHaveProperty('overview');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.overview');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('room.overview');
			expect(handler).toBeDefined();

			roomManagerData.mocks.getRoomOverview.mockReturnValueOnce(null);

			await expect(handler!({ roomId: 'non-existent' }, {})).rejects.toThrow(
				'Room not found: non-existent'
			);
		});
	});

	describe('room.status', () => {
		it('returns room status', async () => {
			const handler = messageHubData.handlers.get('room.status');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123' }, {})) as { status: NeoStatus };

			expect(result.status).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.status');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('room.status');
			expect(handler).toBeDefined();

			roomManagerData.mocks.getRoomStatus.mockReturnValueOnce(null);

			await expect(handler!({ roomId: 'non-existent' }, {})).rejects.toThrow(
				'Room not found: non-existent'
			);
		});
	});

	describe('room.assignSession', () => {
		it('assigns session to room', async () => {
			const handler = messageHubData.handlers.get('room.assignSession');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', sessionId: 'session-456' }, {});

			expect(roomManagerData.mocks.assignSession).toHaveBeenCalledWith('room-123', 'session-456');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.assignSession');
			expect(handler).toBeDefined();

			await expect(handler!({ sessionId: 'session-456' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when sessionId is missing', async () => {
			const handler = messageHubData.handlers.get('room.assignSession');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Session ID is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('room.assignSession');
			expect(handler).toBeDefined();

			roomManagerData.mocks.assignSession.mockReturnValueOnce(null);

			await expect(
				handler!({ roomId: 'non-existent', sessionId: 'session-456' }, {})
			).rejects.toThrow('Room not found: non-existent');
		});
	});

	describe('room.unassignSession', () => {
		it('unassigns session from room', async () => {
			const handler = messageHubData.handlers.get('room.unassignSession');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', sessionId: 'session-456' }, {});

			expect(roomManagerData.mocks.unassignSession).toHaveBeenCalledWith('room-123', 'session-456');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.unassignSession');
			expect(handler).toBeDefined();

			await expect(handler!({ sessionId: 'session-456' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when sessionId is missing', async () => {
			const handler = messageHubData.handlers.get('room.unassignSession');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Session ID is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('room.unassignSession');
			expect(handler).toBeDefined();

			roomManagerData.mocks.unassignSession.mockReturnValueOnce(null);

			await expect(
				handler!({ roomId: 'non-existent', sessionId: 'session-456' }, {})
			).rejects.toThrow('Room not found: non-existent');
		});
	});

	describe('room.addPath', () => {
		it('adds allowed path to room', async () => {
			const handler = messageHubData.handlers.get('room.addPath');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', path: '/new/path' }, {});

			expect(roomManagerData.mocks.addAllowedPath).toHaveBeenCalledWith(
				'room-123',
				'/new/path',
				undefined
			);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.addPath');
			expect(handler).toBeDefined();

			await expect(handler!({ path: '/new/path' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when path is missing', async () => {
			const handler = messageHubData.handlers.get('room.addPath');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Path is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('room.addPath');
			expect(handler).toBeDefined();

			roomManagerData.mocks.addAllowedPath.mockReturnValueOnce(null);

			await expect(handler!({ roomId: 'non-existent', path: '/new/path' }, {})).rejects.toThrow(
				'Room not found: non-existent'
			);
		});
	});

	describe('room.removePath', () => {
		it('removes allowed path from room', async () => {
			const handler = messageHubData.handlers.get('room.removePath');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', path: '/old/path' }, {});

			expect(roomManagerData.mocks.removeAllowedPath).toHaveBeenCalledWith('room-123', '/old/path');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.removePath');
			expect(handler).toBeDefined();

			await expect(handler!({ path: '/old/path' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when path is missing', async () => {
			const handler = messageHubData.handlers.get('room.removePath');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Path is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('room.removePath');
			expect(handler).toBeDefined();

			roomManagerData.mocks.removeAllowedPath.mockReturnValueOnce(null);

			await expect(handler!({ roomId: 'non-existent', path: '/old/path' }, {})).rejects.toThrow(
				'Room not found: non-existent'
			);
		});
	});
});
