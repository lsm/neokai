/**
 * GoalRepository.getGoalsForTask() Tests
 *
 * Tests that the json_each-based query correctly finds goals by linked task ID,
 * including the critical regression test for substring matching (the old LIKE
 * pattern would incorrectly match "abc" when searching for a task ID that is a
 * substring of another task ID in the array).
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../../src/storage/schema';
import { GoalRepository } from '../../../../src/storage/repositories/goal-repository';
import { RoomManager } from '../../../../src/lib/room/managers/room-manager';
import { noOpReactiveDb } from '../../../helpers/reactive-database';

describe('GoalRepository — getGoalsForTask (json_each)', () => {
	let db: Database;
	let repo: GoalRepository;
	let roomId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createTables(db);

		const roomManager = new RoomManager(db, noOpReactiveDb);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: [{ path: '/workspace/test' }],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;
		repo = new GoalRepository(db, noOpReactiveDb);
	});

	afterEach(() => {
		db.close();
	});

	describe('basic matching', () => {
		it('should return goals that have the task ID linked', () => {
			const goal1 = repo.createGoal({ roomId, title: 'Goal 1' });
			const goal2 = repo.createGoal({ roomId, title: 'Goal 2' });

			repo.linkTaskToGoal(goal1.id, 'task-abc');
			repo.linkTaskToGoal(goal2.id, 'task-abc');

			const results = repo.getGoalsForTask('task-abc');

			expect(results).toHaveLength(2);
			expect(results.map((g) => g.id)).toContain(goal1.id);
			expect(results.map((g) => g.id)).toContain(goal2.id);
		});

		it('should return empty array when no goals link the task', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal 1' });
			repo.linkTaskToGoal(goal.id, 'task-other');

			const results = repo.getGoalsForTask('task-not-linked');

			expect(results).toHaveLength(0);
		});

		it('should return only goals that match the exact task ID', () => {
			const goal1 = repo.createGoal({ roomId, title: 'Goal With Task A' });
			const goal2 = repo.createGoal({ roomId, title: 'Goal With Task B' });
			const goal3 = repo.createGoal({ roomId, title: 'Goal With Both' });

			repo.linkTaskToGoal(goal1.id, 'task-A');
			repo.linkTaskToGoal(goal2.id, 'task-B');
			repo.linkTaskToGoal(goal3.id, 'task-A');
			repo.linkTaskToGoal(goal3.id, 'task-B');

			const results = repo.getGoalsForTask('task-A');

			expect(results).toHaveLength(2);
			expect(results.map((g) => g.id)).toContain(goal1.id);
			expect(results.map((g) => g.id)).toContain(goal3.id);
			expect(results.map((g) => g.id)).not.toContain(goal2.id);
		});

		it('should return empty array for goals with no linked tasks', () => {
			repo.createGoal({ roomId, title: 'Goal With No Tasks' });

			const results = repo.getGoalsForTask('any-task-id');

			expect(results).toHaveLength(0);
		});

		it('should work when a goal has multiple linked tasks', () => {
			const goal = repo.createGoal({ roomId, title: 'Multi-Task Goal' });

			repo.linkTaskToGoal(goal.id, 'task-1');
			repo.linkTaskToGoal(goal.id, 'task-2');
			repo.linkTaskToGoal(goal.id, 'task-3');

			expect(repo.getGoalsForTask('task-1')).toHaveLength(1);
			expect(repo.getGoalsForTask('task-2')).toHaveLength(1);
			expect(repo.getGoalsForTask('task-3')).toHaveLength(1);
			expect(repo.getGoalsForTask('task-4')).toHaveLength(0);
		});

		it('should order results by created_at ASC', () => {
			const goal1 = repo.createGoal({ roomId, title: 'Oldest' });
			const goal2 = repo.createGoal({ roomId, title: 'Newest' });

			repo.linkTaskToGoal(goal2.id, 'shared-task');
			repo.linkTaskToGoal(goal1.id, 'shared-task');

			const results = repo.getGoalsForTask('shared-task');

			expect(results).toHaveLength(2);
			expect(results[0].id).toBe(goal1.id);
			expect(results[1].id).toBe(goal2.id);
		});

		it('should return goals across different rooms', () => {
			const roomManager = new RoomManager(db, noOpReactiveDb);
			const room2 = roomManager.createRoom({ name: 'Room 2' });

			const goal1 = repo.createGoal({ roomId, title: 'Goal Room 1' });
			const goal2 = repo.createGoal({ roomId: room2.id, title: 'Goal Room 2' });

			repo.linkTaskToGoal(goal1.id, 'shared-task');
			repo.linkTaskToGoal(goal2.id, 'shared-task');

			const results = repo.getGoalsForTask('shared-task');

			expect(results).toHaveLength(2);
		});
	});

	describe('substring regression (LIKE bug)', () => {
		it('should NOT match partial task ID substrings', () => {
			// This is the critical regression test. With the old LIKE '%"abc"%' pattern,
			// searching for "abc" would match a goal that has "abcde" in its linked_task_ids
			// because the JSON array string would contain "abcde" which contains "abc".
			// The json_each approach only matches exact elements.

			const goal = repo.createGoal({ roomId, title: 'Goal' });

			// Link a task with ID "abcde"
			repo.linkTaskToGoal(goal.id, 'abcde');

			// Search for "abc" — should NOT find the goal
			const results = repo.getGoalsForTask('abc');

			expect(results).toHaveLength(0);
		});

		it('should NOT match task ID that is a prefix of another', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });
			repo.linkTaskToGoal(goal.id, 'task-12345');

			// Searching for "task-123" should not match "task-12345"
			const results = repo.getGoalsForTask('task-123');

			expect(results).toHaveLength(0);
		});

		it('should NOT match task ID that is a suffix of another', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });
			repo.linkTaskToGoal(goal.id, 'prefix-task-abc');

			// Searching for "abc" should not match "prefix-task-abc"
			const results = repo.getGoalsForTask('abc');

			expect(results).toHaveLength(0);
		});

		it('should NOT match task ID that is an infix of another', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });
			repo.linkTaskToGoal(goal.id, 'aaa-bbb-ccc');

			// Searching for "bbb" should not match "aaa-bbb-ccc"
			const results = repo.getGoalsForTask('bbb');

			expect(results).toHaveLength(0);
		});

		it('should match exact task ID even when similar IDs exist', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });

			repo.linkTaskToGoal(goal.id, 'abc');
			repo.linkTaskToGoal(goal.id, 'abcde');
			repo.linkTaskToGoal(goal.id, 'xabcx');

			// Searching for "abc" should find exactly one goal
			// (the goal that has "abc" in its linked_task_ids)
			const results = repo.getGoalsForTask('abc');

			expect(results).toHaveLength(1);
			expect(results[0].id).toBe(goal.id);
		});

		it('should distinguish UUIDs that share a common prefix', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });

			// Simulate UUID-like IDs with a common prefix
			const id1 = '550e8400-e29b-41d4-a716-446655440000';
			const id2 = '550e8400-e29b-41d4-a716-446655440001';

			repo.linkTaskToGoal(goal.id, id1);

			// Searching for id2 should not match
			const results = repo.getGoalsForTask(id2);

			expect(results).toHaveLength(0);
		});

		it('should distinguish UUIDs that share a common suffix', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });

			const id1 = '550e8400-e29b-41d4-a716-446655440000';
			const id2 = '660e8400-e29b-41d4-a716-446655440000';

			repo.linkTaskToGoal(goal.id, id1);

			const results = repo.getGoalsForTask(id2);

			expect(results).toHaveLength(0);
		});
	});

	describe('edge cases', () => {
		it('should handle task IDs with special JSON characters', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });
			const specialId = 'task-with-"quotes"';

			repo.linkTaskToGoal(goal.id, specialId);

			const results = repo.getGoalsForTask(specialId);

			expect(results).toHaveLength(1);
		});

		it('should handle task IDs with backslash characters', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });
			const backslashId = 'task\\with\\backslash';

			repo.linkTaskToGoal(goal.id, backslashId);

			const results = repo.getGoalsForTask(backslashId);

			expect(results).toHaveLength(1);
		});

		it('should handle empty linked_task_ids after unlinking', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });
			repo.linkTaskToGoal(goal.id, 'task-1');
			repo.unlinkTaskFromGoal(goal.id, 'task-1');

			const results = repo.getGoalsForTask('task-1');

			expect(results).toHaveLength(0);
		});

		it('should work when searching for a numeric-looking task ID', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });

			repo.linkTaskToGoal(goal.id, '12345');

			const results = repo.getGoalsForTask('12345');

			expect(results).toHaveLength(1);
		});

		it('should not match numeric task ID that is a substring', () => {
			const goal = repo.createGoal({ roomId, title: 'Goal' });

			repo.linkTaskToGoal(goal.id, '1234567890');

			const results = repo.getGoalsForTask('12345');

			expect(results).toHaveLength(0);
		});
	});
});
