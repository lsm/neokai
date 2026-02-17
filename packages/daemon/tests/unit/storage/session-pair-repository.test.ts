/**
 * Session Pair Repository Tests
 *
 * Tests for session pair CRUD operations and query methods.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionPairRepository } from '../../../src/storage/repositories/session-pair-repository';
import type { SessionPair, SessionPairStatus } from '@neokai/shared';

describe('SessionPairRepository', () => {
	let db: Database;
	let repository: SessionPairRepository;

	beforeEach(() => {
		// Create in-memory database
		db = new Database(':memory:');
		// Create the session_pairs table
		db.exec(`
			CREATE TABLE session_pairs (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				room_session_id TEXT NOT NULL,
				manager_session_id TEXT NOT NULL,
				worker_session_id TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'idle', 'crashed', 'completed')),
				current_task_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX idx_session_pairs_room ON session_pairs(room_id);
			CREATE INDEX idx_session_pairs_manager ON session_pairs(manager_session_id);
			CREATE INDEX idx_session_pairs_worker ON session_pairs(worker_session_id);
		`);
		repository = new SessionPairRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('createPair', () => {
		it('should create a session pair with all fields including taskId', () => {
			const data = {
				id: 'pair-1',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-1',
				workerSessionId: 'worker-1',
				currentTaskId: 'task-1',
			};

			const pair = repository.createPair(data);

			expect(pair.id).toBe('pair-1');
			expect(pair.roomId).toBe('room-1');
			expect(pair.roomSessionId).toBe('room-session-1');
			expect(pair.managerSessionId).toBe('manager-1');
			expect(pair.workerSessionId).toBe('worker-1');
			expect(pair.status).toBe('active');
			expect(pair.currentTaskId).toBe('task-1');
			expect(pair.createdAt).toBeDefined();
			expect(pair.updatedAt).toBeDefined();
			expect(pair.createdAt).toBe(pair.updatedAt);
		});

		it('should create a session pair without taskId', () => {
			const data = {
				id: 'pair-2',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-2',
				workerSessionId: 'worker-2',
			};

			const pair = repository.createPair(data);

			expect(pair.id).toBe('pair-2');
			expect(pair.currentTaskId).toBeUndefined();
		});

		it('should generate unique timestamps for created pairs', async () => {
			const data1 = {
				id: 'pair-1',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-1',
				workerSessionId: 'worker-1',
			};

			const pair1 = repository.createPair(data1);

			// Small delay to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 5));

			const data2 = {
				id: 'pair-2',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-2',
				workerSessionId: 'worker-2',
			};

			const pair2 = repository.createPair(data2);

			expect(pair2.createdAt).toBeGreaterThanOrEqual(pair1.createdAt);
		});
	});

	describe('getPair', () => {
		it('should return pair by id', () => {
			const data = {
				id: 'pair-get-test',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-1',
				workerSessionId: 'worker-1',
				currentTaskId: 'task-1',
			};
			repository.createPair(data);

			const pair = repository.getPair('pair-get-test');

			expect(pair).not.toBeNull();
			expect(pair?.id).toBe('pair-get-test');
			expect(pair?.roomId).toBe('room-1');
			expect(pair?.managerSessionId).toBe('manager-1');
			expect(pair?.workerSessionId).toBe('worker-1');
		});

		it('should return null for non-existent id', () => {
			const pair = repository.getPair('non-existent-id');

			expect(pair).toBeNull();
		});

		it('should return all fields correctly', () => {
			const data = {
				id: 'pair-full',
				roomId: 'room-full',
				roomSessionId: 'room-session-full',
				managerSessionId: 'manager-full',
				workerSessionId: 'worker-full',
				currentTaskId: 'task-full',
			};
			repository.createPair(data);

			const pair = repository.getPair('pair-full')!;

			expect(pair.id).toBe('pair-full');
			expect(pair.roomId).toBe('room-full');
			expect(pair.roomSessionId).toBe('room-session-full');
			expect(pair.managerSessionId).toBe('manager-full');
			expect(pair.workerSessionId).toBe('worker-full');
			expect(pair.status).toBe('active');
			expect(pair.currentTaskId).toBe('task-full');
			expect(pair.createdAt).toBeDefined();
			expect(pair.updatedAt).toBeDefined();
		});
	});

	describe('getPairsByRoom', () => {
		it('should return all pairs for a room', () => {
			repository.createPair({
				id: 'pair-1',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-1',
				workerSessionId: 'worker-1',
			});
			repository.createPair({
				id: 'pair-2',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-2',
				workerSessionId: 'worker-2',
			});
			repository.createPair({
				id: 'pair-3',
				roomId: 'room-2',
				roomSessionId: 'room-session-2',
				managerSessionId: 'manager-3',
				workerSessionId: 'worker-3',
			});

			const pairs = repository.getPairsByRoom('room-1');

			expect(pairs.length).toBe(2);
			expect(pairs.map((p) => p.id)).toContain('pair-1');
			expect(pairs.map((p) => p.id)).toContain('pair-2');
			expect(pairs.map((p) => p.id)).not.toContain('pair-3');
		});

		it('should return empty array for room with no pairs', () => {
			const pairs = repository.getPairsByRoom('non-existent-room');

			expect(pairs).toEqual([]);
		});

		it('should order pairs by created_at DESC', async () => {
			repository.createPair({
				id: 'pair-oldest',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-1',
				workerSessionId: 'worker-1',
			});

			await new Promise((resolve) => setTimeout(resolve, 5));

			repository.createPair({
				id: 'pair-middle',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-2',
				workerSessionId: 'worker-2',
			});

			await new Promise((resolve) => setTimeout(resolve, 5));

			repository.createPair({
				id: 'pair-newest',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-3',
				workerSessionId: 'worker-3',
			});

			const pairs = repository.getPairsByRoom('room-1');

			expect(pairs[0].id).toBe('pair-newest');
			expect(pairs[1].id).toBe('pair-middle');
			expect(pairs[2].id).toBe('pair-oldest');
		});
	});

	describe('getPairByManagerSession', () => {
		it('should return pair by manager session ID', () => {
			repository.createPair({
				id: 'pair-manager-test',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-unique',
				workerSessionId: 'worker-1',
			});

			const pair = repository.getPairByManagerSession('manager-unique');

			expect(pair).not.toBeNull();
			expect(pair?.id).toBe('pair-manager-test');
			expect(pair?.managerSessionId).toBe('manager-unique');
		});

		it('should return null for non-existent manager session ID', () => {
			const pair = repository.getPairByManagerSession('non-existent-manager');

			expect(pair).toBeNull();
		});

		it('should not return pair when searching by worker session ID', () => {
			repository.createPair({
				id: 'pair-distinct',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-distinct',
				workerSessionId: 'worker-distinct',
			});

			const pair = repository.getPairByManagerSession('worker-distinct');

			expect(pair).toBeNull();
		});
	});

	describe('getPairByWorkerSession', () => {
		it('should return pair by worker session ID', () => {
			repository.createPair({
				id: 'pair-worker-test',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-1',
				workerSessionId: 'worker-unique',
			});

			const pair = repository.getPairByWorkerSession('worker-unique');

			expect(pair).not.toBeNull();
			expect(pair?.id).toBe('pair-worker-test');
			expect(pair?.workerSessionId).toBe('worker-unique');
		});

		it('should return null for non-existent worker session ID', () => {
			const pair = repository.getPairByWorkerSession('non-existent-worker');

			expect(pair).toBeNull();
		});

		it('should not return pair when searching by manager session ID', () => {
			repository.createPair({
				id: 'pair-distinct-2',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-distinct-2',
				workerSessionId: 'worker-distinct-2',
			});

			const pair = repository.getPairByWorkerSession('manager-distinct-2');

			expect(pair).toBeNull();
		});
	});

	describe('getPairBySession', () => {
		it('should return pair when given manager session ID', () => {
			repository.createPair({
				id: 'pair-session-manager',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-session-test',
				workerSessionId: 'worker-session-test',
			});

			const pair = repository.getPairBySession('manager-session-test');

			expect(pair).not.toBeNull();
			expect(pair?.id).toBe('pair-session-manager');
		});

		it('should return pair when given worker session ID', () => {
			repository.createPair({
				id: 'pair-session-worker',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-session-test-2',
				workerSessionId: 'worker-session-test-2',
			});

			const pair = repository.getPairBySession('worker-session-test-2');

			expect(pair).not.toBeNull();
			expect(pair?.id).toBe('pair-session-worker');
		});

		it('should return null for non-existent session ID', () => {
			const pair = repository.getPairBySession('non-existent-session');

			expect(pair).toBeNull();
		});

		it('should prefer manager match when both exist (edge case)', () => {
			// Create two separate pairs
			repository.createPair({
				id: 'pair-prefers-manager',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'shared-session-id',
				workerSessionId: 'worker-prefers',
			});
			repository.createPair({
				id: 'pair-has-worker',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-has-worker',
				workerSessionId: 'shared-session-id',
			});

			// When the same session ID appears as manager in one pair and worker in another,
			// getPairBySession should return the manager match first
			const pair = repository.getPairBySession('shared-session-id');

			expect(pair).not.toBeNull();
			expect(pair?.id).toBe('pair-prefers-manager');
		});
	});

	describe('updatePairStatus', () => {
		it('should update status to idle', () => {
			const pair = repository.createPair({
				id: 'pair-status-idle',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-status',
				workerSessionId: 'worker-status',
			});
			expect(pair.status).toBe('active');

			const updated = repository.updatePairStatus('pair-status-idle', 'idle');

			expect(updated?.status).toBe('idle');
		});

		it('should update status to crashed', () => {
			repository.createPair({
				id: 'pair-status-crashed',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-crashed',
				workerSessionId: 'worker-crashed',
			});

			const updated = repository.updatePairStatus('pair-status-crashed', 'crashed');

			expect(updated?.status).toBe('crashed');
		});

		it('should update status to completed', () => {
			repository.createPair({
				id: 'pair-status-completed',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-completed',
				workerSessionId: 'worker-completed',
			});

			const updated = repository.updatePairStatus('pair-status-completed', 'completed');

			expect(updated?.status).toBe('completed');
		});

		it('should update status back to active', () => {
			repository.createPair({
				id: 'pair-status-reactivate',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-reactivate',
				workerSessionId: 'worker-reactivate',
			});
			repository.updatePairStatus('pair-status-reactivate', 'idle');

			const updated = repository.updatePairStatus('pair-status-reactivate', 'active');

			expect(updated?.status).toBe('active');
		});

		it('should update updatedAt timestamp', async () => {
			const pair = repository.createPair({
				id: 'pair-status-time',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-time',
				workerSessionId: 'worker-time',
			});
			const originalUpdatedAt = pair.updatedAt;

			await new Promise((resolve) => setTimeout(resolve, 5));
			const updated = repository.updatePairStatus('pair-status-time', 'idle');

			expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
		});

		it('should return null for non-existent pair', () => {
			const updated = repository.updatePairStatus('non-existent', 'idle');

			expect(updated).toBeNull();
		});

		it('should preserve other fields when updating status', () => {
			repository.createPair({
				id: 'pair-preserve',
				roomId: 'room-preserve',
				roomSessionId: 'room-session-preserve',
				managerSessionId: 'manager-preserve',
				workerSessionId: 'worker-preserve',
				currentTaskId: 'task-preserve',
			});

			const updated = repository.updatePairStatus('pair-preserve', 'completed');

			expect(updated?.roomId).toBe('room-preserve');
			expect(updated?.roomSessionId).toBe('room-session-preserve');
			expect(updated?.managerSessionId).toBe('manager-preserve');
			expect(updated?.workerSessionId).toBe('worker-preserve');
			expect(updated?.currentTaskId).toBe('task-preserve');
		});
	});

	describe('updatePairTask', () => {
		it('should set current task ID', () => {
			repository.createPair({
				id: 'pair-task-set',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-task',
				workerSessionId: 'worker-task',
			});

			const updated = repository.updatePairTask('pair-task-set', 'new-task-id');

			expect(updated?.currentTaskId).toBe('new-task-id');
		});

		it('should update current task ID', () => {
			repository.createPair({
				id: 'pair-task-update',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-task-update',
				workerSessionId: 'worker-task-update',
				currentTaskId: 'old-task-id',
			});

			const updated = repository.updatePairTask('pair-task-update', 'new-task-id');

			expect(updated?.currentTaskId).toBe('new-task-id');
		});

		it('should clear current task ID when set to undefined', () => {
			repository.createPair({
				id: 'pair-task-clear',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-task-clear',
				workerSessionId: 'worker-task-clear',
				currentTaskId: 'task-to-clear',
			});

			const updated = repository.updatePairTask('pair-task-clear', undefined);

			expect(updated?.currentTaskId).toBeUndefined();
		});

		it('should update updatedAt timestamp', async () => {
			const pair = repository.createPair({
				id: 'pair-task-time',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-task-time',
				workerSessionId: 'worker-task-time',
			});
			const originalUpdatedAt = pair.updatedAt;

			await new Promise((resolve) => setTimeout(resolve, 5));
			const updated = repository.updatePairTask('pair-task-time', 'task-new');

			expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
		});

		it('should return null for non-existent pair', () => {
			const updated = repository.updatePairTask('non-existent', 'task-id');

			expect(updated).toBeNull();
		});

		it('should preserve other fields when updating task', () => {
			repository.createPair({
				id: 'pair-task-preserve',
				roomId: 'room-task-preserve',
				roomSessionId: 'room-session-task-preserve',
				managerSessionId: 'manager-task-preserve',
				workerSessionId: 'worker-task-preserve',
			});

			const updated = repository.updatePairTask('pair-task-preserve', 'task-preserve');

			expect(updated?.roomId).toBe('room-task-preserve');
			expect(updated?.roomSessionId).toBe('room-session-task-preserve');
			expect(updated?.managerSessionId).toBe('manager-task-preserve');
			expect(updated?.workerSessionId).toBe('worker-task-preserve');
			expect(updated?.status).toBe('active');
		});
	});

	describe('deletePair', () => {
		it('should delete a pair by ID', () => {
			repository.createPair({
				id: 'pair-delete',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-delete',
				workerSessionId: 'worker-delete',
			});

			const result = repository.deletePair('pair-delete');

			expect(result).toBe(true);
			expect(repository.getPair('pair-delete')).toBeNull();
		});

		it('should return false for non-existent pair', () => {
			const result = repository.deletePair('non-existent');

			expect(result).toBe(false);
		});

		it('should only delete the specified pair', () => {
			repository.createPair({
				id: 'pair-keep',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-keep',
				workerSessionId: 'worker-keep',
			});
			repository.createPair({
				id: 'pair-delete-2',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-delete-2',
				workerSessionId: 'worker-delete-2',
			});

			repository.deletePair('pair-delete-2');

			expect(repository.getPair('pair-keep')).not.toBeNull();
			expect(repository.getPair('pair-delete-2')).toBeNull();
		});
	});

	describe('status transitions', () => {
		it('should allow full lifecycle: active -> idle -> active -> completed', () => {
			repository.createPair({
				id: 'pair-lifecycle',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-lifecycle',
				workerSessionId: 'worker-lifecycle',
			});

			// active -> idle
			let pair = repository.updatePairStatus('pair-lifecycle', 'idle');
			expect(pair?.status).toBe('idle');

			// idle -> active
			pair = repository.updatePairStatus('pair-lifecycle', 'active');
			expect(pair?.status).toBe('active');

			// active -> completed
			pair = repository.updatePairStatus('pair-lifecycle', 'completed');
			expect(pair?.status).toBe('completed');
		});

		it('should allow direct transition to any status', () => {
			repository.createPair({
				id: 'pair-direct',
				roomId: 'room-1',
				roomSessionId: 'room-session-1',
				managerSessionId: 'manager-direct',
				workerSessionId: 'worker-direct',
			});

			// Direct to crashed
			const pair = repository.updatePairStatus('pair-direct', 'crashed');
			expect(pair?.status).toBe('crashed');
		});
	});
});
