/**
 * Tests for planning task recovery fixes.
 *
 * Covers all 5 fixes from the "Fix planning task recovery" task:
 *
 * Fix 1: Default maxPlanningAttempts = 2 (allows 1 retry)
 * Fix 2: HTTP 400 treated as recoverable (bounce) for planner workers
 * Fix 3: Promote draft tasks when planning task fails with terminal error
 * Fix 4: Auto-recover needs_human goals with only failed planning tasks
 * Fix 5: Auto-detect plan PR merge for stuck submitted_for_review planning groups
 */

import { describe, expect, it, afterEach, beforeEach } from 'bun:test';
import { createRuntimeTestContext, type RuntimeTestContext } from './room-runtime-test-helpers';
import { getEffectiveMaxPlanningAttempts } from '../../../../src/storage/repositories/goal-repository';
import type { RoomGoal } from '@neokai/shared';

// ─── Fix 1: Default maxPlanningAttempts ─────────────────────────────────────

describe('Fix 1: getEffectiveMaxPlanningAttempts defaults to 2', () => {
	it('returns 2 when no per-goal or room-level override is set', () => {
		const goal = {
			id: 'g1',
			maxPlanningAttempts: 0, // DB default — not a real override
		} as unknown as RoomGoal;
		const result = getEffectiveMaxPlanningAttempts(goal, {});
		expect(result).toBe(2);
	});

	it('returns 2 when maxPlanningAttempts is 0 (DB default sentinel) and no room config', () => {
		const goal = { id: 'g1', maxPlanningAttempts: 0 } as unknown as RoomGoal;
		expect(getEffectiveMaxPlanningAttempts(goal)).toBe(2);
	});

	it('respects per-goal override when set to a positive integer', () => {
		const goal = { id: 'g1', maxPlanningAttempts: 5 } as unknown as RoomGoal;
		expect(getEffectiveMaxPlanningAttempts(goal)).toBe(5);
	});

	it('respects room-level maxPlanningRetries (N retries → N+1 total)', () => {
		const goal = { id: 'g1', maxPlanningAttempts: 0 } as unknown as RoomGoal;
		expect(getEffectiveMaxPlanningAttempts(goal, { maxPlanningRetries: 3 })).toBe(4);
	});

	it('per-goal override takes precedence over room-level config', () => {
		const goal = { id: 'g1', maxPlanningAttempts: 3 } as unknown as RoomGoal;
		expect(getEffectiveMaxPlanningAttempts(goal, { maxPlanningRetries: 10 })).toBe(3);
	});
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorkerMessage(text: string) {
	return { id: 'msg-1', text, toolCallNames: [] };
}

/**
 * Create a goal, let the runtime spawn a planning group, and return the group + planning task.
 * After this call the runtime has a planner group with workerRole='planner' in awaiting_worker state.
 */
async function setupPlannerGroup(ctx: RuntimeTestContext) {
	const goal = await ctx.goalManager.createGoal({
		title: 'Build feature X',
		description: 'Implement feature X end-to-end',
	});
	ctx.runtime.start();
	await ctx.runtime.tick();

	const groups = ctx.groupRepo.getActiveGroups('room-1');
	const group = groups[0];
	if (!group) throw new Error('No group spawned after tick');

	// The planning task was created by spawnPlanningGroup
	const planningTask = await ctx.taskManager.getTask(group.taskId);
	if (!planningTask) throw new Error('No planning task found');

	return { goal, group, planningTask };
}

// ─── Fix 2: Planner HTTP 400 bounces instead of failing ─────────────────────

describe('Fix 2: Planner HTTP 400 treated as recoverable (bounce)', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('bounces planner worker on HTTP 400 instead of failing the task', async () => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [
				makeWorkerMessage('API Error: 400 {"error":{"message":"prompt too long for model"}}'),
			],
		});

		const { group, planningTask } = await setupPlannerGroup(ctx);
		expect(group.workerRole).toBe('planner');

		// Capture call count before invoking the terminal state handler
		const callsBefore = ctx.sessionFactory.calls.length;

		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		// Task should NOT be failed — it should still be in_progress (bounce keeps it alive)
		const updatedTask = await ctx.taskManager.getTask(planningTask.id);
		expect(updatedTask!.status).not.toBe('needs_attention');

		// A NEW injectMessage call should have been made after onWorkerTerminalState (bounce message)
		const newCalls = ctx.sessionFactory.calls.slice(callsBefore);
		const injectCall = newCalls.find(
			(c) => c.method === 'injectMessage' && c.args[0] === group.workerSessionId
		);
		expect(injectCall).toBeDefined();
		expect(String(injectCall!.args[1])).toContain('HTTP 400');
	});

	it('does NOT bounce non-planner workers on HTTP 400 (general/coder still fail)', async () => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [
				makeWorkerMessage('API Error: 400 {"error":{"message":"bad request"}}'),
			],
		});

		const g = await ctx.goalManager.createGoal({ title: 'G', description: 'D' });
		const task = await ctx.taskManager.createTask({
			title: 'Task',
			description: 'Desc',
			assignedAgent: 'general',
		});
		await ctx.goalManager.linkTaskToGoal(g.id, task.id);

		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];
		expect(group.workerRole).toBe('general');

		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		// Non-planner workers should still fail immediately on 400
		const updatedTask = await ctx.taskManager.getTask(task.id);
		expect(updatedTask!.status).toBe('needs_attention');
	});

	it('does NOT bounce planner on other terminal errors (e.g., 401)', async () => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [
				makeWorkerMessage('API Error: 401 {"error":{"message":"Unauthorized"}}'),
			],
		});

		const { group, planningTask } = await setupPlannerGroup(ctx);

		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		// 401 is not recoverable even for planners — task should fail
		const updatedTask = await ctx.taskManager.getTask(planningTask.id);
		expect(updatedTask!.status).toBe('needs_attention');
	});

	it('falls through to fail after dead loop is detected for planner HTTP 400', async () => {
		// Configure dead loop to trigger after 2 failures (very low threshold for testing)
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [
				makeWorkerMessage('API Error: 400 {"error":{"message":"context too large"}}'),
			],
		});

		const { group, planningTask } = await setupPlannerGroup(ctx);

		// First call — should bounce
		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});
		const taskAfterFirst = await ctx.taskManager.getTask(planningTask.id);
		expect(taskAfterFirst!.status).not.toBe('needs_attention');

		// Eventually dead loop fires (default is 5 consecutive failures within 10 min).
		// Simulate enough calls to trigger dead loop by calling many times.
		for (let i = 0; i < 10; i++) {
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});
		}

		// After dead loop, task should eventually fail
		const taskAfterLoop = await ctx.taskManager.getTask(planningTask.id);
		expect(taskAfterLoop!.status).toBe('needs_attention');
	});
});

