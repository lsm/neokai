/**
 * Tests for Memory RPC Handlers
 *
 * Tests the RPC handlers for memory operations:
 * - memory.add - Add memory to room
 * - memory.list - List memories in room
 * - memory.search - Search memories
 * - memory.recall - Recall memories by type/tags
 * - memory.delete - Delete a memory
 *
 * Mocks MemoryManager to focus on RPC handler logic.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type NeoMemory, type MemoryType, type MemoryImportance } from '@neokai/shared';
import { setupMemoryHandlers } from '../../../src/lib/rpc-handlers/memory-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock MemoryManager module
const mockMemoryManager = {
	addMemory: mock(
		async () =>
			({
				id: 'memory-123',
				roomId: 'room-123',
				type: 'note' as MemoryType,
				content: 'Test memory content',
				tags: [],
				importance: 'medium' as MemoryImportance,
				createdAt: Date.now(),
			}) as NeoMemory
	),
	listMemories: mock(async () => [] as NeoMemory[]),
	searchMemories: mock(async () => [] as NeoMemory[]),
	recallMemories: mock(async () => [] as NeoMemory[]),
	deleteMemory: mock(async () => true),
};

// Mock the MemoryManager module
mock.module('../../../src/lib/room', () => ({
	MemoryManager: mock(() => mockMemoryManager),
}));

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
function createMockRoomManager(): unknown {
	return {
		createRoom: mock(() => ({ id: 'room-123' })),
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
	};
}

// Helper to create mock Database
function createMockDatabase(): Database {
	const mockRawDb = {
		prepare: mock(() => ({
			run: mock(() => ({ changes: 1 })),
			get: mock(() => null),
			all: mock(() => []),
		})),
		run: mock(() => ({ changes: 1 })),
		get: mock(() => null),
		all: mock(() => []),
	};

	return {
		getDatabase: mock(() => mockRawDb),
	} as unknown as Database;
}

describe('Memory RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHub: DaemonHub;
	let roomManager: ReturnType<typeof createMockRoomManager>;
	let db: Database;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHub = createMockDaemonHub();
		roomManager = createMockRoomManager();
		db = createMockDatabase();

		// Reset all mocks
		mockMemoryManager.addMemory.mockClear();
		mockMemoryManager.listMemories.mockClear();
		mockMemoryManager.searchMemories.mockClear();
		mockMemoryManager.recallMemories.mockClear();
		mockMemoryManager.deleteMemory.mockClear();

		// Setup handlers with mocked dependencies
		setupMemoryHandlers(messageHubData.hub, roomManager, daemonHub, db);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('memory.add', () => {
		it('adds memory with all parameters', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				type: 'note' as MemoryType,
				content: 'This is an important note',
				tags: ['important', 'project'],
				importance: 'high' as MemoryImportance,
				sessionId: 'session-456',
				taskId: 'task-789',
			};

			const result = (await handler!(params, {})) as { memory: NeoMemory };

			expect(mockMemoryManager.addMemory).toHaveBeenCalled();
			expect(result.memory).toBeDefined();
			expect(result.memory.roomId).toBe('room-123');
		});

		it('adds memory with minimal parameters', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				content: 'Simple memory',
			};

			const result = (await handler!(params, {})) as { memory: NeoMemory };

			expect(mockMemoryManager.addMemory).toHaveBeenCalled();
			expect(result.memory).toBeDefined();
		});

		it('defaults type to note when not provided', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				content: 'Memory without type',
			};

			await handler!(params, {});

			// The handler should default type to 'note'
			expect(mockMemoryManager.addMemory).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'note' })
			);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const params = {
				content: 'Memory without room',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when content is missing', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			await expect(handler!(params, {})).rejects.toThrow('Memory content is required');
		});

		it('adds memory with different types', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const types: MemoryType[] = ['note', 'decision', 'preference', 'error', 'success'];

			for (const type of types) {
				mockMemoryManager.addMemory.mockClear();

				const params = {
					roomId: 'room-123',
					type,
					content: `Memory of type ${type}`,
				};

				const result = (await handler!(params, {})) as { memory: NeoMemory };
				expect(result.memory).toBeDefined();
			}
		});

		it('adds memory with different importance levels', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const importances: MemoryImportance[] = ['low', 'medium', 'high'];

			for (const importance of importances) {
				mockMemoryManager.addMemory.mockClear();

				const params = {
					roomId: 'room-123',
					content: `Memory with ${importance} importance`,
					importance,
				};

				const result = (await handler!(params, {})) as { memory: NeoMemory };
				expect(result.memory).toBeDefined();
			}
		});
	});

	describe('memory.list', () => {
		it('lists all memories in a room', async () => {
			const handler = messageHubData.handlers.get('memory.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { memories: NeoMemory[] };

			expect(mockMemoryManager.listMemories).toHaveBeenCalled();
			expect(Array.isArray(result.memories)).toBe(true);
		});

		it('filters by type', async () => {
			const handler = messageHubData.handlers.get('memory.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				type: 'decision' as MemoryType,
			};

			await handler!(params, {});

			expect(mockMemoryManager.listMemories).toHaveBeenCalledWith('decision');
		});

		it('returns empty array when no memories', async () => {
			const handler = messageHubData.handlers.get('memory.list');
			expect(handler).toBeDefined();

			// Mock empty result
			mockMemoryManager.listMemories.mockResolvedValueOnce([]);

			const result = (await handler!({ roomId: 'room-123' }, {})) as {
				memories: NeoMemory[];
			};

			expect(result.memories).toEqual([]);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('memory.list');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('memory.search', () => {
		it('searches memories with search term', async () => {
			const handler = messageHubData.handlers.get('memory.search');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				searchTerm: 'important',
			};

			const result = (await handler!(params, {})) as { memories: NeoMemory[] };

			expect(mockMemoryManager.searchMemories).toHaveBeenCalledWith('important', undefined);
			expect(Array.isArray(result.memories)).toBe(true);
		});

		it('searches with limit', async () => {
			const handler = messageHubData.handlers.get('memory.search');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				searchTerm: 'test',
				limit: 10,
			};

			await handler!(params, {});

			expect(mockMemoryManager.searchMemories).toHaveBeenCalledWith('test', 10);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('memory.search');
			expect(handler).toBeDefined();

			await expect(handler!({ searchTerm: 'test' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when searchTerm is missing', async () => {
			const handler = messageHubData.handlers.get('memory.search');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Search term is required');
		});

		it('returns empty array when no matches', async () => {
			const handler = messageHubData.handlers.get('memory.search');
			expect(handler).toBeDefined();

			// Mock empty result
			mockMemoryManager.searchMemories.mockResolvedValueOnce([]);

			const result = (await handler!({ roomId: 'room-123', searchTerm: 'nonexistent' }, {})) as {
				memories: NeoMemory[];
			};

			expect(result.memories).toEqual([]);
		});
	});

	describe('memory.recall', () => {
		it('recalls memories by type', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				type: 'decision' as MemoryType,
			};

			const result = (await handler!(params, {})) as { memories: NeoMemory[] };

			expect(mockMemoryManager.recallMemories).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'decision' })
			);
			expect(Array.isArray(result.memories)).toBe(true);
		});

		it('recalls memories by tags', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				tags: ['important', 'project'],
			};

			await handler!(params, {});

			expect(mockMemoryManager.recallMemories).toHaveBeenCalledWith(
				expect.objectContaining({ tags: ['important', 'project'] })
			);
		});

		it('recalls memories by type and tags', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				type: 'note' as MemoryType,
				tags: ['important'],
			};

			await handler!(params, {});

			expect(mockMemoryManager.recallMemories).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'note', tags: ['important'] })
			);
		});

		it('recalls with limit', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				limit: 5,
			};

			await handler!(params, {});

			expect(mockMemoryManager.recallMemories).toHaveBeenCalledWith(
				expect.objectContaining({ limit: 5 })
			);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			await expect(handler!({ type: 'note' }, {})).rejects.toThrow('Room ID is required');
		});

		it('returns empty array when no criteria match', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			// Mock empty result
			mockMemoryManager.recallMemories.mockResolvedValueOnce([]);

			const result = (await handler!({ roomId: 'room-123' }, {})) as {
				memories: NeoMemory[];
			};

			expect(result.memories).toEqual([]);
		});
	});

	describe('memory.delete', () => {
		it('deletes memory successfully', async () => {
			const handler = messageHubData.handlers.get('memory.delete');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				memoryId: 'memory-456',
			};

			const result = (await handler!(params, {})) as { success: boolean };

			expect(mockMemoryManager.deleteMemory).toHaveBeenCalledWith('memory-456');
			expect(result.success).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('memory.delete');
			expect(handler).toBeDefined();

			await expect(handler!({ memoryId: 'memory-456' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when memoryId is missing', async () => {
			const handler = messageHubData.handlers.get('memory.delete');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Memory ID is required');
		});

		it('returns false when memory not found', async () => {
			const handler = messageHubData.handlers.get('memory.delete');
			expect(handler).toBeDefined();

			// Mock delete returning false
			mockMemoryManager.deleteMemory.mockResolvedValueOnce(false);

			const result = (await handler!({ roomId: 'room-123', memoryId: 'nonexistent' }, {})) as {
				success: boolean;
			};

			expect(result.success).toBe(false);
		});
	});
});
