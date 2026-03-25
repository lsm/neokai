/**
 * Tests for terminal API error detection in RoomRuntime — leader path.
 *
 * Verifies that when a leader session outputs a terminal API error
 * (HTTP 400, 401, 403, 404, 422, etc.) the runtime fails the task
 * immediately instead of leaving it stuck without clear feedback.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

describe('RoomRuntime - leader terminal error detection', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	function makeMessage(text: string) {
		return { id: 'msg-1', text, toolCallNames: [] };
	}

	/**
	 * Spawn a group, route worker to leader (worker succeeds), then simulate
	 * the leader reaching terminal state with the given output text.
	 * Returns the group and task.
	 */
	async function spawnAndSimulateLeaderOutput(leaderOutput: string) {
		let leaderSessionId: string | null = null;

		ctx = createRuntimeTestContext({
			// Return error text for leader session; empty for worker so it routes normally.
			getWorkerMessages: (sessionId, _afterMessageId) => {
				if (leaderSessionId && sessionId === leaderSessionId) {
					return [makeMessage(leaderOutput)];
				}
				return [];
			},
		});

		const { task } = await createGoalAndTask(ctx);
		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];

		// Capture leader session ID so the mock returns error messages for it
		leaderSessionId = group.leaderSessionId;

		// Route worker → leader (worker has no terminal error — empty messages)
		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		// Simulate leader reaching terminal state with error output
		await ctx.runtime.onLeaderTerminalState(group.id, {
			sessionId: group.leaderSessionId,
			kind: 'idle',
		});

		return { group, task };
	}

	describe('terminal errors cause immediate task failure', () => {
		it('fails task immediately on HTTP 400 error in leader output', async () => {
			const { task, group } = await spawnAndSimulateLeaderOutput(
				'API Error: 400 {"error":{"message":"Invalid model: claude-bad-v0"}}'
			);

			// Task should be failed (needs_attention)
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');

			// Group should be completed (terminated)
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.completedAt).not.toBeNull();
		});

		it('fails task immediately on HTTP 401 error in leader output', async () => {
			const { task } = await spawnAndSimulateLeaderOutput('API Error: 401 Unauthorized');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});

		it('fails task immediately on HTTP 403 error in leader output', async () => {
			const { task } = await spawnAndSimulateLeaderOutput('API Error: 403 Forbidden');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});

		it('fails task immediately on HTTP 404 error in leader output', async () => {
			const { task } = await spawnAndSimulateLeaderOutput('API Error: 404 Not Found');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});

		it('fails task immediately on HTTP 422 error in leader output', async () => {
			const { task } = await spawnAndSimulateLeaderOutput('API Error: 422 Unprocessable Entity');

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});

		it('fails task on terminal error embedded in multi-line leader output', async () => {
			const multilineOutput = [
				'Reviewing worker output...',
				'Found issues with the implementation.',
				'API Error: 400 {"error":{"message":"Invalid model: xyz","type":"invalid_request_error"}}',
				'Session ended.',
			].join('\n');

			const { task } = await spawnAndSimulateLeaderOutput(multilineOutput);

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('needs_attention');
		});
	});

	describe('non-terminal cases do not fail the task', () => {
		it('does not fail task when leader has no output (silent terminal)', async () => {
			// Empty leader output — leader finished without calling a tool and without an error
			const { task } = await spawnAndSimulateLeaderOutput('');

			// Task should remain in_progress (not failed)
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});

		it('does not fail task when leader output is normal prose (no API error)', async () => {
			const { task } = await spawnAndSimulateLeaderOutput(
				'The worker has completed the task successfully. Reviewing the output now.'
			);

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});

		it('does NOT fail task when leader discusses error handling in prose (regression)', async () => {
			// Regression guard: broad text matching would falsely trip on explanatory prose
			const proseOutput = [
				'I reviewed the implementation of invalid model error handling.',
				'The worker correctly handles authentication failed scenarios.',
				'All edge cases including quota exceeded are covered.',
				'Sending feedback to worker.',
			].join('\n');

			const { task } = await spawnAndSimulateLeaderOutput(proseOutput);

			// Prose should NOT fail the task
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});

		it('does NOT fail task on HTTP 429 rate limit in leader output (rate_limit, not terminal)', async () => {
			const { task, group } = await spawnAndSimulateLeaderOutput(
				'API Error: 429 Too Many Requests'
			);

			// 429 is rate_limit class, not terminal — task should not be failed
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).not.toBe('needs_attention');

			// Bare 429 (no parseable reset time) must set a minimum backoff to prevent indefinite stall
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.rateLimit).not.toBeNull();
			expect(updatedGroup!.rateLimit!.resetsAt).toBeGreaterThan(Date.now());
			expect(updatedGroup!.rateLimit!.sessionRole).toBe('leader');
		});
	});

	describe('usage_limit handling', () => {
		it('pauses task when usage_limit detected in leader output and no fallback model configured', async () => {
			// First detection: leader outputs usage limit text → should set rate limit backoff
			const { task, group } = await spawnAndSimulateLeaderOutput(
				"You've hit your limit · resets 1pm (America/New_York)"
			);

			// Task should NOT be failed — it should pause (usage_limited)
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).not.toBe('needs_attention');

			// Group should have a rate limit backoff set with future reset time
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.rateLimit).not.toBeNull();
			expect(updatedGroup!.rateLimit!.resetsAt).toBeGreaterThan(Date.now());
			expect(updatedGroup!.rateLimit!.sessionRole).toBe('leader');
		});

		it('does NOT re-set usage limit when group already has rate limit (leader re-trigger after expiry)', async () => {
			// Production flow:
			//   1. Initial usage_limit → setRateLimit(resetsAt) → scheduleTickAfterRateLimitReset
			//   2. Timer fires after reset time → does NOT clear rateLimit (sentinel remains)
			//   3. recoverStuckLeaders → onLeaderTerminalState called again with same usage_limit text
			//   4. group.rateLimit is non-null (expired but present) → guard skips re-detection
			//   5. Falls through to normal completion — no infinite loop

			// Step 1: trigger first detection
			const { group } = await spawnAndSimulateLeaderOutput(
				"You've hit your limit · resets 1pm (America/New_York)"
			);

			// Confirm first detection set a rate limit
			const groupAfterFirst = ctx.groupRepo.getGroup(group.id);
			expect(groupAfterFirst!.rateLimit).not.toBeNull();

			// Step 2: simulate the limit having expired (resetsAt now in past, sentinel still present)
			const expiredRateLimit = {
				detectedAt: Date.now() - 120_000,
				resetsAt: Date.now() - 1, // already expired
				sessionRole: 'leader' as const,
			};
			ctx.groupRepo.setRateLimit(group.id, expiredRateLimit);

			// Step 3: re-trigger as recoverStuckLeaders would
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// Rate limit must NOT have been pushed to a new future timestamp —
			// the re-detection guard should have skipped the usage_limit block.
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.rateLimit!.resetsAt).toBeLessThanOrEqual(Date.now());
		});
	});
});
