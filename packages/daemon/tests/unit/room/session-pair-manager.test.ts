/**
 * SessionPairManager Tests
 *
 * Tests for session pair management:
 * - Creating paired sessions (Manager + Worker)
 * - Getting pairs by ID, room, or session
 * - Updating pair status
 * - Archiving pairs
 * - Error handling for room not found, no workspace path
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { SessionPairManager } from '../../../src/lib/room/session-pair-manager';
import { SessionPairRepository } from '../../../src/storage/repositories/session-pair-repository';
import { RoomManager } from '../../../src/lib/room/room-manager';
import type { CreateSessionPairParams, SessionPair, NeoTask, Room } from '@neokai/shared';

// Mock SessionLifecycle
interface MockSessionLifecycle {
	create: ReturnType<typeof mock>;
	update: ReturnType<typeof mock>;
}

// Helper to create a mock session lifecycle
function createMockSessionLifecycle(): MockSessionLifecycle {
	return {
		create: mock(async () => `session-${Date.now()}-${Math.random().toString(36).substring(7)}`),
		update: mock(async () => undefined),
	};
}

describe('SessionPairManager', () => {
	let db: Database;
	let sessionPairManager: SessionPairManager;
	let roomManager: RoomManager;
	let mockSessionLifecycle: MockSessionLifecycle;

	beforeEach(() => {
		// Create in-memory database with all required tables
		const dbId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		db = new Database(`file:${dbId}?mode=memory&cache=private`, { create: true });
		createTables(db);

		// Create session_pairs table (migration 16)
		db.exec(`
			CREATE TABLE IF NOT EXISTS session_pairs (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				room_session_id TEXT NOT NULL,
				manager_session_id TEXT NOT NULL,
				worker_session_id TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'idle', 'crashed', 'completed')),
				current_task_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_session_pairs_room ON session_pairs(room_id);
			CREATE INDEX IF NOT EXISTS idx_session_pairs_manager ON session_pairs(manager_session_id);
			CREATE INDEX IF NOT EXISTS idx_session_pairs_worker ON session_pairs(worker_session_id);
		`);

		// Create room manager
		roomManager = new RoomManager(db);

		// Create mock session lifecycle
		mockSessionLifecycle = createMockSessionLifecycle();

		// Create session pair manager
		sessionPairManager = new SessionPairManager(db, mockSessionLifecycle as any, roomManager);
	});

	afterEach(() => {
		db.close();
	});

	describe('createPair', () => {
		it('should create a session pair with all required components', async () => {
			// Create a room with workspace path
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Test Task',
				taskDescription: 'A test task description',
			};

			const result = await sessionPairManager.createPair(params);

			// Verify result structure
			expect(result).toBeDefined();
			expect(result.pair).toBeDefined();
			expect(result.task).toBeDefined();

			// Verify pair fields
			expect(result.pair.id).toBeDefined();
			expect(result.pair.roomId).toBe(room.id);
			expect(result.pair.roomSessionId).toBe('room-session-123');
			expect(result.pair.managerSessionId).toBeDefined();
			expect(result.pair.workerSessionId).toBeDefined();
			expect(result.pair.status).toBe('active');
			expect(result.pair.currentTaskId).toBe(result.task.id);

			// Verify task fields
			expect(result.task.id).toBeDefined();
			expect(result.task.roomId).toBe(room.id);
			expect(result.task.title).toBe('Test Task');
			expect(result.task.description).toBe('A test task description');
			expect(result.task.status).toBe('pending');

			// Verify session lifecycle was called correctly
			// First call should be for worker session
			expect(mockSessionLifecycle.create).toHaveBeenCalledTimes(2);

			// Verify room assignment was done
			const updatedRoom = roomManager.getRoom(room.id);
			expect(updatedRoom?.sessionIds).toContain(result.pair.workerSessionId);
			expect(updatedRoom?.sessionIds).toContain(result.pair.managerSessionId);
		});

		it('should create pair with custom workspace path', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/default', '/workspace/custom'],
				defaultPath: '/workspace/default',
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Custom Path Task',
				workspacePath: '/workspace/custom',
			};

			const result = await sessionPairManager.createPair(params);

			expect(result.pair).toBeDefined();
			expect(mockSessionLifecycle.create).toHaveBeenCalled();
		});

		it('should create pair with custom model', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
				defaultModel: 'claude-sonnet-4-20250514',
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Custom Model Task',
				model: 'claude-opus-4-5-20250514',
			};

			const result = await sessionPairManager.createPair(params);

			expect(result.pair).toBeDefined();
		});

		it('should use room default path when workspacePath not provided', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Default Path Task',
			};

			const result = await sessionPairManager.createPair(params);

			expect(result.pair).toBeDefined();
		});

		it('should use first allowed path when no default path', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/first', '/workspace/second'],
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'First Allowed Path Task',
			};

			const result = await sessionPairManager.createPair(params);

			expect(result.pair).toBeDefined();
		});

		it('should throw error when room not found', async () => {
			const params: CreateSessionPairParams = {
				roomId: 'non-existent-room',
				roomSessionId: 'room-session-123',
				taskTitle: 'Test Task',
			};

			await expect(sessionPairManager.createPair(params)).rejects.toThrow(
				'Room not found: non-existent-room'
			);
		});

		it('should throw error when no workspace path available', async () => {
			// Create room without any paths
			const room = roomManager.createRoom({
				name: 'No Paths Room',
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Test Task',
			};

			await expect(sessionPairManager.createPair(params)).rejects.toThrow(
				'No workspace path available for session pair'
			);
		});

		it('should create task with default empty description', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'No Description Task',
				// No taskDescription provided
			};

			const result = await sessionPairManager.createPair(params);

			expect(result.task.description).toBe('');
		});

		it('should create sessions with correct titles', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Implement Feature X',
			};

			await sessionPairManager.createPair(params);

			// Check that sessions were created with correct titles
			const createCalls = mockSessionLifecycle.create.mock.calls;
			expect(createCalls.length).toBe(2);

			// First call is for worker session
			expect(createCalls[0][0].title).toBe('Worker: Implement Feature X');
			expect(createCalls[0][0].sessionType).toBe('worker');

			// Second call is for manager session
			expect(createCalls[1][0].title).toBe('Manager: Implement Feature X');
			expect(createCalls[1][0].sessionType).toBe('manager');
		});

		it('should link sessions correctly', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Linked Task',
			};

			await sessionPairManager.createPair(params);

			const createCalls = mockSessionLifecycle.create.mock.calls;
			const createResults = mockSessionLifecycle.create.mock.results;

			// Manager should be linked to worker (pairedSessionId)
			// The worker session ID is the resolved value of the first create call promise
			const workerSessionId = await createResults[0].value;
			expect(createCalls[1][0].pairedSessionId).toBe(workerSessionId);

			// Both should have the same parent and task
			expect(createCalls[0][0].parentSessionId).toBe('room-session-123');
			expect(createCalls[1][0].parentSessionId).toBe('room-session-123');
		});

		it('should update worker session with manager pairedSessionId', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const params: CreateSessionPairParams = {
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Update Test',
			};

			await sessionPairManager.createPair(params);

			// SessionLifecycle.update should be called to set pairedSessionId on worker
			expect(mockSessionLifecycle.update).toHaveBeenCalled();
		});
	});

	describe('getPair', () => {
		it('should return pair by ID', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Get Test Task',
			});

			const retrieved = sessionPairManager.getPair(pair.id);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe(pair.id);
			expect(retrieved?.roomId).toBe(room.id);
		});

		it('should return null for non-existent pair', () => {
			const result = sessionPairManager.getPair('non-existent-id');

			expect(result).toBeNull();
		});
	});

	describe('getPairsByRoom', () => {
		it('should return all pairs for a room', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-1',
				taskTitle: 'Task 1',
			});

			await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-2',
				taskTitle: 'Task 2',
			});

			const pairs = sessionPairManager.getPairsByRoom(room.id);

			expect(pairs).toHaveLength(2);
			expect(pairs.map((p) => p.roomId)).toEqual([room.id, room.id]);
		});

		it('should return empty array for room with no pairs', () => {
			const room = roomManager.createRoom({ name: 'Empty Room' });

			const pairs = sessionPairManager.getPairsByRoom(room.id);

			expect(pairs).toEqual([]);
		});

		it('should not return pairs from other rooms', async () => {
			const room1 = roomManager.createRoom({
				name: 'Room 1',
				allowedPaths: ['/workspace/1'],
				defaultPath: '/workspace/1',
			});

			const room2 = roomManager.createRoom({
				name: 'Room 2',
				allowedPaths: ['/workspace/2'],
				defaultPath: '/workspace/2',
			});

			await sessionPairManager.createPair({
				roomId: room1.id,
				roomSessionId: 'room-session-1',
				taskTitle: 'Room 1 Task',
			});

			await sessionPairManager.createPair({
				roomId: room2.id,
				roomSessionId: 'room-session-2',
				taskTitle: 'Room 2 Task',
			});

			const room1Pairs = sessionPairManager.getPairsByRoom(room1.id);
			const room2Pairs = sessionPairManager.getPairsByRoom(room2.id);

			expect(room1Pairs).toHaveLength(1);
			expect(room2Pairs).toHaveLength(1);
		});
	});

	describe('getPairBySession', () => {
		it('should return pair by manager session ID', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Manager Session Test',
			});

			const retrieved = sessionPairManager.getPairBySession(pair.managerSessionId);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe(pair.id);
		});

		it('should return pair by worker session ID', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Worker Session Test',
			});

			const retrieved = sessionPairManager.getPairBySession(pair.workerSessionId);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe(pair.id);
		});

		it('should return null for non-existent session', () => {
			const result = sessionPairManager.getPairBySession('non-existent-session');

			expect(result).toBeNull();
		});
	});

	describe('updatePairStatus', () => {
		it('should update pair status to idle', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Status Update Test',
			});

			expect(pair.status).toBe('active');

			const updated = sessionPairManager.updatePairStatus(pair.id, 'idle');

			expect(updated).not.toBeNull();
			expect(updated?.status).toBe('idle');
		});

		it('should update pair status to crashed', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Crash Test',
			});

			const updated = sessionPairManager.updatePairStatus(pair.id, 'crashed');

			expect(updated?.status).toBe('crashed');
		});

		it('should update pair status to completed', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Complete Test',
			});

			const updated = sessionPairManager.updatePairStatus(pair.id, 'completed');

			expect(updated?.status).toBe('completed');
		});

		it('should return null for non-existent pair', () => {
			const result = sessionPairManager.updatePairStatus('non-existent', 'completed');

			expect(result).toBeNull();
		});

		it('should update updatedAt timestamp', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Timestamp Test',
			});

			const originalUpdatedAt = pair.updatedAt;

			// Small delay to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 5));

			const updated = sessionPairManager.updatePairStatus(pair.id, 'idle');

			expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
		});
	});

	describe('archivePair', () => {
		it('should archive an active pair', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Archive Test',
			});

			expect(pair.status).toBe('active');

			const result = await sessionPairManager.archivePair(pair.id);

			expect(result).toBe(true);

			// Verify status was updated
			const archived = sessionPairManager.getPair(pair.id);
			expect(archived?.status).toBe('completed');
		});

		it('should return false for non-existent pair', async () => {
			const result = await sessionPairManager.archivePair('non-existent');

			expect(result).toBe(false);
		});

		it('should be idempotent - archiving already archived pair', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Idempotent Archive Test',
			});

			await sessionPairManager.archivePair(pair.id);
			const result = await sessionPairManager.archivePair(pair.id);

			expect(result).toBe(true);

			const archived = sessionPairManager.getPair(pair.id);
			expect(archived?.status).toBe('completed');
		});
	});

	describe('deletePair', () => {
		it('should delete a pair', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Delete Test',
			});

			const result = sessionPairManager.deletePair(pair.id);

			expect(result).toBe(true);

			const deleted = sessionPairManager.getPair(pair.id);
			expect(deleted).toBeNull();
		});

		it('should return false for non-existent pair', () => {
			const result = sessionPairManager.deletePair('non-existent');

			expect(result).toBe(false);
		});

		it('should not delete other pairs', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair: pair1 } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-1',
				taskTitle: 'Pair 1',
			});

			const { pair: pair2 } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-2',
				taskTitle: 'Pair 2',
			});

			sessionPairManager.deletePair(pair1.id);

			expect(sessionPairManager.getPair(pair1.id)).toBeNull();
			expect(sessionPairManager.getPair(pair2.id)).not.toBeNull();
		});
	});

	describe('integration with repository', () => {
		it('should persist pairs to database', async () => {
			const room = roomManager.createRoom({
				name: 'Test Room',
				allowedPaths: ['/workspace/test'],
				defaultPath: '/workspace/test',
			});

			const { pair } = await sessionPairManager.createPair({
				roomId: room.id,
				roomSessionId: 'room-session-123',
				taskTitle: 'Persistence Test',
			});

			// Verify directly through repository
			const repo = new SessionPairRepository(db);
			const retrieved = repo.getPair(pair.id);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe(pair.id);
		});
	});
});
