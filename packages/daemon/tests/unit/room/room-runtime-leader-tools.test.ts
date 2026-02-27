import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	spawnAndRouteToLeader,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

describe('RoomRuntime leader tools', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	describe('handleLeaderTool', () => {
		it('should handle complete_task', async () => {
			const { task, group } = await spawnAndRouteToLeader(ctx);

			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Health endpoint added',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('completed');
		});

		it('should handle fail_task', async () => {
			const { task, group } = await spawnAndRouteToLeader(ctx);

			const result = await ctx.runtime.handleLeaderTool(group.id, 'fail_task', {
				reason: 'Cannot be done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('failed');
		});

		it('should handle send_to_worker', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			const result = await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Fix the tests',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			// Should inject feedback into worker session
			const injectCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage' && (c.args[1] as string).includes('LEADER FEEDBACK')
			);
			expect(injectCalls.length).toBeGreaterThan(0);
		});

		it('should reject if group not in awaiting_leader state', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			// Group is in awaiting_worker (haven't routed to leader yet)
			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('awaiting_leader');
		});

		it('should reject for non-existent group', async () => {
			const result = await ctx.runtime.handleLeaderTool('nonexistent', 'complete_task', {
				summary: 'Done',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
		});
	});

	describe('replan_goal', () => {
		async function setupGoalWithMultipleTasks() {
			const goal = await ctx.goalManager.createGoal({
				title: 'Build auth system',
				description: 'Implement authentication',
			});
			const task1 = await ctx.taskManager.createTask({
				title: 'Add login endpoint',
				description: 'POST /login',
				priority: 'high',
			});
			const task2 = await ctx.taskManager.createTask({
				title: 'Add signup endpoint',
				description: 'POST /signup',
			});
			const task3 = await ctx.taskManager.createTask({
				title: 'Add logout endpoint',
				description: 'POST /logout',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task1.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, task2.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, task3.id);
			return { goal, task1, task2, task3 };
		}

		it('should fail the current task and spawn a planning group', async () => {
			const { goal, task1, task2, task3 } = await setupGoalWithMultipleTasks();
			await ctx.goalManager.incrementPlanningAttempts(goal.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			expect(groups).toHaveLength(1);
			const group = groups[0];

			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const result = await ctx.runtime.handleLeaderTool(group.id, 'replan_goal', {
				reason: 'JWT approach is wrong, need session-based auth',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);
			expect(parsed.message).toContain('Replanning triggered');

			// The current task should be failed
			const updatedTask = await ctx.taskManager.getTask(task1.id);
			expect(updatedTask!.status).toBe('failed');

			// Remaining pending tasks should be cancelled
			const t2 = await ctx.taskManager.getTask(task2.id);
			const t3 = await ctx.taskManager.getTask(task3.id);
			expect(t2!.status).toBe('failed');
			expect(t3!.status).toBe('failed');

			// A new planning group should have been spawned
			const allActiveGroups = ctx.groupRepo.getActiveGroups('room-1');
			expect(allActiveGroups.length).toBeGreaterThanOrEqual(1);

			const allPlanningTasks = (await ctx.taskManager.listTasks({})).filter(
				(t) => t.taskType === 'planning'
			);
			expect(allPlanningTasks.length).toBeGreaterThanOrEqual(1);
		});

		it('should reject replan for planning tasks', async () => {
			const goal = await ctx.goalManager.createGoal({
				title: 'Plan something',
				description: '',
			});
			const planTask = await ctx.taskManager.createTask({
				title: 'Plan: Plan something',
				description: 'Break down the goal',
				taskType: 'planning',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, planTask.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			if (groups.length === 0) return; // Planning tasks go through spawnPlanningGroup

			const group = groups[0];
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const result = await ctx.runtime.handleLeaderTool(group.id, 'replan_goal', {
				reason: 'bad plan',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Cannot replan from a planning task');
		});

		it('should escalate when max planning attempts exceeded', async () => {
			const { goal, task1 } = await setupGoalWithMultipleTasks();
			// Set planning_attempts to MAX (3)
			await ctx.goalManager.incrementPlanningAttempts(goal.id);
			await ctx.goalManager.incrementPlanningAttempts(goal.id);
			await ctx.goalManager.incrementPlanningAttempts(goal.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			expect(groups).toHaveLength(1);
			const group = groups[0];

			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const result = await ctx.runtime.handleLeaderTool(group.id, 'replan_goal', {
				reason: 'Still failing',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Max planning attempts');

			// Task should still be failed
			const updatedTask = await ctx.taskManager.getTask(task1.id);
			expect(updatedTask!.status).toBe('failed');

			// Goal should be escalated to needs_human
			const updatedGoal = (await ctx.goalManager.listGoals())[0];
			expect(updatedGoal.status).toBe('needs_human');
		});

		it('should not replan if goal has no linked tasks (edge case)', async () => {
			await ctx.taskManager.createTask({
				title: 'Orphan task',
				description: 'Not linked to goal',
			});

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			if (groups.length === 0) return;

			const group = groups[0];
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const result = await ctx.runtime.handleLeaderTool(group.id, 'replan_goal', {
				reason: 'Need replan',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('No goal linked');
		});

		it('fail_task should NOT trigger automatic replanning', async () => {
			const { goal, task1, task2, task3 } = await setupGoalWithMultipleTasks();
			await ctx.goalManager.incrementPlanningAttempts(goal.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Leader calls fail_task (not replan_goal)
			await ctx.runtime.handleLeaderTool(group.id, 'fail_task', {
				reason: 'Cannot be done',
			});

			// Task should be failed
			expect((await ctx.taskManager.getTask(task1.id))!.status).toBe('failed');

			// But sibling tasks should still be pending (NOT cancelled by auto-replan)
			expect((await ctx.taskManager.getTask(task2.id))!.status).toBe('pending');
			expect((await ctx.taskManager.getTask(task3.id))!.status).toBe('pending');

			// No new planning group should have been spawned
			const allTasks = await ctx.taskManager.listTasks({});
			const planningTasks = allTasks.filter((t) => t.taskType === 'planning');
			expect(planningTasks).toHaveLength(0);
		});
	});
});
