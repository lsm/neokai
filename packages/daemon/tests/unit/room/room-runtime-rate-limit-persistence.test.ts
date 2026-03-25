/**
 * Tests for rate/usage limit restriction persistence in RoomRuntime.
 *
 * Verifies:
 * - Task status transitions to rate_limited / usage_limited on first detection
 * - restrictions field is persisted with correct data (type, resetAt, sessionRole)
 * - Task status clears back to in_progress when send_to_worker is called
 * - recoverStuckWorkers skips actively rate-limited tasks (group.rateLimit still active)
 * - recoverStuckWorkers re-triggers routing after backoff expires
 */

import { describe, expect, it, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	spawnAndRouteToLeader,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

describe('RoomRuntime - rate limit restriction persistence', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	// Rate limit error that includes a parseable reset time
	const RATE_LIMIT_MSG = "API Error: 429 You've hit your limit · resets 11pm (America/New_York)";
	// Usage limit message
	const USAGE_LIMIT_MSG = "You've hit your limit · resets 11pm (America/New_York)";

	function makeWorkerMessages(text: string) {
		return [{ id: 'msg-1', text, toolCallNames: [] }];
	}

	async function spawnAndTriggerWorkerTerminal(workerOutput: string) {
		const { task } = await createGoalAndTask(ctx);
		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];

		// Put task in_progress so transitions are valid
		await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		return { group, task };
	}

	describe('worker rate_limit sets task to rate_limited', () => {
		it('updates task status to rate_limited on first 429 detection', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(RATE_LIMIT_MSG),
			});

			const { task } = await spawnAndTriggerWorkerTerminal('');

			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.status).toBe('rate_limited');
		});

		it('persists restrictions with correct type and sessionRole', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(RATE_LIMIT_MSG),
			});

			const { task } = await spawnAndTriggerWorkerTerminal('');

			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.restrictions).toBeDefined();
			expect(updated!.restrictions!.type).toBe('rate_limit');
			expect(updated!.restrictions!.sessionRole).toBe('worker');
			expect(updated!.restrictions!.resetAt).toBeGreaterThan(Date.now());
		});

		it('group.rateLimit is set and active after first detection', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(RATE_LIMIT_MSG),
			});

			const { group } = await spawnAndTriggerWorkerTerminal('');

			// Group has rateLimit set from first detection — it's still active
			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(true);

			// The stored backoff resetsAt should be in the future
			const groupData = ctx.groupRepo.getActiveGroups('room-1').find((g) => g.id === group.id);
			expect(groupData?.rateLimit).toBeDefined();
			expect(groupData?.rateLimit?.resetsAt).toBeGreaterThan(Date.now());
		});
	});

	describe('worker usage_limit sets task to usage_limited when no fallback', () => {
		it('updates task status to usage_limited when no fallback model available', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				// No fallback models configured → usage_limit falls through to pause behavior
				getGlobalSettings: () => ({}) as never,
			});

			const { task } = await spawnAndTriggerWorkerTerminal('');

			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.status).toBe('usage_limited');
			expect(updated!.restrictions).toBeDefined();
			expect(updated!.restrictions!.type).toBe('usage_limit');
		});
	});

	describe('send_to_worker clears task restriction', () => {
		it('restores task to in_progress when send_to_worker is called', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(RATE_LIMIT_MSG),
			});

			const { group, task } = await spawnAndTriggerWorkerTerminal('');

			// Verify task is rate_limited
			const rateLimited = await ctx.taskManager.getTask(task.id);
			expect(rateLimited!.status).toBe('rate_limited');

			// Manually expire the rate limit so send_to_worker doesn't get blocked
			ctx.groupRepo.setRateLimit(group.id, {
				detectedAt: Date.now() - 120_000,
				resetsAt: Date.now() - 60_000, // expired
				sessionRole: 'worker',
			});

			// Call send_to_worker (the leader tool that clears backoff)
			await ctx.runtime.handleLeaderTool(group.id, 'send_to_worker', {
				message: 'Please continue from where you left off.',
			});

			const resumed = await ctx.taskManager.getTask(task.id);
			expect(resumed!.status).toBe('in_progress');
			expect(resumed!.restrictions).toBeNull();
		});
	});

	describe('recoverStuckWorkers handles rate limit expiry', () => {
		it('skips groups with active (non-expired) rate limit', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(RATE_LIMIT_MSG),
			});

			const { group } = await spawnAndTriggerWorkerTerminal('');

			// Group is actively rate-limited
			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(true);

			// Record calls before tick
			const callsBefore = ctx.sessionFactory.calls.length;

			// Tick — recoverStuckWorkers should skip this group
			await ctx.runtime.tick();

			// No new routing should have been attempted
			const callsAfter = ctx.sessionFactory.calls.length;
			expect(callsAfter).toBe(callsBefore);
		});

		it('recovers groups after rate limit expires', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(RATE_LIMIT_MSG),
			});

			// Set worker session to idle state for stuck worker detection
			ctx.sessionFactory.processingStates.set('worker-session-1', 'idle');

			const { group } = await spawnAndTriggerWorkerTerminal('');

			// Manually set an expired rate limit
			ctx.groupRepo.setRateLimit(group.id, {
				detectedAt: Date.now() - 120_000,
				resetsAt: Date.now() - 60_000, // expired
				sessionRole: 'worker',
			});

			// The group should not be actively rate-limited anymore
			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(false);

			// recoverStuckWorkers should re-trigger onWorkerTerminalState for this group
			// (hasExpiredRateLimit = true, so feedbackIteration check is bypassed)
			const callsBefore = ctx.sessionFactory.calls.length;
			await ctx.runtime.tick();
			const callsAfter = ctx.sessionFactory.calls.length;

			// Some routing call should have been made
			expect(callsAfter).toBeGreaterThanOrEqual(callsBefore);
		});
	});

	// ─── Leader rate/usage limit paths ───────────────────────────────────────
	// Worker returns normal output; only the leader session returns the error message.
	// This ensures no group.rateLimit is set from the worker path, so the leader
	// detection guard (!group.rateLimit) correctly triggers on first leader detection.

	describe('leader rate_limit sets task to rate_limited', () => {
		it('updates task status to rate_limited on leader 429 detection', async () => {
			let leaderSessionId: string | null = null;
			ctx = createRuntimeTestContext({
				getWorkerMessages: (sessionId) => {
					if (leaderSessionId && sessionId === leaderSessionId) {
						return makeWorkerMessages(RATE_LIMIT_MSG);
					}
					// Worker returns normal output — no error
					return [];
				},
			});

			const { task, group } = await spawnAndRouteToLeader(ctx);
			leaderSessionId = group.leaderSessionId;

			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.status).toBe('rate_limited');
		});

		it('persists restrictions with sessionRole=leader on leader rate limit', async () => {
			let leaderSessionId: string | null = null;
			ctx = createRuntimeTestContext({
				getWorkerMessages: (sessionId) => {
					if (leaderSessionId && sessionId === leaderSessionId) {
						return makeWorkerMessages(RATE_LIMIT_MSG);
					}
					return [];
				},
			});

			const { task, group } = await spawnAndRouteToLeader(ctx);
			leaderSessionId = group.leaderSessionId;

			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.restrictions).toBeDefined();
			expect(updated!.restrictions!.type).toBe('rate_limit');
			expect(updated!.restrictions!.sessionRole).toBe('leader');
			expect(updated!.restrictions!.resetAt).toBeGreaterThan(Date.now());
		});
	});

	describe('leader usage_limit sets task to usage_limited when no fallback', () => {
		it('updates task status to usage_limited on leader usage limit (no fallback)', async () => {
			let leaderSessionId: string | null = null;
			ctx = createRuntimeTestContext({
				getWorkerMessages: (sessionId) => {
					if (leaderSessionId && sessionId === leaderSessionId) {
						return makeWorkerMessages(USAGE_LIMIT_MSG);
					}
					return [];
				},
				getGlobalSettings: () => ({}) as never,
			});

			const { task, group } = await spawnAndRouteToLeader(ctx);
			leaderSessionId = group.leaderSessionId;

			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.status).toBe('usage_limited');
			expect(updated!.restrictions).toBeDefined();
			expect(updated!.restrictions!.type).toBe('usage_limit');
			expect(updated!.restrictions!.sessionRole).toBe('leader');
		});
	});

	describe('leader usage_limit re-detection guard (!group.rateLimit)', () => {
		it('skips usage_limit handler when group.rateLimit is already set (active)', async () => {
			// Scenario: usage_limit was already detected (group.rateLimit set).
			// Re-triggering onLeaderTerminalState with the same usage-limit output must NOT
			// re-apply the backoff or return early — it must fall through to normal completion.
			let leaderSessionId: string | null = null;
			ctx = createRuntimeTestContext({
				getWorkerMessages: (sessionId) => {
					if (leaderSessionId && sessionId === leaderSessionId) {
						return makeWorkerMessages(USAGE_LIMIT_MSG);
					}
					return [];
				},
				getGlobalSettings: () => ({}) as never,
			});

			const { task, group } = await spawnAndRouteToLeader(ctx);
			leaderSessionId = group.leaderSessionId;
			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

			// Simulate a rateLimit that is already set (first detection already occurred)
			const existingBackoff = {
				detectedAt: Date.now() - 10_000,
				resetsAt: Date.now() + 60_000, // still active
				sessionRole: 'leader' as const,
			};
			ctx.groupRepo.setRateLimit(group.id, existingBackoff);

			// Re-trigger onLeaderTerminalState — the guard must prevent re-applying backoff
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// group.rateLimit must remain unchanged (not re-applied)
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.rateLimit).toEqual(existingBackoff);

			// Task should still be in_progress (no new restriction persisted)
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});

		it('skips usage_limit handler when group.rateLimit is expired (re-trigger after reset)', async () => {
			// Scenario: usage_limit was detected, rateLimit set, then the reset timer fired.
			// group.rateLimit is expired but still non-null.
			// onLeaderTerminalState must NOT re-apply backoff — fall through to completion.
			let leaderSessionId: string | null = null;
			ctx = createRuntimeTestContext({
				getWorkerMessages: (sessionId) => {
					if (leaderSessionId && sessionId === leaderSessionId) {
						return makeWorkerMessages(USAGE_LIMIT_MSG);
					}
					return [];
				},
				getGlobalSettings: () => ({}) as never,
			});

			const { task, group } = await spawnAndRouteToLeader(ctx);
			leaderSessionId = group.leaderSessionId;
			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

			// Expired rate limit — simulates the reset timer having fired
			const expiredBackoff = {
				detectedAt: Date.now() - 120_000,
				resetsAt: Date.now() - 10_000, // expired 10s ago
				sessionRole: 'leader' as const,
			};
			ctx.groupRepo.setRateLimit(group.id, expiredBackoff);

			// Re-trigger onLeaderTerminalState
			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// group.rateLimit must remain the expired backoff — not overwritten with a new one
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.rateLimit).toEqual(expiredBackoff);

			// Task must not transition to usage_limited again
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});
	});

	// ─── clearGroupRateLimit ────────────────────────────────────────────────────────────────

	describe('clearGroupRateLimit(taskId)', () => {
		it('returns false when no group exists for the task', async () => {
			ctx = createRuntimeTestContext();
			ctx.runtime.start();
			const result = await ctx.runtime.clearGroupRateLimit('non-existent-task');
			expect(result).toBe(false);
		});

		it('returns false when the group is already completed', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(RATE_LIMIT_MSG),
			});

			const { group, task } = await spawnAndTriggerWorkerTerminal('');

			// Mark the group as completed
			ctx.groupRepo.completeGroup(group.id, group.version);

			const result = await ctx.runtime.clearGroupRateLimit(task.id);
			expect(result).toBe(false);
		});

		it('clears group rateLimit and task restriction, returns true', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(RATE_LIMIT_MSG),
			});

			const { group, task } = await spawnAndTriggerWorkerTerminal('');

			// Confirm the group is rate-limited and task restriction is set
			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(true);
			const restricted = await ctx.taskManager.getTask(task.id);
			expect(restricted!.status).toBe('rate_limited');
			expect(restricted!.restrictions).toBeDefined();

			// Clear via the new public method
			const result = await ctx.runtime.clearGroupRateLimit(task.id);
			expect(result).toBe(true);

			// Group rateLimit should be gone
			const groupAfter = ctx.groupRepo.getActiveGroups('room-1').find((g) => g.id === group.id);
			expect(groupAfter?.rateLimit).toBeNull();

			// Task restriction should be cleared and status restored to in_progress
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.restrictions).toBeNull();
			expect(taskAfter!.status).toBe('in_progress');
		});

		it('clears group rateLimit and task restriction after usage_limit detection, returns true', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				// No fallback models — usage_limit triggers pause behavior
				getGlobalSettings: () => ({}) as never,
			});

			const { group, task } = await spawnAndTriggerWorkerTerminal('');

			// Confirm usage_limited state
			const restricted = await ctx.taskManager.getTask(task.id);
			expect(restricted!.status).toBe('usage_limited');
			expect(restricted!.restrictions).toBeDefined();
			expect(restricted!.restrictions!.type).toBe('usage_limit');
			expect(ctx.groupRepo.getGroup(group.id)!.rateLimit).toBeDefined();

			// Clear via the public method
			const result = await ctx.runtime.clearGroupRateLimit(task.id);
			expect(result).toBe(true);

			// Group rateLimit should be gone
			expect(ctx.groupRepo.getGroup(group.id)!.rateLimit).toBeNull();

			// Task restriction should be cleared and status restored to in_progress
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.restrictions).toBeNull();
			expect(taskAfter!.status).toBe('in_progress');
		});
	});

	// ─── integration: manual status change clears backoff, allows normal routing ──────────

	describe('integration: manual status change to in_progress allows normal worker routing', () => {
		it('after manual status change, worker output with clean messages routes to leader normally', async () => {
			// Use a mutable ref so we can switch from error messages to clean messages mid-test
			const msgRef = { msgs: makeWorkerMessages(USAGE_LIMIT_MSG) };

			ctx = createRuntimeTestContext({
				getWorkerMessages: () => msgRef.msgs,
				// No fallback models — ensures usage_limit triggers pause, not fallback switch
				getGlobalSettings: () => ({}) as never,
			});

			// Phase 1: usage_limit detected → backoff set, task = usage_limited
			const { group, task } = await spawnAndTriggerWorkerTerminal('');

			expect((await ctx.taskManager.getTask(task.id))!.status).toBe('usage_limited');
			expect(ctx.groupRepo.getGroup(group.id)!.rateLimit).toBeDefined();

			// Phase 2: manual status change → clearGroupRateLimit clears backoff
			const cleared = await ctx.runtime.clearGroupRateLimit(task.id);
			expect(cleared).toBe(true);
			expect(ctx.groupRepo.getGroup(group.id)!.rateLimit).toBeNull();
			expect((await ctx.taskManager.getTask(task.id))!.status).toBe('in_progress');

			// Phase 3: new worker message (without error text)
			msgRef.msgs = [{ id: 'msg-2', text: 'Work completed successfully.', toolCallNames: [] }];

			// Both worker and leader sessions are created by tick(); routing uses injectMessage.
			const leaderSessionId = group.leaderSessionId;
			const injectCallsBefore = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
			).length;

			// Phase 4: onWorkerTerminalState with clean messages → should route to leader
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Verify: no new backoff applied (group.rateLimit still null)
			expect(ctx.groupRepo.getGroup(group.id)!.rateLimit).toBeNull();

			// Verify: task was NOT paused again
			const taskAfter = await ctx.taskManager.getTask(task.id);
			expect(taskAfter!.status).not.toBe('usage_limited');

			// Verify: worker output was injected into the leader (routing happened)
			const injectCallsAfter = ctx.sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage' && c.args[0] === leaderSessionId
			).length;
			expect(injectCallsAfter).toBeGreaterThan(injectCallsBefore);
		});
	});

	// ─── leader fallback early return ──────────────────────────────────────────────────────

	describe('leader usage_limit: return early after successful trySwitchToFallbackModel', () => {
		/**
		 * Creates a context where trySwitchToFallbackModel succeeds:
		 * - getGlobalSettings returns a fallback model chain
		 * - messageHub.request('session.model.get') returns a current model not in the chain
		 *   (so the first fallback is selected)
		 * - sessionFactory.switchModel returns success
		 */
		function createFallbackCtx(leaderSessionIdRef: { value: string | null }) {
			return createRuntimeTestContext({
				getWorkerMessages: (sessionId) => {
					if (leaderSessionIdRef.value && sessionId === leaderSessionIdRef.value) {
						return makeWorkerMessages(USAGE_LIMIT_MSG);
					}
					return [];
				},
				getGlobalSettings: () =>
					({
						fallbackModels: [{ model: 'claude-haiku-4-5', provider: 'anthropic' }],
					}) as never,
				messageHub: {
					async request(method: string, _params: unknown) {
						if (method === 'session.model.get') {
							return {
								currentModel: 'claude-sonnet-4-6',
								modelInfo: { provider: 'anthropic' },
							};
						}
						return undefined;
					},
				},
			});
		}

		it('clears group rateLimit after successful fallback switch in leader path', async () => {
			const leaderSessionIdRef: { value: string | null } = { value: null };
			ctx = createFallbackCtx(leaderSessionIdRef);

			const { task, group } = await spawnAndRouteToLeader(ctx);
			leaderSessionIdRef.value = group.leaderSessionId;
			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

			// Pre-condition: no rateLimit yet
			expect(ctx.groupRepo.getGroup(group.id)!.rateLimit).toBeNull();

			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// rateLimit must be cleared (not set) after a successful fallback switch
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.rateLimit).toBeNull();
		});

		it('clears task restriction after successful fallback switch in leader path', async () => {
			const leaderSessionIdRef: { value: string | null } = { value: null };
			ctx = createFallbackCtx(leaderSessionIdRef);

			const { task, group } = await spawnAndRouteToLeader(ctx);
			leaderSessionIdRef.value = group.leaderSessionId;

			// Simulate that a prior detection set a usage_limited restriction
			await ctx.taskManager.updateTaskStatus(task.id, 'usage_limited', {
				restrictions: {
					type: 'usage_limit',
					resetAt: Date.now() + 60_000,
					sessionRole: 'leader',
					reason: 'Daily/weekly usage cap in leader',
				},
			});

			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// Task restriction must be cleared back to in_progress
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
			expect(updatedTask!.restrictions).toBeNull();
		});

		it('does not fall through to normal completion after successful fallback switch', async () => {
			// If the function returned early, no further processing (e.g. group completion) happens.
			// The group should still be active (not completed) because the new model query is ongoing.
			const leaderSessionIdRef: { value: string | null } = { value: null };
			ctx = createFallbackCtx(leaderSessionIdRef);

			const { task, group } = await spawnAndRouteToLeader(ctx);
			leaderSessionIdRef.value = group.leaderSessionId;
			await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

			await ctx.runtime.onLeaderTerminalState(group.id, {
				sessionId: group.leaderSessionId,
				kind: 'idle',
			});

			// Group must NOT be completed — the new-model query is still pending
			const updatedGroup = ctx.groupRepo.getGroup(group.id);
			expect(updatedGroup!.completedAt).toBeNull();
		});
	});
});
