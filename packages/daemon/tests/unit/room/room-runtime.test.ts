import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	makeRoom,
	spawnAndRouteToLeader,
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
				(c) => c.method === 'createAndStartSession' && c.args[1] !== 'leader'
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

		it('should trigger replanning when planning succeeded but all execution tasks failed (maxPlanningRetries=2)', async () => {
			// Use a room config with maxPlanningRetries=2 to allow retries
			ctx.runtime.updateRoom({ ...ctx.runtime['room'], config: { maxPlanningRetries: 2 } });

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

		it('should escalate to needs_human immediately when maxPlanningRetries=0 (default) and execution tasks all failed', async () => {
			// Default room config: maxPlanningRetries = 0 (no retries)
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

			const execTask = await ctx.taskManager.createTask({
				title: 'Add endpoints',
				description: 'Add REST endpoints',
				taskType: 'coding',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, execTask.id);
			await ctx.taskManager.failTask(execTask.id, 'Compilation error');

			// planning_attempts = 1 (initial planning done), maxPlanningAttempts = 0+1 = 1
			// So attempts >= maxPlanningAttempts → escalate immediately
			await ctx.goalManager.incrementPlanningAttempts(goal.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			// Should NOT have spawned a new planner session
			const plannerCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'planner'
			);
			expect(plannerCalls.length).toBe(0);

			// Goal should be escalated to needs_human
			const goalAfter = await ctx.goalManager.getGoal(goal.id);
			expect(goalAfter!.status).toBe('needs_human');
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

	describe('config clamping', () => {
		it('should clamp maxReviewRounds above 20 to 20 via updateRoom', async () => {
			ctx.runtime.updateRoom(makeRoom({ config: { maxReviewRounds: 25 } }));
			const { group } = await spawnAndRouteToLeader(ctx);
			// Saturate to 20 by incrementing feedbackIteration 19 more times (already at 1)
			let g = ctx.groupRepo.getGroup(group.id)!;
			for (let i = 0; i < 19; i++) {
				g = ctx.groupRepo.incrementFeedbackIteration(g.id, g.version)!;
			}
			// feedbackIteration == 20 == clamped maxFeedbackIterations → must fail
			const result = await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'over the limit',
			});
			const parsed = JSON.parse(result.content[0].text) as { success: boolean; error?: string };
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Max feedback iterations');
		});

		it('should fall back to default (1) when maxConcurrentGroups is 0 or negative', async () => {
			// 0 is below the >= 1 guard, so default applies
			const ctx2 = createRuntimeTestContext({ maxConcurrentGroups: undefined });
			ctx2.runtime.updateRoom(makeRoom({ config: { maxConcurrentGroups: 0 } }));
			const goal = await ctx2.goalManager.createGoal({ title: 'g', description: 'd' });
			const task1 = await ctx2.taskManager.createTask({
				title: 'T1',
				description: 'd',
				assignedAgent: 'general',
			});
			const task2 = await ctx2.taskManager.createTask({
				title: 'T2',
				description: 'd',
				assignedAgent: 'general',
			});
			await ctx2.goalManager.linkTaskToGoal(goal.id, task1.id);
			await ctx2.goalManager.linkTaskToGoal(goal.id, task2.id);
			ctx2.runtime.start();
			await ctx2.runtime.tick();
			// Default is 1 → only 1 group spawned despite 2 pending tasks
			const workers = ctx2.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] !== 'leader'
			);
			expect(workers).toHaveLength(1);
			ctx2.runtime.stop();
			ctx2.db.close();
		});

		it('should floor fractional maxReviewRounds to an integer via updateRoom', async () => {
			ctx.runtime.updateRoom(makeRoom({ config: { maxReviewRounds: 1.7 } }));
			const { group } = await spawnAndRouteToLeader(ctx);
			// feedbackIteration starts at 1 after routeWorkerToLeader; floored cap is 1 → must fail
			const result = await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'fractional',
			});
			const parsed = JSON.parse(result.content[0].text) as { success: boolean; error?: string };
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Max feedback iterations');
		});
	});

	describe('config defaults', () => {
		it('should use maxFeedbackIterations default of 3 when not configured', async () => {
			// The helper no longer applies a ?? 5 fallback, so the runtime uses its own default (3).
			// Verify behaviorally: saturate feedbackIteration to 3 and assert send_to_worker fails.
			const { group } = await spawnAndRouteToLeader(ctx);
			// After routeWorkerToLeader feedbackIteration is 1; increment twice more to reach 3.
			let g = ctx.groupRepo.getGroup(group.id)!;
			g = ctx.groupRepo.incrementFeedbackIteration(g.id, g.version)!;
			g = ctx.groupRepo.incrementFeedbackIteration(g.id, g.version)!;
			// feedbackIteration == 3 == maxFeedbackIterations (default) → must fail
			const result = await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'one more round',
			});
			const parsed = JSON.parse(result.content[0].text) as { success: boolean; error?: string };
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Max feedback iterations');
		});
	});

	describe('updateRoom', () => {
		it('should update maxConcurrentGroups reactively — next tick starts an additional group', async () => {
			// Create goal and 2 tasks BEFORE starting the runtime so the phantom
			// scheduleTick microtask does not trigger a planning spawn on an empty goal.
			const goal = await ctx.goalManager.createGoal({
				title: 'Test goal',
				description: 'desc',
			});
			const task1 = await ctx.taskManager.createTask({
				title: 'Task 1',
				description: 'First',
				assignedAgent: 'general',
			});
			const task2 = await ctx.taskManager.createTask({
				title: 'Task 2',
				description: 'Second',
				assignedAgent: 'general',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task1.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, task2.id);

			// Start with maxConcurrentGroups = 1
			ctx.runtime.start();

			// First tick: only 1 group should spawn (maxConcurrentGroups = 1)
			await ctx.runtime.tick();
			const workerCallsAfterTick1 = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] !== 'leader'
			);
			expect(workerCallsAfterTick1).toHaveLength(1);

			// Drain the microtask queued by tick1's finally block (queueMicrotask re-tick).
			// Without this, Bun schedules the test continuation before that microtask,
			// so the re-tick fires mid-tick2 rather than before it.
			await Promise.resolve();

			// Update room config to allow 2 concurrent groups
			ctx.runtime.updateRoom(makeRoom({ config: { maxConcurrentGroups: 2 } }));

			// Second tick: 1 active group + limit now 2 → 1 available slot → spawn task2
			await ctx.runtime.tick();
			const workerCallsAfterTick2 = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] !== 'leader'
			);
			expect(workerCallsAfterTick2).toHaveLength(2);
		});

		it('should update maxReviewRounds (maxFeedbackIterations) reactively', async () => {
			// Lower the cap to 1 reactively before any groups are spawned.
			ctx.runtime.updateRoom(makeRoom({ config: { maxReviewRounds: 1 } }));
			// spawnAndRouteToLeader starts the runtime and routes the worker to the leader,
			// incrementing feedbackIteration to 1.
			const { group } = await spawnAndRouteToLeader(ctx);
			// feedbackIteration == 1 == maxFeedbackIterations (reactively set to 1) → must fail
			const result = await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'one more',
			});
			const parsed = JSON.parse(result.content[0].text) as { success: boolean; error?: string };
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Max feedback iterations');
		});

		it('decreasing maxConcurrentGroups does not kill running groups', async () => {
			// Create goal and 2 tasks BEFORE starting to avoid phantom planning spawn.
			const ctx2 = createRuntimeTestContext({ maxConcurrentGroups: 2 });

			const goal = await ctx2.goalManager.createGoal({
				title: 'Test goal',
				description: 'desc',
			});
			const task1 = await ctx2.taskManager.createTask({
				title: 'Task 1',
				description: 'First',
				assignedAgent: 'general',
			});
			const task2 = await ctx2.taskManager.createTask({
				title: 'Task 2',
				description: 'Second',
				assignedAgent: 'general',
			});
			await ctx2.goalManager.linkTaskToGoal(goal.id, task1.id);
			await ctx2.goalManager.linkTaskToGoal(goal.id, task2.id);

			ctx2.runtime.start();

			// Tick: 2 slots available → both tasks should spawn
			await ctx2.runtime.tick();
			const activeGroupsBefore = ctx2.groupRepo.getActiveGroups('room-1');
			expect(activeGroupsBefore).toHaveLength(2);

			// Decrease to 1 — running groups should NOT be killed
			ctx2.runtime.updateRoom(makeRoom({ config: { maxConcurrentGroups: 1 } }));

			// Groups still active after config change
			const activeGroupsAfter = ctx2.groupRepo.getActiveGroups('room-1');
			expect(activeGroupsAfter).toHaveLength(2);

			ctx2.runtime.stop();
			ctx2.db.close();
		});
	});
});
