import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

describe('RoomRuntime', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	describe('lifecycle', () => {
		it('should start in paused state', () => {
			expect(ctx.runtime.getState()).toBe('paused');
		});

		it('should transition to running on start', () => {
			ctx.runtime.start();
			expect(ctx.runtime.getState()).toBe('running');
		});

		it('should pause and resume', () => {
			ctx.runtime.start();
			ctx.runtime.pause();
			expect(ctx.runtime.getState()).toBe('paused');
			ctx.runtime.resume();
			expect(ctx.runtime.getState()).toBe('running');
		});

		it('should stop', () => {
			ctx.runtime.start();
			ctx.runtime.stop();
			expect(ctx.runtime.getState()).toBe('stopped');
		});
	});

	describe('tick', () => {
		it('should not tick when paused', async () => {
			await createGoalAndTask(ctx);
			await ctx.runtime.tick();

			// No groups should be spawned since runtime is paused
			expect(ctx.sessionFactory.calls).toHaveLength(0);
		});

		it('should spawn a group for pending task when running', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			// Worker starts immediately, leader is deferred until routeWorkerToLeader
			const workerCalls = ctx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'createAndStartSession' &&
					c.args[1] !== 'leader'
			);
			const leaderCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
			);
			expect(workerCalls).toHaveLength(1);
			expect(leaderCalls).toHaveLength(0);

			// Task should be in_progress
			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.status).toBe('in_progress');
		});

		it('should respect maxConcurrentGroups', async () => {
			await createGoalAndTask(ctx);
			// Create second task
			const task2 = await ctx.taskManager.createTask({
				title: 'Another task',
				description: 'Details',
			});
			const goals = await ctx.goalManager.listGoals();
			await ctx.goalManager.linkTaskToGoal(goals[0].id, task2.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			// Only 1 group should be spawned (maxConcurrentGroups = 1)
			const workerCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] !== 'leader'
			);
			expect(workerCalls).toHaveLength(1);
		});

		it('should not spawn group when no pending tasks', async () => {
			ctx.runtime.start();
			await ctx.runtime.tick();

			expect(ctx.sessionFactory.calls).toHaveLength(0);
		});

		it('should use mutex to prevent concurrent ticks', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();

			// Run two ticks concurrently
			await Promise.all([ctx.runtime.tick(), ctx.runtime.tick()]);

			// Only one group should be spawned
			const activeGroups = ctx.groupRepo.getActiveGroups('room-1');
			expect(activeGroups).toHaveLength(1);
		});

		it('should trigger replanning when planning succeeded but all execution tasks failed', async () => {
			// Create goal with a completed planning task and failed execution tasks
			const goal = await ctx.goalManager.createGoal({
				title: 'Build API',
				description: 'Build the REST API',
			});
			const planningTask = await ctx.taskManager.createTask({
				title: 'Plan: Build API',
				description: 'Plan the work',
				taskType: 'planning',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, planningTask.id);
			await ctx.taskManager.completeTask(planningTask.id, 'Plan created');

			const execTask1 = await ctx.taskManager.createTask({
				title: 'Add endpoints',
				description: 'Add REST endpoints',
				taskType: 'coding',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, execTask1.id);
			await ctx.taskManager.failTask(execTask1.id, 'Compilation error');

			const execTask2 = await ctx.taskManager.createTask({
				title: 'Add auth',
				description: 'Add authentication',
				taskType: 'coding',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, execTask2.id);
			await ctx.taskManager.failTask(execTask2.id, 'Test failure');

			// Increment planning_attempts to 1 (initial planning already done)
			await ctx.goalManager.incrementPlanningAttempts(goal.id);
			const attemptsBefore = (await ctx.goalManager.getGoal(goal.id))!.planning_attempts;

			ctx.runtime.start();
			await ctx.runtime.tick();

			// Should have spawned a new planning group (planner session)
			const plannerCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'planner'
			);
			expect(plannerCalls.length).toBeGreaterThanOrEqual(1);

			// planning_attempts should have incremented
			const goalAfter = await ctx.goalManager.getGoal(goal.id);
			expect(goalAfter!.planning_attempts).toBeGreaterThan(attemptsBefore);
		});

		it('should NOT replan when execution tasks are still active', async () => {
			const goal = await ctx.goalManager.createGoal({
				title: 'Build API',
				description: 'Build the REST API',
			});
			const planningTask = await ctx.taskManager.createTask({
				title: 'Plan: Build API',
				description: 'Plan the work',
				taskType: 'planning',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, planningTask.id);
			await ctx.taskManager.completeTask(planningTask.id, 'Plan created');

			// One failed, one still pending — should NOT trigger replan
			const execTask1 = await ctx.taskManager.createTask({
				title: 'Add endpoints',
				description: 'Add REST endpoints',
				taskType: 'coding',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, execTask1.id);
			await ctx.taskManager.failTask(execTask1.id, 'Compilation error');

			const execTask2 = await ctx.taskManager.createTask({
				title: 'Add auth',
				description: 'Add authentication',
				taskType: 'coding',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, execTask2.id);
			// execTask2 stays pending

			await ctx.goalManager.incrementPlanningAttempts(goal.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			// Should spawn execution group for pending task, NOT a planning group
			const plannerCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'planner'
			);
			expect(plannerCalls).toHaveLength(0);

			const coderCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'coder'
			);
			expect(coderCalls).toHaveLength(1);
		});
	});
});
