import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	spawnAndRouteToLeader,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

describe('RoomRuntime flow', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	describe('onWorkerTerminalState', () => {
		it('should route worker output to leader', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Group should transition to awaiting_leader
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('awaiting_leader');
		});

		it('should ignore if group not in awaiting_worker', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			// Route to leader first
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Try again - should be idempotent (now in awaiting_leader)
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Still awaiting_leader, no error
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('awaiting_leader');
		});
	});

	describe('autonomous flow integration', () => {
		it('should complete the full single-iteration cycle: spawn → worker done → leader completes', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();

			// Step 1: tick spawns the group
			await ctx.runtime.tick();
			const groups = ctx.groupRepo.getActiveGroups('room-1');
			expect(groups).toHaveLength(1);
			const group = groups[0];

			// Step 2: Worker finishes — runtime routes output to Leader
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('awaiting_leader');

			// Step 3: Leader reviews and approves
			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Endpoint added successfully',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);

			// Group and task are both done
			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('completed');
			expect((await ctx.taskManager.getTask(task.id))!.status).toBe('completed');

			// Tick should not spawn a new group (no more pending tasks)
			ctx.sessionFactory.calls.length = 0;
			await ctx.runtime.tick();
			expect(
				ctx.sessionFactory.calls.filter((c) => c.method === 'createAndStartSession')
			).toHaveLength(0);
		});

		it('should complete the full two-iteration feedback cycle', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();

			// Spawn
			await ctx.runtime.tick();
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];
			expect(group.feedbackIteration).toBe(0);

			// Iteration 1: Worker done → Leader sends feedback
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('awaiting_leader');

			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Add error handling to the endpoint',
			});

			// Group is back to awaiting_worker with iteration bumped
			const afterFeedback = ctx.groupRepo.getGroup(group.id)!;
			expect(afterFeedback.state).toBe('awaiting_worker');
			expect(afterFeedback.feedbackIteration).toBe(1);

			// Feedback message was injected into Worker
			const feedbackInjects = ctx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.workerSessionId &&
					(c.args[1] as string).includes('LEADER FEEDBACK')
			);
			expect(feedbackInjects).toHaveLength(1);

			// Iteration 2: Worker finishes again → Leader completes
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('awaiting_leader');

			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Error handling added',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);

			// Final state
			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('completed');
			const finalTask = await ctx.taskManager.getTask(task.id);
			expect(finalTask!.status).toBe('completed');
			expect(finalTask!.result).toBe('Error handling added');
		});

		it('should complete a three-iteration cycle and track feedback iterations accurately', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];

			// Iterations 1 and 2: Leader sends feedback each time
			for (let i = 0; i < 2; i++) {
				await ctx.runtime.onWorkerTerminalState(group.id, {
					sessionId: group.workerSessionId,
					kind: 'idle',
				});
				await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
					message: `Feedback round ${i + 1}`,
				});
				expect(ctx.groupRepo.getGroup(group.id)!.feedbackIteration).toBe(i + 1);
			}

			// Iteration 3: Leader completes
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			await ctx.runtime.handleLeaderTool(group.id, 'complete_task', { summary: 'All done' });

			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('completed');
			expect(ctx.groupRepo.getGroup(group.id)!.feedbackIteration).toBe(3);
		});

		it('should reset leader contract violations on each new worker→leader round', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];

			// Worker done → Leader violates contract once
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});
			expect(ctx.groupRepo.getGroup(group.id)!.leaderContractViolations).toBe(1);

			// Leader sends feedback — group goes back to awaiting_worker
			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', { message: 'Redo this' });
			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('awaiting_worker');

			// Iteration 2: Worker done → routeWorkerToLeader resets violations to 0
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			expect(ctx.groupRepo.getGroup(group.id)!.leaderContractViolations).toBe(0);
			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('awaiting_leader');

			// Leader finishes cleanly
			await ctx.runtime.handleLeaderTool(group.id, 'complete_task', { summary: 'Done' });
			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('completed');
		});

		it('should spawn the next pending task after first group completes', async () => {
			// Create two tasks under the same goal
			const goal = await ctx.goalManager.createGoal({ title: 'Sprint 1', description: '' });
			const task1 = await ctx.taskManager.createTask({
				title: 'Task 1',
				description: 'First',
				priority: 'high',
			});
			const task2 = await ctx.taskManager.createTask({
				title: 'Task 2',
				description: 'Second',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task1.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, task2.id);

			ctx.runtime.start();

			// Tick 1: picks up task1 (maxConcurrentGroups = 1)
			await ctx.runtime.tick();
			const group1 = ctx.groupRepo.getActiveGroups('room-1')[0];
			expect(group1).toBeDefined();

			// Complete group1 directly via taskGroupManager
			await ctx.runtime.taskGroupManager.complete(group1.id, 'Task 1 done');
			expect((await ctx.taskManager.getTask(task1.id))!.status).toBe('completed');
			expect(ctx.groupRepo.getActiveGroups('room-1')).toHaveLength(0);

			// Tick 2: picks up task2 now that slot is free
			await ctx.runtime.tick();
			expect(ctx.groupRepo.getActiveGroups('room-1')).toHaveLength(1);
			expect(ctx.groupRepo.getActiveGroups('room-1')[0].id).not.toBe(group1.id);
			expect((await ctx.taskManager.getTask(task2.id))!.status).toBe('in_progress');
		});
	});

	describe('onLeaderTerminalState (contract validation)', () => {
		it('should nudge on first contract violation', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			// Leader reaches terminal without calling a tool
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// Should inject nudge message
			const nudgeCalls = ctx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.leaderSessionId &&
					(c.args[1] as string).includes('must call exactly one')
			);
			expect(nudgeCalls).toHaveLength(1);

			// Violations should be 1
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.leaderContractViolations).toBe(1);
		});

		it('should fail group on second contract violation', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			// First violation
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// Second violation
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// Group should be failed after second contract violation
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('failed');
		});

		it('should not fire if Leader called a tool', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			// Leader calls complete_task (which persists leaderCalledTool in DB)
			await ctx.runtime.handleLeaderTool(group.id, 'complete_task', { summary: 'Done' });

			// Leader terminal state should be no-op (tool was called)
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('completed');
		});
	});
});
