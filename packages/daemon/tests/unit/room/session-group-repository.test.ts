import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';

describe('SessionGroupRepository', () => {
	let db: Database;
	let repo: SessionGroupRepository;
	const roomId = 'room-1';
	const taskId = 'task-1';
	const workerSessionId = 'worker-sess-1';
	const leaderSessionId = 'leader-sess-1';

	beforeEach(() => {
		db = new Database(':memory:');
		// Enable foreign keys for cascade delete to work
		db.exec('PRAGMA foreign_keys = ON');
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
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				archived_at INTEGER,
				active_session TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				updated_at INTEGER
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
			CREATE TABLE task_group_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				payload_json TEXT,
				created_at INTEGER NOT NULL
			);

			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${Date.now()}, ${Date.now()});
			INSERT INTO tasks (id, room_id, title, description, created_at) VALUES ('${taskId}', '${roomId}', 'Test Task', 'desc', ${Date.now()});
			INSERT INTO tasks (id, room_id, title, description, created_at) VALUES ('task-2', '${roomId}', 'Task 2', 'desc', ${Date.now()});
		`);
		repo = new SessionGroupRepository(createReactiveDatabase(db));
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

		it('should derive submittedForReview from metadata only', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			db.prepare(`UPDATE session_groups SET state = 'awaiting_human' WHERE id = ?`).run(group.id);
			// Keep metadata without submittedForReview=true
			db.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`).run(
				JSON.stringify({
					feedbackIteration: 0,
					leaderContractViolations: 0,
					leaderCalledTool: false,
					lastProcessedLeaderTurnId: null,
					lastForwardedMessageId: null,
					activeWorkStartedAt: null,
					activeWorkElapsed: 0,
					hibernatedAt: null,
					tokensUsed: 0,
					workerRole: 'coder',
					submittedForReview: false,
					approved: false,
				}),
				group.id
			);

			const fetched = repo.getGroup(group.id);
			expect(fetched).not.toBeNull();
			expect(fetched!.submittedForReview).toBe(false);
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
		it('should set completedAt timestamp', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const completed = repo.completeGroup(group.id, group.version);
			expect(completed!.completedAt).toBeDefined();
			expect(completed!.completedAt).toBeGreaterThan(0);
			expect(completed!.version).toBe(group.version + 1);
		});
	});

	describe('failGroup', () => {
		it('should set completedAt timestamp', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const failed = repo.failGroup(group.id, group.version);
			expect(failed!.completedAt).toBeDefined();
			expect(failed!.completedAt).toBeGreaterThan(0);
		});
	});

	describe('deleteGroup', () => {
		it('should delete a group', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			expect(repo.getGroup(group.id)).not.toBeNull();

			const result = repo.deleteGroup(group.id);
			expect(result).toBe(true);
			expect(repo.getGroup(group.id)).toBeNull();
		});

		it('should return false when group does not exist', () => {
			const result = repo.deleteGroup('non-existent-group');
			expect(result).toBe(false);
		});

		it('should cascade delete members', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);

			// Verify members exist
			const members = db
				.prepare('SELECT * FROM session_group_members WHERE group_id = ?')
				.all(group.id) as unknown[];
			expect(members).toHaveLength(2);

			// Delete the group
			repo.deleteGroup(group.id);

			// Members should be deleted too
			const remainingMembers = db
				.prepare('SELECT * FROM session_group_members WHERE group_id = ?')
				.all(group.id) as unknown[];
			expect(remainingMembers).toHaveLength(0);
		});

		it('should cascade delete events', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);

			// Add some events
			repo.appendEvent({ groupId: group.id, kind: 'status', payloadJson: '{}' });
			repo.appendEvent({ groupId: group.id, kind: 'log', payloadJson: '{}' });

			const events = db
				.prepare('SELECT * FROM task_group_events WHERE group_id = ?')
				.all(group.id) as unknown[];
			expect(events).toHaveLength(2);

			// Delete the group
			repo.deleteGroup(group.id);

			// Events should be deleted too
			const remainingEvents = db
				.prepare('SELECT * FROM task_group_events WHERE group_id = ?')
				.all(group.id) as unknown[];
			expect(remainingEvents).toHaveLength(0);
		});
	});

	describe('resetGroupForRestart', () => {
		it('should reset failed group (clear completedAt)', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			// Set to failed state
			repo.failGroup(group.id, group.version);

			// Reset for restart
			const reset = repo.resetGroupForRestart(group.id);
			expect(reset).not.toBeNull();
			expect(reset!.completedAt).toBeNull();
		});

		it('should reset completed group (clear completedAt)', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			// Set to completed state
			repo.completeGroup(group.id, group.version);

			// Reset for restart
			const reset = repo.resetGroupForRestart(group.id);
			expect(reset).not.toBeNull();
			expect(reset!.completedAt).toBeNull();
		});

		it('should preserve workerRole and workspacePath', () => {
			const group = repo.createGroup(
				taskId,
				workerSessionId,
				leaderSessionId,
				'planner',
				'/workspace'
			);
			repo.failGroup(group.id, group.version);

			const reset = repo.resetGroupForRestart(group.id);
			expect(reset!.workerRole).toBe('planner');
			expect(reset!.workspacePath).toBe('/workspace');
		});

		it('should reset metadata fields to defaults', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.failGroup(group.id, group.version);

			const reset = repo.resetGroupForRestart(group.id);
			expect(reset!.feedbackIteration).toBe(0);
			expect(reset!.tokensUsed).toBe(0);
			expect(reset!.submittedForReview).toBe(false);
			expect(reset!.approved).toBe(false);
		});

		it('should return null for non-existent group', () => {
			const result = repo.resetGroupForRestart('non-existent');
			expect(result).toBeNull();
		});

		it('should increment version', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.failGroup(group.id, group.version);

			const reset = repo.resetGroupForRestart(group.id);
			expect(reset!.version).toBe(group.version + 2); // +1 for failGroup, +1 for reset
		});
	});

	describe('reviveGroup', () => {
		it('should clear completedAt on a failed group', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const failed = repo.failGroup(group.id, group.version);
			expect(failed!.completedAt).not.toBeNull();

			const revived = repo.reviveGroup(group.id);
			expect(revived).not.toBeNull();
			expect(revived!.completedAt).toBeNull();
		});

		it('should preserve existing metadata (unlike resetGroupForRestart)', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			// Simulate some accumulated metadata
			const afterIter = repo.incrementFeedbackIteration(group.id, group.version)!;
			repo.failGroup(afterIter.id, afterIter.version);

			const revived = repo.reviveGroup(group.id);
			// feedbackIteration should be preserved (not reset to 0)
			expect(revived!.feedbackIteration).toBe(1);
		});

		it('should increment version', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.failGroup(group.id, group.version);

			const revived = repo.reviveGroup(group.id);
			expect(revived!.version).toBe(group.version + 2); // +1 failGroup, +1 revive
		});

		it('should return null for non-existent group', () => {
			const result = repo.reviveGroup('non-existent');
			expect(result).toBeNull();
		});

		it('should make the group appear in getActiveGroups after revive', () => {
			// room and task already exist from beforeEach
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.failGroup(group.id, group.version);
			expect(repo.getActiveGroups(roomId)).toHaveLength(0);

			repo.reviveGroup(group.id);
			expect(repo.getActiveGroups(roomId)).toHaveLength(1);
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

	describe('setWaitingForQuestion', () => {
		it('should default to waitingForQuestion=false and waitingSession=null', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			expect(group.waitingForQuestion).toBe(false);
			expect(group.waitingSession).toBeNull();
		});

		it('should set waitingForQuestion=true and waitingSession=worker', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.setWaitingForQuestion(group.id, true, 'worker');
			const updated = repo.getGroup(group.id)!;
			expect(updated.waitingForQuestion).toBe(true);
			expect(updated.waitingSession).toBe('worker');
		});

		it('should set waitingForQuestion=true and waitingSession=leader', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.setWaitingForQuestion(group.id, true, 'leader');
			const updated = repo.getGroup(group.id)!;
			expect(updated.waitingForQuestion).toBe(true);
			expect(updated.waitingSession).toBe('leader');
		});

		it('should clear waitingForQuestion flag', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.setWaitingForQuestion(group.id, true, 'worker');
			repo.setWaitingForQuestion(group.id, false, null);
			const updated = repo.getGroup(group.id)!;
			expect(updated.waitingForQuestion).toBe(false);
			expect(updated.waitingSession).toBeNull();
		});
	});

	describe('optimistic locking', () => {
		it('should prevent concurrent updates', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);

			// First update succeeds
			const first = repo.incrementFeedbackIteration(group.id, group.version);
			expect(first).not.toBeNull();

			// Second update with stale version fails
			const second = repo.incrementFeedbackIteration(group.id, group.version);
			expect(second).toBeNull();

			// Verify first update stuck
			const final = repo.getGroup(group.id);
			expect(final!.feedbackIteration).toBe(1);
		});
	});

	describe('appendEvent / getEvents', () => {
		it('should append and retrieve events', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const eventId = repo.appendEvent({
				groupId: group.id,
				kind: 'status',
				payloadJson: JSON.stringify({ text: 'Hello status' }),
			});
			expect(eventId).toBeGreaterThan(0);

			const { events, hasMore } = repo.getEvents(group.id);
			expect(events).toHaveLength(1);
			expect(events[0].kind).toBe('status');
			expect(events[0].payloadJson).toBe(JSON.stringify({ text: 'Hello status' }));
			expect(hasMore).toBe(false);
		});

		it('should paginate events', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			for (let i = 0; i < 5; i++) {
				repo.appendEvent({
					groupId: group.id,
					kind: 'status',
					payloadJson: JSON.stringify({ text: `event ${i}` }),
				});
			}

			const page1 = repo.getEvents(group.id, { limit: 3 });
			expect(page1.events).toHaveLength(3);
			expect(page1.hasMore).toBe(true);

			const page2 = repo.getEvents(group.id, { afterId: page1.events.at(-1)!.id });
			expect(page2.events).toHaveLength(2);
			expect(page2.hasMore).toBe(false);
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

	describe('Gate Failure Tracking (Dead Loop Detection)', () => {
		it('starts with empty failure history', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const history = repo.getGateFailureHistory(group.id);
			expect(history).toEqual([]);
		});

		it('records a gate failure', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.recordGateFailure(group.id, 'worker_exit', 'No PR found.');
			const history = repo.getGateFailureHistory(group.id);
			expect(history).toHaveLength(1);
			expect(history[0].gateName).toBe('worker_exit');
			expect(history[0].reason).toBe('No PR found.');
			expect(history[0].timestamp).toBeGreaterThan(0);
		});

		it('accumulates multiple failures', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.recordGateFailure(group.id, 'worker_exit', 'No PR found.');
			repo.recordGateFailure(group.id, 'worker_exit', 'Branch is base branch.');
			repo.recordGateFailure(group.id, 'leader_complete', 'PR not merged.');
			const history = repo.getGateFailureHistory(group.id);
			expect(history).toHaveLength(3);
			expect(history[0].gateName).toBe('worker_exit');
			expect(history[2].gateName).toBe('leader_complete');
		});

		it('caps history at 50 records', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			for (let i = 0; i < 60; i++) {
				repo.recordGateFailure(group.id, 'worker_exit', `Failure ${i}`);
			}
			const history = repo.getGateFailureHistory(group.id);
			expect(history).toHaveLength(50);
			// Should keep the most recent (last 50)
			expect(history[0].reason).toBe('Failure 10');
			expect(history[49].reason).toBe('Failure 59');
		});

		it('returns empty array for non-existent group', () => {
			const history = repo.getGateFailureHistory('non-existent-id');
			expect(history).toEqual([]);
		});

		it('preserves existing metadata when recording failures', () => {
			const group = repo.createGroup(
				taskId,
				workerSessionId,
				leaderSessionId,
				'coder',
				'/workspace'
			);
			repo.setApproved(group.id, true);
			repo.recordGateFailure(group.id, 'worker_exit', 'No PR found.');
			const updated = repo.getGroup(group.id)!;
			// Approved flag should still be set
			expect(updated.approved).toBe(true);
			// Failure should be recorded
			const history = repo.getGateFailureHistory(group.id);
			expect(history).toHaveLength(1);
		});
	});

	describe('setLeaderProgressSummary', () => {
		it('should default to null when not set', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			expect(group.leaderProgressSummary).toBeNull();
		});

		it('should persist a progress summary', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			const summary =
				'Task adds GET /health endpoint. Worker created the route; tests are failing.';
			repo.setLeaderProgressSummary(group.id, summary);
			const updated = repo.getGroup(group.id)!;
			expect(updated.leaderProgressSummary).toBe(summary);
		});

		it('should overwrite an existing progress summary', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.setLeaderProgressSummary(group.id, 'First summary');
			repo.setLeaderProgressSummary(group.id, 'Updated summary after second iteration');
			const updated = repo.getGroup(group.id)!;
			expect(updated.leaderProgressSummary).toBe('Updated summary after second iteration');
		});

		it('should preserve existing metadata fields when setting summary', () => {
			const group = repo.createGroup(taskId, workerSessionId, leaderSessionId);
			repo.setApproved(group.id, true);
			repo.setLeaderProgressSummary(group.id, 'Progress so far');
			const updated = repo.getGroup(group.id)!;
			// Both fields should be set
			expect(updated.approved).toBe(true);
			expect(updated.leaderProgressSummary).toBe('Progress so far');
		});
	});
});
