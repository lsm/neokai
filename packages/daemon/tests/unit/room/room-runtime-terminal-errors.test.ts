/**
 * Tests for terminal API error detection in RoomRuntime.
 *
 * Verifies that when a worker session outputs a terminal API error
 * (HTTP 400, 401, 403, 404, 422, invalid model, etc.) the runtime
 * fails the task immediately instead of routing to the leader.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

describe('RoomRuntime - terminal error detection', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	function makeWorkerMessage(text: string) {
		return { id: 'msg-1', text, toolCallNames: [] };
	}

	/**
	 * Spawn a group and simulate worker terminal state with the given output text.
	 * Returns the group that was spawned.
	 */
	async function spawnAndSimulateWorkerOutput(workerOutput: string) {
		const { task } = await createGoalAndTask(ctx);
		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];

		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		return { group, task };
	}

	describe('terminal errors cause immediate task failure', () => {
		it('fails task immediately on HTTP 400 error in worker output', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [
					makeWorkerMessage('API Error: 400 {"error":{"message":"Invalid model: claude-bad-v0"}}'),
				],
			});

			const { group, task } = await spawnAndSimulateWorkerOutput('');

			// Task should be failed, NOT routed to leader
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');

			// Group should be completed (terminated)
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.completedAt).not.toBeNull();

			// No leader session should have been created
			const leaderCalls = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
			);
			expect(leaderCalls).toHaveLength(0);
		});

		it('fails task immediately on HTTP 401 error in worker output', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 401 Unauthorized')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});

		it('fails task immediately on HTTP 403 error in worker output', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 403 Forbidden')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});

		it('fails task immediately on HTTP 404 error in worker output', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 404 Not Found')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});

		it('fails task immediately on HTTP 422 error in worker output', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 422 Unprocessable Entity')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});

		it('fails task on terminal error embedded in multi-line worker output', async () => {
			const multilineOutput = [
				'Starting task execution...',
				'Running some analysis...',
				'API Error: 400 {"error":{"message":"Invalid model: xyz","type":"invalid_request_error"}}',
				'Session ended.',
			].join('\n');

			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage(multilineOutput)],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});
	});

	describe('recoverable errors are still routed to leader', () => {
		it('routes worker to leader on HTTP 500 error (server error - recoverable)', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 500 Internal Server Error')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			// Task should remain in_progress (routed to leader, not failed)
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});

		it('routes worker to leader when no API error in output (normal flow)', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [
					makeWorkerMessage('Completed the implementation. All tests pass.'),
				],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			// Task should remain in_progress (awaiting leader review)
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});

		it('does NOT fail task when worker discusses error handling in prose (regression)', async () => {
			// Regression: broad text patterns previously caused false positives
			// when the worker wrote explanatory text containing phrases like
			// "invalid model", "authentication failed", etc.
			const proseOutput = [
				'I have implemented handling for invalid model errors in the provider adapter.',
				'The fix ensures authentication failed scenarios are retried correctly.',
				'I also added quota exceeded detection so users get clear messages.',
				'All tests pass. Creating PR now.',
			].join('\n');

			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage(proseOutput)],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			// Prose should NOT fail the task — it should route to leader normally
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});

		it('does NOT fail task on HTTP 429 rate limit (classified as rate_limit, not terminal)', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 429 Too Many Requests')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			// 429 is rate_limit, not terminal — task is NOT failed immediately
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).not.toBe('needs_attention');
		});
	});

	describe('empty / no worker messages use terminal state placeholder', () => {
		it('does not fail task when worker has no messages (idle exit - normal)', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [], // empty — triggers placeholder text
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			// Placeholder text does not match terminal error patterns
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});
	});

	describe('rate limit bounce prevention', () => {
		it('sets a rate limit backoff on first bare-429 detection (prevents rapid bounce loop)', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 429 Too Many Requests')],
			});

			const { group, task } = await spawnAndSimulateWorkerOutput('');

			// Task should not be failed (429 is rate_limit, not terminal)
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).not.toBe('needs_attention');

			// Group must be rate-limited so the worker is NOT immediately bounced back
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.rateLimit).not.toBeNull();
			expect(updatedGroup!.rateLimit!.resetsAt).toBeGreaterThan(Date.now());
			expect(updatedGroup!.rateLimit!.sessionRole).toBe('worker');
		});

		it('does NOT re-set rate limit when group already has one (re-trigger after expiry)', async () => {
			// Regression: after rate limit expires, recoverStuckWorkers re-triggers
			// onWorkerTerminalState.  The old 429 message is still in the worker output.
			// The fix: skip rate_limit detection when group.rateLimit is already set,
			// allowing the worker to fall through to the worktree check (and attempt cleanup).
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 429 Too Many Requests')],
			});

			const { group } = await spawnAndSimulateWorkerOutput('');

			// Simulate the rate limit having already expired
			const expiredResetsAt = Date.now() - 1;
			ctx.groupRepo.setRateLimit(group.id, {
				detectedAt: Date.now() - 120_000,
				resetsAt: expiredResetsAt,
				sessionRole: 'worker',
			});

			// Re-trigger as recoverStuckWorkers would
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Rate limit must NOT have been pushed to a new future timestamp
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.rateLimit!.resetsAt).toBeLessThanOrEqual(Date.now());

			// Worker should have been routed to leader (worktree is clean in tests).
			// Routing is confirmed by feedbackIteration incrementing to 1.
			expect(updatedGroup!.feedbackIteration).toBe(1);
		});
	});
});
