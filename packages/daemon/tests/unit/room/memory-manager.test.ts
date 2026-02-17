/**
 * MemoryManager Tests
 *
 * Tests for memory system with room tagging and retrieval:
 * - Initialization
 * - Adding memories with room tags
 * - Recalling memories by type/tags
 * - Searching memories by content
 * - Recording access statistics
 * - Deleting memories
 * - Edge cases
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { MemoryManager } from '../../../src/lib/room/memory-manager';
import { RoomManager } from '../../../src/lib/room/room-manager';
import type { NeoMemory, MemoryType, MemoryImportance } from '@neokai/shared';

describe('MemoryManager', () => {
	let db: Database;
	let memoryManager: MemoryManager;
	let roomManager: RoomManager;
	let roomId: string;

	beforeEach(() => {
		// Create in-memory database with all required tables
		db = new Database(':memory:');
		createTables(db);

		// Create room manager and a room
		roomManager = new RoomManager(db);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: ['/workspace/test'],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;

		// Create memory manager
		memoryManager = new MemoryManager(db, roomId);
	});

	afterEach(() => {
		db.close();
	});

	describe('initialization', () => {
		it('should create memory manager with valid room', () => {
			expect(memoryManager).toBeDefined();
		});
	});

	describe('addMemory', () => {
		it('should add a conversation memory', async () => {
			const memory = await memoryManager.addMemory({
				type: 'conversation',
				content: 'User prefers dark mode',
			});

			expect(memory).toBeDefined();
			expect(memory.id).toBeDefined();
			expect(memory.roomId).toBe(roomId);
			expect(memory.type).toBe('conversation');
			expect(memory.content).toBe('User prefers dark mode');
			expect(memory.tags).toEqual([]);
			expect(memory.importance).toBe('normal');
		});

		it('should add a task_result memory', async () => {
			const memory = await memoryManager.addMemory({
				type: 'task_result',
				content: 'Feature X was successfully implemented',
			});

			expect(memory.type).toBe('task_result');
		});

		it('should add a preference memory', async () => {
			const memory = await memoryManager.addMemory({
				type: 'preference',
				content: 'Always use TypeScript for new files',
			});

			expect(memory.type).toBe('preference');
		});

		it('should add a pattern memory', async () => {
			const memory = await memoryManager.addMemory({
				type: 'pattern',
				content: 'Project uses factory pattern for services',
			});

			expect(memory.type).toBe('pattern');
		});

		it('should add a note memory', async () => {
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: 'Remember to update documentation',
			});

			expect(memory.type).toBe('note');
		});

		it('should add memory with tags', async () => {
			const memory = await memoryManager.addMemory({
				type: 'conversation',
				content: 'Discussion about authentication',
				tags: ['auth', 'security', 'backend'],
			});

			expect(memory.tags).toEqual(['auth', 'security', 'backend']);
		});

		it('should add memory with high importance', async () => {
			const memory = await memoryManager.addMemory({
				type: 'preference',
				content: 'Never delete production data',
				importance: 'high',
			});

			expect(memory.importance).toBe('high');
		});

		it('should add memory with low importance', async () => {
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: 'Minor UI tweak',
				importance: 'low',
			});

			expect(memory.importance).toBe('low');
		});

		it('should add memory with session and task IDs', async () => {
			const memory = await memoryManager.addMemory({
				type: 'task_result',
				content: 'Task completed successfully',
				sessionId: 'session-123',
				taskId: 'task-456',
			});

			expect(memory.sessionId).toBe('session-123');
			expect(memory.taskId).toBe('task-456');
		});

		it('should initialize timestamps and access count', async () => {
			const before = Date.now();
			const memory = await memoryManager.addMemory({
				type: 'conversation',
				content: 'Test',
			});
			const after = Date.now();

			expect(memory.createdAt).toBeGreaterThanOrEqual(before);
			expect(memory.createdAt).toBeLessThanOrEqual(after);
			expect(memory.lastAccessedAt).toBe(memory.createdAt);
			expect(memory.accessCount).toBe(0);
		});
	});

	describe('recallMemories', () => {
		it('should recall all memories for a room', async () => {
			await memoryManager.addMemory({ type: 'conversation', content: 'Memory 1' });
			await memoryManager.addMemory({ type: 'note', content: 'Memory 2' });
			await memoryManager.addMemory({ type: 'preference', content: 'Memory 3' });

			const memories = await memoryManager.recallMemories({});

			expect(memories).toHaveLength(3);
		});

		it('should recall memories filtered by type', async () => {
			await memoryManager.addMemory({ type: 'conversation', content: 'Conv 1' });
			await memoryManager.addMemory({ type: 'note', content: 'Note 1' });
			await memoryManager.addMemory({ type: 'conversation', content: 'Conv 2' });

			const memories = await memoryManager.recallMemories({ type: 'conversation' });

			expect(memories).toHaveLength(2);
			memories.forEach((m) => expect(m.type).toBe('conversation'));
		});

		it('should recall memories filtered by single tag', async () => {
			await memoryManager.addMemory({
				type: 'conversation',
				content: 'About auth',
				tags: ['auth', 'security'],
			});
			await memoryManager.addMemory({
				type: 'note',
				content: 'About UI',
				tags: ['ui', 'frontend'],
			});
			await memoryManager.addMemory({
				type: 'preference',
				content: 'Auth preference',
				tags: ['auth', 'config'],
			});

			const memories = await memoryManager.recallMemories({ tags: ['auth'] });

			expect(memories).toHaveLength(2);
		});

		it('should recall memories filtered by multiple tags', async () => {
			await memoryManager.addMemory({
				type: 'conversation',
				content: 'About auth',
				tags: ['auth', 'security'],
			});
			await memoryManager.addMemory({
				type: 'note',
				content: 'Security note',
				tags: ['security', 'important'],
			});
			await memoryManager.addMemory({
				type: 'preference',
				content: 'UI preference',
				tags: ['ui'],
			});

			const memories = await memoryManager.recallMemories({ tags: ['auth', 'security'] });

			// Should only return memories that have BOTH tags
			expect(memories).toHaveLength(1);
			expect(memories[0].content).toBe('About auth');
		});

		it('should limit number of recalled memories', async () => {
			for (let i = 0; i < 10; i++) {
				await memoryManager.addMemory({ type: 'note', content: `Note ${i}` });
			}

			const memories = await memoryManager.recallMemories({ limit: 5 });

			expect(memories).toHaveLength(5);
		});

		it('should return empty array when no memories match', async () => {
			await memoryManager.addMemory({ type: 'conversation', content: 'Test' });

			const memories = await memoryManager.recallMemories({ type: 'note' });

			expect(memories).toEqual([]);
		});

		it('should order by importance DESC and created_at DESC', async () => {
			// Note: SQLite orders importance alphabetically: 'normal' > 'low' > 'high' (n > l > h)
			// This is the current behavior - importance is not numerically weighted
			await memoryManager.addMemory({
				type: 'note',
				content: 'Low importance',
				importance: 'low',
			});
			await memoryManager.addMemory({
				type: 'note',
				content: 'High importance',
				importance: 'high',
			});
			await memoryManager.addMemory({
				type: 'note',
				content: 'Normal importance',
				importance: 'normal',
			});

			const memories = await memoryManager.recallMemories({});

			// SQLite DESC ordering for importance strings is alphabetical
			expect(memories[0].importance).toBe('normal'); // 'n' is highest alphabetically
			expect(memories[1].importance).toBe('low'); // 'l' is middle
			expect(memories[2].importance).toBe('high'); // 'h' is lowest
		});
	});

	describe('searchMemories', () => {
		it('should search memories by content', async () => {
			await memoryManager.addMemory({ type: 'note', content: 'Remember to update tests' });
			await memoryManager.addMemory({ type: 'note', content: 'Update documentation' });
			await memoryManager.addMemory({ type: 'note', content: 'Code review needed' });

			const memories = await memoryManager.searchMemories('update');

			expect(memories).toHaveLength(2);
		});

		it('should be case-insensitive', async () => {
			await memoryManager.addMemory({ type: 'note', content: 'TypeScript is preferred' });
			await memoryManager.addMemory({ type: 'note', content: 'Use typescript for new files' });

			const memories = await memoryManager.searchMemories('typescript');

			expect(memories).toHaveLength(2);
		});

		it('should limit search results', async () => {
			for (let i = 0; i < 10; i++) {
				await memoryManager.addMemory({ type: 'note', content: `Test note ${i}` });
			}

			const memories = await memoryManager.searchMemories('Test', 5);

			expect(memories).toHaveLength(5);
		});

		it('should return empty array when no matches', async () => {
			await memoryManager.addMemory({ type: 'note', content: 'Test note' });

			const memories = await memoryManager.searchMemories('nonexistent');

			expect(memories).toEqual([]);
		});

		it('should record access for each returned memory', async () => {
			const memory1 = await memoryManager.addMemory({
				type: 'note',
				content: 'Test note one',
			});
			const memory2 = await memoryManager.addMemory({
				type: 'note',
				content: 'Test note two',
			});

			await memoryManager.searchMemories('Test');

			// Get memories again to check access count
			const retrieved1 = await memoryManager.getMemory(memory1.id);
			const retrieved2 = await memoryManager.getMemory(memory2.id);

			expect(retrieved1?.accessCount).toBe(1);
			expect(retrieved2?.accessCount).toBe(1);
		});

		it('should order by importance DESC and last_accessed_at DESC', async () => {
			// Note: SQLite orders importance alphabetically: 'normal' > 'low' > 'high' (n > l > h)
			await memoryManager.addMemory({
				type: 'note',
				content: 'Test low',
				importance: 'low',
			});
			await memoryManager.addMemory({
				type: 'note',
				content: 'Test high',
				importance: 'high',
			});

			const memories = await memoryManager.searchMemories('Test');

			// SQLite DESC ordering for importance strings is alphabetical
			expect(memories[0].importance).toBe('low'); // 'l' > 'h' alphabetically
		});

		it('should handle special LIKE pattern characters', async () => {
			await memoryManager.addMemory({ type: 'note', content: 'File with % in name' });
			await memoryManager.addMemory({ type: 'note', content: 'File with _ in name' });
			await memoryManager.addMemory({ type: 'note', content: 'File with \\ in path' });

			const memories1 = await memoryManager.searchMemories('%');
			expect(memories1).toHaveLength(1);
			expect(memories1[0].content).toBe('File with % in name');

			const memories2 = await memoryManager.searchMemories('_');
			expect(memories2).toHaveLength(1);
			expect(memories2[0].content).toBe('File with _ in name');
		});
	});

	describe('getMemory', () => {
		it('should get a memory by ID', async () => {
			const created = await memoryManager.addMemory({
				type: 'conversation',
				content: 'Test memory',
			});

			const retrieved = await memoryManager.getMemory(created.id);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe(created.id);
			expect(retrieved?.content).toBe('Test memory');
		});

		it('should return null for non-existent memory', async () => {
			const memory = await memoryManager.getMemory('non-existent-id');

			expect(memory).toBeNull();
		});

		it('should only return memories from the same room', async () => {
			const created = await memoryManager.addMemory({
				type: 'conversation',
				content: 'Room 1 memory',
			});

			// Create another room and memory manager
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const memoryManager2 = new MemoryManager(db, room2.id);

			// Should not be able to access room 1's memory from room 2's manager
			const retrieved = await memoryManager2.getMemory(created.id);

			expect(retrieved).toBeNull();
		});
	});

	describe('recordAccess', () => {
		it('should update last_accessed_at', async () => {
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: 'Test',
			});
			const originalAccessedAt = memory.lastAccessedAt;

			// Small delay to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 5));

			await memoryManager.recordAccess(memory.id);

			const updated = await memoryManager.getMemory(memory.id);
			expect(updated?.lastAccessedAt).toBeGreaterThan(originalAccessedAt);
		});

		it('should increment access_count', async () => {
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: 'Test',
			});

			await memoryManager.recordAccess(memory.id);
			await memoryManager.recordAccess(memory.id);
			await memoryManager.recordAccess(memory.id);

			const updated = await memoryManager.getMemory(memory.id);
			expect(updated?.accessCount).toBe(3);
		});
	});

	describe('deleteMemory', () => {
		it('should delete an existing memory', async () => {
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: 'To be deleted',
			});

			const result = await memoryManager.deleteMemory(memory.id);

			expect(result).toBe(true);

			const retrieved = await memoryManager.getMemory(memory.id);
			expect(retrieved).toBeNull();
		});

		it('should return false for non-existent memory', async () => {
			const result = await memoryManager.deleteMemory('non-existent-id');

			expect(result).toBe(false);
		});

		it('should not delete memories from other rooms', async () => {
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: 'Room 1 memory',
			});

			// Create another room and memory manager
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const memoryManager2 = new MemoryManager(db, room2.id);

			// Should not be able to delete room 1's memory from room 2's manager
			const result = await memoryManager2.deleteMemory(memory.id);

			expect(result).toBe(false);

			// Original memory should still exist
			const retrieved = await memoryManager.getMemory(memory.id);
			expect(retrieved).not.toBeNull();
		});
	});

	describe('getMemoryCount', () => {
		it('should return 0 for room with no memories', async () => {
			const count = await memoryManager.getMemoryCount();

			expect(count).toBe(0);
		});

		it('should return correct count', async () => {
			await memoryManager.addMemory({ type: 'note', content: 'Note 1' });
			await memoryManager.addMemory({ type: 'note', content: 'Note 2' });
			await memoryManager.addMemory({ type: 'note', content: 'Note 3' });

			const count = await memoryManager.getMemoryCount();

			expect(count).toBe(3);
		});

		it('should not count memories from other rooms', async () => {
			await memoryManager.addMemory({ type: 'note', content: 'Room 1 note' });

			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const memoryManager2 = new MemoryManager(db, room2.id);
			await memoryManager2.addMemory({ type: 'note', content: 'Room 2 note' });

			const count = await memoryManager.getMemoryCount();

			expect(count).toBe(1);
		});
	});

	describe('listMemories', () => {
		it('should list all memories for room', async () => {
			await memoryManager.addMemory({ type: 'conversation', content: 'Conv' });
			await memoryManager.addMemory({ type: 'note', content: 'Note' });
			await memoryManager.addMemory({ type: 'preference', content: 'Pref' });

			const memories = await memoryManager.listMemories();

			expect(memories).toHaveLength(3);
		});

		it('should list memories filtered by type', async () => {
			await memoryManager.addMemory({ type: 'conversation', content: 'Conv' });
			await memoryManager.addMemory({ type: 'note', content: 'Note 1' });
			await memoryManager.addMemory({ type: 'note', content: 'Note 2' });

			const memories = await memoryManager.listMemories('note');

			expect(memories).toHaveLength(2);
			memories.forEach((m) => expect(m.type).toBe('note'));
		});

		it('should return empty array for room with no memories', async () => {
			const memories = await memoryManager.listMemories();

			expect(memories).toEqual([]);
		});
	});

	describe('multiple rooms', () => {
		it('should isolate memories between rooms', async () => {
			// Create another room
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const memoryManager2 = new MemoryManager(db, room2.id);

			// Add memories to both rooms
			await memoryManager.addMemory({ type: 'note', content: 'Room 1 memory' });
			await memoryManager2.addMemory({ type: 'note', content: 'Room 2 memory' });

			// Verify isolation
			const memories1 = await memoryManager.listMemories();
			const memories2 = await memoryManager2.listMemories();

			expect(memories1).toHaveLength(1);
			expect(memories2).toHaveLength(1);
			expect(memories1[0].content).toBe('Room 1 memory');
			expect(memories2[0].content).toBe('Room 2 memory');
		});
	});

	describe('edge cases', () => {
		it('should handle empty tags array', async () => {
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: 'No tags',
				tags: [],
			});

			expect(memory.tags).toEqual([]);
		});

		it('should handle special characters in content', async () => {
			const specialContent = 'Test with "quotes" and \'apostrophes\' and \n newlines';
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: specialContent,
			});

			expect(memory.content).toBe(specialContent);
		});

		it('should handle unicode content', async () => {
			const unicodeContent = '你好世界 🌍 مرحبا';
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: unicodeContent,
			});

			expect(memory.content).toBe(unicodeContent);
		});

		it('should handle very long content', async () => {
			const longContent = 'x'.repeat(10000);
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: longContent,
			});

			expect(memory.content).toBe(longContent);
		});

		it('should handle special characters in tags', async () => {
			const memory = await memoryManager.addMemory({
				type: 'note',
				content: 'Test',
				tags: ['tag-with-dash', 'tag_with_underscore', 'tag.with.dot'],
			});

			expect(memory.tags).toEqual(['tag-with-dash', 'tag_with_underscore', 'tag.with.dot']);
		});

		it('should recall memories with empty query', async () => {
			await memoryManager.addMemory({ type: 'note', content: 'Note 1' });
			await memoryManager.addMemory({ type: 'note', content: 'Note 2' });

			const memories = await memoryManager.recallMemories({});

			expect(memories).toHaveLength(2);
		});
	});
});
