/**
 * Tests for Room Pair RPC Handlers
 *
 * Tests the RPC handlers for session pair operations:
 * - room.createPair - Create a manager+worker session pair
 * - room.getPairs - List pairs for a room
 * - room.getPair - Get single pair details
 * - room.archivePair - Archive a pair
 *
 * These tests mock the SessionPairManager and SessionBridge to focus
 * on the RPC handler logic itself.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupRoomHandlers } from '../../../src/lib/rpc-handlers/room-handlers';
import type { SessionPairManager } from '../../../src/lib/room/session-pair-manager';
import type { SessionBridge } from '../../../src/lib/room/session-bridge';
import type { RoomManager } from '../../../src/lib/room/room-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { SessionPair, NeoTask, Room } from '@neokai/shared';

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
function createMockDaemonHub(): DaemonHub {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
}

// Helper to create mock RoomManager
function createMockRoomManager(): RoomManager {
	return {
		createRoom: mock(() => ({ id: 'room-123' }) as Room),
		listRooms: mock(() => []),
		getRoom: mock(() => null),
		getRoomOverview: mock(() => null),
		updateRoom: mock(() => null),
		archiveRoom: mock(() => null),
		getRoomStatus: mock(() => null),
		assignSession: mock(() => null),
		unassignSession: mock(() => null),
		addAllowedPath: mock(() => null),
		removeAllowedPath: mock(() => null),
	} as unknown as RoomManager;
}

// Helper to create mock SessionPairManager
function createMockSessionPairManager(): {
	manager: SessionPairManager;
	createPair: ReturnType<typeof mock>;
	getPair: ReturnType<typeof mock>;
	getPairsByRoom: ReturnType<typeof mock>;
	archivePair: ReturnType<typeof mock>;
} {
	const createPairMock = mock(async () => ({
		pair: {
			id: 'pair-123',
			roomId: 'room-123',
			roomSessionId: 'room-session-123',
			managerSessionId: 'manager-session-123',
			workerSessionId: 'worker-session-123',
			status: 'active' as const,
			currentTaskId: 'task-123',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} as SessionPair,
		task: {
			id: 'task-123',
			roomId: 'room-123',
			title: 'Test Task',
			description: 'Test description',
			status: 'pending' as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} as NeoTask,
	}));

	const getPairMock = mock(() => null);
	const getPairsByRoomMock = mock(() => []);
	const archivePairMock = mock(async () => true);

	const manager = {
		createPair: createPairMock,
		getPair: getPairMock,
		getPairsByRoom: getPairsByRoomMock,
		getPairBySession: mock(() => null),
		updatePairStatus: mock(() => null),
		archivePair: archivePairMock,
		deletePair: mock(() => false),
		getManagerTools: mock(() => undefined),
	} as unknown as SessionPairManager;

	return {
		manager,
		createPair: createPairMock,
		getPair: getPairMock,
		getPairsByRoom: getPairsByRoomMock,
		archivePair: archivePairMock,
	};
}

// Helper to create mock SessionBridge
function createMockSessionBridge(): {
	bridge: SessionBridge;
	startBridge: ReturnType<typeof mock>;
	stopBridge: ReturnType<typeof mock>;
} {
	const startBridgeMock = mock(async () => {});
	const stopBridgeMock = mock(() => {});

	const bridge = {
		startBridge: startBridgeMock,
		stopBridge: stopBridgeMock,
		stopAllBridges: mock(async () => {}),
		getActiveBridges: mock(() => []),
		isBridgeActive: mock(() => false),
		getBridgeInfo: mock(() => null),
	} as unknown as SessionBridge;

	return {
		bridge,
		startBridge: startBridgeMock,
		stopBridge: stopBridgeMock,
	};
}

describe('Room Pair RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHub: DaemonHub;
	let roomManager: RoomManager;
	let sessionPairManagerData: ReturnType<typeof createMockSessionPairManager>;
	let sessionBridgeData: ReturnType<typeof createMockSessionBridge>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHub = createMockDaemonHub();
		roomManager = createMockRoomManager();
		sessionPairManagerData = createMockSessionPairManager();
		sessionBridgeData = createMockSessionBridge();

		// Setup handlers with mocked dependencies
		setupRoomHandlers(
			messageHubData.hub,
			roomManager,
			daemonHub,
			sessionPairManagerData.manager,
			sessionBridgeData.bridge
		);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('room.createPair', () => {
		it('creates pair successfully with all parameters', async () => {
			const handler = messageHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roomSessionId: 'room-session-123',
				taskTitle: 'Implement Feature X',
				taskDescription: 'Detailed description of the task',
				workspacePath: '/workspace/project',
				model: 'claude-opus-4-5-20250514',
			};

			const result = await handler!(params, {});

			expect(sessionPairManagerData.createPair).toHaveBeenCalledWith(params);
			expect(sessionBridgeData.startBridge).toHaveBeenCalledWith('pair-123');
			expect(result).toEqual({
				pair: expect.objectContaining({
					id: 'pair-123',
					roomId: 'room-123',
					status: 'active',
				}),
				task: expect.objectContaining({
					id: 'task-123',
					title: 'Test Task',
				}),
			});
		});

		it('creates pair with minimal parameters', async () => {
			const handler = messageHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roomSessionId: 'room-session-123',
				taskTitle: 'Simple Task',
			};

			const result = await handler!(params, {});

			expect(sessionPairManagerData.createPair).toHaveBeenCalledWith(params);
			expect(result).toBeDefined();
		});

		it('returns error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			const params = {
				roomSessionId: 'room-session-123',
				taskTitle: 'Test Task',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('returns error when roomSessionId is missing', async () => {
			const handler = messageHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskTitle: 'Test Task',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room session ID is required');
		});

		it('returns error when taskTitle is missing', async () => {
			const handler = messageHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roomSessionId: 'room-session-123',
			};

			await expect(handler!(params, {})).rejects.toThrow('Task title is required');
		});

		it('starts bridge after creation', async () => {
			const handler = messageHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roomSessionId: 'room-session-123',
				taskTitle: 'Test Task',
			};

			await handler!(params, {});

			expect(sessionBridgeData.startBridge).toHaveBeenCalledTimes(1);
			expect(sessionBridgeData.startBridge).toHaveBeenCalledWith('pair-123');
		});

		it('creates linked manager and worker sessions', async () => {
			const handler = messageHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roomSessionId: 'room-session-456',
				taskTitle: 'Linked Sessions Test',
			};

			const result = (await handler!(params, {})) as { pair: SessionPair; task: NeoTask };

			expect(result.pair.managerSessionId).toBeDefined();
			expect(result.pair.workerSessionId).toBeDefined();
			expect(result.pair.managerSessionId).not.toBe(result.pair.workerSessionId);
		});

		it('returns error when sessionPairManager is not available', async () => {
			// Create a new hub without sessionPairManager
			const newHubData = createMockMessageHub();
			setupRoomHandlers(newHubData.hub, roomManager, daemonHub, undefined, undefined);

			const handler = newHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roomSessionId: 'room-session-123',
				taskTitle: 'Test Task',
			};

			await expect(handler!(params, {})).rejects.toThrow(
				'Session pair functionality not yet available'
			);
		});

		it('propagates error from SessionPairManager.createPair', async () => {
			const handler = messageHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			// Override mock to throw
			sessionPairManagerData.createPair.mockImplementationOnce(async () => {
				throw new Error('Room not found: non-existent-room');
			});

			const params = {
				roomId: 'non-existent-room',
				roomSessionId: 'room-session-123',
				taskTitle: 'Test Task',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room not found: non-existent-room');
		});

		it('works without sessionBridge (bridge is optional)', async () => {
			// Create a new hub without sessionBridge
			const newHubData = createMockMessageHub();
			setupRoomHandlers(
				newHubData.hub,
				roomManager,
				daemonHub,
				sessionPairManagerData.manager,
				undefined
			);

			const handler = newHubData.handlers.get('room.createPair');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roomSessionId: 'room-session-123',
				taskTitle: 'Test Task',
			};

			// Should not throw - bridge is optional
			const result = await handler!(params, {});
			expect(result).toBeDefined();
		});
	});

	describe('room.getPairs', () => {
		it('returns empty array for room with no pairs', async () => {
			const handler = messageHubData.handlers.get('room.getPairs');
			expect(handler).toBeDefined();

			sessionPairManagerData.getPairsByRoom.mockReturnValueOnce([]);

			const result = (await handler!({ roomId: 'room-123' }, {})) as { pairs: SessionPair[] };

			expect(result.pairs).toEqual([]);
		});

		it('returns all pairs for a room', async () => {
			const handler = messageHubData.handlers.get('room.getPairs');
			expect(handler).toBeDefined();

			const mockPairs: SessionPair[] = [
				{
					id: 'pair-1',
					roomId: 'room-123',
					roomSessionId: 'room-session-1',
					managerSessionId: 'manager-1',
					workerSessionId: 'worker-1',
					status: 'active',
					currentTaskId: 'task-1',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: 'pair-2',
					roomId: 'room-123',
					roomSessionId: 'room-session-2',
					managerSessionId: 'manager-2',
					workerSessionId: 'worker-2',
					status: 'idle',
					currentTaskId: 'task-2',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];

			sessionPairManagerData.getPairsByRoom.mockReturnValueOnce(mockPairs);

			const result = (await handler!({ roomId: 'room-123' }, {})) as { pairs: SessionPair[] };

			expect(result.pairs).toHaveLength(2);
			expect(result.pairs).toEqual(mockPairs);
		});

		it('returns pairs in correct order (newest first)', async () => {
			const handler = messageHubData.handlers.get('room.getPairs');
			expect(handler).toBeDefined();

			const now = Date.now();
			const mockPairs: SessionPair[] = [
				{
					id: 'pair-newest',
					roomId: 'room-123',
					roomSessionId: 'room-session-2',
					managerSessionId: 'manager-2',
					workerSessionId: 'worker-2',
					status: 'active',
					createdAt: now,
					updatedAt: now,
				},
				{
					id: 'pair-oldest',
					roomId: 'room-123',
					roomSessionId: 'room-session-1',
					managerSessionId: 'manager-1',
					workerSessionId: 'worker-1',
					status: 'active',
					createdAt: now - 10000,
					updatedAt: now - 10000,
				},
			];

			sessionPairManagerData.getPairsByRoom.mockReturnValueOnce(mockPairs);

			const result = (await handler!({ roomId: 'room-123' }, {})) as { pairs: SessionPair[] };

			// Verify the manager was called with the correct room ID
			expect(sessionPairManagerData.getPairsByRoom).toHaveBeenCalledWith('room-123');
			expect(result.pairs).toEqual(mockPairs);
		});

		it('returns error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.getPairs');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('returns error when sessionPairManager is not available', async () => {
			const newHubData = createMockMessageHub();
			setupRoomHandlers(newHubData.hub, roomManager, daemonHub, undefined, undefined);

			const handler = newHubData.handlers.get('room.getPairs');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow(
				'Session pair functionality not yet available'
			);
		});
	});

	describe('room.getPair', () => {
		it('returns pair by ID', async () => {
			const handler = messageHubData.handlers.get('room.getPair');
			expect(handler).toBeDefined();

			const mockPair: SessionPair = {
				id: 'pair-123',
				roomId: 'room-123',
				roomSessionId: 'room-session-123',
				managerSessionId: 'manager-123',
				workerSessionId: 'worker-123',
				status: 'active',
				currentTaskId: 'task-123',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			sessionPairManagerData.getPair.mockReturnValueOnce(mockPair);

			const result = (await handler!({ pairId: 'pair-123' }, {})) as { pair: SessionPair };

			expect(sessionPairManagerData.getPair).toHaveBeenCalledWith('pair-123');
			expect(result.pair).toEqual(mockPair);
		});

		it('returns error for non-existent pair', async () => {
			const handler = messageHubData.handlers.get('room.getPair');
			expect(handler).toBeDefined();

			sessionPairManagerData.getPair.mockReturnValueOnce(null);

			await expect(handler!({ pairId: 'non-existent' }, {})).rejects.toThrow(
				'Session pair not found: non-existent'
			);
		});

		it('returns error when pairId is missing', async () => {
			const handler = messageHubData.handlers.get('room.getPair');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Pair ID is required');
		});

		it('returns error when sessionPairManager is not available', async () => {
			const newHubData = createMockMessageHub();
			setupRoomHandlers(newHubData.hub, roomManager, daemonHub, undefined, undefined);

			const handler = newHubData.handlers.get('room.getPair');
			expect(handler).toBeDefined();

			await expect(handler!({ pairId: 'pair-123' }, {})).rejects.toThrow(
				'Session pair functionality not yet available'
			);
		});
	});

	describe('room.archivePair', () => {
		it('archives active pair successfully', async () => {
			const handler = messageHubData.handlers.get('room.archivePair');
			expect(handler).toBeDefined();

			sessionPairManagerData.archivePair.mockResolvedValueOnce(true);

			const result = (await handler!({ pairId: 'pair-123' }, {})) as { success: boolean };

			expect(sessionPairManagerData.archivePair).toHaveBeenCalledWith('pair-123');
			expect(result.success).toBe(true);
		});

		it('stops bridge before archiving', async () => {
			const handler = messageHubData.handlers.get('room.archivePair');
			expect(handler).toBeDefined();

			sessionPairManagerData.archivePair.mockResolvedValueOnce(true);

			await handler!({ pairId: 'pair-123' }, {});

			// Verify both methods were called
			expect(sessionBridgeData.stopBridge).toHaveBeenCalledWith('pair-123');
			expect(sessionPairManagerData.archivePair).toHaveBeenCalledWith('pair-123');
			// stopBridge should be called once (before archive)
			expect(sessionBridgeData.stopBridge).toHaveBeenCalledTimes(1);
		});

		it('returns error for non-existent pair', async () => {
			const handler = messageHubData.handlers.get('room.archivePair');
			expect(handler).toBeDefined();

			sessionPairManagerData.archivePair.mockResolvedValueOnce(false);

			await expect(handler!({ pairId: 'non-existent' }, {})).rejects.toThrow(
				'Session pair not found: non-existent'
			);
		});

		it('returns error when pairId is missing', async () => {
			const handler = messageHubData.handlers.get('room.archivePair');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Pair ID is required');
		});

		it('returns error when sessionPairManager is not available', async () => {
			const newHubData = createMockMessageHub();
			setupRoomHandlers(newHubData.hub, roomManager, daemonHub, undefined, undefined);

			const handler = newHubData.handlers.get('room.archivePair');
			expect(handler).toBeDefined();

			await expect(handler!({ pairId: 'pair-123' }, {})).rejects.toThrow(
				'Session pair functionality not yet available'
			);
		});

		it('works without sessionBridge (bridge is optional)', async () => {
			const newHubData = createMockMessageHub();
			setupRoomHandlers(
				newHubData.hub,
				roomManager,
				daemonHub,
				sessionPairManagerData.manager,
				undefined
			);

			const handler = newHubData.handlers.get('room.archivePair');
			expect(handler).toBeDefined();

			sessionPairManagerData.archivePair.mockResolvedValueOnce(true);

			// Should not throw - bridge is optional
			const result = await handler!({ pairId: 'pair-123' }, {});
			expect(result).toEqual({ success: true });
		});

		it('archives pair that is already completed (idempotent)', async () => {
			const handler = messageHubData.handlers.get('room.archivePair');
			expect(handler).toBeDefined();

			// Simulate archiving an already completed pair - still returns true
			sessionPairManagerData.archivePair.mockResolvedValueOnce(true);

			const result = (await handler!({ pairId: 'pair-123' }, {})) as { success: boolean };

			expect(result.success).toBe(true);
		});

		it('continues archiving even if stopBridge throws', async () => {
			const handler = messageHubData.handlers.get('room.archivePair');
			expect(handler).toBeDefined();

			// Make stopBridge throw
			sessionBridgeData.stopBridge.mockImplementationOnce(() => {
				throw new Error('Bridge error');
			});

			sessionPairManagerData.archivePair.mockResolvedValueOnce(true);

			// Should still throw because stopBridge error propagates
			await expect(handler!({ pairId: 'pair-123' }, {})).rejects.toThrow('Bridge error');
		});
	});
});
