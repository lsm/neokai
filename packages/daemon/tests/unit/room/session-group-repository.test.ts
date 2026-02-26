import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionGroupRepository } from '../../../src/lib/room/session-group-repository';
import type { GroupState } from '../../../src/lib/room/session-group-repository';

describe('SessionGroupRepository', () => {
	let db: Database;
	let repo: SessionGroupRepository;
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
				task_type TEXT DEFAULT 'coding',
				created_by_task_id TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task_pair',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_craft'
					CHECK(state IN ('awaiting_craft', 'awaiting_lead', 'awaiting_human', 'hibernated', 'completed', 'failed')),
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
				PRIMARY KEY (group_id, role)
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
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			expect(group.id).toBeDefined();
			expect(group.taskId).toBe(taskId);
			expect(group.craftSessionId).toBe(craftSessionId);
			expect(group.leadSessionId).toBe(leadSessionId);
			expect(group.state).toBe('awaiting_craft');
			expect(group.feedbackIteration).toBe(0);
			expect(group.leadContractViolations).toBe(0);
			expect(group.lastProcessedLeadTurnId).toBeNull();
			expect(group.version).toBe(0);
			expect(group.tokensUsed).toBe(0);
			expect(group.completedAt).toBeNull();
		});
	});

	describe('getGroup', () => {
		it('should return null for non-existent group', () => {
			expect(repo.getGroup('no-such-id')).toBeNull();
		});

		it('should return created group', () => {
			const created = repo.createGroup(taskId, craftSessionId, leadSessionId);
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
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
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
			repo.createGroup(taskId, craftSessionId, leadSessionId);
			repo.createGroup('task-2', 'craft-2', 'lead-2');
			const groups = repo.getActiveGroups(roomId);
			expect(groups).toHaveLength(2);
		});

		it('should exclude completed/failed groups', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			repo.completeGroup(group.id, group.version);
			expect(repo.getActiveGroups(roomId)).toHaveLength(0);
		});
	});

	describe('updateGroupState', () => {
		it('should update state with correct version', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			const updated = repo.updateGroupState(group.id, 'awaiting_lead', group.version);
			expect(updated).not.toBeNull();
			expect(updated!.state).toBe('awaiting_lead');
			expect(updated!.version).toBe(group.version + 1);
		});

		it('should return null on version mismatch', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			const result = repo.updateGroupState(group.id, 'awaiting_lead', group.version + 999);
			expect(result).toBeNull();
		});
	});

	describe('incrementFeedbackIteration', () => {
		it('should increment feedback count', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			const updated = repo.incrementFeedbackIteration(group.id, group.version);
			expect(updated!.feedbackIteration).toBe(1);
			expect(updated!.version).toBe(group.version + 1);

			const again = repo.incrementFeedbackIteration(group.id, updated!.version);
			expect(again!.feedbackIteration).toBe(2);
		});

		it('should return null on version mismatch', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			expect(repo.incrementFeedbackIteration(group.id, 999)).toBeNull();
		});
	});

	describe('completeGroup', () => {
		it('should set state to completed and set completedAt', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			const completed = repo.completeGroup(group.id, group.version);
			expect(completed!.state).toBe('completed');
			expect(completed!.completedAt).toBeDefined();
			expect(completed!.completedAt).toBeGreaterThan(0);
			expect(completed!.version).toBe(group.version + 1);
		});
	});

	describe('failGroup', () => {
		it('should set state to failed and set completedAt', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			const failed = repo.failGroup(group.id, group.version);
			expect(failed!.state).toBe('failed');
			expect(failed!.completedAt).toBeDefined();
			expect(failed!.completedAt).toBeGreaterThan(0);
		});
	});

	describe('updateLeadContractViolations', () => {
		it('should update violations and turn ID', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			const updated = repo.updateLeadContractViolations(group.id, 1, 'turn-abc', group.version);
			expect(updated!.leadContractViolations).toBe(1);
			expect(updated!.lastProcessedLeadTurnId).toBe('turn-abc');
		});
	});

	describe('resetLeadContractViolations', () => {
		it('should reset violations to 0', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			const v1 = repo.updateLeadContractViolations(group.id, 2, 'turn-1', group.version);
			const v2 = repo.resetLeadContractViolations(group.id, v1!.version);
			expect(v2!.leadContractViolations).toBe(0);
		});
	});

	describe('updateLastForwardedMessageId', () => {
		it('should update last forwarded message ID', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			const updated = repo.updateLastForwardedMessageId(group.id, 'msg-123', group.version);
			expect(updated!.lastForwardedMessageId).toBe('msg-123');
		});
	});

	describe('optimistic locking', () => {
		it('should prevent concurrent updates', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);

			// First update succeeds
			const first = repo.updateGroupState(group.id, 'awaiting_lead', group.version);
			expect(first).not.toBeNull();

			// Second update with stale version fails
			const second = repo.updateGroupState(group.id, 'awaiting_human', group.version);
			expect(second).toBeNull();

			// Verify first update stuck
			const final = repo.getGroup(group.id);
			expect(final!.state).toBe('awaiting_lead');
		});
	});

	describe('appendMessage / getMessages', () => {
		it('should append and retrieve messages', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			const msgId = repo.appendMessage({
				groupId: group.id,
				sessionId: craftSessionId,
				role: 'craft',
				messageType: 'text',
				content: 'Hello from Craft',
			});
			expect(msgId).toBeGreaterThan(0);

			const { messages, hasMore } = repo.getMessages(group.id);
			expect(messages).toHaveLength(1);
			expect(messages[0].role).toBe('craft');
			expect(messages[0].content).toBe('Hello from Craft');
			expect(messages[0].sessionId).toBe(craftSessionId);
			expect(hasMore).toBe(false);
		});

		it('should paginate messages', () => {
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			for (let i = 0; i < 5; i++) {
				repo.appendMessage({
					groupId: group.id,
					role: 'craft',
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
				'awaiting_craft',
				'awaiting_lead',
				'awaiting_human',
				'hibernated',
				'completed',
				'failed',
			];
			const group = repo.createGroup(taskId, craftSessionId, leadSessionId);
			let currentVersion = group.version;

			for (const state of states.slice(0, 4)) {
				const updated = repo.updateGroupState(group.id, state, currentVersion);
				expect(updated).not.toBeNull();
				currentVersion = updated!.version;
			}
		});
	});
});