// ─── Fix 3: Promote draft tasks when planning task fails ─────────────────────

describe('Fix 3: Draft tasks promoted when planning task fails with terminal error', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('promotes draft tasks to pending before failing planning task on terminal error (401)', async () => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [
				makeWorkerMessage('API Error: 401 {"error":{"message":"Unauthorized"}}'),
			],
		});

		const { group, planningTask, goal } = await setupPlannerGroup(ctx);

		// Create draft tasks as if the planner already made progress in Phase 2
		const draftTask1 = await ctx.taskManager.createTask({
			title: 'Draft subtask 1',
			description: 'Was created by planner before crash',
			status: 'draft',
			createdByTaskId: planningTask.id,
			taskType: 'coding',
		});
		const draftTask2 = await ctx.taskManager.createTask({
			title: 'Draft subtask 2',
			description: 'Was created by planner before crash',
			status: 'draft',
			createdByTaskId: planningTask.id,
			taskType: 'coding',
		});
		// Link draft tasks to goal
		await ctx.goalManager.linkTaskToGoal(goal.id, draftTask1.id);
		await ctx.goalManager.linkTaskToGoal(goal.id, draftTask2.id);

		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		// Planning task should be failed
		const updatedPlanning = await ctx.taskManager.getTask(planningTask.id);
		expect(updatedPlanning!.status).toBe('needs_attention');

		// Draft tasks should be promoted to pending (not lost)
		const updatedDraft1 = await ctx.taskManager.getTask(draftTask1.id);
		const updatedDraft2 = await ctx.taskManager.getTask(draftTask2.id);
		expect(updatedDraft1!.status).toBe('pending');
		expect(updatedDraft2!.status).toBe('pending');
	});

	it('does not fail for planning task with no drafts (no-op)', async () => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [
				makeWorkerMessage('API Error: 422 {"error":{"message":"Validation error"}}'),
			],
		});

		const { group, planningTask } = await setupPlannerGroup(ctx);

		// No draft tasks created — should not throw
		await expect(
			ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			})
		).resolves.toBeUndefined();

		const updatedTask = await ctx.taskManager.getTask(planningTask.id);
		expect(updatedTask!.status).toBe('needs_attention');
	});

	it('does not promote draft tasks for non-planner workers on terminal error', async () => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [
				makeWorkerMessage('API Error: 403 {"error":{"message":"Forbidden"}}'),
			],
		});

		const goal = await ctx.goalManager.createGoal({ title: 'G', description: 'D' });
		const execTask = await ctx.taskManager.createTask({
			title: 'Exec task',
			description: 'Execution task',
			assignedAgent: 'general',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, execTask.id);

		// Create a draft task linked to the exec task
		const draftTask = await ctx.taskManager.createTask({
			title: 'Draft',
			description: 'Draft',
			status: 'draft',
			createdByTaskId: execTask.id,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];
		expect(group.workerRole).toBe('general');

		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		// Exec task should be failed
		const updatedExec = await ctx.taskManager.getTask(execTask.id);
		expect(updatedExec!.status).toBe('needs_attention');

		// Draft task should NOT be promoted (non-planner workers don't trigger Fix 3)
		const updatedDraft = await ctx.taskManager.getTask(draftTask.id);
		expect(updatedDraft!.status).toBe('draft');
	});
});

