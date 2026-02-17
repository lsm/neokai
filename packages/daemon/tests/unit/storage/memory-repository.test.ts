/**
 * Memory Repository Tests
 *
 * Tests for Neo memory CRUD operations.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MemoryRepository } from '../../../src/storage/repositories/memory-repository';
import type { NeoMemory, CreateMemoryParams, MemoryType, MemoryImportance } from '@neokai/shared';

describe('MemoryRepository', () => {
	let db: Database;
	let repository: MemoryRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE memories (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				type TEXT NOT NULL,
				content TEXT NOT NULL,
				tags TEXT NOT NULL DEFAULT '[]',
				importance TEXT NOT NULL DEFAULT 'normal',
				session_id TEXT,
				task_id TEXT,
				created_at INTEGER NOT NULL,
				last_accessed_at INTEGER NOT NULL,
				access_count INTEGER NOT NULL DEFAULT 0
			);

			CREATE INDEX idx_memories_room ON memories(room_id);
			CREATE INDEX idx_memories_type ON memories(type);
		`);
		repository = new MemoryRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('createMemory', () => {
		it('should create a memory with required fields', () => {
			const params: CreateMemoryParams = {
				roomId: 'room-1',
				type: 'conversation',
				content: 'This is a conversation memory',
			};

			const memory = repository.createMemory(params);

			expect(memory.id).toBeDefined();
			expect(memory.roomId).toBe('room-1');
			expect(memory.type).toBe('conversation');
			expect(memory.content).toBe('This is a conversation memory');
			expect(memory.tags).toEqual([]);
			expect(memory.importance).toBe('normal');
		});

		it('should create a memory with all optional fields', () => {
			const params: CreateMemoryParams = {
				roomId: 'room-1',
				type: 'task_result',
				content: 'Task completed successfully',
				tags: ['important', 'code'],
				importance: 'high',
				sessionId: 'session-1',
				taskId: 'task-1',
			};

			const memory = repository.createMemory(params);

			expect(memory.tags).toEqual(['important', 'code']);
			expect(memory.importance).toBe('high');
			expect(memory.sessionId).toBe('session-1');
			expect(memory.taskId).toBe('task-1');
		});

		it('should set createdAt and lastAccessedAt to current time', () => {
			const beforeTime = Date.now();
			const params: CreateMemoryParams = {
				roomId: 'room-1',
				type: 'note',
				content: 'Test note',
			};

			const memory = repository.createMemory(params);

			expect(memory.createdAt).toBeGreaterThanOrEqual(beforeTime);
			expect(memory.lastAccessedAt).toBeGreaterThanOrEqual(beforeTime);
			expect(memory.createdAt).toBe(memory.lastAccessedAt);
		});

		it('should initialize accessCount to 0', () => {
			const params: CreateMemoryParams = {
				roomId: 'room-1',
				type: 'pattern',
				content: 'Test pattern',
			};

			const memory = repository.createMemory(params);

			expect(memory.accessCount).toBe(0);
		});

		it('should support all memory types', () => {
			const types: MemoryType[] = ['conversation', 'task_result', 'preference', 'pattern', 'note'];

			types.forEach((type) => {
				const memory = repository.createMemory({
					roomId: 'room-1',
					type,
					content: `Memory of type ${type}`,
				});
				expect(memory.type).toBe(type);
			});
		});

		it('should support all importance levels', () => {
			const levels: MemoryImportance[] = ['low', 'normal', 'high'];

			levels.forEach((importance) => {
				const memory = repository.createMemory({
					roomId: 'room-1',
					type: 'note',
					content: `Memory with ${importance} importance`,
					importance,
				});
				expect(memory.importance).toBe(importance);
			});
		});
	});

	describe('getMemory', () => {
		it('should return memory by ID', () => {
			const created = repository.createMemory({
				roomId: 'room-1',
				type: 'conversation',
				content: 'Test memory',
			});

			const memory = repository.getMemory(created.id);

			expect(memory).not.toBeNull();
			expect(memory?.id).toBe(created.id);
			expect(memory?.content).toBe('Test memory');
		});

		it('should return null for non-existent ID', () => {
			const memory = repository.getMemory('non-existent-id');

			expect(memory).toBeNull();
		});
	});

	describe('listMemories', () => {
		it('should return all memories for a room', () => {
			repository.createMemory({ roomId: 'room-1', type: 'conversation', content: 'Memory 1' });
			repository.createMemory({ roomId: 'room-1', type: 'task_result', content: 'Memory 2' });
			repository.createMemory({ roomId: 'room-2', type: 'note', content: 'Memory 3' });

			const memories = repository.listMemories('room-1');

			expect(memories.length).toBe(2);
			expect(memories.map((m) => m.content)).toContain('Memory 1');
			expect(memories.map((m) => m.content)).toContain('Memory 2');
		});

		it('should return memories ordered by created_at DESC', async () => {
			repository.createMemory({ roomId: 'room-1', type: 'note', content: 'Oldest' });
			await new Promise((r) => setTimeout(r, 5));
			repository.createMemory({ roomId: 'room-1', type: 'note', content: 'Middle' });
			await new Promise((r) => setTimeout(r, 5));
			repository.createMemory({ roomId: 'room-1', type: 'note', content: 'Newest' });

			const memories = repository.listMemories('room-1');

			expect(memories[0].content).toBe('Newest');
			expect(memories[1].content).toBe('Middle');
			expect(memories[2].content).toBe('Oldest');
		});

		it('should filter by type when provided', () => {
			repository.createMemory({
				roomId: 'room-1',
				type: 'conversation',
				content: 'Conversation 1',
			});
			repository.createMemory({ roomId: 'room-1', type: 'task_result', content: 'Task Result 1' });
			repository.createMemory({
				roomId: 'room-1',
				type: 'conversation',
				content: 'Conversation 2',
			});

			const conversations = repository.listMemories('room-1', 'conversation');
			const taskResults = repository.listMemories('room-1', 'task_result');

			expect(conversations.length).toBe(2);
			expect(taskResults.length).toBe(1);
		});

		it('should return empty array for non-existent room', () => {
			const memories = repository.listMemories('non-existent-room');

			expect(memories).toEqual([]);
		});

		it('should return empty array when no memories match type filter', () => {
			repository.createMemory({ roomId: 'room-1', type: 'conversation', content: 'Test' });

			const memories = repository.listMemories('room-1', 'task_result');

			expect(memories).toEqual([]);
		});
	});

	describe('touchMemory', () => {
		it('should update last_accessed_at timestamp', async () => {
			const memory = repository.createMemory({
				roomId: 'room-1',
				type: 'note',
				content: 'Test',
			});
			const originalAccessedAt = memory.lastAccessedAt;
			await new Promise((r) => setTimeout(r, 5));

			repository.touchMemory(memory.id);

			const updated = repository.getMemory(memory.id);
			expect(updated?.lastAccessedAt).toBeGreaterThan(originalAccessedAt);
		});

		it('should increment access_count', () => {
			const memory = repository.createMemory({
				roomId: 'room-1',
				type: 'note',
				content: 'Test',
			});
			expect(memory.accessCount).toBe(0);

			repository.touchMemory(memory.id);
			repository.touchMemory(memory.id);
			repository.touchMemory(memory.id);

			const updated = repository.getMemory(memory.id);
			expect(updated?.accessCount).toBe(3);
		});

		it('should not throw when touching non-existent memory', () => {
			expect(() => repository.touchMemory('non-existent')).not.toThrow();
		});
	});

	describe('deleteMemory', () => {
		it('should delete a memory by ID', () => {
			const memory = repository.createMemory({
				roomId: 'room-1',
				type: 'note',
				content: 'To be deleted',
			});

			repository.deleteMemory(memory.id);

			expect(repository.getMemory(memory.id)).toBeNull();
		});

		it('should only delete the specified memory', () => {
			const memory1 = repository.createMemory({
				roomId: 'room-1',
				type: 'note',
				content: 'Memory 1',
			});
			const memory2 = repository.createMemory({
				roomId: 'room-1',
				type: 'note',
				content: 'Memory 2',
			});

			repository.deleteMemory(memory1.id);

			expect(repository.getMemory(memory1.id)).toBeNull();
			expect(repository.getMemory(memory2.id)).not.toBeNull();
		});

		it('should not throw when deleting non-existent memory', () => {
			expect(() => repository.deleteMemory('non-existent')).not.toThrow();
		});
	});

	describe('deleteMemoriesForRoom', () => {
		it('should delete all memories for a room', () => {
			repository.createMemory({ roomId: 'room-1', type: 'note', content: 'Memory 1' });
			repository.createMemory({ roomId: 'room-1', type: 'note', content: 'Memory 2' });
			repository.createMemory({ roomId: 'room-2', type: 'note', content: 'Memory 3' });

			repository.deleteMemoriesForRoom('room-1');

			expect(repository.listMemories('room-1')).toEqual([]);
			expect(repository.listMemories('room-2').length).toBe(1);
		});

		it('should not throw when deleting for non-existent room', () => {
			expect(() => repository.deleteMemoriesForRoom('non-existent')).not.toThrow();
		});
	});

	describe('countMemories', () => {
		it('should return count of memories for a room', () => {
			repository.createMemory({ roomId: 'room-1', type: 'note', content: 'Memory 1' });
			repository.createMemory({ roomId: 'room-1', type: 'note', content: 'Memory 2' });
			repository.createMemory({ roomId: 'room-1', type: 'note', content: 'Memory 3' });

			const count = repository.countMemories('room-1');

			expect(count).toBe(3);
		});

		it('should return 0 for non-existent room', () => {
			const count = repository.countMemories('non-existent-room');

			expect(count).toBe(0);
		});

		it('should only count memories for specified room', () => {
			repository.createMemory({ roomId: 'room-1', type: 'note', content: 'Memory 1' });
			repository.createMemory({ roomId: 'room-2', type: 'note', content: 'Memory 2' });

			expect(repository.countMemories('room-1')).toBe(1);
			expect(repository.countMemories('room-2')).toBe(1);
		});
	});

	describe('memory lifecycle', () => {
		it('should support full memory workflow', async () => {
			// Create memory
			const memory = repository.createMemory({
				roomId: 'room-1',
				type: 'task_result',
				content: 'Completed feature implementation',
				tags: ['feature', 'important'],
				importance: 'high',
				sessionId: 'session-1',
				taskId: 'task-1',
			});

			expect(memory.importance).toBe('high');
			expect(memory.accessCount).toBe(0);

			// Access memory multiple times
			repository.touchMemory(memory.id);
			repository.touchMemory(memory.id);

			const accessed = repository.getMemory(memory.id);
			expect(accessed?.accessCount).toBe(2);

			// List memories
			const memories = repository.listMemories('room-1', 'task_result');
			expect(memories.length).toBe(1);

			// Count memories
			expect(repository.countMemories('room-1')).toBe(1);

			// Delete memory
			repository.deleteMemory(memory.id);
			expect(repository.countMemories('room-1')).toBe(0);
		});
	});
});
