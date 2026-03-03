import { describe, expect, it, test, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	spawnAndRouteToLeader,
	makeRoom,
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

	describe('lifecycle hooks', () => {
		test('bounces coder back when on base branch', async () => {
			// Hook: git returns 'main' as current branch → coder must be on a feature branch
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (args: string[], _cwd: string) => {
						const cmd = args.join(' ');
						if (cmd === 'git rev-parse --abbrev-ref HEAD') {
							return { stdout: 'main', exitCode: 0 };
						}
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			await createGoalAndTask(hookCtx, { assignedAgent: 'coder' });
			hookCtx.runtime.start();
			await hookCtx.runtime.tick();

			const groups = hookCtx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			await hookCtx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Worker should have been bounced back with feature-branch message
			const bounceCalls = hookCtx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.workerSessionId &&
					(c.args[1] as string).includes('feature branch')
			);
			expect(bounceCalls).toHaveLength(1);

			// Group stays in awaiting_worker
			const updated = hookCtx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('awaiting_worker');
		});

		test('bounces coder back when no PR exists', async () => {
			// Hook: branch is 'feat/test' but gh pr list returns empty array
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (args: string[], _cwd: string) => {
						const cmd = args.join(' ');
						if (cmd === 'git rev-parse --abbrev-ref HEAD') {
							return { stdout: 'feat/test', exitCode: 0 };
						}
						if (cmd.startsWith('gh pr list')) {
							return { stdout: '[]', exitCode: 0 };
						}
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			await createGoalAndTask(hookCtx, { assignedAgent: 'coder' });
			hookCtx.runtime.start();
			await hookCtx.runtime.tick();

			const groups = hookCtx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			await hookCtx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Worker should have been bounced back with PR creation message
			const bounceCalls = hookCtx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.workerSessionId &&
					(c.args[1] as string).includes('gh pr create')
			);
			expect(bounceCalls).toHaveLength(1);

			// Group stays in awaiting_worker
			const updated = hookCtx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('awaiting_worker');
		});

		test('rejects complete_task when no reviews and reviewers configured', async () => {
			// Room has reviewer sub-agents configured
			// Hook: branch is feature, PR exists but has 0 reviews
			const hookCtx = createRuntimeTestContext({
				room: {
					config: {
						agentSubagents: {
							leader: [{ model: 'claude-opus-4-6' }],
						},
					},
				},
				hookOptions: {
					runCommand: async (args: string[], _cwd: string) => {
						const cmd = args.join(' ');
						if (cmd === 'git rev-parse --abbrev-ref HEAD') {
							return { stdout: 'feat/test', exitCode: 0 };
						}
						if (cmd.startsWith('gh pr list')) {
							return { stdout: '[{"number":1,"url":"https://github.com/org/repo/pull/1"}]', exitCode: 0 };
						}
						if (cmd.startsWith('gh pr view') && cmd.includes('reviews')) {
							return { stdout: '0', exitCode: 0 };
						}
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			// Must be a coder task so the reviewer gate fires
			// Also pre-set submittedForReview so the state machine gate doesn't block first
			const { group } = await spawnAndRouteToLeader(hookCtx, { assignedAgent: 'coder' });
			hookCtx.groupRepo.setSubmittedForReview(group.id, true);

			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.action_required).toBeDefined();
			expect(typeof parsed.action_required).toBe('string');

			// Group stays in awaiting_leader — not completed
			const updated = hookCtx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('awaiting_leader');
		});

		test('allows complete_task when no reviewers configured', async () => {
			// All git/gh commands fail gracefully (exit 1), so all hooks pass
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => {
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await spawnAndRouteToLeader(hookCtx);

			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			const updated = hookCtx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('completed');
		});

		test('bounces planner back when no draft tasks created (phase 2)', async () => {
			// All git/gh commands fail (exit 1) — in phase 2 (planApproved=true),
			// the draft-tasks check matters for planners
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => {
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			// Create a goal with no tasks — tick will spawn a planning group
			await hookCtx.goalManager.createGoal({
				title: 'New Feature',
				description: 'Build something new',
			});

			hookCtx.runtime.start();
			await hookCtx.runtime.tick();

			const groups = hookCtx.groupRepo.getActiveGroups('room-1');
			expect(groups).toHaveLength(1);
			const group = groups[0];

			// Set planApproved=true to simulate phase 2 (after human approval)
			hookCtx.groupRepo.setPlanApproved(group.id, true);

			// Planner finishes without creating any draft tasks (draftTaskCount = 0)
			await hookCtx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Planner should be bounced with message about create_task
			const bounceCalls = hookCtx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.workerSessionId &&
					(c.args[1] as string).includes('create_task')
			);
			expect(bounceCalls).toHaveLength(1);

			// Group stays in awaiting_worker
			const updated = hookCtx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('awaiting_worker');
		});
	});

	describe('goal progress recalculation', () => {
		it('should recalculate goal progress when task progress is updated in onWorkerTerminalState', async () => {
			const { goal, task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			// Verify initial goal progress is 0
			const initialGoal = await ctx.goalManager.getGoal(goal.id);
			expect(initialGoal!.progress).toBe(0);

			// Worker finishes — runtime routes to leader and updates task progress
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Task progress should be non-zero (formula: iteration 1 → 20%)
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.progress).toBeGreaterThan(0);

			// Goal progress should be recalculated from the updated task progress
			const updatedGoal = await ctx.goalManager.getGoal(goal.id);
			expect(updatedGoal!.progress).toBe(updatedTask!.progress);
		});

		it('should recalculate goal progress to 100 when task is completed', async () => {
			const { goal } = await spawnAndRouteToLeader(ctx);

			const initialGoal = await ctx.goalManager.getGoal(goal.id);
			expect(initialGoal!.progress).toBeLessThan(100);

			// Leader completes the task
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];
			await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Task done',
			});

			// Goal progress should now be 100 (completed task = 100%)
			const updatedGoal = await ctx.goalManager.getGoal(goal.id);
			expect(updatedGoal!.progress).toBe(100);
		});

		it('should recalculate goal progress to 0 when task fails', async () => {
			const { goal } = await spawnAndRouteToLeader(ctx);

			// Leader fails the task
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];
			await ctx.runtime.handleLeaderTool(group.id, 'fail_task', {
				reason: 'Task could not be completed',
			});

			// Failed tasks contribute 0 to progress calculation
			const updatedGoal = await ctx.goalManager.getGoal(goal.id);
			expect(updatedGoal!.progress).toBe(0);
		});

		it('should recalculate goal progress when task is submitted for review', async () => {
			const { goal } = await spawnAndRouteToLeader(ctx);

			// Leader submits the task for review
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];
			await ctx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});

			// Goal progress should reflect the task's current progress after submit_for_review
			const updatedGoal = await ctx.goalManager.getGoal(goal.id);
			const updatedTask = await ctx.taskManager.getTask(group.taskId);
			// Task should now be in 'review' status
			expect(updatedTask!.status).toBe('review');
			// Goal progress should be consistent with task progress (not 100% since not completed)
			expect(updatedGoal!.progress).toBeLessThan(100);
			expect(updatedGoal!.progress).toBe(updatedTask!.progress ?? 0);
		});
	});

	describe('submit_for_review gate', () => {
		test('rejects submit_for_review when no PR exists for coder task', async () => {
			// Worker exit gate uses `--json number,url`; submit gate uses `--json number`.
			// We pass the worker exit gate (PR exists), then fail the submit gate (no PR).
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (args: string[], _cwd: string) => {
						const cmd = args.join(' ');
						if (cmd === 'git rev-parse --abbrev-ref HEAD') {
							return { stdout: 'feat/test', exitCode: 0 };
						}
						// Worker exit gate: checkPrExists uses --json number,url → return PR
						if (cmd.includes('--json number,url')) {
							return { stdout: '[{"number":1,"url":"https://github.com/org/repo/pull/1"}]', exitCode: 0 };
						}
						// Worker exit gate: checkPrSynced uses git rev-parse HEAD
						if (cmd === 'git rev-parse HEAD') {
							return { stdout: 'abc123', exitCode: 0 };
						}
						// Worker exit gate: checkPrSynced uses gh pr view --json headRefOid
						if (cmd.startsWith('gh pr view --json headRefOid')) {
							return { stdout: 'abc123', exitCode: 0 };
						}
						// Submit gate: checkLeaderPrExists uses --json number → return empty (no PR)
						if (cmd.includes('--json number')) {
							return { stdout: '[]', exitCode: 0 };
						}
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await spawnAndRouteToLeader(hookCtx, { assignedAgent: 'coder' });

			// Verify the group is in awaiting_leader (worker exit gate passed)
			expect(hookCtx.groupRepo.getGroup(group.id)!.state).toBe('awaiting_leader');

			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: '',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.action_required).toBeDefined();
			expect(typeof parsed.action_required).toBe('string');
			expect(parsed.action_required).toContain('send_to_worker');

			// Group stays in awaiting_leader — not submitted
			const updated = hookCtx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('awaiting_leader');
		});

		test('allows submit_for_review when PR exists for coder task', async () => {
			// Hook: branch is feat/test and PR exists
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (args: string[], _cwd: string) => {
						const cmd = args.join(' ');
						if (cmd === 'git rev-parse --abbrev-ref HEAD') {
							return { stdout: 'feat/test', exitCode: 0 };
						}
						if (cmd.startsWith('gh pr list')) {
							return { stdout: '[{"number":1}]', exitCode: 0 };
						}
						return { stdout: '', exitCode: 1 };
					},
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group, task } = await spawnAndRouteToLeader(hookCtx, { assignedAgent: 'coder' });

			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			// Group is awaiting_human (not completed) and task is in review
			const updatedGroup = hookCtx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.state).toBe('awaiting_human');
			expect(updatedGroup!.submittedForReview).toBe(true);
			const updatedTask = await hookCtx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('review');
		});
	});

	describe('state machine: submit_for_review → awaiting_human → complete_task', () => {
		test('complete_task is rejected for coder tasks without prior submit_for_review', async () => {
			const { group } = await spawnAndRouteToLeader(ctx, { assignedAgent: 'coder' });

			// Coder task: complete_task without submit_for_review should be rejected
			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Done',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('submit_for_review');
			expect(parsed.action_required).toBeDefined();

			// Group stays in awaiting_leader — not completed
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('awaiting_leader');
		});

		test('complete_task is allowed for coder tasks after submit_for_review', async () => {
			// Use a no-op hook context (all commands fail → gates pass by default)
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({ stdout: '', exitCode: 1 }),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await spawnAndRouteToLeader(hookCtx, { assignedAgent: 'coder' });

			// Step 1: submit_for_review → transitions to awaiting_human
			const submitResult = await hookCtx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});
			expect(JSON.parse(submitResult.content[0].text).success).toBe(true);
			expect(hookCtx.groupRepo.getGroup(group.id)!.state).toBe('awaiting_human');
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(true);

			// Step 2: human approves → resumeFromHuman transitions back to awaiting_leader
			const resumed = await hookCtx.runtime.resumeFromHuman(
				group.taskId,
				'Human approved. Call complete_task.'
			);
			expect(resumed).toBe(true);
			expect(hookCtx.groupRepo.getGroup(group.id)!.state).toBe('awaiting_leader');

			// Step 3: complete_task succeeds
			const completeResult = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Implemented and reviewed',
			});
			expect(JSON.parse(completeResult.content[0].text).success).toBe(true);
			expect(hookCtx.groupRepo.getGroup(group.id)!.state).toBe('completed');
		});

		test('complete_task is allowed for non-coder tasks without submit_for_review', async () => {
			// general tasks skip the submit_for_review gate
			const { group } = await spawnAndRouteToLeader(ctx);

			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'General task done',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);
			expect(ctx.groupRepo.getGroup(group.id)!.state).toBe('completed');
		});

		test('submit_for_review sets group state to awaiting_human', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({ stdout: '', exitCode: 1 }),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await spawnAndRouteToLeader(hookCtx, { assignedAgent: 'coder' });

			await hookCtx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});

			const updated = hookCtx.groupRepo.getGroup(group.id);
			expect(updated!.state).toBe('awaiting_human');
			expect(updated!.submittedForReview).toBe(true);
		});

		test('awaiting_human groups do not count toward maxConcurrentGroups', async () => {
			// Create a coder task and submit for review → slot freed
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({ stdout: '', exitCode: 1 }),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			// Two tasks: first is coder (high priority, will be submitted for review), second is general
			const goal = await hookCtx.goalManager.createGoal({ title: 'G', description: '' });
			const task1 = await hookCtx.taskManager.createTask({
				title: 'Coder task',
				description: 'desc',
				priority: 'high',
				assignedAgent: 'coder',
			});
			const task2 = await hookCtx.taskManager.createTask({
				title: 'General task',
				description: 'desc',
				priority: 'normal',
				assignedAgent: 'general',
			});
			await hookCtx.goalManager.linkTaskToGoal(goal.id, task1.id);
			await hookCtx.goalManager.linkTaskToGoal(goal.id, task2.id);

			hookCtx.runtime.start();
			await hookCtx.runtime.tick();

			// One group spawned (maxConcurrentGroups = 1), must be for task1
			const groups1 = hookCtx.groupRepo.getActiveGroups('room-1');
			expect(groups1).toHaveLength(1);
			const group1 = groups1[0];
			expect(group1.taskId).toBe(task1.id);

			// Route to leader
			await hookCtx.runtime.onWorkerTerminalState(group1.id, {
				sessionId: group1.workerSessionId,
				kind: 'idle',
			});

			// Leader submits for review → group goes to awaiting_human
			await hookCtx.runtime.handleLeaderTool(group1.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});
			expect(hookCtx.groupRepo.getGroup(group1.id)!.state).toBe('awaiting_human');

			// Tick should now pick up task2 (awaiting_human doesn't count against slot)
			await hookCtx.runtime.tick();
			const groups2 = hookCtx.groupRepo
				.getActiveGroups('room-1')
				.filter((g) => g.state !== 'awaiting_human');
			expect(groups2).toHaveLength(1);
			expect(groups2[0].taskId).toBe(task2.id);
		});

		test('resumeFromHuman returns false when group is not in awaiting_human', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			// Group is in awaiting_leader, not awaiting_human
			const result = await ctx.runtime.resumeFromHuman(group.taskId, 'some message');
			expect(result).toBe(false);
		});
	});

	describe('worktree isolation enforcement', () => {
		test('fails task when createWorktree returns null for coder role', async () => {
			// Create a context where createWorktree always returns null (simulating git failure)
			const isolCtx = createRuntimeTestContext();
			// Override createWorktree on the mock factory to simulate worktree creation failure
			(isolCtx.sessionFactory as { createWorktree: (b: string, s: string, branch?: string) => Promise<string | null> }).createWorktree =
				async (_basePath: string, _sessionId: string, _branchName?: string) => null;

			afterEach(() => {
				isolCtx.runtime.stop();
				isolCtx.db.close();
			});

			const { task } = await createGoalAndTask(isolCtx, { assignedAgent: 'coder' });
			isolCtx.runtime.start();

			// tick() spawns a coder group and spawn() throws on null worktree;
			// the runtime catches the error and the task is marked failed
			await isolCtx.runtime.tick();

			// Task should be failed with a worktree-related error
			const updatedTask = await isolCtx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('failed');
			expect(updatedTask!.error).toContain('worktree');
		});

		test('fails task when createWorktree returns null for planner role', async () => {
			// All roles now require an isolated worktree — planner tasks should also fail
			const isolCtx = createRuntimeTestContext();
			(isolCtx.sessionFactory as { createWorktree: (b: string, s: string, branch?: string) => Promise<string | null> }).createWorktree =
				async (_basePath: string, _sessionId: string, _branchName?: string) => null;

			afterEach(() => {
				isolCtx.runtime.stop();
				isolCtx.db.close();
			});

			// A goal with no tasks triggers planner spawn
			await isolCtx.goalManager.createGoal({
				title: 'New Feature',
				description: 'Plan it out',
			});
			isolCtx.runtime.start();
			await isolCtx.runtime.tick();

			// The planning task should have been created by spawnPlanningGroup and then failed
			// (worktree creation failure causes failTask() before the group is created)
			const allTasks = await isolCtx.taskManager.listTasks({ status: 'failed' });
			expect(allTasks.length).toBeGreaterThan(0);
			expect(allTasks[0].error).toContain('worktree');
		});

		test('fails task when createWorktree returns null for general role', async () => {
			// General tasks also require worktrees now
			const isolCtx = createRuntimeTestContext();
			(isolCtx.sessionFactory as { createWorktree: (b: string, s: string, branch?: string) => Promise<string | null> }).createWorktree =
				async (_basePath: string, _sessionId: string, _branchName?: string) => null;

			afterEach(() => {
				isolCtx.runtime.stop();
				isolCtx.db.close();
			});

			const { task } = await createGoalAndTask(isolCtx, { assignedAgent: 'general' });
			isolCtx.runtime.start();
			await isolCtx.runtime.tick();

			// Task should be failed with a worktree-related error
			const updatedTask = await isolCtx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('failed');
			expect(updatedTask!.error).toContain('worktree');
		});

		test('creates worktree with meaningful branch name derived from task title', async () => {
			const isolCtx = createRuntimeTestContext();
			const worktreeCalls: Array<{ basePath: string; sessionId: string; branchName?: string }> = [];
			(isolCtx.sessionFactory as { createWorktree: (b: string, s: string, branch?: string) => Promise<string | null> }).createWorktree =
				async (basePath: string, sessionId: string, branchName?: string) => {
					worktreeCalls.push({ basePath, sessionId, branchName });
					return `/tmp/worktrees/${sessionId}`;
				};

			afterEach(() => {
				isolCtx.runtime.stop();
				isolCtx.db.close();
			});

			// Task title "Add health check endpoint" → branch "task/add-health-check-endpoint"
			const goal = await isolCtx.goalManager.createGoal({ title: 'Goal', description: '' });
			const task = await isolCtx.taskManager.createTask({
				title: 'Add health check endpoint',
				description: 'GET /health returns 200',
				assignedAgent: 'coder',
			});
			await isolCtx.goalManager.linkTaskToGoal(goal.id, task.id);

			isolCtx.runtime.start();
			await isolCtx.runtime.tick();

			expect(worktreeCalls).toHaveLength(1);
			expect(worktreeCalls[0].branchName).toBe('task/add-health-check-endpoint');
		});
	});
});
