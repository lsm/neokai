/**
 * Tests for model-specific fallback mappings in trySwitchToFallbackModel().
 *
 * Verifies:
 * - When the current model has an entry in modelFallbackMap, that chain is used instead of
 *   the default fallbackModels list
 * - When the current model has NO entry in modelFallbackMap, the default fallbackModels list
 *   is used as a catch-all
 * - When neither modelFallbackMap nor fallbackModels is configured, no switch occurs
 * - Model-specific chain always starts from index 0 (not from currentIndex + 1)
 * - Provider availability checks still work for model-specific chains
 * - Same-model skip guard still applies for model-specific chains
 */

import { describe, expect, it, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';
import type { GlobalSettings } from '@neokai/shared';

describe('RoomRuntime - modelFallbackMap in trySwitchToFallbackModel', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	const USAGE_LIMIT_MSG = "You've hit your limit · resets 11pm (America/New_York)";

	function makeWorkerMessages(text: string) {
		return [{ id: 'msg-1', text, toolCallNames: [] }];
	}

	function makeGetCurrentModel(currentModel: string, provider: string = 'anthropic') {
		return async (_sessionId: string) => ({ currentModel, provider });
	}

	function makeGlobalSettings(overrides: Partial<GlobalSettings>): () => GlobalSettings {
		return () => overrides as unknown as GlobalSettings;
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

	describe('model-specific map takes priority over default list', () => {
		it('uses the model-specific chain when current model has a mapping', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings({
					// Default list: haiku first
					fallbackModels: [
						{ model: 'haiku', provider: 'anthropic' },
						{ model: 'glm-4', provider: 'glm' },
					],
					// Model-specific: sonnet → minimax first
					modelFallbackMap: {
						'anthropic/sonnet': [
							{ model: 'minimax-turbo', provider: 'minimax' },
							{ model: 'glm-4', provider: 'glm' },
						],
					},
				}),
				getCurrentModelImpl: makeGetCurrentModel('sonnet', 'anthropic'),
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// Should use model-specific chain (minimax first), NOT the default (haiku first)
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('minimax-turbo');
			expect(switchCalls[0].args[2]).toBe('minimax');
		});

		it('uses default fallbackModels when current model has no mapping', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings({
					fallbackModels: [
						{ model: 'haiku', provider: 'anthropic' },
						{ model: 'glm-4', provider: 'glm' },
					],
					modelFallbackMap: {
						// Only opus has a mapping; current model is sonnet → no mapping
						'anthropic/opus': [{ model: 'glm-4', provider: 'glm' }],
					},
				}),
				getCurrentModelImpl: makeGetCurrentModel('sonnet', 'anthropic'),
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// No model-specific mapping for anthropic/sonnet → falls back to default list
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('haiku');
			expect(switchCalls[0].args[2]).toBe('anthropic');
		});
	});

	describe('model-specific chain always starts from index 0', () => {
		it('starts at index 0 of model-specific chain regardless of current model position', async () => {
			// Even though the current model matches chain[0], we should NOT advance past it
			// (the model-specific chain is a dedicated replacement chain, always start fresh)
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings({
					modelFallbackMap: {
						'anthropic/sonnet': [
							{ model: 'minimax-turbo', provider: 'minimax' },
							{ model: 'glm-4', provider: 'glm' },
						],
					},
				}),
				getCurrentModelImpl: makeGetCurrentModel('sonnet', 'anthropic'),
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// Should start from minimax-turbo (index 0), not skip it
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('minimax-turbo');
		});
	});

	describe('same-model skip guard still works for model-specific chain', () => {
		it('skips a model-specific chain entry that matches the current model', async () => {
			// chain[0] is sonnet (same as current) → should be skipped → use glm-4
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings({
					modelFallbackMap: {
						'anthropic/sonnet': [
							{ model: 'sonnet', provider: 'anthropic' }, // same as current → skip
							{ model: 'glm-4', provider: 'glm' },
						],
					},
				}),
				getCurrentModelImpl: makeGetCurrentModel('sonnet', 'anthropic'),
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// chain[0] is sonnet (same as current) → skipped; chain[1] glm-4 → used
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('glm-4');
		});
	});

	describe('provider availability checks work for model-specific chains', () => {
		it('skips unavailable providers in model-specific chain and uses the next one', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings({
					modelFallbackMap: {
						'anthropic/sonnet': [
							{ model: 'minimax-turbo', provider: 'minimax' }, // unavailable
							{ model: 'glm-4', provider: 'glm' }, // available
						],
					},
				}),
				getCurrentModelImpl: makeGetCurrentModel('sonnet', 'anthropic'),
				isProviderAvailable: async (provider, model) => {
					if (provider === 'minimax' && model === 'minimax-turbo') return false;
					return true;
				},
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// minimax-turbo unavailable → skipped; glm-4 available → used
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('glm-4');
		});

		it('returns false when all model-specific chain entries are unavailable', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings({
					// Default list has haiku available — but model-specific map should be used
					// and all its entries are unavailable
					fallbackModels: [{ model: 'haiku', provider: 'anthropic' }],
					modelFallbackMap: {
						'anthropic/sonnet': [
							{ model: 'minimax-turbo', provider: 'minimax' },
							{ model: 'glm-4', provider: 'glm' },
						],
					},
				}),
				getCurrentModelImpl: makeGetCurrentModel('sonnet', 'anthropic'),
				isProviderAvailable: async () => false,
			});

			const { group, task } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// Both model-specific entries unavailable → no switch, even though default list has haiku
			expect(switchCalls.length).toBe(0);

			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.status).toBe('usage_limited');
		});
	});

	describe('fallback when modelFallbackMap is defined but empty', () => {
		it('falls back to default fallbackModels when map is empty object', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings({
					fallbackModels: [{ model: 'haiku', provider: 'anthropic' }],
					modelFallbackMap: {}, // empty map, no matching key
				}),
				getCurrentModelImpl: makeGetCurrentModel('sonnet', 'anthropic'),
			});

			const { group } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			// No mapping for anthropic/sonnet → uses default fallbackModels → haiku
			expect(switchCalls.length).toBe(1);
			expect(switchCalls[0].args[1]).toBe('haiku');
		});
	});

	describe('no fallback configured at all', () => {
		it('returns false immediately when neither modelFallbackMap nor fallbackModels is set', async () => {
			ctx = createRuntimeTestContext({
				getWorkerMessages: () => makeWorkerMessages(USAGE_LIMIT_MSG),
				getGlobalSettings: makeGlobalSettings({}),
				getCurrentModelImpl: makeGetCurrentModel('sonnet', 'anthropic'),
			});

			const { group, task } = await spawnGroup();
			await ctx.runtime.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			expect(switchCalls.length).toBe(0);

			const updated = await ctx.taskManager.getTask(task.id);
			expect(updated!.status).toBe('usage_limited');
		});
	});
});
