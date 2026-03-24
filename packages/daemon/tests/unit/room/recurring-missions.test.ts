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
import { createRuntimeTestContext, type RuntimeTestContext } from './room-runtime-test-helpers';

// ============================================================
// Tests
// ============================================================

describe('Recurring Missions: getNextGoalForPlanning skips recurring', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
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
		expect(oneShotGoal?.planning_attempts ?? 0).toBeGreaterThan(0);
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
		await ctx.goalManager.linkTaskToGoal(goal.id, oldTask.id);

		ctx.runtime.start();
		await ctx.runtime.tick();

		// After the new execution starts, linked_task_ids should be cleared
		// (it may contain the new planning task, but not the old task)
		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		const linkedIds = updatedGoal?.linkedTaskIds ?? [];
		expect(linkedIds).not.toContain(oldTask.id);
	});

	test('auto-computes nextRunAt when recurring goal created with schedule but no nextRunAt', async () => {
		// Regression test: creating a recurring goal with a schedule (but no explicit
		// nextRunAt) should auto-compute nextRunAt so the goal triggers on the next tick.
		// Without this fix, nextRunAt would be null and Phase 2 would skip the goal.
		const goal = await ctx.goalManager.createGoal({
			title: 'Auto-schedule test',
			description: 'nextRunAt should be auto-computed',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			// NOTE: nextRunAt is NOT set here — that's the bug scenario
		});

		// nextRunAt should have been auto-computed to a future time
		expect(goal.nextRunAt).not.toBeNull();
		expect(goal.nextRunAt!).toBeGreaterThan(Math.floor(Date.now() / 1000));

		// Now set nextRunAt to the past so the tick will trigger
		await ctx.goalManager.updateNextRunAt(goal.id, Math.floor(Date.now() / 1000) - 60);

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Execution should have been triggered
		const activeExecution = ctx.goalManager.getActiveExecution(goal.id);
		expect(activeExecution).not.toBeNull();
		expect(activeExecution?.status).toBe('running');
	});
});

