import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TaskPairRepository } from '../../../src/lib/room/task-pair-repository';
import type { PairState } from '../../../src/lib/room/task-pair-repository';

describe('TaskPairRepository', () => {
	let db: Database;
	let repo: TaskPairRepository;
	const roomId = 'room-1';
	const taskId = 'task-1';
	const craftSessionId = 'craft-sess-1';
	const leadSessionId = 'lead-sess-1';

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL REFERENCES rooms(id),
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal',
				depends_on TEXT DEFAULT '[]',
				created_at INTEGER NOT NULL
			);
			CREATE TABLE task_pairs (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES tasks(id),
				craft_session_id TEXT NOT NULL,
				lead_session_id TEXT NOT NULL,
				pair_state TEXT NOT NULL DEFAULT 'awaiting_craft'
					CHECK(pair_state IN ('awaiting_craft', 'awaiting_lead', 'awaiting_human', 'hibernated', 'completed', 'failed')),
				feedback_iteration INTEGER NOT NULL DEFAULT 0,
				lead_contract_violations INTEGER NOT NULL DEFAULT 0,
				last_processed_lead_turn_id TEXT,
				last_forwarded_message_id TEXT,
				active_work_started_at INTEGER,
				active_work_elapsed INTEGER NOT NULL DEFAULT 0,
				hibernated_at INTEGER,
				version INTEGER NOT NULL DEFAULT 0,
				tokens_used INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE INDEX idx_task_pairs_task ON task_pairs(task_id);
			CREATE INDEX idx_task_pairs_state ON task_pairs(pair_state);

			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${Date.now()}, ${Date.now()});
			INSERT INTO tasks (id, room_id, title, description, created_at) VALUES ('${taskId}', '${roomId}', 'Test Task', 'desc', ${Date.now()});
			INSERT INTO tasks (id, room_id, title, description, created_at) VALUES ('task-2', '${roomId}', 'Task 2', 'desc', ${Date.now()});
		`);
		repo = new TaskPairRepository(db as never);
	});

	afterEach(() => {
		db.close();
	});

	describe('createPair', () => {
		it('should create a pair with defaults', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			expect(pair.id).toBeDefined();
			expect(pair.taskId).toBe(taskId);
			expect(pair.craftSessionId).toBe(craftSessionId);
			expect(pair.leadSessionId).toBe(leadSessionId);
			expect(pair.pairState).toBe('awaiting_craft');
			expect(pair.feedbackIteration).toBe(0);
			expect(pair.leadContractViolations).toBe(0);
			expect(pair.lastProcessedLeadTurnId).toBeNull();
			expect(pair.version).toBe(0);
			expect(pair.tokensUsed).toBe(0);
			expect(pair.completedAt).toBeNull();
		});
	});

	describe('getPair', () => {
		it('should return null for non-existent pair', () => {
			expect(repo.getPair('no-such-id')).toBeNull();
		});

		it('should return created pair', () => {
			const created = repo.createPair(taskId, craftSessionId, leadSessionId);
			const fetched = repo.getPair(created.id);
			expect(fetched).not.toBeNull();
			expect(fetched!.id).toBe(created.id);
		});
	});

	describe('getPairByTaskId', () => {
		it('should return null when no pair exists', () => {
			expect(repo.getPairByTaskId('non-existent')).toBeNull();
		});

		it('should return pair by task ID', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			const fetched = repo.getPairByTaskId(taskId);
			expect(fetched).not.toBeNull();
			expect(fetched!.id).toBe(pair.id);
		});
	});

	describe('getActivePairs', () => {
		it('should return empty array when no pairs', () => {
			expect(repo.getActivePairs(roomId)).toHaveLength(0);
		});

		it('should return active pairs for room', () => {
			repo.createPair(taskId, craftSessionId, leadSessionId);
			repo.createPair('task-2', 'craft-2', 'lead-2');
			const pairs = repo.getActivePairs(roomId);
			expect(pairs).toHaveLength(2);
		});

		it('should exclude completed/failed pairs', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			repo.completePair(pair.id, pair.version);
			expect(repo.getActivePairs(roomId)).toHaveLength(0);
		});
	});

	describe('updatePairState', () => {
		it('should update state with correct version', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			const updated = repo.updatePairState(pair.id, 'awaiting_lead', pair.version);
			expect(updated).not.toBeNull();
			expect(updated!.pairState).toBe('awaiting_lead');
			expect(updated!.version).toBe(pair.version + 1);
		});

		it('should return null on version mismatch', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			const result = repo.updatePairState(pair.id, 'awaiting_lead', pair.version + 999);
			expect(result).toBeNull();
		});
	});

	describe('incrementFeedbackIteration', () => {
		it('should increment feedback count', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			const updated = repo.incrementFeedbackIteration(pair.id, pair.version);
			expect(updated!.feedbackIteration).toBe(1);
			expect(updated!.version).toBe(pair.version + 1);

			const again = repo.incrementFeedbackIteration(pair.id, updated!.version);
			expect(again!.feedbackIteration).toBe(2);
		});

		it('should return null on version mismatch', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			expect(repo.incrementFeedbackIteration(pair.id, 999)).toBeNull();
		});
	});

	describe('completePair', () => {
		it('should set state to completed and set completedAt', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			const completed = repo.completePair(pair.id, pair.version);
			expect(completed!.pairState).toBe('completed');
			expect(completed!.completedAt).toBeDefined();
			expect(completed!.completedAt).toBeGreaterThan(0);
			expect(completed!.version).toBe(pair.version + 1);
		});
	});

	describe('failPair', () => {
		it('should set state to failed and set completedAt', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			const failed = repo.failPair(pair.id, pair.version);
			expect(failed!.pairState).toBe('failed');
			expect(failed!.completedAt).toBeDefined();
			expect(failed!.completedAt).toBeGreaterThan(0);
		});
	});

	describe('updateLeadContractViolations', () => {
		it('should update violations and turn ID', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			const updated = repo.updateLeadContractViolations(pair.id, 1, 'turn-abc', pair.version);
			expect(updated!.leadContractViolations).toBe(1);
			expect(updated!.lastProcessedLeadTurnId).toBe('turn-abc');
		});
	});

	describe('resetLeadContractViolations', () => {
		it('should reset violations to 0', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			const v1 = repo.updateLeadContractViolations(pair.id, 2, 'turn-1', pair.version);
			const v2 = repo.resetLeadContractViolations(pair.id, v1!.version);
			expect(v2!.leadContractViolations).toBe(0);
		});
	});

	describe('updateLastForwardedMessageId', () => {
		it('should update last forwarded message ID', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);
			const updated = repo.updateLastForwardedMessageId(pair.id, 'msg-123', pair.version);
			expect(updated!.lastForwardedMessageId).toBe('msg-123');
		});
	});

	describe('optimistic locking', () => {
		it('should prevent concurrent updates', () => {
			const pair = repo.createPair(taskId, craftSessionId, leadSessionId);

			// First update succeeds
			const first = repo.updatePairState(pair.id, 'awaiting_lead', pair.version);
			expect(first).not.toBeNull();

			// Second update with stale version fails
			const second = repo.updatePairState(pair.id, 'awaiting_human', pair.version);
			expect(second).toBeNull();

			// Verify first update stuck
			const final = repo.getPair(pair.id);
			expect(final!.pairState).toBe('awaiting_lead');
		});
	});
});