// ─── Fix 4: Auto-recover needs_human goals with only failed planning tasks ───

describe('Fix 4: needs_human goals with only failed planning tasks auto-recover', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('resets needs_human goal to active when all linked tasks are failed planning tasks and attempts < max', async () => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [],
		});

		// Create a goal and planning task, simulate escalation
		const goal = await ctx.goalManager.createGoal({
			title: 'Feature Y',
			description: 'Build Y',
		});

		// Simulate: planning_attempts was incremented once (first planning attempt failed)
		await ctx.goalManager.incrementPlanningAttempts(goal.id);
		// With new default max=2, attempts=1 < 2 → auto-recoverable

		// Create a planning task in needs_attention (failed state)
		const planningTask = await ctx.taskManager.createTask({
			title: 'Plan: Feature Y',
			description: 'Planning task for Feature Y',
			taskType: 'planning',
			status: 'needs_attention',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, planningTask.id);

		// Set goal to needs_human (as if it was escalated with old max=1)
		await ctx.goalManager.updateGoalStatus(goal.id, 'needs_human');

		ctx.runtime.start();
		await ctx.runtime.tick();

		// After tick, goal should be reset to active (auto-recovery)
		const refreshedGoal = await ctx.goalManager.getGoal(goal.id);
		// The goal was recovered and a new planning group was spawned, changing status back to active
		// (getNextGoalForPlanning resets it to active and returns it for spawning)
		expect(['active']).toContain(refreshedGoal?.status);

		// A new planning group should have been spawned
		const groups = ctx.groupRepo.getActiveGroups('room-1');
		expect(groups.length).toBeGreaterThan(0);
	});

	it('does NOT recover needs_human goal when planning_attempts >= effectiveMax', async () => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [],
		});

		const goal = await ctx.goalManager.createGoal({
			title: 'Feature Z',
			description: 'Build Z',
		});

		// Simulate: planning_attempts = 2 (exhausted new default max=2)
		await ctx.goalManager.incrementPlanningAttempts(goal.id);
		await ctx.goalManager.incrementPlanningAttempts(goal.id);

		const planningTask = await ctx.taskManager.createTask({
			title: 'Plan: Feature Z',
			description: 'Planning task',
			taskType: 'planning',
			status: 'needs_attention',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, planningTask.id);
		await ctx.goalManager.updateGoalStatus(goal.id, 'needs_human');

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Goal should remain needs_human — retries exhausted
		const refreshedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(refreshedGoal?.status).toBe('needs_human');
	});

	it('does NOT recover needs_human goal when linked tasks include execution tasks', async () => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [],
		});

		const goal = await ctx.goalManager.createGoal({
			title: 'Feature W',
			description: 'Build W',
		});

		await ctx.goalManager.incrementPlanningAttempts(goal.id);

		const planningTask = await ctx.taskManager.createTask({
			title: 'Plan: Feature W',
			description: 'Planning task',
			taskType: 'planning',
			status: 'needs_attention',
		});
		// Also create a failed EXECUTION task — this means human attention is genuinely needed
		const execTask = await ctx.taskManager.createTask({
			title: 'Exec task that failed',
			description: 'An execution task that genuinely failed',
			taskType: 'coding',
			status: 'needs_attention',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, planningTask.id);
		await ctx.goalManager.linkTaskToGoal(goal.id, execTask.id);
		await ctx.goalManager.updateGoalStatus(goal.id, 'needs_human');

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Goal should remain needs_human — execution tasks failed (real problem)
		const refreshedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(refreshedGoal?.status).toBe('needs_human');
	});
});

