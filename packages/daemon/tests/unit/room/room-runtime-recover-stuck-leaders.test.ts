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
});
