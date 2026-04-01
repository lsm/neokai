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

import { describe, expect, it, beforeEach, mock, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MessageHub } from '@neokai/shared';
import { setupRoomHandlers } from '../../../src/lib/rpc-handlers/room-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { SessionManager } from '../../../src/lib/session-manager';
import type { Room, RoomOverview, NeoStatus, Session } from '@neokai/shared';

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
		allowedPaths: [{ path: tempDir }],
		defaultPath: tempDir,
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

// A real temporary directory used for tests that need a valid defaultPath on disk
const tempDir = mkdtempSync(`${tmpdir()}/room-handlers-test-`);

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

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
		it('creates a room with required name and defaultPath', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			const result = (await handler!({ name: 'New Room', defaultPath: tempDir }, {})) as {
				room: Room;
			};

			expect(result.room).toBeDefined();
			expect(roomManagerData.mocks.createRoom).toHaveBeenCalledWith(
				expect.objectContaining({ name: 'New Room', defaultPath: tempDir })
			);
		});

		it('creates a room with background and defaultPath', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await handler!(
				{
					name: 'Full Room',
					background: 'A full featured room',
					defaultPath: tempDir,
				},
				{}
			);

			expect(roomManagerData.mocks.createRoom).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'Full Room',
					background: 'A full featured room',
					defaultPath: tempDir,
				})
			);
		});

		it('derives allowedPaths from defaultPath when not explicitly provided', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await handler!({ name: 'Path Room', defaultPath: tempDir }, {});

			expect(roomManagerData.mocks.createRoom).toHaveBeenCalledWith(
				expect.objectContaining({
					allowedPaths: [{ path: tempDir }],
				})
			);
		});

		it('uses explicit allowedPaths when provided', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			const customPaths = [{ path: tempDir }, { path: '/other/path' }];
			await handler!(
				{ name: 'Custom Paths Room', defaultPath: tempDir, allowedPaths: customPaths },
				{}
			);

			expect(roomManagerData.mocks.createRoom).toHaveBeenCalledWith(
				expect.objectContaining({
					allowedPaths: customPaths,
				})
			);
		});

		it('throws error when name is missing', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await expect(handler!({ description: 'No name', defaultPath: tempDir }, {})).rejects.toThrow(
				'Room name is required'
			);
		});

		it('throws error when defaultPath is missing', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await expect(handler!({ name: 'No Path Room' }, {})).rejects.toThrow(
				'defaultPath is required when creating a room'
			);
		});

		it('throws error when defaultPath is empty string', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await expect(handler!({ name: 'Empty Path Room', defaultPath: '' }, {})).rejects.toThrow(
				'defaultPath is required when creating a room'
			);
		});

		it('throws error when defaultPath is not an absolute path', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await expect(
				handler!({ name: 'Relative Path Room', defaultPath: 'relative/path' }, {})
			).rejects.toThrow('Invalid defaultPath');
		});

		it('throws error when defaultPath does not exist on disk', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await expect(
				handler!({ name: 'Bad Path Room', defaultPath: '/nonexistent/path/xyz-12345' }, {})
			).rejects.toThrow('defaultPath does not exist: /nonexistent/path/xyz-12345');
		});

		it('broadcasts room.created event', async () => {
			const handler = messageHubData.handlers.get('room.create');
			expect(handler).toBeDefined();

			await handler!({ name: 'New Room', defaultPath: tempDir }, {});

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
		it('updates room with all parameters (no defaultPath change)', async () => {
			const handler = messageHubData.handlers.get('room.update');
			expect(handler).toBeDefined();

			await handler!(
				{
					roomId: 'room-123',
					name: 'Updated Name',
					background: 'Updated background',
					allowedPaths: [{ path: tempDir }],
					defaultModel: 'claude-opus',
				},
				{}
			);

			expect(roomManagerData.mocks.updateRoom).toHaveBeenCalledWith(
				'room-123',
				expect.objectContaining({
					name: 'Updated Name',
					background: 'Updated background',
					allowedPaths: [{ path: tempDir }],
					defaultModel: 'claude-opus',
				})
			);
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

		it('syncs room chat session model when defaultModel changes', async () => {
			const updateSessionMock = mock(async () => {});
			const existingSession: Partial<Session> = {
				id: 'room:chat:room-123',
				config: {
					model: 'glm-5-turbo',
					provider: 'glm',
					maxTokens: 4096,
					temperature: 1.0,
				},
			};
			const sessionManager = {
				getSessionFromDB: mock(() => existingSession as Session),
				updateSession: updateSessionMock,
			} as unknown as SessionManager;

			const { hub, handlers } = createMockMessageHub();
			setupRoomHandlers(hub, roomManagerData.roomManager, daemonHubData.daemonHub, sessionManager);

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', defaultModel: 'sonnet' }, {});

			expect(updateSessionMock).toHaveBeenCalledWith(
				'room:chat:room-123',
				expect.objectContaining({
					config: expect.objectContaining({
						model: 'sonnet',
						provider: 'anthropic',
					}),
				})
			);
		});
	});

	describe('room.update defaultPath guard', () => {
		it('rejects defaultPath change when active task groups exist', async () => {
			const { hub, handlers } = createMockMessageHub();
			const { daemonHub } = createMockDaemonHub();
			const { roomManager } = createMockRoomManager();

			// hasActiveTaskGroups returns true → tasks are running
			const hasActiveTaskGroups = mock(() => true);
			setupRoomHandlers(hub, roomManager, daemonHub, undefined, undefined, undefined, {
				hasActiveTaskGroups,
			});

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			// Create a second tempDir to represent the new path
			const { mkdtempSync: mktemp } = await import('node:fs');
			const { tmpdir } = await import('node:os');
			const newPath = mktemp(`${tmpdir()}/room-handlers-guard-test-`);
			try {
				await expect(handler!({ roomId: 'room-123', defaultPath: newPath }, {})).rejects.toThrow(
					'Cannot change defaultPath while tasks are active. Stop or complete all tasks first.'
				);
				expect(hasActiveTaskGroups).toHaveBeenCalledWith('room-123');
			} finally {
				const { rmSync } = await import('node:fs');
				rmSync(newPath, { recursive: true, force: true });
			}
		});

		it('allows defaultPath change when no active task groups exist', async () => {
			const { hub, handlers } = createMockMessageHub();
			const { daemonHub } = createMockDaemonHub();
			const { roomManager, mocks } = createMockRoomManager();

			// hasActiveTaskGroups returns false → no tasks running
			const hasActiveTaskGroups = mock(() => false);
			setupRoomHandlers(hub, roomManager, daemonHub, undefined, undefined, undefined, {
				hasActiveTaskGroups,
			});

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			const { mkdtempSync: mktemp } = await import('node:fs');
			const { tmpdir } = await import('node:os');
			const newPath = mktemp(`${tmpdir()}/room-handlers-allow-test-`);
			try {
				await handler!({ roomId: 'room-123', defaultPath: newPath }, {});
				expect(hasActiveTaskGroups).toHaveBeenCalledWith('room-123');
				expect(mocks.updateRoom).toHaveBeenCalledWith(
					'room-123',
					expect.objectContaining({ defaultPath: newPath })
				);
			} finally {
				const { rmSync } = await import('node:fs');
				rmSync(newPath, { recursive: true, force: true });
			}
		});

		it('rejects defaultPath change when new path does not exist on disk', async () => {
			const { hub, handlers } = createMockMessageHub();
			const { daemonHub } = createMockDaemonHub();
			const { roomManager } = createMockRoomManager();

			setupRoomHandlers(hub, roomManager, daemonHub, undefined, undefined, undefined, {
				hasActiveTaskGroups: () => false,
			});

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			await expect(
				handler!({ roomId: 'room-123', defaultPath: '/does/not/exist/ever' }, {})
			).rejects.toThrow('defaultPath does not exist: /does/not/exist/ever');
		});

		it('rejects defaultPath change when new path is not absolute', async () => {
			const { hub, handlers } = createMockMessageHub();
			const { daemonHub } = createMockDaemonHub();
			const { roomManager } = createMockRoomManager();

			setupRoomHandlers(hub, roomManager, daemonHub, undefined, undefined, undefined, {
				hasActiveTaskGroups: () => false,
			});

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			await expect(
				handler!({ roomId: 'room-123', defaultPath: 'relative/path' }, {})
			).rejects.toThrow('Invalid defaultPath');
		});

		it('auto-adds new defaultPath to allowedPaths when not already present', async () => {
			const { hub, handlers } = createMockMessageHub();
			const { daemonHub } = createMockDaemonHub();
			const { roomManager, mocks } = createMockRoomManager();

			setupRoomHandlers(hub, roomManager, daemonHub, undefined, undefined, undefined, {
				hasActiveTaskGroups: () => false,
			});

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			const { mkdtempSync: mktemp } = await import('node:fs');
			const { tmpdir } = await import('node:os');
			const newPath = mktemp(`${tmpdir()}/room-handlers-autopaths-test-`);
			try {
				await handler!({ roomId: 'room-123', defaultPath: newPath }, {});
				// newPath was not in the room's original allowedPaths — should be auto-added
				expect(mocks.updateRoom).toHaveBeenCalledWith(
					'room-123',
					expect.objectContaining({
						defaultPath: newPath,
						allowedPaths: expect.arrayContaining([{ path: newPath }]),
					})
				);
			} finally {
				const { rmSync } = await import('node:fs');
				rmSync(newPath, { recursive: true, force: true });
			}
		});

		it('does not trigger guard when defaultPath is unchanged', async () => {
			const { hub, handlers } = createMockMessageHub();
			const { daemonHub } = createMockDaemonHub();
			const { roomManager, mocks } = createMockRoomManager();

			const hasActiveTaskGroups = mock(() => true); // would throw if called
			setupRoomHandlers(hub, roomManager, daemonHub, undefined, undefined, undefined, {
				hasActiveTaskGroups,
			});

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			// mockRoom.defaultPath = tempDir, so passing the same tempDir is "no change"
			await handler!({ roomId: 'room-123', name: 'New Name', defaultPath: tempDir }, {});

			// guard callback must NOT be called when path is unchanged
			expect(hasActiveTaskGroups).not.toHaveBeenCalled();
			expect(mocks.updateRoom).toHaveBeenCalled();
		});
	});

	describe('room.update defaultPath workspacePath sync', () => {
		it('syncs room chat session workspacePath when defaultPath changes', async () => {
			const updateSessionMock = mock(async () => {});
			const existingSession: Partial<Session> = {
				id: 'room:chat:room-123',
				workspacePath: tempDir,
			};
			const sessionManager = {
				getSessionFromDB: mock(() => existingSession as Session),
				updateSession: updateSessionMock,
			} as unknown as SessionManager;

			const { hub, handlers } = createMockMessageHub();
			const { roomManager, mocks } = createMockRoomManager();

			const { mkdtempSync: mktemp } = await import('node:fs');
			const { tmpdir: getTmpdir } = await import('node:os');
			const newPath = mktemp(`${getTmpdir()}/room-handlers-wspath-test-`);
			try {
				// Make updateRoom return a room with the new defaultPath (simulates DB update)
				const updatedRoom: Room = {
					id: 'room-123',
					name: 'Test Room',
					allowedPaths: [{ path: newPath }],
					defaultPath: newPath,
					sessionIds: [],
					status: 'active' as const,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				mocks.updateRoom.mockReturnValueOnce(updatedRoom);

				setupRoomHandlers(
					hub,
					roomManager,
					daemonHubData.daemonHub,
					sessionManager,
					undefined,
					undefined,
					{
						hasActiveTaskGroups: () => false,
					}
				);

				const handler = handlers.get('room.update');
				expect(handler).toBeDefined();

				await handler!({ roomId: 'room-123', defaultPath: newPath }, {});

				expect(updateSessionMock).toHaveBeenCalledWith(
					'room:chat:room-123',
					expect.objectContaining({ workspacePath: newPath })
				);
			} finally {
				const { rmSync } = await import('node:fs');
				rmSync(newPath, { recursive: true, force: true });
			}
		});

		it('does not sync workspacePath when defaultPath is not provided', async () => {
			const updateSessionMock = mock(async () => {});
			const sessionManager = {
				getSessionFromDB: mock(() => null),
				updateSession: updateSessionMock,
			} as unknown as SessionManager;

			const { hub, handlers } = createMockMessageHub();
			const { roomManager } = createMockRoomManager();
			setupRoomHandlers(hub, roomManager, daemonHubData.daemonHub, sessionManager);

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			// Update only the name — no defaultPath
			await handler!({ roomId: 'room-123', name: 'Updated Name' }, {});

			// workspacePath sync should NOT be called
			expect(updateSessionMock).not.toHaveBeenCalled();
		});

		it('does not sync workspacePath when defaultPath is unchanged', async () => {
			// mockRoom has defaultPath: tempDir — sending the same value should be a no-op
			const updateSessionMock = mock(async () => {});
			const existingSession: Partial<Session> = {
				id: 'room:chat:room-123',
				workspacePath: tempDir,
			};
			const sessionManager = {
				getSessionFromDB: mock(() => existingSession as Session),
				updateSession: updateSessionMock,
			} as unknown as SessionManager;

			const { hub, handlers } = createMockMessageHub();
			const { roomManager } = createMockRoomManager();
			setupRoomHandlers(hub, roomManager, daemonHubData.daemonHub, sessionManager);

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			// Send the same defaultPath that the room already has
			await handler!({ roomId: 'room-123', defaultPath: tempDir }, {});

			// defaultPath did not change — no workspacePath sync needed
			expect(updateSessionMock).not.toHaveBeenCalled();
		});

		it('does not sync workspacePath when room chat session does not exist', async () => {
			const updateSessionMock = mock(async () => {});
			const sessionManager = {
				// Returns null — session not in DB yet
				getSessionFromDB: mock(() => null),
				updateSession: updateSessionMock,
			} as unknown as SessionManager;

			const { hub, handlers } = createMockMessageHub();
			const { roomManager } = createMockRoomManager();
			setupRoomHandlers(
				hub,
				roomManager,
				daemonHubData.daemonHub,
				sessionManager,
				undefined,
				undefined,
				{
					hasActiveTaskGroups: () => false,
				}
			);

			const handler = handlers.get('room.update');
			expect(handler).toBeDefined();

			const { mkdtempSync: mktemp } = await import('node:fs');
			const { tmpdir: getTmpdir } = await import('node:os');
			const newPath = mktemp(`${getTmpdir()}/room-handlers-nosession-test-`);
			try {
				await handler!({ roomId: 'room-123', defaultPath: newPath }, {});
				// updateSession must NOT be called when session does not exist
				expect(updateSessionMock).not.toHaveBeenCalled();
			} finally {
				const { rmSync } = await import('node:fs');
				rmSync(newPath, { recursive: true, force: true });
			}
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
});