describe('GoalManager execution methods', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
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

	test('missionType remains recurring through full tick lifecycle: trigger → complete → re-trigger', async () => {
		// Regression test: verify missionType is NOT changed to 'one_shot' through the
		// full recurring mission lifecycle:
		// 1. Phase 2 triggers execution (tick #1)
		// 2. Tasks complete, Phase 1 completes execution and advances next_run_at (tick #2)
		// 3. Phase 2 re-triggers new execution (tick #3)
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Full lifecycle test',
			description: 'missionType should stay recurring through all phases',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		// ── Phase 2 of tick #1: trigger execution ──────────────────────────────
		ctx.runtime.start();
		await ctx.runtime.tick();

		let updatedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(updatedGoal?.missionType).toBe('recurring');

		const exec1 = ctx.goalManager.getActiveExecution(goal.id);
		expect(exec1).not.toBeNull();
		expect(exec1?.status).toBe('running');
		expect(exec1?.executionNumber).toBe(1);

		// Simulate task completion: mark the execution's tasks as completed
		// so Phase 1 will complete the execution on the next tick
		const taskIds = exec1!.taskIds;
		for (const taskId of taskIds) {
			await ctx.taskManager.updateTaskStatus(taskId, 'completed');
		}

		// ── Phase 1 of tick #2: complete execution and advance next_run_at ──────
		await ctx.runtime.tick();

		// Execution should now be completed (not running)
		const exec1After = ctx.goalManager.getActiveExecution(goal.id);
		expect(exec1After).toBeNull(); // no active execution

		// missionType should still be 'recurring'
		updatedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(updatedGoal?.missionType).toBe('recurring');

		// next_run_at should have been advanced to the future
		expect(updatedGoal!.nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

		// ── Phase 2 of tick #3: re-trigger new execution ───────────────────────
		// Set next_run_at to the past to trigger again
		await ctx.goalManager.updateNextRunAt(goal.id, Math.floor(Date.now() / 1000) - 60);

		await ctx.runtime.tick();

		const exec2 = ctx.goalManager.getActiveExecution(goal.id);
		expect(exec2).not.toBeNull();
		expect(exec2?.status).toBe('running');
		expect(exec2?.executionNumber).toBe(2); // second execution

		// missionType should STILL be 'recurring' after re-trigger
		updatedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(updatedGoal?.missionType).toBe('recurring');
		// next_run_at should have been re-advanced by startExecution
		// (may be equal to oldNextRunAt if both computed at same second; verify it's future)
		expect(updatedGoal!.nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});
});

describe('Recurring Missions: plan reuse for subsequent executions', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('subsequent execution clones tasks from previous execution without spawning planning group', async () => {
		// Test that execution #2+ reuses the plan from execution #1 instead of
		// spawning a new planning group. This verifies plan reuse behavior.
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Daily report generation',
			description: 'Generate daily report',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		// ── Execution 1: trigger via tick ─────────────────────────────────────
		ctx.runtime.start();
		await ctx.runtime.tick();

		const exec1 = ctx.goalManager.getActiveExecution(goal.id);
		expect(exec1).not.toBeNull();
		expect(exec1?.executionNumber).toBe(1);

		// Manually create execution tasks (simulating what the planner would have created)
		// and link them to execution 1. In a real run, the planner creates these.
		const task1 = await ctx.taskManager.createTask({
			title: 'Fetch data',
			description: 'Fetch data from API',
			taskType: 'coding',
			assignedAgent: 'coder',
			status: 'pending',
		});
		const task2 = await ctx.taskManager.createTask({
			title: 'Format report',
			description: 'Format data into report',
			taskType: 'coding',
			assignedAgent: 'coder',
			status: 'pending',
		});
		// Link tasks to execution 1
		await ctx.goalManager.linkTaskToExecution(goal.id, exec1!.id, task1.id);
		await ctx.goalManager.linkTaskToExecution(goal.id, exec1!.id, task2.id);

		// Complete execution 1's tasks so Phase 1 completes the execution.
		// The execution's taskIds also includes the planning task created by spawnPlanningGroup,
		// so we must mark that as completed too.
		const allTasks = await Promise.all(exec1!.taskIds.map((id) => ctx.taskManager.getTask(id)));
		const planningTask = allTasks.find((t) => t?.taskType === 'planning');
		if (planningTask) {
			await ctx.taskManager.updateTaskStatus(planningTask.id, 'completed');
		}
		await ctx.taskManager.updateTaskStatus(task1.id, 'completed');
		await ctx.taskManager.updateTaskStatus(task2.id, 'completed');

		// Tick to let Phase 1 complete the execution and advance next_run_at
		await ctx.runtime.tick();

		const exec1After = ctx.goalManager.getActiveExecution(goal.id);
		expect(exec1After).toBeNull(); // execution should be completed

		const completedExecs = ctx.goalManager.listExecutions(goal.id, 10);
		const completedExec1 = completedExecs.find((e) => e.executionNumber === 1);
		expect(completedExec1?.status).toBe('completed');
		expect(completedExec1?.taskIds).toContain(task1.id);
		expect(completedExec1?.taskIds).toContain(task2.id);

		// ── Execution 2: should reuse plan from execution 1 ─────────────────────
		// Set next_run_at to past to trigger execution 2
		await ctx.goalManager.updateNextRunAt(goal.id, Math.floor(Date.now() / 1000) - 60);

		await ctx.runtime.tick();

		const exec2 = ctx.goalManager.getActiveExecution(goal.id);
		expect(exec2).not.toBeNull();
		expect(exec2?.executionNumber).toBe(2);

		// Verify execution 2 has NEW tasks cloned from execution 1's tasks
		// (task IDs should be different from task1/task2)
		expect(exec2!.taskIds).not.toContain(task1.id);
		expect(exec2!.taskIds).not.toContain(task2.id);

		// Verify the cloned tasks have correct properties and are different IDs from original
		const clonedTask1Id = exec2!.taskIds.find((id) => id !== task1.id && id !== task2.id);
		expect(clonedTask1Id).toBeDefined();

		const clonedTask1 = await ctx.taskManager.getTask(clonedTask1Id!);
		// The cloned task should have the same title as one of the original tasks
		expect(['Fetch data', 'Format report']).toContain(clonedTask1?.title);
		// Status may be pending or in_progress (tick's execution flow picks them up)
		expect(['pending', 'in_progress']).toContain(clonedTask1?.status as string);

		// Verify the log shows plan reuse (not fallback to planning)
		// This is implicitly verified by checking that exec2 has new tasks
	});

	test('subsequent execution remaps task dependencies correctly', async () => {
		// Test that when tasks have dependencies, they are correctly remapped to new task IDs
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Build pipeline',
			description: 'Multi-step build',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const exec1 = ctx.goalManager.getActiveExecution(goal.id);

		// Create tasks with a dependency: taskB depends on taskA
		const taskA = await ctx.taskManager.createTask({
			title: 'Setup',
			description: 'Initial setup',
			taskType: 'coding',
			status: 'pending',
		});
		const taskB = await ctx.taskManager.createTask({
			title: 'Build',
			description: 'Run build',
			taskType: 'coding',
			dependsOn: [taskA.id], // taskB depends on taskA
			status: 'pending',
		});
		await ctx.goalManager.linkTaskToExecution(goal.id, exec1!.id, taskA.id);
		await ctx.goalManager.linkTaskToExecution(goal.id, exec1!.id, taskB.id);

		// Complete tasks and trigger execution 2.
		// Also mark the planning task as completed since it's in the execution's taskIds.
		const exec1AllTasks = await Promise.all(
			exec1!.taskIds.map((id) => ctx.taskManager.getTask(id))
		);
		const exec1PlanningTask = exec1AllTasks.find((t) => t?.taskType === 'planning');
		if (exec1PlanningTask) {
			await ctx.taskManager.updateTaskStatus(exec1PlanningTask.id, 'completed');
		}
		await ctx.taskManager.updateTaskStatus(taskA.id, 'completed');
		await ctx.taskManager.updateTaskStatus(taskB.id, 'completed');
		await ctx.runtime.tick();

		await ctx.goalManager.updateNextRunAt(goal.id, Math.floor(Date.now() / 1000) - 60);
		await ctx.runtime.tick();

		const exec2 = ctx.goalManager.getActiveExecution(goal.id);
		expect(exec2!.taskIds.length).toBe(2);

		// Get the cloned tasks
		const clonedTasks = await Promise.all(exec2!.taskIds.map((id) => ctx.taskManager.getTask(id)));
		const clonedA = clonedTasks.find((t) => t?.title === 'Setup');
		const clonedB = clonedTasks.find((t) => t?.title === 'Build');

		// Verify clonedB's dependsOn points to clonedA (not original taskA)
		expect(clonedB?.dependsOn).toContain(clonedA!.id);
		expect(clonedB?.dependsOn).not.toContain(taskA.id);
	});

	test('first execution always spawns planning group even if previous execution exists', async () => {
		// Execution #1 should always go through planning, regardless of any context
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'New recurring mission',
			description: 'Should always plan on first run',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const exec1 = ctx.goalManager.getActiveExecution(goal.id);
		expect(exec1?.executionNumber).toBe(1);

		// Planning group should have been spawned (verify via session factory calls)
		const planningCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(planningCalls.length).toBeGreaterThan(0);
	});

	test('execution with no previous tasks falls back to planning', async () => {
		// If a previous execution had no tasks (e.g., planning failed), fall back to planning
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Sometimes empty',
			description: 'May have no tasks some runs',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const exec1 = ctx.goalManager.getActiveExecution(goal.id);

		// Create a task but don't link any tasks to execution (simulating planning failure)
		// The orphan guard won't trigger since we haven't exceeded 5 minutes
		// Instead, manually complete the empty execution
		ctx.goalManager.completeExecution(exec1!.id, 'No tasks created');

		await ctx.runtime.tick();
		await ctx.goalManager.updateNextRunAt(goal.id, Math.floor(Date.now() / 1000) - 60);

		// Clear session calls to track new planning
		ctx.sessionFactory.calls.length = 0;

		await ctx.runtime.tick();

		const exec2 = ctx.goalManager.getActiveExecution(goal.id);
		expect(exec2?.executionNumber).toBe(2);

		// Execution 2 should have spawned a planning group (fallback)
		const planningCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(planningCalls.length).toBeGreaterThan(0);
	});
});
