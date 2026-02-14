/**
 * Memory RPC Handlers
 *
 * RPC handlers for Neo memory operations:
 * - memory.add - Add memory to room
 * - memory.list - List memories in room
 * - memory.search - Search memories
 * - memory.recall - Recall memories by type/tags
 * - memory.delete - Delete a memory
 *
 * Renamed from neo.memory.* to memory.* for cleaner API.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub, MemoryType, MemoryImportance } from '@neokai/shared';
import type { Database } from '../../storage/database';
import { MemoryManager } from '../room';

/**
 * Create a MemoryManager instance for a room
 */
function createMemoryManager(db: Database, roomId: string): MemoryManager {
	const rawDb = (db as unknown as { db: BunDatabase }).db;
	return new MemoryManager(rawDb, roomId);
}

export function setupMemoryHandlers(
	messageHub: MessageHub,
	_roomManager: unknown,
	_daemonHub: unknown,
	db: Database
): void {
	// memory.add - Add memory to room
	messageHub.onRequest('memory.add', async (data) => {
		const params = data as {
			roomId: string;
			type: MemoryType;
			content: string;
			tags?: string[];
			importance?: MemoryImportance;
			sessionId?: string;
			taskId?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.content) {
			throw new Error('Memory content is required');
		}

		const memoryManager = createMemoryManager(db, params.roomId);
		const memory = await memoryManager.addMemory({
			type: params.type ?? 'note',
			content: params.content,
			tags: params.tags,
			importance: params.importance,
			sessionId: params.sessionId,
			taskId: params.taskId,
		});

		return { memory };
	});

	// memory.list - List memories in room
	messageHub.onRequest('memory.list', async (data) => {
		const params = data as {
			roomId: string;
			type?: MemoryType;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const memoryManager = createMemoryManager(db, params.roomId);
		const memories = await memoryManager.listMemories(params.type);

		return { memories };
	});

	// memory.search - Search memories
	messageHub.onRequest('memory.search', async (data) => {
		const params = data as {
			roomId: string;
			searchTerm: string;
			limit?: number;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.searchTerm) {
			throw new Error('Search term is required');
		}

		const memoryManager = createMemoryManager(db, params.roomId);
		const memories = await memoryManager.searchMemories(params.searchTerm, params.limit);

		return { memories };
	});

	// memory.recall - Recall memories by type/tags
	messageHub.onRequest('memory.recall', async (data) => {
		const params = data as {
			roomId: string;
			type?: MemoryType;
			tags?: string[];
			limit?: number;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const memoryManager = createMemoryManager(db, params.roomId);
		const memories = await memoryManager.recallMemories({
			type: params.type,
			tags: params.tags,
			limit: params.limit,
		});

		return { memories };
	});

	// memory.delete - Delete a memory
	messageHub.onRequest('memory.delete', async (data) => {
		const params = data as { roomId: string; memoryId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.memoryId) {
			throw new Error('Memory ID is required');
		}

		const memoryManager = createMemoryManager(db, params.roomId);
		const deleted = await memoryManager.deleteMemory(params.memoryId);

		return { success: deleted };
	});
}
