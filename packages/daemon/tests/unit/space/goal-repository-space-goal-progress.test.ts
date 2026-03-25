/**
 * GoalRepository.recalculateProgressFromSpaceTasks() Unit Tests
 *
 * Covers:
 * - Empty tasks list returns 0 progress
 * - completed task → 100%
 * - needs_attention/cancelled → 0% (terminal, no contribution)
 * - in_progress with progress value contributes its progress
 * - pending task with no progress → 0%
 * - Average of all non-terminal tasks
 * - Mix of terminal and non-terminal tasks
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables, runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { GoalRepository } from '../../../src/storage/repositories/goal-repository.ts';
import { noOpReactiveDb } from '../../helpers/reactive-database';

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-space-goal-progress',
		`t-${Date.now()}-${Math.random()}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	createTables(db);
	runMigrations(db, () => {});
	return { db, dir };
}

const SPACE_ID = 'space-1';
const GOAL_ID = 'goal-test-1';

function seedSpaceAndGoal(db: BunDatabase): void {
	// Disable FK constraints when seeding — goals table has FK to rooms which
	// isn't created in this isolated test DB. Re-enable after both inserts.
	db.exec('PRAGMA foreign_keys = OFF');

	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(SPACE_ID, '/tmp/ws', 'Test Space', Date.now(), Date.now());

	db.prepare(
		`INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids,
     metrics, created_at, updated_at, mission_type, autonomy_level, schedule, schedule_paused, next_run_at,
     structured_metrics, max_consecutive_failures, max_planning_attempts, consecutive_failures,
     replan_count, short_id)
     VALUES (?, ?, ?, '', 'active', 'normal', 0, '[]', '{}', ?, ?, 'one_shot', 'supervised', NULL, 0, NULL,
     NULL, 3, 0, 0, 0, NULL)`
	).run(GOAL_ID, 'room-1', 'Test Goal', Date.now(), Date.now());

	db.exec('PRAGMA foreign_keys = ON');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GoalRepository.recalculateProgressFromSpaceTasks', () => {
	let db: BunDatabase;
	let dir: string;
	let spaceTaskRepo: SpaceTaskRepository;
	let goalRepo: GoalRepository;

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpaceAndGoal(db);
		spaceTaskRepo = new SpaceTaskRepository(db);
		goalRepo = new GoalRepository(db, noOpReactiveDb);
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

	test('returns 0 progress when no tasks exist for goal', () => {
		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(0);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(0);
	});

	test('completed task contributes 100%', () => {
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Completed Task',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'completed',
		});

		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(100);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(100);
	});

	test('needs_attention task contributes 0% (terminal)', () => {
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Needs Attention Task',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'needs_attention',
		});

		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(0);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(0);
	});

	test('cancelled task contributes 0% (terminal)', () => {
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Cancelled Task',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'cancelled',
		});

		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(0);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(0);
	});

	test('in_progress task with progress contributes its progress value', () => {
		const task = spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'In Progress Task',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'in_progress',
		});
		spaceTaskRepo.updateTask(task.id, { progress: 50 });

		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(50);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(50);
	});

	test('pending task with no progress contributes 0%', () => {
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Pending Task',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'pending',
			// progress not set → undefined/null
		});

		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(0);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(0);
	});

	test('multiple tasks returns average progress', () => {
		// Task 1: completed → 100%
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Completed Task',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'completed',
		});
		// Task 2: in_progress with 50% → 50%
		const halfDoneTask = spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Half Done Task',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'in_progress',
		});
		spaceTaskRepo.updateTask(halfDoneTask.id, { progress: 50 });
		// Task 3: pending, no progress → 0%
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Not Started Task',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'pending',
		});

		// (100 + 50 + 0) / 3 = 50
		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(50);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(50);
	});

	test('all completed tasks returns 100%', () => {
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Task 1',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'completed',
		});
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Task 2',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'completed',
		});
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Task 3',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'completed',
		});

		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(100);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(100);
	});

	test('mix of terminal and non-terminal tasks calculates correctly', () => {
		// completed → 100%
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Completed',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'completed',
		});
		// needs_attention → 0% (terminal)
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Needs Attention',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'needs_attention',
		});
		// cancelled → 0% (terminal)
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Cancelled',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'cancelled',
		});
		// in_progress with 75% → 75%
		const almostDoneTask = spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Almost Done',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'in_progress',
		});
		spaceTaskRepo.updateTask(almostDoneTask.id, { progress: 75 });

		// (100 + 0 + 0 + 75) / 4 = 43.75 → rounded to 44
		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(44);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(44);
	});

	test('only terminal tasks returns 0%', () => {
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Needs Attention',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'needs_attention',
		});
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Cancelled',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'cancelled',
		});

		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(0);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(0);
	});

	test('progress is rounded to nearest integer', () => {
		// Three tasks each at 33% → (33 + 33 + 33) / 3 = 33
		const task1 = spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Task 1',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'in_progress',
		});
		spaceTaskRepo.updateTask(task1.id, { progress: 33 });

		const task2 = spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Task 2',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'in_progress',
		});
		spaceTaskRepo.updateTask(task2.id, { progress: 33 });

		const task3 = spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Task 3',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'in_progress',
		});
		spaceTaskRepo.updateTask(task3.id, { progress: 33 });

		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(33);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(33);
	});

	test('tasks without matching goalId are excluded', () => {
		// Create a task with different goalId
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Other Goal Task',
			description: 'desc',
			goalId: 'other-goal',
			status: 'completed', // Would be 100% if included
		});
		// Create a task with no goalId
		spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'No Goal Task',
			description: 'desc',
			// goalId intentionally omitted
			status: 'completed', // Would be 100% if included
		});
		// Create a task with matching goalId
		const ourGoalTask = spaceTaskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Our Goal Task',
			description: 'desc',
			goalId: GOAL_ID,
			status: 'in_progress',
		});
		spaceTaskRepo.updateTask(ourGoalTask.id, { progress: 25 });

		// Only our goal's task counts → 25
		const progress = goalRepo.recalculateProgressFromSpaceTasks(GOAL_ID, spaceTaskRepo);
		expect(progress).toBe(25);

		const goal = goalRepo.getGoal(GOAL_ID);
		expect(goal?.progress).toBe(25);
	});
});
