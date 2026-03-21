/**
 * SpaceTaskRepository.findByGoalId() Unit Tests
 *
 * Covers:
 * - Finding tasks by goalId
 * - Excluding archived tasks
 * - Handling null/undefined goalId gracefully
 * - Ordering by created_at ASC
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(process.cwd(), 'tmp', 'test-findByGoalId', `t-${Date.now()}-${Math.random()}`);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

const SPACE_ID = 'space-1';

function seedSpace(db: BunDatabase): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(SPACE_ID, '/tmp/ws', 'Test Space', Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SpaceTaskRepository.findByGoalId', () => {
	let db: BunDatabase;
	let dir: string;
	let repo: SpaceTaskRepository;

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db);
		repo = new SpaceTaskRepository(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test('returns tasks with matching goalId', () => {
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'Task 1',
			description: 'desc 1',
			goalId: 'goal-A',
		});
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'Task 2',
			description: 'desc 2',
			goalId: 'goal-A',
		});

		const tasks = repo.findByGoalId('goal-A');
		expect(tasks).toHaveLength(2);
		expect(tasks[0].title).toBe('Task 1');
		expect(tasks[1].title).toBe('Task 2');
	});

	test('returns empty array when no tasks match the goalId', () => {
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'Task 1',
			description: 'desc',
			goalId: 'goal-A',
		});

		const tasks = repo.findByGoalId('goal-nonexistent');
		expect(tasks).toHaveLength(0);
	});

	test('does not return tasks with different goalId', () => {
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'Task A',
			description: 'desc',
			goalId: 'goal-A',
		});
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'Task B',
			description: 'desc',
			goalId: 'goal-B',
		});

		const tasksA = repo.findByGoalId('goal-A');
		expect(tasksA).toHaveLength(1);
		expect(tasksA[0].title).toBe('Task A');

		const tasksB = repo.findByGoalId('goal-B');
		expect(tasksB).toHaveLength(1);
		expect(tasksB[0].title).toBe('Task B');
	});

	test('excludes archived tasks', () => {
		const task1 = repo.createTask({
			spaceId: SPACE_ID,
			title: 'Active Task',
			description: 'desc',
			goalId: 'goal-A',
		});
		const task2 = repo.createTask({
			spaceId: SPACE_ID,
			title: 'Archived Task',
			description: 'desc',
			goalId: 'goal-A',
		});

		// Archive the second task
		repo.archiveTask(task2.id);

		const tasks = repo.findByGoalId('goal-A');
		expect(tasks).toHaveLength(1);
		expect(tasks[0].id).toBe(task1.id);
		expect(tasks[0].title).toBe('Active Task');
	});

	test('does not return tasks with null goalId', () => {
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'No Goal Task',
			description: 'desc',
			// goalId intentionally omitted (will be null in DB)
		});
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'Has Goal Task',
			description: 'desc',
			goalId: 'goal-A',
		});

		const tasks = repo.findByGoalId('goal-A');
		expect(tasks).toHaveLength(1);
		expect(tasks[0].title).toBe('Has Goal Task');
	});

	test('returns all tasks with matching goalId regardless of creation timing', () => {
		const t1 = repo.createTask({
			spaceId: SPACE_ID,
			title: 'First',
			description: 'desc',
			goalId: 'goal-order',
		});
		const t2 = repo.createTask({
			spaceId: SPACE_ID,
			title: 'Second',
			description: 'desc',
			goalId: 'goal-order',
		});
		const t3 = repo.createTask({
			spaceId: SPACE_ID,
			title: 'Third',
			description: 'desc',
			goalId: 'goal-order',
		});

		const tasks = repo.findByGoalId('goal-order');
		expect(tasks).toHaveLength(3);
		// Verify all three task IDs are present (order may vary with same-ms timestamps)
		const ids = new Set(tasks.map((t) => t.id));
		expect(ids.has(t1.id)).toBe(true);
		expect(ids.has(t2.id)).toBe(true);
		expect(ids.has(t3.id)).toBe(true);
	});

	test('handles multiple tasks with same goalId across different statuses', () => {
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'Pending',
			description: 'desc',
			goalId: 'goal-mixed',
			status: 'pending',
		});
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'In Progress',
			description: 'desc',
			goalId: 'goal-mixed',
			status: 'in_progress',
		});
		repo.createTask({
			spaceId: SPACE_ID,
			title: 'Completed',
			description: 'desc',
			goalId: 'goal-mixed',
			status: 'completed',
		});

		const tasks = repo.findByGoalId('goal-mixed');
		expect(tasks).toHaveLength(3);
	});

	test('returns tasks across all spaces with matching goalId', () => {
		// Seed a second space
		const space2 = 'space-2';
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
       allowed_models, session_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
		).run(space2, '/tmp/ws2', 'Space 2', Date.now(), Date.now());

		repo.createTask({
			spaceId: SPACE_ID,
			title: 'Space 1 Task',
			description: 'desc',
			goalId: 'shared-goal',
		});
		repo.createTask({
			spaceId: space2,
			title: 'Space 2 Task',
			description: 'desc',
			goalId: 'shared-goal',
		});

		// findByGoalId does not filter by space — it returns all matching tasks
		const tasks = repo.findByGoalId('shared-goal');
		expect(tasks).toHaveLength(2);
	});
});
