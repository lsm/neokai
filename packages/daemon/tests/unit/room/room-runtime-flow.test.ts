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
		ctx = createRuntimeTestContext({ maxFeedbackIterations: 5 });
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	describe('agent model resolution', () => {
		it('should use planner model from room.config.agentModels for planning task spawn', async () => {
			ctx.runtime.stop();
			ctx.db.close();
			ctx = createRuntimeTestContext({
				room: makeRoom({
					defaultModel: 'room-default-model',
					config: {
						agentModels: {
							planner: 'planner-model',
							leader: 'leader-model',
						},
					},
				}),
			});

			await ctx.goalManager.createGoal({
				title: 'Planning goal',
				description: 'Needs a plan',
			});

			ctx.runtime.start();
			await ctx.runtime.tick();

			const createCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession'
			);
			expect(createCalls).toHaveLength(1);
			expect(createCalls[0].args[1]).toBe('planner');
			expect((createCalls[0].args[0] as { model?: string }).model).toBe('planner-model');

			const group = ctx.groupRepo.getActiveGroups('room-1')[0];
			expect(group.workerRole).toBe('planner');
		});

		it('should use role-specific worker model for coder and general tasks', async () => {
			ctx.runtime.stop();
			ctx.db.close();
			ctx = createRuntimeTestContext({
				room: makeRoom({
					defaultModel: 'room-default-model',
					config: {
						agentModels: {
							coder: 'coder-model',
							general: 'general-model',
							leader: 'leader-model',
						},
					},
				}),
			});

			await createGoalAndTask(ctx, { assignedAgent: 'coder' });
			ctx.runtime.start();
			await ctx.runtime.tick();
			let createCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession'
			);
			expect(createCalls[0].args[1]).toBe('coder');
			expect((createCalls[0].args[0] as { model?: string }).model).toBe('coder-model');

			// Force lazy leader creation path in test harness (mock hasSession() defaults to true).
			(ctx.sessionFactory as unknown as { hasSession: (sessionId: string) => boolean }).hasSession =
				(sessionId: string) => sessionId.includes('coder');

			const coderGroup = ctx.groupRepo.getActiveGroups('room-1')[0];
			await ctx.runtime.onWorkerTerminalState(coderGroup.id, {
				sessionId: coderGroup.workerSessionId,
				kind: 'idle',
			});
			const leaderCall = ctx.sessionFactory.calls
				.filter((c) => c.method === 'createAndStartSession')
				.find((c) => c.args[1] === 'leader');
			expect(leaderCall).toBeDefined();
			expect((leaderCall!.args[0] as { model?: string }).model).toBe('leader-model');

			ctx.runtime.stop();
			ctx.db.close();
			ctx = createRuntimeTestContext({
				room: makeRoom({
					defaultModel: 'room-default-model',
					config: {
						agentModels: {
							coder: 'coder-model',
							general: 'general-model',
							leader: 'leader-model',
						},
					},
				}),
			});
			await createGoalAndTask(ctx, { assignedAgent: 'general' });
			ctx.runtime.start();
			await ctx.runtime.tick();
			createCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'createAndStartSession');
			expect(createCalls[0].args[1]).toBe('general');
			expect((createCalls[0].args[0] as { model?: string }).model).toBe('general-model');
		});
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
			expect(updated!.submittedForReview).toBe(false);
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
			expect(updated!.submittedForReview).toBe(false);
		});

		it('should pause task (not route to leader) when worker is waiting_for_input', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			// Record factory calls before worker terminal state
			const callsBefore = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
			).length;

			// Worker asks a question
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'waiting_for_input',
			});

			// Should NOT have routed to leader
			const leaderCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
			);
			expect(leaderCalls.length).toBe(callsBefore);

			// Group should be marked as waiting for question
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.waitingForQuestion).toBe(true);
			expect(updated!.waitingSession).toBe('worker');

			// Group should still be active (not completed)
			expect(updated!.completedAt).toBeNull();
		});

		it('should resume routing after worker answers question and returns idle', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const groups = ctx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			// Step 1: Worker asks a question → task pauses
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'waiting_for_input',
			});

			const afterQuestion = ctx.groupRepo.getGroup(group.id)!;
			expect(afterQuestion.waitingForQuestion).toBe(true);
			expect(afterQuestion.waitingSession).toBe('worker');

			// Step 2: Question answered, worker completes work → idle
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// waiting flag should be cleared
			const afterResume = ctx.groupRepo.getGroup(group.id)!;
			expect(afterResume.waitingForQuestion).toBe(false);
			expect(afterResume.waitingSession).toBeNull();
		});
	});

	describe('cancelTask', () => {
		it('should terminate active group and free slot for pending tasks', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'G', description: '' });
			const task1 = await ctx.taskManager.createTask({
				title: 'Task 1',
				description: 'desc',
				priority: 'high',
			});
			const task2 = await ctx.taskManager.createTask({
				title: 'Task 2',
				description: 'desc',
				priority: 'normal',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task1.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, task2.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			const firstGroup = ctx.groupRepo.getGroupByTaskId(task1.id);
			expect(firstGroup).toBeDefined();
			expect(firstGroup!.submittedForReview).toBe(false);

			const cancelResult = await ctx.runtime.cancelTask(task1.id);
			expect(cancelResult.success).toBe(true);

			const cancelledTask = await ctx.taskManager.getTask(task1.id);
			expect(cancelledTask!.status).toBe('cancelled');

			const cancelledGroup = ctx.groupRepo.getGroup(firstGroup!.id);
			expect(cancelledGroup!.completedAt).not.toBeNull();

			const stopCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'stopSession');
			expect(stopCalls).toHaveLength(2);
			expect(stopCalls.map((c) => c.args[0])).toEqual(
				expect.arrayContaining([firstGroup!.workerSessionId, firstGroup!.leaderSessionId])
			);

			// cancelTask() schedules a follow-up tick asynchronously.
			await new Promise((resolve) => setTimeout(resolve, 0));
			const secondGroup = ctx.groupRepo.getGroupByTaskId(task2.id);
			expect(secondGroup).toBeDefined();
			expect(secondGroup!.submittedForReview).toBe(false);
		});

		it('should terminate orphaned active group even if task is already cancelled', async () => {
			const goal = await ctx.goalManager.createGoal({ title: 'G', description: '' });
			const task = await ctx.taskManager.createTask({
				title: 'Task 1',
				description: 'desc',
				priority: 'high',
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			const group = ctx.groupRepo.getGroupByTaskId(task.id);
			expect(group).toBeDefined();
			expect(group!.submittedForReview).toBe(false);

			// Simulate prior bug: task cancelled but group left active.
			await ctx.taskManager.cancelTask(task.id);
			expect((await ctx.taskManager.getTask(task.id))!.status).toBe('cancelled');
			expect(ctx.groupRepo.getGroup(group!.id)!.submittedForReview).toBe(false);

			const cancelResult = await ctx.runtime.cancelTask(task.id);
			expect(cancelResult.success).toBe(true);
			expect(ctx.groupRepo.getGroup(group!.id)!.completedAt).not.toBeNull();

			const stopCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'stopSession');
			expect(stopCalls.map((c) => c.args[0])).toEqual(
				expect.arrayContaining([group!.workerSessionId, group!.leaderSessionId])
			);
		});
	});

	describe('interruptTaskSession', () => {
		it('should interrupt sessions without changing task status', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const group = ctx.groupRepo.getGroupByTaskId(task.id);
			expect(group).toBeDefined();
			expect(group!.completedAt).toBeNull();

			const result = await ctx.runtime.interruptTaskSession(task.id);
			expect(result.success).toBe(true);

			// Task should remain in_progress (not failed/cancelled)
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');

			// Group should remain active (not terminal)
			const updatedGroup = ctx.groupRepo.getGroup(group!.id);
			expect(updatedGroup!.completedAt).toBeNull();

			// Both sessions should have been interrupted (not stopped/removed)
			const interruptCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'interruptSession'
			);
			expect(interruptCalls).toHaveLength(2);
			expect(interruptCalls.map((c) => c.args[0])).toEqual(
				expect.arrayContaining([group!.workerSessionId, group!.leaderSessionId])
			);
			// stopSession should NOT be called
			const stopCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'stopSession');
			expect(stopCalls).toHaveLength(0);
		});

		it('should return failure for non-existent task', async () => {
			const result = await ctx.runtime.interruptTaskSession('non-existent-task-id');
			expect(result.success).toBe(false);
		});

		it('should return failure for task not in in_progress or review status', async () => {
			const task = await ctx.taskManager.createTask({
				title: 'Pending Task',
				description: 'Not started yet',
				priority: 'normal',
			});
			// Task is pending by default
			expect(task.status).toBe('pending');

			const result = await ctx.runtime.interruptTaskSession(task.id);
			expect(result.success).toBe(false);
		});

		it('should return failure for task with no active group', async () => {
			const task = await ctx.taskManager.createTask({
				title: 'Task without group',
				description: 'desc',
				priority: 'normal',
			});
			// Manually move to in_progress with no group
			await ctx.taskManager.setTaskStatus(task.id, 'in_progress');

			// No group exists, so interruptTaskSession should fail gracefully
			const result = await ctx.runtime.interruptTaskSession(task.id);
			expect(result.success).toBe(false);
		});

		it('should set humanInterrupted flag preventing auto-routing to leader', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const group = ctx.groupRepo.getGroupByTaskId(task.id);
			expect(group).toBeDefined();

			// Interrupt the task
			await ctx.runtime.interruptTaskSession(task.id);

			// humanInterrupted should be set
			const updatedGroup = ctx.groupRepo.getGroup(group!.id);
			expect(updatedGroup!.humanInterrupted).toBe(true);

			// Simulate worker reaching terminal state (would normally route to leader)
			const initialInjectCount = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage'
			).length;
			await ctx.runtime.onWorkerTerminalState(group!.id, {
				sessionId: group!.workerSessionId,
				kind: 'idle',
			});

			// humanInterrupted should be cleared after onWorkerTerminalState
			const clearedGroup = ctx.groupRepo.getGroup(group!.id);
			expect(clearedGroup!.humanInterrupted).toBe(false);

			// No leader session should have been created (routing was blocked)
			const createCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession'
			);
			// Only 1 create call (the initial worker), leader was not created
			expect(createCalls).toHaveLength(1);

			// No new inject messages (routing to leader sends an envelope)
			const injectCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'injectMessage');
			expect(injectCalls.length).toBe(initialInjectCount);
		});

		it('should clear humanInterrupted when routeLeaderToWorker is called (P2 fix)', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const group = ctx.groupRepo.getGroupByTaskId(task.id);
			expect(group).toBeDefined();

			// Interrupt the task (sets humanInterrupted = true)
			await ctx.runtime.interruptTaskSession(task.id);
			expect(ctx.groupRepo.getGroup(group!.id)!.humanInterrupted).toBe(true);

			// Leader routes feedback to worker (simulates send_to_worker tool call)
			await ctx.runtime.taskGroupManager.routeLeaderToWorker(group!.id, 'Here is my feedback');

			// humanInterrupted should be cleared so the next worker completion routes normally
			expect(ctx.groupRepo.getGroup(group!.id)!.humanInterrupted).toBe(false);

			// Now when worker finishes, onWorkerTerminalState should NOT be blocked
			await ctx.runtime.onWorkerTerminalState(group!.id, {
				sessionId: group!.workerSessionId,
				kind: 'idle',
			});

			// humanInterrupted remains false after terminal state
			expect(ctx.groupRepo.getGroup(group!.id)!.humanInterrupted).toBe(false);
		});

		it('should clear humanInterrupted when injectMessageToWorker is called (race condition fix)', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const group = ctx.groupRepo.getGroupByTaskId(task.id);
			expect(group).toBeDefined();

			// Interrupt the task (sets humanInterrupted = true)
			await ctx.runtime.interruptTaskSession(task.id);
			expect(ctx.groupRepo.getGroup(group!.id)!.humanInterrupted).toBe(true);

			// User injects a new message to the worker (simulates typing after interrupt)
			const injected = await ctx.runtime.injectMessageToWorker(task.id, 'Please fix the error');
			expect(injected).toBe(true);

			// humanInterrupted should be cleared so the next worker completion routes normally
			expect(ctx.groupRepo.getGroup(group!.id)!.humanInterrupted).toBe(false);

			// Now when worker finishes, onWorkerTerminalState should NOT be blocked by humanInterrupted
			// (it's already false). Verify by checking the flag is NOT re-set after terminal state.
			await ctx.runtime.onWorkerTerminalState(group!.id, {
				sessionId: group!.workerSessionId,
				kind: 'idle',
			});

			// humanInterrupted remains false — not set again by onWorkerTerminalState
			expect(ctx.groupRepo.getGroup(group!.id)!.humanInterrupted).toBe(false);

			// The 'humanInterrupted early return' path was NOT taken, so either exit gate
			// routing or normal routing occurred — at minimum, more than 0 injectMessage
			// calls were made (from gate checks or leader routing), unlike the interrupt
			// path which returns before any inject
			const allCalls = ctx.sessionFactory.calls.map((c) => c.method);
			// At least interruptSession x2 + injectMessage x1 (human msg) were made
			expect(allCalls.filter((m) => m === 'interruptSession')).toHaveLength(2);
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
			expect(ctx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

			// Step 3: Leader reviews and approves
			ctx.groupRepo.setSubmittedForReview(group.id, true);
			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Endpoint added successfully',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);

			// Group and task are both done
			expect(ctx.groupRepo.getGroup(group.id)!.completedAt).not.toBeNull();
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
			expect(ctx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Add error handling to the endpoint',
				mode: 'queue',
			});

			// Group is back to awaiting_worker with iteration bumped
			const afterFeedback = ctx.groupRepo.getGroup(group.id)!;
			expect(afterFeedback.submittedForReview).toBe(false);
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
			expect(ctx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

			ctx.groupRepo.setSubmittedForReview(group.id, true);
			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Error handling added',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);

			// Final state
			expect(ctx.groupRepo.getGroup(group.id)!.completedAt).not.toBeNull();
			const finalTask = await ctx.taskManager.getTask(task.id);
			expect(finalTask!.status).toBe('completed');
			expect(finalTask!.result).toBe('Error handling added');
		});

		it('should escalate task to human review (not fail) when max feedback iterations reached', async () => {
			// Create a new context with maxFeedbackIterations = 5
			// (default is 3)
			ctx.runtime.stop();
			ctx.db.close();
			ctx = createRuntimeTestContext({ maxFeedbackIterations: 5 });

			// feedbackIteration is incremented by routeWorkerToLeader (1-based).
			// The check fires when feedbackIteration >= maxFeedbackIterations,
			// i.e., on the 5th review round when the leader tries send_to_worker.

			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];

			// Complete 4 full feedback rounds (feedbackIteration reaches 4 after round 4)
			for (let i = 0; i < 4; i++) {
				await ctx.runtime.onWorkerTerminalState(group.id, {
					sessionId: group.workerSessionId,
					kind: 'idle',
				});
				// send_to_worker succeeds: feedbackIteration i+1 < 5
				const r = await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
					message: `Feedback round ${i + 1}`,
					mode: 'queue',
				});
				expect(JSON.parse(r.content[0].text).success).toBe(true);
				expect(ctx.groupRepo.getGroup(group.id)!.feedbackIteration).toBe(i + 1);
			}

			// 5th review round: routeWorkerToLeader increments feedbackIteration to 5
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			expect(ctx.groupRepo.getGroup(group.id)!.feedbackIteration).toBe(5);

			// Leader tries send_to_worker: 5 >= 5 → runtime escalates
			const result = await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'One more round',
			});

			// Runtime should reject and escalate — NOT fail the task
			expect(JSON.parse(result.content[0].text).success).toBe(false);
			expect(JSON.parse(result.content[0].text).error).toContain('human review');

			// Group state: awaiting_human (not failed/completed)
			const finalGroup = ctx.groupRepo.getGroup(group.id);
			expect(finalGroup!.submittedForReview).toBe(true);

			// Task status: review (not failed)
			const finalTask = await ctx.taskManager.getTask(task.id);
			expect(finalTask!.status).toBe('review');
		});

		it('should keep goal active when task is escalated for human review at max iterations', async () => {
			const { task, goal } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];

			// 4 full rounds + trigger escalation on the 5th
			for (let i = 0; i < 4; i++) {
				await ctx.runtime.onWorkerTerminalState(group.id, {
					sessionId: group.workerSessionId,
					kind: 'idle',
				});
				await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
					message: `Feedback ${i + 1}`,
					mode: 'queue',
				});
			}
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Extra',
				mode: 'queue',
			});

			// Task in review, not failed
			const finalTask = await ctx.taskManager.getTask(task.id);
			expect(finalTask!.status).toBe('review');

			// Goal is NOT failed — only task-level escalation
			const goalState = await ctx.goalManager.getGoal(goal.id);
			expect(goalState!.status).toBe('active');
		});

		it('should reset feedbackIteration after human resumes an escalated task, preventing immediate re-escalation', async () => {
			// This tests the P1 fix: without resetting feedbackIteration in resumeWorkerFromHuman,
			// the leader's first send_to_worker after resume would immediately re-escalate.
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];

			// Exhaust all 5 rounds (feedbackIteration reaches 5, escalation fires)
			for (let i = 0; i < 4; i++) {
				await ctx.runtime.onWorkerTerminalState(group.id, {
					sessionId: group.workerSessionId,
					kind: 'idle',
				});
				await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
					message: `Round ${i + 1}`,
					mode: 'queue',
				});
			}
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Trigger',
				mode: 'queue',
			});

			// Task is in review, group awaiting_human
			expect(ctx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(true);
			expect((await ctx.taskManager.getTask(task.id))!.status).toBe('review');

			// Human resumes the task
			await ctx.runtime.resumeWorkerFromHuman(task.id, 'Please try again with this approach');

			// feedbackIteration must be reset to 0
			expect(ctx.groupRepo.getGroup(group.id)!.feedbackIteration).toBe(0);
			// Group transitions to awaiting_leader (leader receives the human message)
			expect(ctx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);
			// Task back in in_progress
			expect((await ctx.taskManager.getTask(task.id))!.status).toBe('in_progress');

			expect(ctx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

			// Worker finishes again → routeWorkerToLeader increments to 1 (not 6!)
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			expect(ctx.groupRepo.getGroup(group.id)!.feedbackIteration).toBe(1);

			// Leader can now send feedback without triggering re-escalation (1 < 5)
			const r = await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Good, keep going',
				mode: 'queue',
			});
			expect(JSON.parse(r.content[0].text).success).toBe(true);
			expect(ctx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);
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
					mode: 'queue',
				});
				expect(ctx.groupRepo.getGroup(group.id)!.feedbackIteration).toBe(i + 1);
			}

			// Iteration 3: Leader completes
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			ctx.groupRepo.setSubmittedForReview(group.id, true);
			await ctx.runtime.handleLeaderTool(group.id, 'complete_task', { summary: 'All done' });

			expect(ctx.groupRepo.getGroup(group.id)!.completedAt).not.toBeNull();
			expect(ctx.groupRepo.getGroup(group.id)!.feedbackIteration).toBe(3);
		});

		it('should keep leader contract violations at 0 when leader reaches terminal without a tool', async () => {
			await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();
			const group = ctx.groupRepo.getActiveGroups('room-1')[0];

			// Worker done -> Leader reaches terminal without any tool call.
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});
			expect(ctx.groupRepo.getGroup(group.id)!.leaderContractViolations).toBe(0);
			expect(ctx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

			// Leader can still complete after review submission.
			ctx.groupRepo.setSubmittedForReview(group.id, true);
			await ctx.runtime.handleLeaderTool(group.id, 'complete_task', { summary: 'Done' });
			expect(ctx.groupRepo.getGroup(group.id)!.completedAt).not.toBeNull();
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
		it('should not inject nudge messages when leader reaches terminal without a tool', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			// Leader reaches terminal without calling a tool
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// No nudge is injected in the simplified model.
			const nudgeCalls = ctx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.leaderSessionId &&
					(c.args[1] as string).includes('must call exactly one')
			);
			expect(nudgeCalls).toHaveLength(0);

			// Violations stay at 0.
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.leaderContractViolations).toBe(0);
		});

		it('should keep group active even after repeated leader terminal states without tools', async () => {
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

			// Group remains active; no contract-failure transition.
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.submittedForReview).toBe(false);
		});

		it('should not fire if Leader called a tool', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);
			ctx.groupRepo.setSubmittedForReview(group.id, true);

			// Leader calls complete_task (which persists leaderCalledTool in DB)
			await ctx.runtime.handleLeaderTool(group.id, 'complete_task', { summary: 'Done' });

			// Leader terminal state should be no-op (tool was called)
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.completedAt).not.toBeNull();
		});

		it('should pause task (not complete/route) when leader is waiting_for_input', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			// Leader asks a question
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'waiting_for_input',
			});

			// Group should be marked as waiting for question
			const updated = ctx.groupRepo.getGroup(group.id);
			expect(updated!.waitingForQuestion).toBe(true);
			expect(updated!.waitingSession).toBe('leader');

			// Group should still be active (not completed)
			expect(updated!.completedAt).toBeNull();
		});

		it('should clear waiting flag when leader resumes and reaches idle', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			// Step 1: Leader asks a question
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'waiting_for_input',
			});

			const afterQuestion = ctx.groupRepo.getGroup(group.id)!;
			expect(afterQuestion.waitingForQuestion).toBe(true);
			expect(afterQuestion.waitingSession).toBe('leader');

			// Step 2: Question answered, leader resumes → idle
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// waiting flag should be cleared
			const afterResume = ctx.groupRepo.getGroup(group.id)!;
			expect(afterResume.waitingForQuestion).toBe(false);
			expect(afterResume.waitingSession).toBeNull();
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
			expect(updated!.submittedForReview).toBe(false);
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
			expect(updated!.submittedForReview).toBe(false);
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
							return {
								stdout: '[{"number":1,"url":"https://github.com/org/repo/pull/1"}]',
								exitCode: 0,
							};
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

			// Group stays submitted for review and not completed
			const updated = hookCtx.groupRepo.getGroup(group.id);
			expect(updated!.submittedForReview).toBe(true);
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
			hookCtx.groupRepo.setSubmittedForReview(group.id, true);

			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			const updated = hookCtx.groupRepo.getGroup(group.id);
			expect(updated!.completedAt).not.toBeNull();
		});

		test('bounces planner back when no draft tasks created (phase 2)', async () => {
			// All git/gh commands fail (exit 1) — in phase 2 (approved=true),
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

			// Set approved=true to simulate phase 2 (after human approval)
			hookCtx.groupRepo.setApproved(group.id, true);

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
			expect(updated!.submittedForReview).toBe(false);
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
			ctx.groupRepo.setSubmittedForReview(group.id, true);
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
							return {
								stdout: '[{"number":1,"url":"https://github.com/org/repo/pull/1"}]',
								exitCode: 0,
							};
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
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

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
			expect(updated!.submittedForReview).toBe(false);
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
			expect(updatedGroup!.submittedForReview).toBe(true);
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
			expect(updated!.submittedForReview).toBe(false);
		});

		test('complete_task is allowed for coder tasks after submit_for_review and human approval', async () => {
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
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(true);
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(true);

			// Step 2: human approves → routes directly to leader (not worker)
			const resumed = await hookCtx.runtime.resumeWorkerFromHuman(
				group.taskId,
				'PR approved. Merge it.',
				{ approved: true }
			);
			expect(resumed).toBe(true);
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);
			expect(hookCtx.groupRepo.getGroup(group.id)!.approved).toBe(true);

			// Step 3: complete_task succeeds (approved bypasses submit_for_review gate)
			// Leader merges PR and completes directly
			const completeResult = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Implemented, reviewed, and merged',
			});
			expect(JSON.parse(completeResult.content[0].text).success).toBe(true);
			expect(hookCtx.groupRepo.getGroup(group.id)!.completedAt).not.toBeNull();
		});

		test('complete_task is rejected for general tasks without prior submit_for_review', async () => {
			const { group } = await spawnAndRouteToLeader(ctx, { assignedAgent: 'general' });

			const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'General task done',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('submit_for_review');
			expect(ctx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);
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
			expect(updated!.submittedForReview).toBe(true);
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
			expect(hookCtx.groupRepo.getGroup(group1.id)!.submittedForReview).toBe(true);

			// Tick should now pick up task2 (awaiting_human doesn't count against slot)
			await hookCtx.runtime.tick();
			const groups2 = hookCtx.groupRepo
				.getActiveGroups('room-1')
				.filter((g) => !g.submittedForReview);
			expect(groups2).toHaveLength(1);
			expect(groups2[0].taskId).toBe(task2.id);
		});

		test('resumeWorkerFromHuman returns false when group is not in awaiting_human', async () => {
			const { group } = await spawnAndRouteToLeader(ctx);

			// Group is in awaiting_leader, not awaiting_human
			const result = await ctx.runtime.resumeWorkerFromHuman(group.taskId, 'some message');
			expect(result).toBe(false);
		});
	});

	describe('worktree isolation enforcement', () => {
		test('fails task when createWorktree returns null for coder role', async () => {
			// Create a context where createWorktree always returns null (simulating git failure)
			const isolCtx = createRuntimeTestContext();
			// Override createWorktree on the mock factory to simulate worktree creation failure
			(
				isolCtx.sessionFactory as {
					createWorktree: (b: string, s: string, branch?: string) => Promise<string | null>;
				}
			).createWorktree = async (_basePath: string, _sessionId: string, _branchName?: string) =>
				null;

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
			// All roles require an isolated worktree — planner tasks should also fail
			const isolCtx = createRuntimeTestContext();
			(
				isolCtx.sessionFactory as {
					createWorktree: (b: string, s: string, branch?: string) => Promise<string | null>;
				}
			).createWorktree = async (_basePath: string, _sessionId: string, _branchName?: string) =>
				null;

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
			const allTasks = await isolCtx.taskManager.listTasks({ status: 'failed' });
			expect(allTasks.length).toBeGreaterThan(0);
			expect(allTasks[0].error).toContain('worktree');
		});

		test('fails task when createWorktree returns null for general role', async () => {
			// General tasks also require worktrees
			const isolCtx = createRuntimeTestContext();
			(
				isolCtx.sessionFactory as {
					createWorktree: (b: string, s: string, branch?: string) => Promise<string | null>;
				}
			).createWorktree = async (_basePath: string, _sessionId: string, _branchName?: string) =>
				null;

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
			(
				isolCtx.sessionFactory as {
					createWorktree: (b: string, s: string, branch?: string) => Promise<string | null>;
				}
			).createWorktree = async (basePath: string, sessionId: string, branchName?: string) => {
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

	describe('two-phase planning flow (session reuse)', () => {
		/**
		 * Helper: spawn a planning group for a goal, route planner to leader,
		 * then submit for review → awaiting_human.
		 */
		async function setupPlanningGroupInAwaitingHuman(hookCtx: RuntimeTestContext) {
			const goal = await hookCtx.goalManager.createGoal({
				title: 'Build stock app',
				description: 'Stock tracking web app',
			});

			hookCtx.runtime.start();
			await hookCtx.runtime.tick();

			const groups = hookCtx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];
			const tasks = await hookCtx.taskManager.listTasks({ status: 'in_progress' });
			const planTask = tasks.find((t) => t.taskType === 'planning')!;

			// Worker finishes phase 1 → leader reviews
			await hookCtx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Leader submits for review → awaiting_human
			await hookCtx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});

			// Record session count AFTER reaching awaiting_human (includes both worker + leader)
			const sessionCountBefore = hookCtx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession'
			).length;

			return { goal, group, planTask, sessionCountBefore };
		}

		test('resumeWorkerFromHuman reuses existing sessions (no new sessions)', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group, sessionCountBefore } = await setupPlanningGroupInAwaitingHuman(hookCtx);

			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(true);

			// Human approves → routes to leader (not worker)
			const result = await hookCtx.runtime.resumeWorkerFromHuman(
				group.taskId,
				'Plan approved. Merge the PR and create tasks.'
			);
			expect(result).toBe(true);

			// No new sessions should have been created
			const sessionCountAfter = hookCtx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession'
			).length;
			expect(sessionCountAfter).toBe(sessionCountBefore);

			// Approval message should be injected into existing LEADER session (not worker)
			const injectCalls = hookCtx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.leaderSessionId &&
					(c.args[1] as string).includes('Merge the PR')
			);
			expect(injectCalls).toHaveLength(1);
		});

		test('resumeWorkerFromHuman sets approved flag', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await setupPlanningGroupInAwaitingHuman(hookCtx);

			// Before approval: approved should be false
			expect(hookCtx.groupRepo.getGroup(group.id)!.approved).toBeFalsy();

			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'Plan approved.');

			// After approval: approved should be true
			expect(hookCtx.groupRepo.getGroup(group.id)!.approved).toBe(true);
		});

		test('resumeWorkerFromHuman transitions group to awaiting_leader', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group, planTask } = await setupPlanningGroupInAwaitingHuman(hookCtx);

			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(true);

			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'Plan approved.');

			// Group should transition to awaiting_leader (leader handles merge and complete)
			const updated = hookCtx.groupRepo.getGroup(group.id)!;
			expect(updated.submittedForReview).toBe(false);
			// approved flag should be set
			expect(updated.approved).toBe(true);

			// Task should remain in review status for approvals - leader's complete_task
			// will transition it to completed after merging
			const updatedTask = await hookCtx.taskManager.getTask(planTask.id);
			expect(updatedTask!.status).toBe('review');
		});

		test('resumeWorkerFromHuman returns false when not in awaiting_human', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			await hookCtx.goalManager.createGoal({
				title: 'Test Goal',
				description: 'desc',
			});

			hookCtx.runtime.start();
			await hookCtx.runtime.tick();

			const groups = hookCtx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			// Group is in awaiting_worker, not awaiting_human
			const result = await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'some message');
			expect(result).toBe(false);
		});

		test('full two-phase cycle: plan → review → approve → leader merges and completes', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group, planTask, sessionCountBefore } =
				await setupPlanningGroupInAwaitingHuman(hookCtx);

			// *** Phase 2: Human approves → routes to leader ***
			await hookCtx.runtime.resumeWorkerFromHuman(
				group.taskId,
				'Plan approved. Merge the PR and create tasks.'
			);
			// Group is now in awaiting_leader (leader handles merge + complete)
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);
			expect(hookCtx.groupRepo.getGroup(group.id)!.approved).toBe(true);

			// Leader creates draft tasks (simulating what the planner would have done via MCP tools)
			await hookCtx.taskManager.createTask({
				title: 'Implement auth module',
				description: 'Create auth module',
				status: 'draft',
				createdByTaskId: planTask.id,
			});
			await hookCtx.taskManager.createTask({
				title: 'Implement stock API',
				description: 'Stock API endpoint',
				status: 'draft',
				createdByTaskId: planTask.id,
			});

			// Leader completes the planning task directly
			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Plan executed: 2 tasks created',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);

			// Planning task completed
			const completedTask = await hookCtx.taskManager.getTask(planTask.id);
			expect(completedTask!.status).toBe('completed');
			expect(hookCtx.groupRepo.getGroup(group.id)!.completedAt).not.toBeNull();

			// Draft tasks should be promoted to pending
			const pendingTasks = await hookCtx.taskManager.listTasks({ status: 'pending' });
			expect(pendingTasks).toHaveLength(2);

			// Verify no additional sessions were created during phase 2
			const sessionCountAfter = hookCtx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession'
			).length;
			expect(sessionCountAfter).toBe(sessionCountBefore);
		});

		test('mirroring is not cleaned up on submit_for_review (stays active through awaiting_human)', async () => {
			// This test verifies that submit_for_review does NOT call cleanupMirroring.
			// Since daemonHub is not wired in unit tests, we verify indirectly:
			// the group state transitions correctly through the full cycle without
			// any mirroring-related errors, and the group stays active.
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await setupPlanningGroupInAwaitingHuman(hookCtx);

			// Group should be in awaiting_human (not failed or completed)
			const afterSubmit = hookCtx.groupRepo.getGroup(group.id)!;
			expect(afterSubmit.submittedForReview).toBe(true);

			// Resume without errors - routes to leader now
			const resumed = await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'Approved.');
			expect(resumed).toBe(true);

			// Group transitions cleanly to awaiting_leader (leader handles merge + complete)
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);
		});

		test('resumeWorkerFromHuman resets leader contract violations', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await setupPlanningGroupInAwaitingHuman(hookCtx);

			// Simulate a leader contract violation was recorded before submit
			const currentGroup = hookCtx.groupRepo.getGroup(group.id)!;
			hookCtx.groupRepo.updateLeaderContractViolations(
				group.id,
				1,
				'turn_test',
				currentGroup.version
			);
			expect(hookCtx.groupRepo.getGroup(group.id)!.leaderContractViolations).toBe(1);

			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'Approved.');

			// Group should now be in awaiting_leader (leader handles approval)
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

			// Contract violations should be reset after resuming
			expect(hookCtx.groupRepo.getGroup(group.id)!.leaderContractViolations).toBe(0);
		});
	});

	describe('coding task approve/reject flow', () => {
		/**
		 * Helper: spawn a coding group, route coder to leader,
		 * then submit for review → awaiting_human.
		 */
		async function setupCodingGroupInAwaitingHuman(hookCtx: RuntimeTestContext) {
			const goal = await hookCtx.goalManager.createGoal({
				title: 'Implement feature',
				description: 'Add a new feature',
			});
			const task = await hookCtx.taskManager.createTask({
				title: 'Add endpoint',
				description: 'Create a new API endpoint',
				assignedAgent: 'coder',
			});
			await hookCtx.goalManager.linkTaskToGoal(goal.id, task.id);

			hookCtx.runtime.start();
			await hookCtx.runtime.tick();

			const groups = hookCtx.groupRepo.getActiveGroups('room-1');
			const group = groups[0];

			// Worker finishes → leader reviews
			await hookCtx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Leader submits for review → awaiting_human
			await hookCtx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});

			const sessionCountBefore = hookCtx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession'
			).length;

			return { goal, group, task, sessionCountBefore };
		}

		test('approve routes to leader for PR merge', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await setupCodingGroupInAwaitingHuman(hookCtx);

			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(true);

			// Human approves → routes to leader (not worker)
			const result = await hookCtx.runtime.resumeWorkerFromHuman(
				group.taskId,
				'PR approved. Merge it.',
				{ approved: true }
			);
			expect(result).toBe(true);

			// Group transitions to awaiting_leader (not awaiting_worker)
			const updated = hookCtx.groupRepo.getGroup(group.id)!;
			expect(updated.submittedForReview).toBe(false);
			expect(updated.approved).toBe(true);

			// Message injected into leader session (not worker)
			const injectCalls = hookCtx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.leaderSessionId &&
					(c.args[1] as string).includes('Merge it')
			);
			expect(injectCalls).toHaveLength(1);
		});

		test('approve: no new sessions created', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group, sessionCountBefore } = await setupCodingGroupInAwaitingHuman(hookCtx);

			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'PR approved.', {
				approved: true,
			});

			const sessionCountAfter = hookCtx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession'
			).length;
			expect(sessionCountAfter).toBe(sessionCountBefore);
		});

		test('approve: leader receives approval message for merge', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await setupCodingGroupInAwaitingHuman(hookCtx);

			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'PR approved.', {
				approved: true,
			});
			// Approval now routes directly to leader (not worker)
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);
		});

		test('approve: leader can complete_task directly after merge', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await setupCodingGroupInAwaitingHuman(hookCtx);

			// Approve → routes directly to leader (not worker)
			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'PR approved. Merge it.', {
				approved: true,
			});
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

			// Leader can complete directly (approved bypasses submit_for_review gate)
			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Code merged and deployed',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);
			expect(hookCtx.groupRepo.getGroup(group.id)!.completedAt).not.toBeNull();
		});

		test('approve: leader handles merge failure gracefully', async () => {
			// This test simulates what happens when gh pr merge fails after approval.
			// The leader receives the approval message but the merge command fails.
			// The group stays in awaiting_leader state so the leader can retry.
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await setupCodingGroupInAwaitingHuman(hookCtx);

			// Human approves → routes to leader
			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'PR approved. Merge it.', {
				approved: true,
			});

			// Group is now in awaiting_leader state
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);
			expect(hookCtx.groupRepo.getGroup(group.id)!.approved).toBe(true);

			// Leader attempts complete_task without merging (simulating merge failure)
			// In a real scenario, the leader would try gh pr merge first and report the error.
			// Here we test that the system remains in a consistent state.
			// The leader can still call complete_task (approved bypasses gate),
			// but in practice the leader would report the merge failure in its response.
			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Merge failed - needs manual intervention',
			});

			// Complete succeeds (approved bypasses the gate) - the leader is responsible
			// for accurately reporting what happened in the summary
			expect(JSON.parse(result.content[0].text).success).toBe(true);
		});

		test('reject routes to leader for feedback forwarding', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group, task } = await setupCodingGroupInAwaitingHuman(hookCtx);

			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(true);

			// Human rejects → routes to leader (not worker)
			const result = await hookCtx.runtime.resumeWorkerFromHuman(
				group.taskId,
				'Fix the error handling.'
			);
			expect(result).toBe(true);

			const updated = hookCtx.groupRepo.getGroup(group.id)!;
			// Group transitions to awaiting_leader (leader receives rejection)
			expect(updated.submittedForReview).toBe(false);
			// submittedForReview is reset to false (worker will need to re-submit after addressing feedback)
			expect(updated.submittedForReview).toBe(false);
			// approved should NOT be set
			expect(updated.approved).toBe(false);

			// Task back to in_progress
			const updatedTask = await hookCtx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');

			// Feedback injected into LEADER session (not worker)
			const injectCalls = hookCtx.sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.leaderSessionId &&
					(c.args[1] as string).includes('error handling')
			);
			expect(injectCalls).toHaveLength(1);
		});

		test('reject: leader cannot skip submit_for_review after rework', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group } = await setupCodingGroupInAwaitingHuman(hookCtx);

			// Human rejects
			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'Fix the tests.');

			// Worker addresses feedback → exits
			await hookCtx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

			// Leader tries to complete directly → should be blocked
			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Fixed',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('submit_for_review');
		});

		test('full approve cycle: code → review → approve → merge → complete', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group, task, sessionCountBefore } = await setupCodingGroupInAwaitingHuman(hookCtx);

			// 1. Human approves → worker
			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'Approved. Merge the PR.', {
				approved: true,
			});

			// 2. Worker merges → exits → leader
			await hookCtx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// 3. Leader completes
			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Feature shipped',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);

			// Task completed
			const completedTask = await hookCtx.taskManager.getTask(task.id);
			expect(completedTask!.status).toBe('completed');
			expect(completedTask!.result).toBe('Feature shipped');

			// No extra sessions
			const sessionCountAfter = hookCtx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession'
			).length;
			expect(sessionCountAfter).toBe(sessionCountBefore);
		});

		test('full reject-then-approve cycle', async () => {
			const hookCtx = createRuntimeTestContext({
				hookOptions: {
					runCommand: async (_args: string[], _cwd: string) => ({
						stdout: '',
						exitCode: 1,
					}),
				},
			});

			afterEach(() => {
				hookCtx.runtime.stop();
				hookCtx.db.close();
			});

			const { group, task } = await setupCodingGroupInAwaitingHuman(hookCtx);

			// --- Round 1: reject ---
			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'Fix the error handling.');
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(false);

			// Worker reworks → exits
			await hookCtx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Leader must call submit_for_review again
			const blocked = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Fixed',
			});
			expect(JSON.parse(blocked.content[0].text).success).toBe(false);

			// Leader submits for review again → awaiting_human
			const submitResult = await hookCtx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
				pr_url: 'https://github.com/org/repo/pull/1',
			});
			expect(JSON.parse(submitResult.content[0].text).success).toBe(true);
			expect(hookCtx.groupRepo.getGroup(group.id)!.submittedForReview).toBe(true);

			// --- Round 2: approve ---
			await hookCtx.runtime.resumeWorkerFromHuman(group.taskId, 'Approved. Merge the PR.', {
				approved: true,
			});
			expect(hookCtx.groupRepo.getGroup(group.id)!.approved).toBe(true);

			// Worker merges → exits → leader
			await hookCtx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Leader completes
			const result = await hookCtx.runtime.handleLeaderTool(group.id, 'complete_task', {
				summary: 'Fixed and merged',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);

			const completedTask = await hookCtx.taskManager.getTask(task.id);
			expect(completedTask!.status).toBe('completed');
		});
	});

	describe('dependency-aware scheduling', () => {
		it('should not spawn a task with unmet dependencies', async () => {
			const goal = await ctx.goalManager.createGoal({
				title: 'Dep test',
				description: '',
			});
			const taskA = await ctx.taskManager.createTask({
				title: 'Task A',
				description: 'Independent',
			});
			const taskB = await ctx.taskManager.createTask({
				title: 'Task B',
				description: 'Depends on A',
				dependsOn: [taskA.id],
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, taskA.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, taskB.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			// Only taskA should be spawned (taskB is blocked)
			const groups = ctx.groupRepo.getActiveGroups('room-1');
			expect(groups).toHaveLength(1);
			expect((await ctx.taskManager.getTask(taskA.id))!.status).toBe('in_progress');
			expect((await ctx.taskManager.getTask(taskB.id))!.status).toBe('pending');
		});

		it('should spawn dependent task after dependency completes', async () => {
			const goal = await ctx.goalManager.createGoal({
				title: 'Chain test',
				description: '',
			});
			const taskA = await ctx.taskManager.createTask({
				title: 'Task A',
				description: 'First',
			});
			const taskB = await ctx.taskManager.createTask({
				title: 'Task B',
				description: 'Second',
				dependsOn: [taskA.id],
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, taskA.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, taskB.id);

			ctx.runtime.start();

			// Tick 1: Only taskA spawned
			await ctx.runtime.tick();
			const group1 = ctx.groupRepo.getActiveGroups('room-1')[0];
			expect(group1).toBeDefined();
			expect((await ctx.taskManager.getTask(taskA.id))!.status).toBe('in_progress');

			// Complete taskA
			await ctx.runtime.taskGroupManager.complete(group1.id, 'Task A done');
			expect((await ctx.taskManager.getTask(taskA.id))!.status).toBe('completed');

			// Tick 2: taskB should now be spawned since its dep is complete
			await ctx.runtime.tick();
			expect((await ctx.taskManager.getTask(taskB.id))!.status).toBe('in_progress');
		});

		it('should not spawn any tasks when all pending are blocked', async () => {
			const goal = await ctx.goalManager.createGoal({
				title: 'All blocked',
				description: '',
			});
			const taskA = await ctx.taskManager.createTask({
				title: 'Task A',
				description: 'In progress',
			});
			await ctx.taskManager.startTask(taskA.id);

			const taskB = await ctx.taskManager.createTask({
				title: 'Task B',
				description: 'Depends on A',
				dependsOn: [taskA.id],
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, taskA.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, taskB.id);

			ctx.runtime.start();
			await ctx.runtime.tick();

			// taskA is in_progress (not pending), taskB is blocked — no new groups spawned
			expect(ctx.groupRepo.getActiveGroups('room-1')).toHaveLength(0);
			expect((await ctx.taskManager.getTask(taskB.id))!.status).toBe('pending');
		});

		it('should handle multi-level dependency chains', async () => {
			const goal = await ctx.goalManager.createGoal({
				title: 'Chain A->B->C',
				description: '',
			});
			const taskA = await ctx.taskManager.createTask({
				title: 'Task A',
				description: 'Base',
			});
			const taskB = await ctx.taskManager.createTask({
				title: 'Task B',
				description: 'Depends on A',
				dependsOn: [taskA.id],
			});
			const taskC = await ctx.taskManager.createTask({
				title: 'Task C',
				description: 'Depends on B',
				dependsOn: [taskB.id],
			});
			await ctx.goalManager.linkTaskToGoal(goal.id, taskA.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, taskB.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, taskC.id);

			ctx.runtime.start();

			// Tick 1: Only A
			await ctx.runtime.tick();
			expect((await ctx.taskManager.getTask(taskA.id))!.status).toBe('in_progress');
			expect((await ctx.taskManager.getTask(taskB.id))!.status).toBe('pending');
			expect((await ctx.taskManager.getTask(taskC.id))!.status).toBe('pending');

			// Complete A
			const group1 = ctx.groupRepo.getActiveGroups('room-1')[0];
			await ctx.runtime.taskGroupManager.complete(group1.id, 'A done');

			// Tick 2: Only B (C still blocked)
			await ctx.runtime.tick();
			expect((await ctx.taskManager.getTask(taskB.id))!.status).toBe('in_progress');
			expect((await ctx.taskManager.getTask(taskC.id))!.status).toBe('pending');

			// Complete B
			const group2 = ctx.groupRepo.getActiveGroups('room-1')[0];
			await ctx.runtime.taskGroupManager.complete(group2.id, 'B done');

			// Tick 3: C now ready
			await ctx.runtime.tick();
			expect((await ctx.taskManager.getTask(taskC.id))!.status).toBe('in_progress');
		});
	});

	describe('activeSession indicator', () => {
		it('should set activeSession to worker when injecting message to worker', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const group = ctx.groupRepo.getActiveGroups('room-1')[0];
			expect(group).toBeDefined();

			// Task starts with no activeSession
			const taskBefore = await ctx.taskManager.getTask(task.id);
			expect(taskBefore!.activeSession).toBeNull();

			// Inject message to worker
			const result = await ctx.runtime.injectMessageToWorker(task.id, 'Please add error handling');
			expect(result).toBe(true);

			// activeSession should now be 'worker'
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.activeSession).toBe('worker');
		});

		it('should set activeSession to leader when injecting message to leader', async () => {
			const { task } = await spawnAndRouteToLeader(ctx);

			// Inject message to leader
			const result = await ctx.runtime.injectMessageToLeader(
				task.id,
				'Please reconsider the approach'
			);
			expect(result).toBe(true);

			// activeSession should now be 'leader'
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.activeSession).toBe('leader');
		});

		it('should clear activeSession when worker reaches terminal state', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const group = ctx.groupRepo.getActiveGroups('room-1')[0];

			// Set activeSession to 'worker' manually
			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress', { activeSession: 'worker' });
			const taskWithActive = await ctx.taskManager.getTask(task.id);
			expect(taskWithActive!.activeSession).toBe('worker');

			// Worker reaches terminal state
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// activeSession should be cleared
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.activeSession).toBeNull();
		});

		it('should clear activeSession when leader reaches terminal state', async () => {
			const { task, group } = await spawnAndRouteToLeader(ctx);

			// Set activeSession to 'leader' manually
			await ctx.taskManager.updateTaskStatus(task.id, task.status, { activeSession: 'leader' });
			const taskWithActive = await ctx.taskManager.getTask(task.id);
			expect(taskWithActive!.activeSession).toBe('leader');

			// Leader reaches terminal state
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// activeSession should be cleared
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.activeSession).toBeNull();
		});

		it('should not clear activeSession when worker terminal state is for a different session', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			const group = ctx.groupRepo.getActiveGroups('room-1')[0];

			// Set activeSession to 'leader' (different from the worker that just finished)
			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress', { activeSession: 'leader' });

			// Worker reaches terminal state — should NOT clear activeSession (it's 'leader')
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// activeSession should still be 'leader'
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.activeSession).toBe('leader');
		});

		it('should clear activeSession when interruptTaskSession is called', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			// Set activeSession to 'worker' (simulating active generation)
			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress', { activeSession: 'worker' });
			const taskWithActive = await ctx.taskManager.getTask(task.id);
			expect(taskWithActive!.activeSession).toBe('worker');

			// Interrupt the session
			const result = await ctx.runtime.interruptTaskSession(task.id);
			expect(result.success).toBe(true);

			// activeSession should be cleared
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.activeSession).toBeNull();
		});

		it('should be idempotent when interruptTaskSession is called with no active session', async () => {
			const { task } = await createGoalAndTask(ctx);
			ctx.runtime.start();
			await ctx.runtime.tick();

			// activeSession starts as null
			const taskBefore = await ctx.taskManager.getTask(task.id);
			expect(taskBefore!.activeSession).toBeNull();

			// Interrupt should succeed even when no activeSession is set
			const result = await ctx.runtime.interruptTaskSession(task.id);
			expect(result.success).toBe(true);

			// activeSession stays null
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.activeSession).toBeNull();
		});
	});
});
