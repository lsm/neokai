import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import type { GroupState } from '../../../src/lib/room/state/session-group-repository';

describe('SessionGroupRepository', () => {
	let db: Database;
	let repo: SessionGroupRepository;
	const roomId = 'room-1';
	const taskId = 'task-1';
	const workerSessionId = 'worker-sess-1';
	const leaderSessionId = 'leader-sess-1';

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
				task_type TEXT DEFAULT 'coding',
				created_by_task_id TEXT,
				assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER NOT NULL
			);
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_worker'
					CHECK(state IN ('awaiting_worker', 'awaiting_leader', 'awaiting_human', 'completed', 'failed')),
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, session_id)
			);
			CREATE TABLE session_group_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT,
				role TEXT NOT NULL,
				message_type TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${Date.now()}, ${Date.now()});
			INSERT INTO tasks (id, room_id, title, description, created_at) VALUES ('${taskId}', '${roomId}', 'Test Task', 'desc', ${Date.now()});
			INSERT INTO tasks (id, room_id, title, description, created_at) VALUES ('task-2', '${roomId}', 'Task 2', 'desc', ${Date.now()});
		`);
		repo = new SessionGroupRepository(db as never);
	});

	afterEach(() => {
		db.close();
	});

	describe('createGroup', () => {
		it('should create a group with defaults', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			expect(group.id).toBeDefined();
			expect(group.taskId).toBe(taskId);
			expect(group.workerSessionId).toBe(workerSessionId);
			expect(group.leaderSessionId).toBe(leaderSessionId);
			expect(group.workerRole).toBe('coder');
			expect(group.state).toBe('awaiting_worker');
			expect(group.feedbackIteration).toBe(0);
			expect(group.leaderContractViolations).toBe(0);
			expect(group.lastProcessedLeaderTurnId).toBeNull();
			expect(group.version).toBe(0);
			expect(group.tokensUsed).toBe(0);
			expect(group.completedAt).toBeNull();
		});

		it('should store custom workerRole', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId, 'planner');
			expect(group.workerRole).toBe('planner');
		});
	});

	describe('getGroup', () => {
		it('should return null for non-existent group', () => {
			expect(repo.getGroup('no-such-id')).toBeNull();
		});

		it('should return created group', () => {
			const created = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const fetched = repo.getGroup(created.id);
			expect(fetched).not.toBeNull();
			expect(fetched!.id).toBe(created.id);
		});
	});

	describe('getGroupByTaskId', () => {
		it('should return null when no group exists', () => {
			expect(repo.getGroupByTaskId('non-existent')).toBeNull();
		});

		it('should return group by task ID', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const fetched = repo.getGroupByTaskId(taskId);
			expect(fetched).not.toBeNull();
			expect(fetched!.id).toBe(group.id);
		});
	});

	describe('getActiveGroups', () => {
		it('should return empty array when no groups', () => {
			expect(repo.getActiveGroups(roomId)).toHaveLength(0);
		});

		it('should return active groups for room', () => {
			repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.createGroup('task-2', 'worker-2', 'leader-2');
			const groups = repo.getActiveGroups(roomId);
			expect(groups).toHaveLength(2);
		});

		it('should exclude completed/failed groups', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.completeGroup(group.id, group.version);
			expect(repo.getActiveGroups(roomId)).toHaveLength(0);
		});
	});

	describe('updateGroupState', () => {
		it('should update state with correct version', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const updated = repo.updateGroupState(group.id, 'awaiting_leader', group.version);
			expect(updated).not.toBeNull();
			expect(updated!.state).toBe('awaiting_leader');
			expect(updated!.version).toBe(group.version + 1);
		});

		it('should return null on version mismatch', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const result = repo.updateGroupState(group.id, 'awaiting_leader', group.version + 999);
			expect(result).toBeNull();
		});
	});

	describe('incrementFeedbackIteration', () => {
		it('should increment feedback count', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const updated = repo.incrementFeedbackIteration(group.id, group.version);
			expect(updated!.feedbackIteration).toBe(1);
			expect(updated!.version).toBe(group.version + 1);

			const again = repo.incrementFeedbackIteration(group.id, updated!.version);
			expect(again!.feedbackIteration).toBe(2);
		});

		it('should return null on version mismatch', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			expect(repo.incrementFeedbackIteration(group.id, 999)).toBeNull();
		});
	});

	describe('completeGroup', () => {
		it('should set state to completed and set completedAt', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const completed = repo.completeGroup(group.id, group.version);
			expect(completed!.state).toBe('completed');
			expect(completed!.completedAt).toBeDefined();
			expect(completed!.completedAt).toBeGreaterThan(0);
			expect(completed!.version).toBe(group.version + 1);
		});
	});

	describe('failGroup', () => {
		it('should set state to failed and set completedAt', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const failed = repo.failGroup(group.id, group.version);
			expect(failed!.state).toBe('failed');
			expect(failed!.completedAt).toBeDefined();
			expect(failed!.completedAt).toBeGreaterThan(0);
		});
	});

	describe('updateLeaderContractViolations', () => {
		it('should update violations and turn ID', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const updated = repo.updateLeaderContractViolations(group.id, 1, 'turn-abc', group.version);
			expect(updated!.leaderContractViolations).toBe(1);
			expect(updated!.lastProcessedLeaderTurnId).toBe('turn-abc');
		});
	});

	describe('resetLeaderContractViolations', () => {
		it('should reset violations to 0', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const v1 = repo.updateLeaderContractViolations(group.id, 2, 'turn-1', group.version);
			const v2 = repo.resetLeaderContractViolations(group.id, v1!.version);
			expect(v2!.leaderContractViolations).toBe(0);
		});
	});

	describe('updateLastForwardedMessageId', () => {
		it('should update last forwarded message ID', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const updated = repo.updateLastForwardedMessageId(group.id, 'msg-123', group.version);
			expect(updated!.lastForwardedMessageId).toBe('msg-123');
		});
	});

	describe('optimistic locking', () => {
		it('should prevent concurrent updates', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);

			// First update succeeds
			const first = repo.updateGroupState(group.id, 'awaiting_leader', group.version);
			expect(first).not.toBeNull();

			// Second update with stale version fails
			const second = repo.updateGroupState(group.id, 'awaiting_human', group.version);
			expect(second).toBeNull();

			// Verify first update stuck
			const final = repo.getGroup(group.id);
			expect(final!.state).toBe('awaiting_leader');
		});
	});

	describe('appendMessage / getMessages', () => {
		it('should append and retrieve messages', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const msgId = repo.appendMessage({
				groupId: group.id,
				sessionId: workerSessionId,
				role: 'coder',
				messageType: 'text',
				content: 'Hello from Coder',
			});
			expect(msgId).toBeGreaterThan(0);

			const { messages, hasMore } = repo.getMessages(group.id);
			expect(messages).toHaveLength(1);
			expect(messages[0].role).toBe('coder');
			expect(messages[0].content).toBe('Hello from Coder');
			expect(messages[0].sessionId).toBe(workerSessionId);
			expect(hasMore).toBe(false);
		});

		it('should paginate messages', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			for (let i = 0; i < 5; i++) {
				repo.appendMessage({
					groupId: group.id,
					role: 'coder',
					messageType: 'text',
					content: `msg ${i}`,
				});
			}

			const page1 = repo.getMessages(group.id, { limit: 3 });
			expect(page1.messages).toHaveLength(3);
			expect(page1.hasMore).toBe(true);

			const page2 = repo.getMessages(group.id, { afterId: page1.messages.at(-1)!.id });
			expect(page2.messages).toHaveLength(2);
			expect(page2.hasMore).toBe(false);
		});
	});

	describe('GroupState type coverage', () => {
		it('should accept all valid states', () => {
			const states: GroupState[] = [
				'awaiting_worker',
				'awaiting_leader',
				'awaiting_human',
				'completed',
				'failed',
			];
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			let currentVersion = group.version;

			for (const state of states.slice(0, 3)) {
				const updated = repo.updateGroupState(group.id, state, currentVersion);
				expect(updated).not.toBeNull();
				currentVersion = updated!.version;
			}
		});
	});

	describe('rate limit backoff', () => {
		it('should start with null rate limit', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			expect(group.rateLimit).toBeNull();
		});

		it('should set rate limit backoff', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const backoff = {
				detectedAt: Date.now(),
				resetsAt: Date.now() + 3600000, // 1 hour from now
				sessionRole: 'worker' as const,
			};

			repo.setRateLimit(group.id, backoff);
			const updated = repo.getGroup(group.id);

			expect(updated!.rateLimit).not.toBeNull();
			expect(updated!.rateLimit!.detectedAt).toBe(backoff.detectedAt);
			expect(updated!.rateLimit!.resetsAt).toBe(backoff.resetsAt);
			expect(updated!.rateLimit!.sessionRole).toBe('worker');
		});

		it('should clear rate limit', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const backoff = {
				detectedAt: Date.now(),
				resetsAt: Date.now() + 3600000,
				sessionRole: 'worker' as const,
			};

			repo.setRateLimit(group.id, backoff);
			repo.clearRateLimit(group.id);
			const updated = repo.getGroup(group.id);

			expect(updated!.rateLimit).toBeNull();
		});

		it('should detect active rate limit', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const backoff = {
				detectedAt: Date.now(),
				resetsAt: Date.now() + 3600000, // 1 hour from now
				sessionRole: 'worker' as const,
			};

			repo.setRateLimit(group.id, backoff);
			expect(repo.isRateLimited(group.id)).toBe(true);
		});

		it('should not detect rate limit when not set', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			expect(repo.isRateLimited(group.id)).toBe(false);
		});

		it('should not detect rate limit when expired', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const backoff = {
				detectedAt: Date.now() - 7200000, // 2 hours ago
				resetsAt: Date.now() - 3600000, // 1 hour ago (expired)
				sessionRole: 'worker' as const,
			};

			repo.setRateLimit(group.id, backoff);
			expect(repo.isRateLimited(group.id)).toBe(false);
		});

		it('should get remaining time for active rate limit', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const resetTime = Date.now() + 1800000; // 30 minutes from now
			const backoff = {
				detectedAt: Date.now(),
				resetsAt: resetTime,
				sessionRole: 'leader' as const,
			};

			repo.setRateLimit(group.id, backoff);
			const remaining = repo.getRateLimitRemainingMs(group.id);

			// Should be approximately 30 minutes (allow 1 second tolerance)
			expect(remaining).toBeGreaterThan(1799000);
			expect(remaining).toBeLessThanOrEqual(1800000);
		});

		it('should return 0 remaining time when not rate limited', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			expect(repo.getRateLimitRemainingMs(group.id)).toBe(0);
		});

		it('should return 0 remaining time when rate limit expired', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const backoff = {
				detectedAt: Date.now() - 7200000,
				resetsAt: Date.now() - 3600000, // Expired 1 hour ago
				sessionRole: 'worker' as const,
			};

			repo.setRateLimit(group.id, backoff);
			expect(repo.getRateLimitRemainingMs(group.id)).toBe(0);
		});
	});
});
