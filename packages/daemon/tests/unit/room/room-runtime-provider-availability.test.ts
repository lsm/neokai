/**
 * Tests for provider availability checking in trySwitchToFallbackModel().
 *
 * Verifies:
 * - When isProviderAvailable is NOT configured, first valid fallback is used (backward compat)
 * - When isProviderAvailable is configured and returns true, switch proceeds normally
 * - When isProviderAvailable returns false for a candidate, that candidate is skipped
 * - When all candidates are unavailable, returns false (no switch attempted)
 * - Works when current model is NOT in the fallback chain (starts from index 0)
 * - Works when current model IS in the fallback chain (starts from currentIndex + 1)
 */

import { describe, expect, it, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';
import type { GlobalSettings } from '@neokai/shared';

describe('RoomRuntime - isProviderAvailable in trySwitchToFallbackModel', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	const USAGE_LIMIT_MSG = "You've hit your limit · resets 11pm (America/New_York)";

	function makeWorkerMessages(text: string) {
		return [{ id: 'msg-1', text, toolCallNames: [] }];
	}

	/**
	 * Create a messageHub mock that responds to 'session.model.get' with the
	 * given current model / provider.
	 */
	function makeMessageHub(currentModel: string, provider: string = 'anthropic') {
		return {
			async request(method: string, _args: unknown): Promise<unknown> {
				if (method === 'session.model.get') {
					return {
						currentModel,
						modelInfo: { provider },
					};
				}
				return undefined;
			},
		};
	}

	function makeGlobalSettings(
		fallbackModels: Array<{ model: string; provider: string }>
	): () => GlobalSettings {
		return () =>
			({
				fallbackModels,
			}) as unknown as GlobalSettings;
	}

	async function spawnGroup() {
		const { task } = await createGoalAndTask(ctx);
		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];
		await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');
		return { group, task };
	}

	describe('backward compatibility — no isProviderAvailable callback', () => {
		it('uses first fallback in chain without any availability check', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings([
					{ model: 'haiku', provider: 'anthropic' },
					{ model: 'glm-4', provider: 'glm' },
				]),
				messageHub: makeMessageHub('not-in-chain', 'anthropic'),
				// isProviderAvailable intentionally omitted
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// Should have switched to 'haiku' (first in chain) without any availability check
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('haiku');
			expect(switchCalls[0].args[2]).toBe('anthropic');
		});
	});

	describe('isProviderAvailable returns true', () => {
		it('proceeds with the first valid fallback when provider is available', async () => {
			const availabilityChecks: Array<{ provider: string; model: string }> = [];

			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings([
					{ model: 'haiku', provider: 'anthropic' },
					{ model: 'glm-4', provider: 'glm' },
				]),
				messageHub: makeMessageHub('not-in-chain', 'anthropic'),
				isProviderAvailable: async (provider, model) => {
					availabilityChecks.push({ provider, model });
					return true;
				},
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// Should have checked haiku/anthropic availability first
			expect(availabilityChecks.length).toBeGreaterThanOrEqual(1);
			expect(availabilityChecks[0]).toEqual({ provider: 'anthropic', model: 'haiku' });

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('haiku');
		});
	});

	describe('isProviderAvailable returns false — skip to next fallback', () => {
		it('skips unavailable providers and uses the next available fallback', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings([
					{ model: 'haiku', provider: 'anthropic' },
					{ model: 'glm-4', provider: 'glm' },
					{ model: 'sonnet', provider: 'anthropic' },
				]),
				messageHub: makeMessageHub('not-in-chain', 'other'),
				isProviderAvailable: async (provider, model) => {
					// anthropic/haiku is down, glm/glm-4 is down, anthropic/sonnet is up
					if (provider === 'anthropic' && model === 'haiku') return false;
					if (provider === 'glm' && model === 'glm-4') return false;
					return true;
				},
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// Should skip haiku and glm-4, and switch to sonnet
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('sonnet');
			expect(switchCalls[0].args[2]).toBe('anthropic');
		});

		it('returns false (no switch) when all fallbacks are unavailable', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings([
					{ model: 'haiku', provider: 'anthropic' },
					{ model: 'glm-4', provider: 'glm' },
				]),
				messageHub: makeMessageHub('not-in-chain', 'other'),
				isProviderAvailable: async () => false, // all providers down
			});

			const { group, task } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			// No switchModel calls should have been made
			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			expect(switchCalls.length).toBe(0);

			// Task should be usage_limited since no fallback could be found
			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.status).toBe('usage_limited');
		});
	});

	describe('chain traversal when current model is IN the fallback chain', () => {
		it('starts from currentIndex + 1 and skips unavailable entries', async () => {
			// Current model is haiku/anthropic (index 0 in chain)
			// Chain: haiku(0) → glm-4(1) → sonnet(2)
			// glm-4 is unavailable, so should skip to sonnet
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings([
					{ model: 'haiku', provider: 'anthropic' },
					{ model: 'glm-4', provider: 'glm' },
					{ model: 'sonnet', provider: 'anthropic' },
				]),
				messageHub: makeMessageHub('haiku', 'anthropic'),
				isProviderAvailable: async (provider, model) => {
					if (provider === 'glm' && model === 'glm-4') return false;
					return true;
				},
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// haiku is current (skipped as same), glm-4 is unavailable (skipped), sonnet is used
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('sonnet');
		});

		it('returns false when current model is last in chain with no more candidates', async () => {
			// Current model is the last in the chain — no next index exists
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings([
					{ model: 'haiku', provider: 'anthropic' },
					{ model: 'sonnet', provider: 'anthropic' },
				]),
				messageHub: makeMessageHub('sonnet', 'anthropic'),
				isProviderAvailable: async () => true,
			});

			const { group, task } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// sonnet is current and last in chain — no fallback available
			expect(switchCalls.length).toBe(0);

			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.status).toBe('usage_limited');
		});
	});

	describe('same-model skip guard', () => {
		it('skips a fallback entry that matches the current model even if not via chain index', async () => {
			// Current model is NOT in chain (index -1), but chain[0] happens to be the same model
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings([
					{ model: 'haiku', provider: 'anthropic' },
					{ model: 'glm-4', provider: 'glm' },
				]),
				messageHub: makeMessageHub('haiku', 'anthropic'), // same as chain[0]
				isProviderAvailable: async () => true,
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// haiku is current → skipped; glm-4 is next → used
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('glm-4');
		});
	});
});
