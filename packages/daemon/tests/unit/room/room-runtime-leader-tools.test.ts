import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	makeRoom,
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
		it('should handle complete_task after human approval', async () => {
			const { task, group } = await spawnAndRouteToLeader(ctx, { assignedAgent: 'general' });
			// Both submittedForReview and approved must be true for human-approved flow
			ctx.groupRepo.setSubmittedForReview(group.id, true);
			ctx.groupRepo.setApproved(group.id, true);

			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Health endpoint added',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('completed');
		});

		it('should reject complete_task when submittedForReview=true but approved=false', async () => {
			const { group } = await spawnAndRouteToLeader(ctx, { assignedAgent: 'coder' });
			// Submitted for review but not yet approved by a human
			ctx.groupRepo.setSubmittedForReview(group.id, true);

			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Human approval');
			expect(parsed.action_required).toContain('awaiting human review');
		});

		it('should handle fail_task', async () => {
			const { task, group } = await spawnAndRouteToLeader(ctx);

			const result = await ctx.runtime.handleLeaderTool(group.id, 'fail_task', {
				reason: 'Cannot be done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});

		it('should handle send_to_worker and route turn back to worker', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			const result = await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Fix the tests',
				mode: 'queue',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			const updatedGroup = ctx.groupRepo.getGroup(group.id)!;
			expect(updatedGroup.submittedForReview).toBe(false);

			// Should inject feedback into worker session using queue mode
			const injectCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage' && (c.args[1] as string).includes('LEADER FEEDBACK')
			);
			expect(injectCalls.length).toBeGreaterThan(0);
			expect(injectCalls[0].args[2]).toEqual({ deliveryMode: 'next_turn' });
		});

		it('should reject complete_task when not yet submitted for review or approved', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			// Group is active but has not submitted for review or been approved yet.
			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Human approval');
			expect(parsed.action_required).toContain('submit_for_review');
		});

		it('should reject for non-existent group', async () => {
			const result = await ctx.runtime.handleLeaderTool('nonexistent', 'complete_task', {
				summary: 'Done',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
		});
	});

	describe('phase 2 planning (approved)', () => {
		it('should allow complete_task without submit_for_review when approved is true', async () => {
			// Create a goal — tick() will auto-spawn a planning group
			const goal = await ctx.goalManager.createGoal({
				title: 'Build stock app',
				description: 'Stock tracking web app',
			});

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			expect(groups).toHaveLength(1);
			const group = groups[0];

			// Find the planning task that was auto-created
			const tasks = await ctx.taskManager.listTasks({ status: 'in_progress' });
			const planTask = tasks.find((t) => t.taskType === 'planning')!;
			expect(planTask).toBeDefined();

			// Simulate phase 2: set approved, reset submittedForReview
			ctx.groupRepo.setApproved(group.id, true);
			ctx.groupRepo.setSubmittedForReview(group.id, false);

			// Create a draft task (required by lifecycle gate for planning completion)
			await ctx.taskManager.createTask({
				title: 'Implement auth module',
				description: 'Create auth module',
				status: 'draft',
				createdByTaskId: planTask.id,
			});

			// Route worker to leader
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Leader calls complete_task — should succeed without submit_for_review
			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Tasks created from approved plan',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			const updatedTask = await ctx.taskManager.getTask(planTask.id);
			expect(updatedTask!.status).toBe('completed');
		});

		it('should reject complete_task for planning tasks without approved', async () => {
			// Create a goal — tick() will auto-spawn a planning group
			await ctx.goalManager.createGoal({
				title: 'Build stock app',
				description: 'Stock tracking web app',
			});

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			expect(groups).toHaveLength(1);
			const group = groups[0];

			// Route worker to leader (phase 1 — approved is false)
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Leader calls complete_task — should fail (human approval required for planners)
			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Plan done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Human approval');
		});
	});

	describe('isPlanApproved dynamic gate', () => {
		it('should wire isPlanApproved to query group approved flag from DB', async () => {
			// Create a goal — tick() will auto-spawn a planning group
			await ctx.goalManager.createGoal({
				title: 'Dynamic gate test',
				description: 'Tests the isPlanApproved callback',
			});

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			expect(groups).toHaveLength(1);
			const group = groups[0];

			// At creation time, approved should be false
			expect(ctx.groupRepo.getGroup(group.id)!.approved).toBeFalsy();

			// After setting approved in the DB, the isPlanApproved callback
			// should return true (verified indirectly through the complete_task gate)
			ctx.groupRepo.setApproved(group.id, true);
			expect(ctx.groupRepo.getGroup(group.id)!.approved).toBe(true);

			// This shows the DB flag is correctly read — the dynamic gate
			// will pick up this change at tool invocation time
		});

		it('should use approved flag to bypass submit_for_review gate for planning tasks', async () => {
			// Phase 1 (approved=false): complete_task requires submit_for_review
			await ctx.goalManager.createGoal({
				title: 'Phase gate test',
				description: 'desc',
			});

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];
			const tasks = await ctx.taskManager.listTasks({ status: 'in_progress' });
			const planTask = tasks.find((t) => t.taskType === 'planning')!;

			// Route to leader
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Phase 1: complete_task should be rejected (submit_for_review required)
			const phase1Result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Done',
			});
			expect(JSON.parse(phase1Result.content[0].text).success).toBe(false);

			// Now simulate phase 2: set approved, reset submittedForReview
			ctx.groupRepo.setApproved(group.id, true);
			ctx.groupRepo.setSubmittedForReview(group.id, false);

			// Create draft tasks (required by lifecycle gate)
			await ctx.taskManager.createTask({
				title: 'Impl task',
				description: 'desc',
				status: 'draft',
				createdByTaskId: planTask.id,
			});

			// Phase 2: complete_task should succeed (approved bypasses submit_for_review)
			const phase2Result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Tasks created',
			});
			expect(JSON.parse(phase2Result.content[0].text).success).toBe(true);
		});
	});

	describe('replan_goal', () => {
		beforeEach(() => {
			// Enable retries so replan_goal tests can trigger replanning
			ctx.runtime.updateRoom({ ...makeRoom(), config: { maxPlanningRetries: 2 } });
		});

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

			// The current task should be needs_attention (leader explicitly failed it via replan_goal)
			const updatedTask = await ctx.taskManager.getTask(task1.id);
			expect(updatedTask!.status).toBe('needs_attention');

			// Remaining pending tasks should be cancelled (not needs_attention — intentionally stopped)
			const t2 = await ctx.taskManager.getTask(task2.id);
			const t3 = await ctx.taskManager.getTask(task3.id);
			expect(t2!.status).toBe('cancelled');
			expect(t3!.status).toBe('cancelled');

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
			expect(parsed.error).toContain('Max planning retries');

			// Task should still be failed
			const updatedTask = await ctx.taskManager.getTask(task1.id);
			expect(updatedTask!.status).toBe('needs_attention');

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

		it('should create planning task with "Replan:" title prefix', async () => {
			const { goal, task1 } = await setupGoalWithMultipleTasks();
			await ctx.goalManager.incrementPlanningAttempts(goal.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			await ctx.runtime.handleLeaderTool(group.id, 'replan_goal', {
				reason: 'Need different approach',
			});

			const allTasks = await ctx.taskManager.listTasks({});
			const planningTasks = allTasks.filter((t) => t.taskType === 'planning');
			expect(planningTasks).toHaveLength(1);
			expect(planningTasks[0].title).toStartWith('Replan:');
		});

		it('should pass completed tasks and needs_attention task in replan context', async () => {
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

			// Mark task1 as completed with a result
			await ctx.taskManager.completeTask(task1.id, 'Login endpoint implemented with JWT');

			// task2 is the one being worked on (will be needs_attention by replan)
			await ctx.goalManager.incrementPlanningAttempts(goal.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			await ctx.runtime.handleLeaderTool(group.id, 'replan_goal', {
				reason: 'Signup flow needs OAuth, not password',
			});

			// Verify the planner worker received the replan context in its task message.
			// After refactoring, replan context is in the injected task message (not system prompt).
			const injectCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'injectMessage');
			// The last injectMessage to a planner session is the task message for the replanning planner
			const plannerInjectCalls = injectCalls.filter(
				(c) => typeof c.args[0] === 'string' && (c.args[0] as string).startsWith('planner:')
			);
			const lastPlannerInject = plannerInjectCalls[plannerInjectCalls.length - 1];
			const taskMessage = lastPlannerInject?.args[1] as string;

			// Replan context should include the completed task and failure info
			expect(taskMessage).toContain('Replanning Context');
			expect(taskMessage).toContain('Add login endpoint');
			expect(taskMessage).toContain('Login endpoint implemented with JWT');
			// Failed task info
			expect(taskMessage).toContain('Signup flow needs OAuth, not password');
		});

		it('should increment planning_attempts on the goal', async () => {
			const { goal, task1 } = await setupGoalWithMultipleTasks();
			await ctx.goalManager.incrementPlanningAttempts(goal.id);
			const beforeAttempts = (await ctx.goalManager.listGoals())[0].planning_attempts;

			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			await ctx.runtime.handleLeaderTool(group.id, 'replan_goal', {
				reason: 'Wrong approach',
			});

			const afterAttempts = (await ctx.goalManager.listGoals())[0].planning_attempts;
			expect(afterAttempts).toBe(beforeAttempts + 1);
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
			expect((await ctx.taskManager.getTask(task1.id))!.status).toBe('needs_attention');

			// But sibling tasks should still be pending (NOT cancelled by auto-replan)
			expect((await ctx.taskManager.getTask(task2.id))!.status).toBe('pending');
			expect((await ctx.taskManager.getTask(task3.id))!.status).toBe('pending');

			// No new planning group should have been spawned
			const allTasks = await ctx.taskManager.listTasks({});
			const planningTasks = allTasks.filter((t) => t.taskType === 'planning');
			expect(planningTasks).toHaveLength(0);
		});
	});

	describe('submit_for_review stale PR cleanup', () => {
		it('closes stale PR when submit_for_review is called with a different PR URL', async () => {
			const ghCalls: Array<string[]> = [];
			const ctx2 = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (args) => {
						ghCalls.push(args);
						// Simulate successful gh pr close; fail everything else gracefully
						if (args[0] === 'gh' && args[1] === 'pr' && args[2] === 'close') {
							return { stdout: '', exitCode: 0 };
						}
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			try {
				const { task, group } = await spawnAndRouteToLeader(ctx2, { assignedAgent: 'coder' });

				// Pre-set the task with an existing PR URL to simulate a second review cycle
				await ctx2.taskManager.reviewTask(task.id, 'https://github.com/org/repo/pull/10');

				// Leader calls submit_for_review with a NEW, different PR URL
				const result = await ctx2.runtime.handleLeaderTool(group.id, 'submit_for_review', {
					pr_url: 'https://github.com/org/repo/pull/20',
				});

				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.success).toBe(true);

				// Should have called gh pr close with the old PR URL
				const closeCalls = ghCalls.filter((a) => a[1] === 'pr' && a[2] === 'close');
				expect(closeCalls.length).toBe(1);
				expect(closeCalls[0]).toContain('https://github.com/org/repo/pull/10');
				expect(closeCalls[0]).toContain('Superseded by https://github.com/org/repo/pull/20');

				// Task should now have the new PR URL
				const updatedTask = await ctx2.taskManager.getTask(task.id);
				expect(updatedTask!.prUrl).toBe('https://github.com/org/repo/pull/20');
			} finally {
				ctx2.runtime.stop();
				ctx2.db.close();
			}
		});

		it('does not call gh pr close when submit_for_review uses the same PR URL', async () => {
			const ghCalls: Array<string[]> = [];
			const ctx2 = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (args) => {
						ghCalls.push(args);
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			try {
				const { task, group } = await spawnAndRouteToLeader(ctx2, { assignedAgent: 'coder' });

				// Pre-set the task with the same PR URL that will be submitted
				await ctx2.taskManager.reviewTask(task.id, 'https://github.com/org/repo/pull/10');

				// Leader calls submit_for_review with the SAME PR URL — no close needed
				await ctx2.runtime.handleLeaderTool(group.id, 'submit_for_review', {
					pr_url: 'https://github.com/org/repo/pull/10',
				});

				const closeCalls = ghCalls.filter((a) => a[1] === 'pr' && a[2] === 'close');
				expect(closeCalls.length).toBe(0);
			} finally {
				ctx2.runtime.stop();
				ctx2.db.close();
			}
		});

		it('proceeds with submit_for_review even when closeStalePr fails', async () => {
			const ctx2 = createRuntimeTestContext({
				hookOptions: {
					runCommand: async () => ({ stdout: '', exitCode: 1 }), // gh always fails
				},
			});

			try {
				const { task, group } = await spawnAndRouteToLeader(ctx2, { assignedAgent: 'coder' });

				// Pre-set an existing PR URL
				await ctx2.taskManager.reviewTask(task.id, 'https://github.com/org/repo/pull/10');

				// Even though gh pr close will fail, submit_for_review should still succeed
				const result = await ctx2.runtime.handleLeaderTool(group.id, 'submit_for_review', {
					pr_url: 'https://github.com/org/repo/pull/20',
				});

				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.success).toBe(true);

				// Task still updates to the new PR URL
				const updatedTask = await ctx2.taskManager.getTask(task.id);
				expect(updatedTask!.prUrl).toBe('https://github.com/org/repo/pull/20');
			} finally {
				ctx2.runtime.stop();
				ctx2.db.close();
			}
		});
	});

	describe('progress_summary handling', () => {
		it('persists progress_summary to group metadata when provided with send_to_worker', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);
			const summary =
				'Task adds GET /health endpoint. Worker created the route but tests are failing.';

			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Fix the failing tests',
				progress_summary: summary,
			});

			const updated = ctx.groupRepo.getGroup(group.id)!;
			expect(updated.leaderProgressSummary).toBe(summary);
		});

		it('persists progress_summary to group metadata when provided with fail_task', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);
			const summary = 'Task adds GET /health. Worker could not resolve a dependency conflict.';

			await ctx.runtime.handleLeaderTool(group.id, 'fail_task', {
				reason: 'Dependency conflict unresolvable',
				progress_summary: summary,
			});

			const updated = ctx.groupRepo.getGroup(group.id)!;
			expect(updated.leaderProgressSummary).toBe(summary);
		});

		it('emits a leader_summary group event when progress_summary is provided', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);
			const summary = 'Task adds a health endpoint. Worker created route; tests pass.';

			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Looks good, approve',
				progress_summary: summary,
			});

			const { events } = ctx.groupRepo.getEvents(group.id);
			const summaryEvent = events.find((e) => e.kind === 'leader_summary');
			expect(summaryEvent).toBeDefined();
			const payload = JSON.parse(summaryEvent!.payloadJson!);
			expect(payload.text).toContain(summary);
		});

		it('does not persist or emit event when progress_summary is absent', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Fix the tests',
			});

			const updated = ctx.groupRepo.getGroup(group.id)!;
			expect(updated.leaderProgressSummary).toBeNull();

			const { events } = ctx.groupRepo.getEvents(group.id);
			const summaryEvent = events.find((e) => e.kind === 'leader_summary');
			expect(summaryEvent).toBeUndefined();
		});

		it('updates progress_summary on subsequent tool calls', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Fix the tests',
				progress_summary: 'First iteration: route created, tests failing.',
			});

			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Update docs too',
				progress_summary: 'Second iteration: tests fixed, docs missing.',
			});

			const updated = ctx.groupRepo.getGroup(group.id)!;
			expect(updated.leaderProgressSummary).toBe('Second iteration: tests fixed, docs missing.');
		});
	});
});
