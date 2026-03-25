/**
 * Tests for recoverStuckLeaders() — the leader-side counterpart to recoverStuckWorkers().
 *
 * recoverStuckLeaders() runs every tick and re-injects the last worker output into the
 * leader session when the leader has an expired rate/usage limit and is idle.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';
import type { RateLimitBackoff } from '../../../src/lib/room/state/session-group-repository';

/**
 * Helper: create a task + group directly in DB (bypassing tick).
 */
async function createTaskWithGroup(
	ctx: RuntimeTestContext
): Promise<{ taskId: string; groupId: string; workerSessionId: string; leaderSessionId: string }> {
	const { task } = await createGoalAndTask(ctx);
	const group = ctx.groupRepo.createGroup(task.id, `worker:${task.id}`, `leader:${task.id}`);
	await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');
	return {
		taskId: task.id,
		groupId: group.id,
		workerSessionId: group.workerSessionId,
		leaderSessionId: group.leaderSessionId,
	};
}

/**
 * Build an expired rate-limit backoff (resetsAt in the past) for the given role.
 */
function expiredLeaderBackoff(msPast = 1000): RateLimitBackoff {
	return {
		detectedAt: Date.now() - msPast - 5000,
		resetsAt: Date.now() - msPast,
		sessionRole: 'leader',
	};
}

