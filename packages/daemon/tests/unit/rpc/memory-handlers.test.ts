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

// NOTE: We do NOT use mock.module() here because it would globally replace the MemoryManager
// for ALL tests in this process (including memory-manager.test.ts). Instead, we mock the
// database layer which the real MemoryManager uses. This provides proper test isolation.
// See: https://github.com/oven-sh/bun/issues/8244

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

// Helper to create mock Database that simulates basic memory operations
function createMockDatabase(): Database {
	// In-memory store for simulated memories
	const memoriesStore = new Map<string, Record<string, unknown>>();

	const mockRawDb = {
		prepare: mock((sql: string) => {
			// Handle INSERT - store the memory and return success
			if (sql.startsWith('INSERT INTO memories')) {
				return {
					run: mock(
						(
							id: string,
							roomId: string,
							type: string,
							content: string,
							tags: string,
							importance: string,
							sessionId: string | null,
							taskId: string | null,
							createdAt: number,
							lastAccessedAt: number,
							accessCount: number
						) => {
							memoriesStore.set(id, {
								id,
								room_id: roomId,
								type,
								content,
								tags,
								importance,
								session_id: sessionId,
								task_id: taskId,
								created_at: createdAt,
								last_accessed_at: lastAccessedAt,
								access_count: accessCount,
							});
							return { changes: 1 };
						}
					),
					get: mock(() => null),
					all: mock(() => []),
				};
			}

			// Handle SELECT single - retrieve memory by ID
			if (sql.startsWith('SELECT * FROM memories WHERE id = ?')) {
				return {
					run: mock(() => ({ changes: 0 })),
					get: mock((id: string) => memoriesStore.get(id) ?? null),
					all: mock(() => []),
				};
			}

			// Handle SELECT all - list memories by room
			if (sql.startsWith('SELECT * FROM memories WHERE room_id = ?')) {
				return {
					run: mock(() => ({ changes: 0 })),
					get: mock(() => null),
					all: mock((roomId: string, ...rest: unknown[]) => {
						let results = Array.from(memoriesStore.values()).filter((m) => m.room_id === roomId);
						// Handle type filter if provided
						if (rest.length > 0 && typeof rest[0] === 'string') {
							results = results.filter((m) => m.type === rest[0]);
						}
						return results;
					}),
				};
			}

			// Handle DELETE
			if (sql.startsWith('DELETE FROM memories WHERE id = ?')) {
				return {
					run: mock((id: string) => {
						const existed = memoriesStore.has(id);
						memoriesStore.delete(id);
						return { changes: existed ? 1 : 0 };
					}),
					get: mock(() => null),
					all: mock(() => []),
				};
			}

			// Handle UPDATE (touch)
			if (sql.startsWith('UPDATE memories SET last_accessed_at')) {
				return {
					run: mock(() => ({ changes: 1 })),
					get: mock(() => null),
					all: mock(() => []),
				};
			}

			// Handle COUNT
			if (sql.startsWith('SELECT COUNT(*)')) {
				return {
					run: mock(() => ({ changes: 0 })),
					get: mock((roomId: string) => ({
						count: Array.from(memoriesStore.values()).filter((m) => m.room_id === roomId).length,
					})),
					all: mock(() => []),
				};
			}

			// Default handler for other queries
			return {
				run: mock(() => ({ changes: 1 })),
				get: mock(() => null),
				all: mock(() => []),
			};
		}),
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

			expect(result.memory).toBeDefined();
			expect(result.memory.roomId).toBe('room-123');
			expect(result.memory.content).toBe('This is an important note');
		});

		it('adds memory with minimal parameters', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				content: 'Simple memory',
			};

			const result = (await handler!(params, {})) as { memory: NeoMemory };

			expect(result.memory).toBeDefined();
			expect(result.memory.content).toBe('Simple memory');
		});

		it('defaults type to note when not provided', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				content: 'Memory without type',
			};

			const result = (await handler!(params, {})) as { memory: NeoMemory };

			// The handler should default type to 'note'
			expect(result.memory.type).toBe('note');
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
				const params = {
					roomId: 'room-123',
					type,
					content: `Memory of type ${type}`,
				};

				const result = (await handler!(params, {})) as { memory: NeoMemory };
				expect(result.memory).toBeDefined();
				expect(result.memory.type).toBe(type);
			}
		});

		it('adds memory with different importance levels', async () => {
			const handler = messageHubData.handlers.get('memory.add');
			expect(handler).toBeDefined();

			const importances: MemoryImportance[] = ['low', 'medium', 'high'];

			for (const importance of importances) {
				const params = {
					roomId: 'room-123',
					content: `Memory with ${importance} importance`,
					importance,
				};

				const result = (await handler!(params, {})) as { memory: NeoMemory };
				expect(result.memory).toBeDefined();
				expect(result.memory.importance).toBe(importance);
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

			expect(Array.isArray(result.memories)).toBe(true);
		});

		it('filters by type', async () => {
			const handler = messageHubData.handlers.get('memory.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				type: 'decision' as MemoryType,
			};

			const result = (await handler!(params, {})) as { memories: NeoMemory[] };

			// Verify the result is an array (type filter is applied by MemoryManager)
			expect(Array.isArray(result.memories)).toBe(true);
		});

		it('returns empty array when no memories', async () => {
			const handler = messageHubData.handlers.get('memory.list');
			expect(handler).toBeDefined();

			// With mock database returning empty arrays, result will be empty
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

			const result = (await handler!(params, {})) as { memories: NeoMemory[] };

			// Verify the result is an array (limit is applied by MemoryManager)
			expect(Array.isArray(result.memories)).toBe(true);
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

			// With mock database returning empty arrays, result will be empty
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

			expect(Array.isArray(result.memories)).toBe(true);
		});

		it('recalls memories by tags', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				tags: ['important', 'project'],
			};

			const result = (await handler!(params, {})) as { memories: NeoMemory[] };

			// Verify the result is an array (tags filter is applied by MemoryManager)
			expect(Array.isArray(result.memories)).toBe(true);
		});

		it('recalls memories by type and tags', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				type: 'note' as MemoryType,
				tags: ['important'],
			};

			const result = (await handler!(params, {})) as { memories: NeoMemory[] };

			// Verify the result is an array (filters applied by MemoryManager)
			expect(Array.isArray(result.memories)).toBe(true);
		});

		it('recalls with limit', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				limit: 5,
			};

			const result = (await handler!(params, {})) as { memories: NeoMemory[] };

			// Verify the result is an array (limit applied by MemoryManager)
			expect(Array.isArray(result.memories)).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			await expect(handler!({ type: 'note' }, {})).rejects.toThrow('Room ID is required');
		});

		it('returns empty array when no criteria match', async () => {
			const handler = messageHubData.handlers.get('memory.recall');
			expect(handler).toBeDefined();

			// With mock database returning empty arrays, result will be empty
			const result = (await handler!({ roomId: 'room-123' }, {})) as {
				memories: NeoMemory[];
			};

			expect(result.memories).toEqual([]);
		});
	});

	describe('memory.delete', () => {
		it('deletes memory successfully', async () => {
			const addHandler = messageHubData.handlers.get('memory.add');
			const deleteHandler = messageHubData.handlers.get('memory.delete');
			expect(addHandler).toBeDefined();
			expect(deleteHandler).toBeDefined();

			// First add a memory
			const addResult = (await addHandler!(
				{
					roomId: 'room-123',
					content: 'Memory to delete',
				},
				{}
			)) as { memory: NeoMemory };

			// Then delete it
			const deleteResult = (await deleteHandler!(
				{
					roomId: 'room-123',
					memoryId: addResult.memory.id,
				},
				{}
			)) as { success: boolean };

			expect(deleteResult.success).toBe(true);
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

			// Try to delete a memory that doesn't exist (db is empty, so this will fail)
			const result = (await handler!({ roomId: 'room-123', memoryId: 'nonexistent' }, {})) as {
				success: boolean;
			};

			expect(result.success).toBe(false);
		});
	});
});
