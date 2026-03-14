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
			expect(updatedTask!.status).toBe('failed');

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
			expect(updatedTask!.status).toBe('failed');
		});

		it('fails task immediately on HTTP 403 error in worker output', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 403 Forbidden')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('failed');
		});

		it('fails task immediately on HTTP 404 error in worker output', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 404 Not Found')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('failed');
		});

		it('fails task immediately on HTTP 422 error in worker output', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 422 Unprocessable Entity')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('failed');
		});

		it('fails task immediately on "Invalid model" text pattern', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [
					makeWorkerMessage('Invalid model: claude-unknown-v99. Please check your configuration.'),
				],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('failed');
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
			expect(updatedTask!.status).toBe('failed');
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

		it('does NOT fail task on HTTP 429 rate limit (classified as rate_limit, not terminal)', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => [makeWorkerMessage('API Error: 429 Too Many Requests')],
			});

			const { task } = await spawnAndSimulateWorkerOutput('');

			// 429 is rate_limit, not terminal — task is NOT failed immediately
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).not.toBe('failed');
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
});
