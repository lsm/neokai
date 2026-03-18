/**
 * Recurring Missions Tests
 *
 * Tests for Task 3: Recurring Missions — Scheduling with Execution Identity and Recovery.
 *
 * Covers:
 * - getNextGoalForPlanning() skips recurring missions
 * - tickRecurringMissions() triggers planning when next_run_at <= now
 * - Overlap prevention: no double-trigger if execution is running
 * - schedule_paused prevents firing
 * - next_run_at advances after execution completes
 * - executionId stored in session group metadata
 * - linkTaskToExecution atomic dual-write
 * - GoalManager.startExecution / completeExecution / failExecution
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	createRuntimeTestContext,
	makeRoom,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';
import { GoalRepository } from '../../../src/storage/repositories/goal-repository';

// ============================================================
// Schema extension: add mission_executions table to test DB
// ============================================================

function addMissionExecutionsTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS mission_executions (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			execution_number INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			status TEXT NOT NULL DEFAULT 'running',
			result_summary TEXT,
			task_ids TEXT NOT NULL DEFAULT '[]',
			planning_attempts INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
			UNIQUE(goal_id, execution_number)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running
			ON mission_executions(goal_id) WHERE status = 'running';
	`);
}

// ============================================================
// Tests
// ============================================================

describe('Recurring Missions: getNextGoalForPlanning skips recurring', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('recurring mission is not returned by getNextGoalForPlanning', async () => {
		// Create a recurring mission with next_run_at far in the future (not due)
		const goal = await ctx.goalManager.createGoal({
			title: 'Daily standup',
			description: 'Run daily at 9am',
			missionType: 'recurring',
			schedule: { expression: '0 9 * * *', timezone: 'UTC' },
			nextRunAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour in future
		});

		// Also create a regular one-shot goal needing planning
		const oneShot = await ctx.goalManager.createGoal({
			title: 'One-shot work',
			description: 'Regular task',
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		// The runtime should have spawned planning for the one-shot, not the recurring
		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		// Only one planning group should spawn (for one-shot, not recurring)
		expect(workerCalls.length).toBeGreaterThanOrEqual(1);

		// Verify recurring goal status is unchanged (still active, no planning attempts)
		const recurringGoal = await ctx.goalManager.getGoal(goal.id);
		expect(recurringGoal?.planning_attempts).toBe(0);

		// Verify one-shot goal got planning attempts
		const oneShotGoal = await ctx.goalManager.getGoal(oneShot.id);
		expect((oneShotGoal?.planning_attempts ?? 0)).toBeGreaterThan(0);
	});

	test('recurring mission with zero linked tasks is NOT selected by standard planning', async () => {
		await ctx.goalManager.createGoal({
			title: 'Recurring — no tasks',
			description: 'Should never be planned by standard selector',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		// No worker sessions should be spawned (no one-shot goals, and recurring is skipped)
		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls).toHaveLength(0);
	});
});

describe('Recurring Missions: tickRecurringMissions triggers execution', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('triggers planning when next_run_at <= now and not paused', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60; // 60s in past
		await ctx.goalManager.createGoal({
			title: 'Daily report',
			description: 'Run every day',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Should have spawned a planning group
		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls.length).toBeGreaterThan(0);
	});

	test('does NOT trigger when schedule_paused is true', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		await ctx.goalManager.createGoal({
			title: 'Paused mission',
			description: 'Should not fire',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
			schedulePaused: true,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls).toHaveLength(0);
	});

	test('does NOT trigger when next_run_at is in the future', async () => {
		const futureTime = Math.floor(Date.now() / 1000) + 3600;
		await ctx.goalManager.createGoal({
			title: 'Future mission',
			description: 'Not yet',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: futureTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls).toHaveLength(0);
	});

	test('does NOT trigger when an execution is already running (overlap prevention)', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Overlap test',
			description: 'No double trigger',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		// Manually start an execution (simulate already-running)
		ctx.goalManager.startExecution(goal.id);

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Should NOT spawn another planning group (execution already running)
		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls).toHaveLength(0);
	});

	test('advances next_run_at after triggering', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Catchup test',
			description: 'next_run_at advances',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		// next_run_at should have been advanced to a future time
		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(updatedGoal?.nextRunAt).not.toBeNull();
		expect(updatedGoal!.nextRunAt!).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	test('creates mission_executions row on trigger', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Execution row test',
			description: 'should create execution',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const activeExecution = ctx.goalManager.getActiveExecution(goal.id);
		expect(activeExecution).not.toBeNull();
		expect(activeExecution?.status).toBe('running');
		expect(activeExecution?.executionNumber).toBe(1);
	});

	test('clears linked_task_ids when new execution starts', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Clear tasks test',
			description: 'linked_task_ids should be cleared',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		// Simulate a task from a previous execution
		const oldTask = await ctx.taskManager.createTask({
			title: 'Old task',
			description: 'From previous execution',
			status: 'completed',
		});
		const goalRepo = new GoalRepository(ctx.db as never);
		goalRepo.linkTaskToGoal(goal.id, oldTask.id);

		ctx.runtime.start();
		await ctx.runtime.tick();

		// After the new execution starts, linked_task_ids should be cleared
		// (it may contain the new planning task, but not the old task)
		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		const linkedIds = updatedGoal?.linkedTaskIds ?? [];
		expect(linkedIds).not.toContain(oldTask.id);
	});
});

describe('GoalManager execution methods', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('startExecution creates execution row with execution_number=1 for first run', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Recurring goal',
			description: 'test',
			missionType: 'recurring',
		});

		const execution = ctx.goalManager.startExecution(goal.id);
		expect(execution.executionNumber).toBe(1);
		expect(execution.status).toBe('running');
		expect(execution.goalId).toBe(goal.id);
	});

	test('startExecution increments execution_number monotonically', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Recurring goal',
			description: 'test',
			missionType: 'recurring',
		});

		const exec1 = ctx.goalManager.startExecution(goal.id);
		ctx.goalManager.completeExecution(exec1.id);

		const exec2 = ctx.goalManager.startExecution(goal.id);
		expect(exec2.executionNumber).toBe(2);
	});

	test('completeExecution sets status to completed', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Recurring goal',
			description: 'test',
			missionType: 'recurring',
		});

		const execution = ctx.goalManager.startExecution(goal.id);
		const completed = ctx.goalManager.completeExecution(execution.id, 'All done');
		expect(completed?.status).toBe('completed');
		expect(completed?.resultSummary).toBe('All done');
		expect(completed?.completedAt).toBeDefined();
	});

	test('failExecution sets status to failed', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Recurring goal',
			description: 'test',
			missionType: 'recurring',
		});

		const execution = ctx.goalManager.startExecution(goal.id);
		const failed = ctx.goalManager.failExecution(execution.id, 'Something went wrong');
		expect(failed?.status).toBe('failed');
		expect(failed?.resultSummary).toBe('Something went wrong');
	});

	test('DB partial unique index prevents two running executions', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Recurring goal',
			description: 'test',
			missionType: 'recurring',
		});

		ctx.goalManager.startExecution(goal.id); // first execution (running)

		// Attempting a second execution should throw (UNIQUE constraint on running)
		expect(() => {
			ctx.goalManager.startExecution(goal.id);
		}).toThrow();
	});

	test('getActiveExecution returns null after completion', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Recurring goal',
			description: 'test',
			missionType: 'recurring',
		});

		const execution = ctx.goalManager.startExecution(goal.id);
		ctx.goalManager.completeExecution(execution.id);

		const active = ctx.goalManager.getActiveExecution(goal.id);
		expect(active).toBeNull();
	});
});

describe('linkTaskToExecution atomic dual-write', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('appends task to both mission_executions.task_ids and goals.linked_task_ids', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Recurring goal',
			description: 'test',
			missionType: 'recurring',
		});
		const execution = ctx.goalManager.startExecution(goal.id);

		const task = await ctx.taskManager.createTask({
			title: 'Test task',
			description: 'For execution',
		});

		await ctx.goalManager.linkTaskToExecution(goal.id, execution.id, task.id);

		// Check goals.linked_task_ids
		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(updatedGoal?.linkedTaskIds).toContain(task.id);

		// Check mission_executions.task_ids
		const updatedExecution = ctx.goalManager.getActiveExecution(goal.id);
		expect(updatedExecution?.taskIds).toContain(task.id);
	});

	test('is idempotent — linking same task twice does not duplicate', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Recurring goal',
			description: 'test',
			missionType: 'recurring',
		});
		const execution = ctx.goalManager.startExecution(goal.id);

		const task = await ctx.taskManager.createTask({
			title: 'Test task',
			description: 'For execution',
		});

		await ctx.goalManager.linkTaskToExecution(goal.id, execution.id, task.id);
		await ctx.goalManager.linkTaskToExecution(goal.id, execution.id, task.id);

		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		const count = updatedGoal!.linkedTaskIds.filter((id) => id === task.id).length;
		expect(count).toBe(1);
	});

	test('throws if goal does not exist', async () => {
		const task = await ctx.taskManager.createTask({
			title: 'Test task',
			description: 'No goal',
		});
		await expect(
			ctx.goalManager.linkTaskToExecution('non-existent-goal', 'exec-1', task.id)
		).rejects.toThrow();
	});
});

describe('executionId in session group metadata', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('spawned planning group has executionId set in metadata', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Execution identity test',
			description: 'executionId in metadata',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const activeExecution = ctx.goalManager.getActiveExecution(goal.id);
		expect(activeExecution).not.toBeNull();

		// Find the planning group and check its executionId metadata
		const activeGroups = ctx.groupRepo.getActiveGroups('room-1');
		expect(activeGroups.length).toBeGreaterThan(0);

		const planningGroup = activeGroups[0];
		expect(planningGroup.executionId).toBe(activeExecution!.id);
	});
});

describe('replan_goal + recurring mission interaction', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('getActiveExecution returns running execution for handleReplanGoal to consume', async () => {
		// Simulate what handleReplanGoal checks: is there an active execution for a recurring mission?
		const goal = await ctx.goalManager.createGoal({
			title: 'Daily digest',
			description: 'recurring',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
		});
		const execution = ctx.goalManager.startExecution(goal.id);

		// handleReplanGoal calls getActiveExecution to get the executionId
		const activeExecution = ctx.goalManager.getActiveExecution(goal.id);
		expect(activeExecution).not.toBeNull();
		expect(activeExecution!.id).toBe(execution.id);
		expect(activeExecution!.status).toBe('running');
	});

	test('atomicStartExecution resets planning_attempts to 0', async () => {
		// Verifies that per-execution planning_attempts counter is reset atomically on
		// each new execution (important for replan budget tracking).
		const goal = await ctx.goalManager.createGoal({
			title: 'Recurring goal',
			description: 'test',
			missionType: 'recurring',
		});

		// Simulate two planning attempts during the first execution
		await ctx.goalManager.incrementPlanningAttempts(goal.id);
		await ctx.goalManager.incrementPlanningAttempts(goal.id);
		const afterAttempts = await ctx.goalManager.getGoal(goal.id);
		expect(afterAttempts?.planning_attempts).toBe(2);

		// Complete the execution so we can start a second one
		const execution = ctx.goalManager.startExecution(goal.id);
		ctx.goalManager.completeExecution(execution.id);

		// New execution: planning_attempts must reset to 0 atomically
		ctx.goalManager.startExecution(goal.id);
		const afterRestart = await ctx.goalManager.getGoal(goal.id);
		expect(afterRestart?.planning_attempts).toBe(0);
	});

	test('atomicStartExecution sets nextRunAt in the same transaction', async () => {
		// Verifies that nextRunAt is advanced atomically with execution start —
		// crash between startExecution and a separate updateNextRunAt cannot leave
		// an expired next_run_at paired with a running execution.
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const futureTime = Math.floor(Date.now() / 1000) + 3600;

		const goal = await ctx.goalManager.createGoal({
			title: 'Atomic schedule test',
			description: 'test',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.goalManager.startExecution(goal.id, futureTime);

		const updated = await ctx.goalManager.getGoal(goal.id);
		expect(updated?.nextRunAt).toBe(futureTime);
	});

	test('tick triggers execution and spawns planning group for due recurring mission', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Due recurring mission',
			description: 'test',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const activeExecution = ctx.goalManager.getActiveExecution(goal.id);
		expect(activeExecution).not.toBeNull();

		// Planning group executionId must match the running execution
		const activeGroups = ctx.groupRepo.getActiveGroups('room-1');
		expect(activeGroups.length).toBeGreaterThan(0);
		expect(activeGroups[0].executionId).toBe(activeExecution!.id);

		// next_run_at must be advanced past now (atomic with execution start)
		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(updatedGoal!.nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});
});