describe('recoverStuckLeaders', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext({
			getWorkerMessages: (_sessionId, _afterId) => [
				{ id: 'msg-1', text: 'Worker output text', toolCallNames: [] },
			],
		});
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('injects a message into the leader session when the rate limit has expired', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		// Simulate expired leader rate limit
		ctx.groupRepo.setRateLimit(groupId, expiredLeaderBackoff());
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].args[1]).toContain('[Auto-recovery]');
		expect(injectCalls[0].args[1]).toContain('Worker output text');
	});

	it('clears the rate limit from the group before injecting', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		ctx.groupRepo.setRateLimit(groupId, expiredLeaderBackoff());
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const updated = ctx.groupRepo.getGroup(groupId)!;
		expect(updated.rateLimit).toBeNull();
	});

	it('restores task status to in_progress via clearTaskRestriction', async () => {
		const { groupId, taskId, leaderSessionId } = await createTaskWithGroup(ctx);

		// Set the task to usage_limited (simulating what persistTaskRestriction does)
		await ctx.taskManager.updateTaskStatus(taskId, 'usage_limited');

		ctx.groupRepo.setRateLimit(groupId, expiredLeaderBackoff());
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Allow the async clearTaskRestriction to complete
		await new Promise((r) => setTimeout(r, 10));

		const task = await ctx.taskManager.getTask(taskId);
		expect(task!.status).toBe('in_progress');
	});

	it('does not inject when the rate limit is still active (resetsAt in the future)', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		// Active rate limit — not yet expired
		ctx.groupRepo.setRateLimit(groupId, {
			detectedAt: Date.now(),
			resetsAt: Date.now() + 60_000,
			sessionRole: 'leader',
		});
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		expect(injectCalls).toHaveLength(0);
	});

	it('does not inject when the rate limit is scoped to the worker role', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		// Expired rate limit but scoped to worker, not leader
		ctx.groupRepo.setRateLimit(groupId, {
			detectedAt: Date.now() - 5000,
			resetsAt: Date.now() - 1000,
			sessionRole: 'worker',
		});
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		expect(injectCalls).toHaveLength(0);
	});

	it('does not inject when the leader session is actively processing', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		ctx.groupRepo.setRateLimit(groupId, expiredLeaderBackoff());
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'processing');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		expect(injectCalls).toHaveLength(0);
	});

	it('injects when the leader session is interrupted (treated same as idle)', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		ctx.groupRepo.setRateLimit(groupId, expiredLeaderBackoff());
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'interrupted');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].args[1]).toContain('[Auto-recovery]');
	});

	it('does not inject when the group has waitingForQuestion=true', async () => {
		const { groupId, leaderSessionId, workerSessionId } = await createTaskWithGroup(ctx);

		ctx.groupRepo.setRateLimit(groupId, expiredLeaderBackoff());
		ctx.groupRepo.setWaitingForQuestion(groupId, true, workerSessionId);
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		expect(injectCalls).toHaveLength(0);
	});

	it('does not inject when the group is awaiting human review', async () => {
		const { groupId, leaderSessionId, taskId } = await createTaskWithGroup(ctx);

		ctx.groupRepo.setRateLimit(groupId, expiredLeaderBackoff());
		ctx.groupRepo.setSubmittedForReview(groupId, true);
		await ctx.taskManager.reviewTask(taskId);
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		expect(injectCalls).toHaveLength(0);
	});

	it('does not inject when the leader session is missing from the factory', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		ctx.groupRepo.setRateLimit(groupId, expiredLeaderBackoff());
		ctx.sessionFactory.missingSessionIds = new Set([leaderSessionId]);
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		expect(injectCalls).toHaveLength(0);
	});

	it('guards against duplicate injection: only one inject across two ticks due to rate limit cleared', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		ctx.groupRepo.setRateLimit(groupId, expiredLeaderBackoff());
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();

		// First tick — triggers recovery: rate limit cleared, message injected
		await ctx.runtime.tick();
		// Second tick — rate limit already cleared, no recovery needed
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		// Only one inject because the rate limit is cleared on the first recovery
		expect(injectCalls).toHaveLength(1);
	});

	it('does not inject when there is no rate limit', async () => {
		const { leaderSessionId } = await createTaskWithGroup(ctx);

		// No rate limit set — group is normally idle
		ctx.sessionFactory.processingStates.set(leaderSessionId, 'idle');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
		);
		expect(injectCalls).toHaveLength(0);
	});

	it('sends generic continuation message when getWorkerMessages returns empty (normal case after routing)', async () => {
		// In the normal case, lastForwardedMessageId is already up-to-date after routeWorkerToLeader,
		// so getWorkerMessages returns an empty array. The generic message alone should be sent.
		const ctxEmpty = createRuntimeTestContext({
			getWorkerMessages: () => [],
		});
		ctx.runtime.stop();

		const { task } = await createGoalAndTask(ctxEmpty);
		const group = ctxEmpty.groupRepo.createGroup(task.id, `worker:${task.id}`, `leader:${task.id}`);
		await ctxEmpty.taskManager.updateTaskStatus(task.id, 'in_progress');

		ctxEmpty.groupRepo.setRateLimit(group.id, expiredLeaderBackoff());
		ctxEmpty.sessionFactory.processingStates.set(group.leaderSessionId, 'idle');

		ctxEmpty.runtime.start();
		await ctxEmpty.runtime.tick();

		const injectCalls = ctxEmpty.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === group.leaderSessionId
		);
		expect(injectCalls).toHaveLength(1);
		const msg = injectCalls[0].args[1] as string;
		expect(msg).toContain('[Auto-recovery]');
		expect(msg).not.toContain('Last worker output');

		ctxEmpty.runtime.stop();
		ctxEmpty.db.close();
	});

	it('includes excerpt of worker output in the injected continuation message', async () => {
		const workerOutputText = 'Implemented the feature as requested.';
		const ctxWithMessages = createRuntimeTestContext({
			getWorkerMessages: () => [{ id: 'w1', text: workerOutputText, toolCallNames: [] }],
		});
		ctx.runtime.stop();

		const { task } = await createGoalAndTask(ctxWithMessages);
		const group = ctxWithMessages.groupRepo.createGroup(
			task.id,
			`worker:${task.id}`,
			`leader:${task.id}`
		);
		await ctxWithMessages.taskManager.updateTaskStatus(task.id, 'in_progress');

		ctxWithMessages.groupRepo.setRateLimit(group.id, expiredLeaderBackoff());
		ctxWithMessages.sessionFactory.processingStates.set(group.leaderSessionId, 'idle');

		ctxWithMessages.runtime.start();
		await ctxWithMessages.runtime.tick();

		const injectCalls = ctxWithMessages.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === group.leaderSessionId
		);
		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].args[1]).toContain(workerOutputText);

		ctxWithMessages.runtime.stop();
		ctxWithMessages.db.close();
	});

	// ─── Subtask 4: coexistence with recoverStuckWorkers ─────────────────────

	it('recoverStuckLeaders and recoverStuckWorkers both fire in the same tick without interfering', async () => {
		// Two groups in the same tick:
		//   group1 — expired WORKER rate limit: recoverStuckWorkers handles it,
		//             recoverStuckLeaders ignores it (sessionRole !== 'leader')
		//   group2 — expired LEADER rate limit, no new worker messages:
		//             recoverStuckWorkers skips it, recoverStuckLeaders handles it

		const workerSessionsWithMessages = new Set<string>();
		const ctxCoexist = createRuntimeTestContext({
			maxConcurrentGroups: 2,
			getWorkerMessages: (sessionId, _afterId) => {
				if (workerSessionsWithMessages.has(sessionId)) {
					return [{ id: 'w1', text: 'Worker output for stuck-worker group', toolCallNames: [] }];
				}
				return [];
			},
		});
		ctx.runtime.stop();

		// Group 1: expired WORKER rate limit — recoverStuckWorkers will handle it
		const { task: task1 } = await createGoalAndTask(ctxCoexist);
		const group1 = ctxCoexist.groupRepo.createGroup(
			task1.id,
			`worker-w:${task1.id}`,
			`leader-w:${task1.id}`
		);
		await ctxCoexist.taskManager.updateTaskStatus(task1.id, 'in_progress');
		ctxCoexist.groupRepo.setRateLimit(group1.id, {
			detectedAt: Date.now() - 5000,
			resetsAt: Date.now() - 1000,
			sessionRole: 'worker',
		});
		ctxCoexist.sessionFactory.processingStates.set(group1.workerSessionId, 'idle');
		ctxCoexist.sessionFactory.processingStates.set(group1.leaderSessionId, 'idle');
		// group1 has new worker messages — this causes recoverStuckWorkers to trigger
		workerSessionsWithMessages.add(group1.workerSessionId);

		// Group 2: expired LEADER rate limit — recoverStuckLeaders will handle it
		const { task: task2 } = await createGoalAndTask(ctxCoexist);
		const group2 = ctxCoexist.groupRepo.createGroup(
			task2.id,
			`worker-l:${task2.id}`,
			`leader-l:${task2.id}`
		);
		await ctxCoexist.taskManager.updateTaskStatus(task2.id, 'in_progress');
		ctxCoexist.groupRepo.setRateLimit(group2.id, {
			detectedAt: Date.now() - 5000,
			resetsAt: Date.now() - 1000,
			sessionRole: 'leader',
		});
		ctxCoexist.sessionFactory.processingStates.set(group2.workerSessionId, 'idle');
		ctxCoexist.sessionFactory.processingStates.set(group2.leaderSessionId, 'idle');
		// group2 worker has no new messages — recoverStuckWorkers skips it (messages already forwarded)

		ctxCoexist.runtime.start();
		await ctxCoexist.runtime.tick();

		// recoverStuckLeaders must have injected a continuation message for group2's leader
		const group2LeaderInjects = ctxCoexist.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === group2.leaderSessionId
		);
		expect(group2LeaderInjects).toHaveLength(1);
		expect(group2LeaderInjects[0].args[1]).toContain('[Auto-recovery]');

		// recoverStuckLeaders must NOT have injected for group1's leader
		// (group1.rateLimit.sessionRole === 'worker', not 'leader')
		const group1AutoRecoveryInjects = ctxCoexist.sessionFactory.calls.filter(
			(c) =>
				c.method === 'injectMessage' &&
				c.args[0] === group1.leaderSessionId &&
				typeof c.args[1] === 'string' &&
				(c.args[1] as string).includes('[Auto-recovery]')
		);
		expect(group1AutoRecoveryInjects).toHaveLength(0);

		// group2 rate limit must be cleared by recoverStuckLeaders
		expect(ctxCoexist.groupRepo.getGroup(group2.id)!.rateLimit).toBeNull();

		ctxCoexist.runtime.stop();
		ctxCoexist.db.close();
	});

	// ─── Subtask 5: onLeaderTerminalState behavior after re-injection ─────────

	it('leader with fresh output after re-injection completes normally without new backoff', async () => {
		// After recoverStuckLeaders clears the rate limit and injects a continuation message,
		// onLeaderTerminalState fires with the leader's fresh output (no error text).
		// The leader should complete normally with no new rate-limit backoff set.
		const ctxFresh = createRuntimeTestContext({
			getWorkerMessages: () => [],
		});
		ctx.runtime.stop();

		const { task } = await createGoalAndTask(ctxFresh);
		const group = ctxFresh.groupRepo.createGroup(task.id, `worker:${task.id}`, `leader:${task.id}`);
		await ctxFresh.taskManager.updateTaskStatus(task.id, 'in_progress');

		ctxFresh.groupRepo.setRateLimit(group.id, expiredLeaderBackoff());
		ctxFresh.sessionFactory.processingStates.set(group.leaderSessionId, 'idle');

		ctxFresh.runtime.start();

		// Tick: recoverStuckLeaders clears the rate limit and injects a continuation message
		await ctxFresh.runtime.tick();

		const injectCalls = ctxFresh.sessionFactory.calls.filter((c) => c.method === 'injectMessage');
		expect(injectCalls).toHaveLength(1);

		// Rate limit must be cleared so onLeaderTerminalState sees null
		expect(ctxFresh.groupRepo.getGroup(group.id)!.rateLimit).toBeNull();

		// Mark leader as having received work (normally done by routeWorkerToLeader)
		ctxFresh.groupRepo.setLeaderHasWork(group.id);

		// Simulate leader responding with fresh output — getWorkerMessages returns [] (no error text)
		// onLeaderTerminalState falls through to normal completion
		await ctxFresh.runtime.onLeaderTerminalState(group.id, {
			sessionId: group.leaderSessionId,
			kind: 'idle',
		});

		// No new backoff must have been set
		const updatedGroup = ctxFresh.groupRepo.getGroup(group.id)!;
		expect(updatedGroup.rateLimit).toBeNull();

		// Task must remain in_progress (not paused)
		const updatedTask = await ctxFresh.taskManager.getTask(task.id);
		expect(updatedTask!.status).toBe('in_progress');

		ctxFresh.runtime.stop();
		ctxFresh.db.close();
	});

	it('re-detection guard prevents backoff reset when rate limit sentinel is present with stale usage-limit text', async () => {
		// When the rate limit sentinel (group.rateLimit) is still set (even if expired),
		// the !group.rateLimit guard in onLeaderTerminalState causes the usage_limit block
		// to be skipped entirely — falling through to normal completion.
		//
		// This guard fires when some path re-triggers onLeaderTerminalState while the
		// sentinel is still present (e.g. a reconnect event before recoverStuckLeaders
		// clears it, or a mirroring path that doesn't clear first).
		const STALE_USAGE_LIMIT_TEXT = "You've hit your limit · resets 2pm (America/New_York)";

		const ctxGuard = createRuntimeTestContext({
			// Return stale usage-limit text as if the leader session still contains the old message
			getWorkerMessages: (_sessionId, _afterId) => [
				{ id: 'l1', text: STALE_USAGE_LIMIT_TEXT, toolCallNames: [] },
			],
		});
		ctx.runtime.stop();

		const { task } = await createGoalAndTask(ctxGuard);
		const group = ctxGuard.groupRepo.createGroup(task.id, `worker:${task.id}`, `leader:${task.id}`);
		await ctxGuard.taskManager.updateTaskStatus(task.id, 'in_progress');

		// Simulate the state right before re-injection: rate limit is expired but still present
		const expiredRateLimit = expiredLeaderBackoff();
		ctxGuard.groupRepo.setRateLimit(group.id, expiredRateLimit);
		ctxGuard.groupRepo.setLeaderHasWork(group.id);

		// Trigger onLeaderTerminalState with stale usage-limit text while sentinel is non-null.
		// The re-detection guard (!group.rateLimit is false) must skip the usage_limit block.
		await ctxGuard.runtime.onLeaderTerminalState(group.id, {
			sessionId: group.leaderSessionId,
			kind: 'idle',
		});

		// resetsAt must NOT have been pushed to a new future value — guard fired correctly
		const updatedGroup = ctxGuard.groupRepo.getGroup(group.id)!;
		expect(updatedGroup.rateLimit!.resetsAt).toBeLessThanOrEqual(Date.now());

		// Task must not be re-paused with a new future reset
		const updatedTask = await ctxGuard.taskManager.getTask(task.id);
		expect(updatedTask!.status).toBe('in_progress');

		ctxGuard.runtime.stop();
		ctxGuard.db.close();
	});
});