// ─── Fix 5: Auto-detect plan PR merge ────────────────────────────────────────

describe('Fix 5: Auto-detect plan PR merge for stuck planning groups', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		// runCommand returns 'MERGED' for gh pr view commands (PR is merged on GitHub)
		ctx = createRuntimeTestContext({
			hookOptions: {
				runCommand: async (args: string[], _cwd: string) => {
					// Only mock gh pr view calls
					if (args[0] === 'gh' && args[1] === 'pr' && args[2] === 'view') {
						return { stdout: 'MERGED', exitCode: 0 };
					}
					return { stdout: '', exitCode: 1 };
				},
			},
			getWorkerMessages: () => [],
		});
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('auto-approves planning group when plan PR is merged on GitHub', async () => {
		const { group, planningTask } = await setupPlannerGroup(ctx);

		// Simulate: leader called submit_for_review with plan PR URL
		// Set task prUrl and mark group as submitted for review
		await ctx.taskManager.reviewTask(planningTask.id, 'https://github.com/org/repo/pull/42');
		ctx.groupRepo.setSubmittedForReview(group.id, true);

		// Verify group is stuck waiting for human approval
		expect(ctx.groupRepo.getGroup(group.id)?.approved).toBe(false);
		expect(ctx.groupRepo.getGroup(group.id)?.submittedForReview).toBe(true);

		// Tick should detect the merged PR and auto-approve
		await ctx.runtime.tick();

		// Group should now be approved
		const updatedGroup = ctx.groupRepo.getGroup(group.id);
		expect(updatedGroup?.approved).toBe(true);
		// approvalSource should be 'github_merge_detected' (not 'human') for audit trail
		expect(updatedGroup?.approvalSource).toBe('github_merge_detected');

		// The leader should have received a resume message
		const injectToLeader = ctx.sessionFactory.calls.find(
			(c) => c.method === 'injectMessage' && c.args[0] === group.leaderSessionId
		);
		expect(injectToLeader).toBeDefined();
		expect(String(injectToLeader!.args[1])).toContain('merged on GitHub');
	});

	it('does NOT approve when PR is not yet merged (OPEN state)', async () => {
		// Override runCommand to return OPEN
		ctx.runtime.stop();
		ctx.db.close();

		ctx = createRuntimeTestContext({
			hookOptions: {
				runCommand: async (args: string[], _cwd: string) => {
					if (args[0] === 'gh' && args[1] === 'pr' && args[2] === 'view') {
						return { stdout: 'OPEN', exitCode: 0 };
					}
					return { stdout: '', exitCode: 1 };
				},
			},
			getWorkerMessages: () => [],
		});

		const { group, planningTask } = await setupPlannerGroup(ctx);
		await ctx.taskManager.reviewTask(planningTask.id, 'https://github.com/org/repo/pull/99');
		ctx.groupRepo.setSubmittedForReview(group.id, true);

		await ctx.runtime.tick();

		// Group should still be unapproved (PR is OPEN, not MERGED)
		const updatedGroup = ctx.groupRepo.getGroup(group.id);
		expect(updatedGroup?.approved).toBe(false);
	});

	it('does NOT trigger for non-planner groups in submitted_for_review', async () => {
		// Create a regular (non-planning) task
		const goal = await ctx.goalManager.createGoal({ title: 'G', description: 'D' });
		const task = await ctx.taskManager.createTask({
			title: 'Coder task',
			description: 'Coding task',
			assignedAgent: 'coder',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];

		// Set PR URL and mark as submitted for review
		await ctx.taskManager.reviewTask(task.id, 'https://github.com/org/repo/pull/77');
		ctx.groupRepo.setSubmittedForReview(group.id, true);

		const initialCalls = ctx.sessionFactory.calls.length;

		await ctx.runtime.tick();

		// No additional injectMessage calls to leader for non-planner groups
		// (the recovery only applies to planner groups)
		const newLeaderInjects = ctx.sessionFactory.calls
			.slice(initialCalls)
			.filter((c) => c.method === 'injectMessage' && c.args[0] === group.leaderSessionId);
		expect(newLeaderInjects.length).toBe(0);
		expect(ctx.groupRepo.getGroup(group.id)?.approved).toBe(false);
	});

	it('does NOT trigger when planning group has no prUrl', async () => {
		const { group } = await setupPlannerGroup(ctx);

		// Mark as submitted for review but NO prUrl on the task
		ctx.groupRepo.setSubmittedForReview(group.id, true);

		const initialCalls = ctx.sessionFactory.calls.length;

		await ctx.runtime.tick();

		// No resume should have been triggered
		const newCalls = ctx.sessionFactory.calls.slice(initialCalls);
		const injectCalls = newCalls.filter((c) => c.method === 'injectMessage');
		expect(injectCalls.length).toBe(0);
	});

	it('does NOT trigger when gh command fails (fails open gracefully)', async () => {
		ctx.runtime.stop();
		ctx.db.close();

		// runCommand always fails (e.g. gh not installed)
		ctx = createRuntimeTestContext({
			hookOptions: {
				runCommand: async (_args: string[], _cwd: string) => {
					return { stdout: '', exitCode: 1 };
				},
			},
			getWorkerMessages: () => [],
		});

		const { group, planningTask } = await setupPlannerGroup(ctx);
		await ctx.taskManager.reviewTask(planningTask.id, 'https://github.com/org/repo/pull/55');
		ctx.groupRepo.setSubmittedForReview(group.id, true);

		// Should not throw — fails open
		await expect(ctx.runtime.tick()).resolves.toBeUndefined();

		// Group should not be auto-approved when gh fails
		expect(ctx.groupRepo.getGroup(group.id)?.approved).toBe(false);
	});
});
