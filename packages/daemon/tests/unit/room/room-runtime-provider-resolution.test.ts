/**
 * Tests for RoomRuntime.resolveAgentModelWithProvider()
 *
 * Regression coverage for the bug where `claude-opus-4.6` resolved to
 * `provider: 'anthropic-copilot'` instead of `'anthropic'`.
 *
 * The fix has two parts:
 * 1. anthropic-provider.ts: isFullVersionId() now recognises dot-notation IDs
 *    (claude-opus-4.6) so they are correctly deduplicated when the SDK also
 *    returns the canonical 'opus' alias.
 * 2. room-runtime.ts: resolveAgentModelWithProvider() falls back to the
 *    registry's detectProvider() when the model is absent from the model cache,
 *    ensuring 'claude-*' models always resolve to 'anthropic' rather than to
 *    whichever provider happens to claim them first in the cache.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearModelsCache, setModelsCache } from '../../../src/lib/model-service';
import { createRuntimeTestContext, type RuntimeTestContext } from './room-runtime-test-helpers';
import type { ModelInfo } from '@neokai/shared';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeModelInfo(
	overrides: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'provider'>
): ModelInfo {
	return {
		name: overrides.id,
		alias: overrides.id,
		family: 'opus',
		contextWindow: 200000,
		description: '',
		releaseDate: '',
		available: true,
		...overrides,
	};
}

function setTestModelsCache(models: ModelInfo[]): void {
	const cache = new Map<string, ModelInfo[]>();
	cache.set('global', models);
	setModelsCache(cache);
}

async function spawnTask(ctx: RuntimeTestContext) {
	const goal = await ctx.goalManager.createGoal({
		title: 'Test goal',
		description: 'desc',
		status: 'active',
		priority: 'normal',
		linkedTaskIds: [],
	});
	await ctx.taskManager.createTask({
		title: 'Test task',
		description: 'desc',
		status: 'pending',
		priority: 'normal',
		goalId: goal.id,
	});
	ctx.runtime.start();
	await ctx.runtime.tick();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RoomRuntime.resolveAgentModelWithProvider — model cache lookup', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		clearModelsCache();
	});

	afterEach(() => {
		ctx?.runtime.stop();
		ctx?.db.close();
		clearModelsCache();
	});

	it('resolves provider from cache — Anthropic entry found first for claude-opus-4.6', async () => {
		// Both Anthropic and Copilot have the same model ID in cache.
		// Anthropic's entry is first (providers are registered/loaded in that order).
		setTestModelsCache([
			makeModelInfo({ id: 'claude-opus-4.6', provider: 'anthropic' }),
			makeModelInfo({ id: 'claude-opus-4.6', provider: 'anthropic-copilot' }),
		]);

		ctx = createRuntimeTestContext({
			room: { defaultModel: 'claude-opus-4.6' },
		});

		await spawnTask(ctx);

		const leaderCall = ctx.sessionFactory.calls.find(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCall).toBeDefined();
		const leaderInit = leaderCall!.args[0] as { provider?: string };
		// First match in cache is Anthropic's entry → routes to anthropic
		expect(leaderInit.provider).toBe('anthropic');
	});

	it('falls back to undefined provider when model is absent from cache', async () => {
		// Cache has no entry for 'claude-opus-4.6'.
		// In unit tests the provider registry is empty (setup.ts resets it),
		// so detectProvider() returns undefined. The important thing is that the
		// code reaches the fallback path rather than crashing.
		setTestModelsCache([
			makeModelInfo({ id: 'opus', provider: 'anthropic' }),
			makeModelInfo({ id: 'sonnet', provider: 'anthropic' }),
		]);

		ctx = createRuntimeTestContext({
			room: { defaultModel: 'claude-opus-4.6' },
		});

		await spawnTask(ctx);

		const leaderCall = ctx.sessionFactory.calls.find(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCall).toBeDefined();
		// In unit tests, registry is empty → detectProvider returns undefined.
		// The spawn still succeeds (provider is optional in AgentSessionInit).
		const leaderInit = leaderCall!.args[0] as { provider?: string };
		expect(leaderInit.provider).toBeUndefined();
	});

	it('resolves anthropic-copilot when only Copilot has the model in cache', async () => {
		// Only Copilot has 'claude-opus-4.6' in cache → should route to copilot
		setTestModelsCache([
			makeModelInfo({ id: 'opus', provider: 'anthropic' }),
			makeModelInfo({ id: 'claude-opus-4.6', provider: 'anthropic-copilot' }),
		]);

		ctx = createRuntimeTestContext({
			room: { defaultModel: 'claude-opus-4.6' },
		});

		await spawnTask(ctx);

		const leaderCall = ctx.sessionFactory.calls.find(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCall).toBeDefined();
		const leaderInit = leaderCall!.args[0] as { provider?: string };
		expect(leaderInit.provider).toBe('anthropic-copilot');
	});

	it('resolves anthropic for canonical opus model', async () => {
		setTestModelsCache([makeModelInfo({ id: 'opus', provider: 'anthropic' })]);

		ctx = createRuntimeTestContext({
			room: { defaultModel: 'opus' },
		});

		await spawnTask(ctx);

		const leaderCall = ctx.sessionFactory.calls.find(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCall).toBeDefined();
		const leaderInit = leaderCall!.args[0] as { provider?: string };
		expect(leaderInit.provider).toBe('anthropic');
	});

	it('provider propagates to both worker and leader sessions', async () => {
		setTestModelsCache([makeModelInfo({ id: 'claude-opus-4.6', provider: 'anthropic' })]);

		ctx = createRuntimeTestContext({
			room: {
				defaultModel: 'claude-opus-4.6',
				config: {
					agentModels: {
						leader: 'claude-opus-4.6',
						coder: 'claude-opus-4.6',
					},
				},
			},
		});

		await spawnTask(ctx);

		const sessionInits = ctx.sessionFactory.calls
			.filter((c) => c.method === 'createAndStartSession')
			.map((c) => c.args[0] as { provider?: string });

		expect(sessionInits.length).toBeGreaterThanOrEqual(2); // at least worker + leader
		for (const init of sessionInits) {
			expect(init.provider).toBe('anthropic');
		}
	});
});
