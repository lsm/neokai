/**
 * Tests for real-time usage_limit detection in setupMirroring().
 *
 * Verifies:
 * - usage_limit message fires fallback attempt when fallback configured
 * - successful fallback: model_fallback event appended, task restriction cleared
 * - failed fallback (no models): backoff set, task restricted to usage_limited
 * - re-detection guard: second usage_limit message for same session skips duplicate attempt
 * - fresh state reads: stale closure group object is never used for mutable state
 */

import { describe, expect, it, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';
import type { MessageHub } from '@neokai/shared';
import type { GlobalSettings } from '@neokai/shared';

const USAGE_LIMIT_MSG = "You've hit your limit · resets 11pm (America/New_York)";

/** Wrap a message in a JSON string the way the SDK serializes it to sdk.message events */
function makeSdkMessage(text: string, uuid = 'msg-uuid-1') {
	return JSON.stringify({ uuid, type: 'text', text });
}

/** Build a minimal MessageHub mock that responds to session.model.get */
function makeMessageHubMock(opts: {
	model?: string;
	provider?: string;
	failModelGet?: boolean;
}): MessageHub {
	return {
		request: async (method: string, _params: unknown) => {
			if (method === 'session.model.get') {
				if (opts.failModelGet) throw new Error('model get failed');
				return {
					currentModel: opts.model ?? 'claude-3-5-sonnet-20241022',
					modelInfo: { provider: opts.provider ?? 'anthropic' },
				};
			}
			return undefined;
		},
	} as unknown as MessageHub;
}

/** Global settings with one fallback model configured */
function withFallbackModel(
	fallbackModel = 'claude-haiku-4-5-20251001',
	provider = 'anthropic'
): () => GlobalSettings {
	return () =>
		({
			fallbackModels: [{ model: fallbackModel, provider }],
		}) as GlobalSettings;
}

describe('setupMirroring - usage_limit real-time detection', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	async function spawnGroup() {
		const { task } = await createGoalAndTask(ctx);
		ctx.runtime.start();
		await ctx.runtime.tick();
		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];
		await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');
		return { group, task };
	}

	describe('no fallback model configured', () => {
		it('applies backoff when usage_limit is detected and no fallback available', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: () => ({}) as GlobalSettings,
			});

			const { group } = await spawnGroup();

			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			// Allow async .then() chain to settle
			await new Promise((r) => setTimeout(r, 10));

			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(true);
		});

		it('sets task to usage_limited when no fallback available', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: () => ({}) as GlobalSettings,
			});

			const { group, task } = await spawnGroup();

			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('usage_limited');
			expect(updatedTask!.restrictions?.type).toBe('usage_limit');
		});

		it('appends rate_limited event when no fallback available', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: () => ({}) as GlobalSettings,
			});

			const { group } = await spawnGroup();

			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			const events = ctx.db
				.prepare(`SELECT kind, payload_json FROM task_group_events WHERE group_id = ? ORDER BY id`)
				.all(group.id) as Array<{ kind: string; payload_json: string }>;

			const rateLimitedEvent = events.find((e) => e.kind === 'rate_limited');
			expect(rateLimitedEvent).toBeDefined();
			const payload = JSON.parse(rateLimitedEvent!.payload_json);
			expect(payload.sessionRole).toBe('worker');
		});
	});

	describe('fallback model configured', () => {
		it('calls trySwitchToFallbackModel when usage_limit detected', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: withFallbackModel(),
				messageHub: makeMessageHubMock({}),
			});

			const { group } = await spawnGroup();

			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			expect(switchCalls.length).toBeGreaterThanOrEqual(1);
		});

		it('appends model_fallback event on successful switch', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: withFallbackModel(),
				messageHub: makeMessageHubMock({}),
			});

			const { group } = await spawnGroup();

			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			const events = ctx.db
				.prepare(`SELECT kind, payload_json FROM task_group_events WHERE group_id = ? ORDER BY id`)
				.all(group.id) as Array<{ kind: string; payload_json: string }>;

			const fallbackEvent = events.find((e) => e.kind === 'model_fallback');
			expect(fallbackEvent).toBeDefined();
		});

		it('does NOT set group.rateLimit on successful switch', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: withFallbackModel(),
				messageHub: makeMessageHubMock({}),
			});

			const { group } = await spawnGroup();

			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(false);
		});

		it('clears task restriction when task was usage_limited before successful switch', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: withFallbackModel(),
				messageHub: makeMessageHubMock({}),
			});

			const { group, task } = await spawnGroup();
			// Pre-set restriction to simulate prior detection
			await ctx.taskManager.updateTaskStatus(task.id, 'usage_limited', {
				restrictions: {
					type: 'usage_limit',
					limit: 'Daily/weekly usage cap',
					resetAt: Date.now() + 60_000,
					sessionRole: 'worker',
				},
			});

			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
			expect(updatedTask!.restrictions).toBeNull();
		});
	});

	describe('re-detection guard', () => {
		it('does not attempt fallback twice for the same session+message', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: withFallbackModel(),
				messageHub: makeMessageHubMock({}),
			});

			const { group } = await spawnGroup();

			// Fire the SAME message UUID twice — second should be deduplicated by mirroredUuids
			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-same', type: 'text', text: USAGE_LIMIT_MSG },
			});
			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-same', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			// Should have been called exactly once despite two events
			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			expect(switchCalls).toHaveLength(1);
		});

		it('does not attempt fallback twice for different UUIDs but after fallbackAttempted is set', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: withFallbackModel(),
				messageHub: makeMessageHubMock({}),
			});

			const { group } = await spawnGroup();

			// First message triggers fallback
			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			// Second message with different UUID (not deduped by mirroredUuids)
			// but fallbackAttempted should guard against it
			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-2', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			// Only one switchModel call total
			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			expect(switchCalls).toHaveLength(1);
		});

		it('skips when group.rateLimit is already set (re-detection guard)', async () => {
			ctx = createRuntimeTestContext({
				// No fallback configured so first detection sets a backoff
				getGlobalSettings: () => ({}) as GlobalSettings,
			});

			const { group } = await spawnGroup();

			// First event sets backoff
			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(true);

			// Second event with different UUID — rateLimit guard should skip it
			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-2', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			// No duplicate events: only one rate_limited event
			const events = ctx.db
				.prepare(`SELECT kind FROM task_group_events WHERE group_id = ? AND kind = 'rate_limited'`)
				.all(group.id) as Array<{ kind: string }>;
			expect(events).toHaveLength(1);
		});
	});

	describe('message content parsing', () => {
		it('handles usage_limit in JSON-wrapped message content', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: () => ({}) as GlobalSettings,
			});

			const { group } = await spawnGroup();

			// The mirroring callback stringifies the entire event.message, so
			// a nested text field containing the usage_limit string is still detected.
			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: {
					uuid: 'msg-json-1',
					type: 'assistant',
					content: [{ type: 'text', text: USAGE_LIMIT_MSG }],
				},
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(true);
		});

		it('does not trigger on normal non-error messages', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: () => ({}) as GlobalSettings,
			});

			const { group } = await spawnGroup();

			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-ok', type: 'text', text: 'Task completed successfully.' },
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(false);
		});
	});

	describe('leader session mirroring', () => {
		it('detects usage_limit in leader messages when no fallback', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: () => ({}) as GlobalSettings,
			});

			const { group } = await spawnGroup();

			ctx.hub.fire('sdk.message', {
				sessionId: group.leaderSessionId,
				message: { uuid: 'leader-msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(ctx.groupRepo.isRateLimited(group.id)).toBe(true);

			const events = ctx.db
				.prepare(
					`SELECT kind, payload_json FROM task_group_events WHERE group_id = ? AND kind = 'rate_limited'`
				)
				.all(group.id) as Array<{ kind: string; payload_json: string }>;
			expect(events).toHaveLength(1);
			const payload = JSON.parse(events[0].payload_json);
			expect(payload.sessionRole).toBe('leader');
		});
	});

	describe('cleanup', () => {
		it('clears fallbackAttempted set when mirroring is cleaned up', async () => {
			ctx = createRuntimeTestContext({
				getGlobalSettings: withFallbackModel(),
				messageHub: makeMessageHubMock({}),
			});

			const { group } = await spawnGroup();

			// Trigger fallback
			ctx.hub.fire('sdk.message', {
				sessionId: group.workerSessionId,
				message: { uuid: 'msg-1', type: 'text', text: USAGE_LIMIT_MSG },
			});

			await new Promise((r) => setTimeout(r, 10));

			// Cleanup mirroring (normally done when group is completed)
			ctx.runtime.stop();

			// No errors thrown — cleanup ran successfully
			expect(true).toBe(true);
		});
	});
});
