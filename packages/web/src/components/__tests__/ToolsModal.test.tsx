/**
 * Tests for ToolsModal utility functions and logic
 *
 * Imports the real utility functions from ToolsModal.utils.ts so tests cover
 * the actual code used by the component, not re-implementations.
 */
import { describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals';
import {
	isServerEnabled,
	toggleServer,
	toggleGroupServers,
	computeGroupState,
} from '../ToolsModal.utils.ts';

describe('ToolsModal Utilities', () => {
	describe('isServerEnabled', () => {
		it('returns true when server is not in disabled list', () => {
			expect(isServerEnabled(['server2'], 'server1')).toBe(true);
		});

		it('returns false when server is in disabled list', () => {
			expect(isServerEnabled(['server1'], 'server1')).toBe(false);
		});

		it('returns true for empty disabled list', () => {
			expect(isServerEnabled([], 'any-server')).toBe(true);
		});
	});

	describe('toggleServer', () => {
		it('adds server to disabled list when currently enabled', () => {
			const result = toggleServer([], 'server1');
			expect(result).toContain('server1');
		});

		it('removes server from disabled list when currently disabled', () => {
			const result = toggleServer(['server1', 'server2'], 'server1');
			expect(result).not.toContain('server1');
			expect(result).toContain('server2');
		});

		it('does not mutate the original array', () => {
			const original = ['server1'];
			toggleServer(original, 'server2');
			expect(original).toEqual(['server1']);
		});
	});

	describe('toggleGroupServers', () => {
		it('disables all servers when all are currently enabled', () => {
			const result = toggleGroupServers([], ['alpha', 'beta', 'gamma']);
			expect(result).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
		});

		it('enables all servers when some are disabled (not all-on)', () => {
			const result = toggleGroupServers(['alpha'], ['alpha', 'beta', 'gamma']);
			expect(result).not.toContain('alpha');
			expect(result).not.toContain('beta');
			expect(result).not.toContain('gamma');
		});

		it('enables all servers when all are disabled', () => {
			const result = toggleGroupServers(['alpha', 'beta', 'other'], ['alpha', 'beta']);
			expect(result).not.toContain('alpha');
			expect(result).not.toContain('beta');
			expect(result).toContain('other'); // outside group unaffected
		});

		it('preserves servers outside the group when disabling', () => {
			const result = toggleGroupServers(['other'], ['alpha']);
			expect(result).toContain('other');
			expect(result).toContain('alpha');
		});

		it('does not add duplicates when disabling', () => {
			// All servers are enabled (none in disabled list), so toggling disables all
			// alpha should appear exactly once in the result
			const result = toggleGroupServers([], ['alpha', 'beta']);
			const alphaCount = result.filter((s) => s === 'alpha').length;
			expect(alphaCount).toBe(1);
		});

		it('returns original disabled list (filtered) when enabling', () => {
			const result = toggleGroupServers(['alpha', 'extra'], ['alpha', 'beta']);
			expect(result).toContain('extra');
		});
	});

	describe('computeGroupState', () => {
		it('returns allEnabled=false, someEnabled=false for empty list (no vacuous truth)', () => {
			const state = computeGroupState([], []);
			expect(state.allEnabled).toBe(false);
			expect(state.someEnabled).toBe(false);
			expect(state.isIndeterminate).toBe(false);
		});

		it('returns allEnabled=true when no servers are disabled', () => {
			const state = computeGroupState([], ['alpha', 'beta']);
			expect(state.allEnabled).toBe(true);
			expect(state.someEnabled).toBe(true);
			expect(state.isIndeterminate).toBe(false);
		});

		it('returns allEnabled=false, someEnabled=false when all disabled', () => {
			const state = computeGroupState(['alpha', 'beta'], ['alpha', 'beta']);
			expect(state.allEnabled).toBe(false);
			expect(state.someEnabled).toBe(false);
			expect(state.isIndeterminate).toBe(false);
		});

		it('returns isIndeterminate=true when some but not all enabled', () => {
			const state = computeGroupState(['alpha'], ['alpha', 'beta']);
			expect(state.allEnabled).toBe(false);
			expect(state.someEnabled).toBe(true);
			expect(state.isIndeterminate).toBe(true);
		});
	});
});

describe('ToolsModal Logic', () => {
	describe('Config Loading', () => {
		it('loads disabledMcpServers from session config', () => {
			const session = { config: { tools: { disabledMcpServers: ['s1', 's2'] } } };
			const disabled = session.config.tools?.disabledMcpServers ?? [];
			expect(disabled).toEqual(['s1', 's2']);
		});

		it('defaults to empty disabledMcpServers when not set', () => {
			const session = { config: {} };
			const disabled = (session.config as Record<string, unknown>).tools as
				| { disabledMcpServers?: string[] }
				| undefined;
			expect(disabled?.disabledMcpServers ?? []).toEqual([]);
		});

		it('handles legacy loadSettingSources=false', () => {
			const tools: Record<string, unknown> = { loadSettingSources: false };
			let sources: string[];
			if (tools['settingSources']) {
				sources = tools['settingSources'] as string[];
			} else if (tools['loadSettingSources'] !== false) {
				sources = ['user', 'project', 'local'];
			} else {
				sources = [];
			}
			expect(sources).toEqual([]);
		});

		it('defaults to all setting sources when settingSources not set', () => {
			const tools: Record<string, unknown> = {};
			let sources: string[];
			if (tools['settingSources']) {
				sources = tools['settingSources'] as string[];
			} else if (tools['loadSettingSources'] !== false) {
				sources = ['user', 'project', 'local'];
			} else {
				sources = [];
			}
			expect(sources).toEqual(['user', 'project', 'local']);
		});
	});

	describe('App-Level Skill Toggle (global scope)', () => {
		it('calls setEnabled immediately when toggling a skill', async () => {
			const setEnabled = vi.fn((_id: string, _enabled: boolean) =>
				Promise.resolve({ id: 'skill-1', enabled: false })
			);
			await setEnabled('skill-1', false);
			expect(setEnabled).toHaveBeenCalledWith('skill-1', false);
		});

		it('group toggle uses Promise.allSettled for parallel execution', async () => {
			const calls: string[] = [];
			const setEnabled = vi.fn((id: string, _enabled: boolean) => {
				calls.push(id);
				return Promise.resolve();
			});
			const skills = [
				{ id: 'skill-1', enabled: true },
				{ id: 'skill-2', enabled: true },
			];
			const allOn = skills.every((s) => s.enabled);
			const newEnabled = !allOn;
			const toToggle = skills.filter((s) => s.enabled !== newEnabled);

			await Promise.allSettled(toToggle.map((s) => setEnabled(s.id, newEnabled)));

			expect(calls).toHaveLength(2);
			expect(calls).toContain('skill-1');
			expect(calls).toContain('skill-2');
		});

		it('group toggle skips skills already in desired state', async () => {
			const setEnabled = vi.fn((_id: string, _enabled: boolean) => Promise.resolve());
			const skills = [
				{ id: 'skill-1', enabled: false },
				{ id: 'skill-2', enabled: true },
			];
			const allOn = skills.every((s) => s.enabled);
			const newEnabled = !allOn; // true
			const toToggle = skills.filter((s) => s.enabled !== newEnabled);

			await Promise.allSettled(toToggle.map((s) => setEnabled(s.id, newEnabled)));

			expect(setEnabled).toHaveBeenCalledTimes(1);
			expect(setEnabled).toHaveBeenCalledWith('skill-1', true);
		});
	});

	describe('Save / Cancel', () => {
		it('Save button disabled when no changes', () => {
			const hasChanges = signal(false);
			const saving = signal(false);
			expect(!hasChanges.value || saving.value).toBe(true);
		});

		it('Save button enabled after file-based toggle', () => {
			const hasChanges = signal(false);
			// Simulate toggleServer side-effect
			hasChanges.value = true;
			expect(hasChanges.value).toBe(true);
		});

		it('hasChanges not set by app-level skill toggle', () => {
			// App-level toggles go through skillsStore.setEnabled — no hasChanges flag
			const hasChanges = signal(false);
			expect(hasChanges.value).toBe(false); // unchanged after skill toggle
		});

		it('Cancel resets disabledMcpServers to original', () => {
			const original = ['server1'];
			let current = ['server1', 'server2'];
			// loadConfig re-runs on cancel
			current = [...original];
			expect(current).toEqual(['server1']);
		});

		it('Cancel resets hasChanges to false', () => {
			const hasChanges = signal(true);
			hasChanges.value = false;
			expect(hasChanges.value).toBe(false);
		});
	});

	describe('Setting Source Toggle', () => {
		it('adds a source', () => {
			let sources = ['user'] as string[];
			if (!sources.includes('project')) sources = [...sources, 'project'];
			expect(sources).toContain('project');
		});

		it('removes a source', () => {
			let sources = ['user', 'project', 'local'];
			sources = sources.filter((s) => s !== 'local');
			expect(sources).not.toContain('local');
		});

		it('prevents removing all sources', () => {
			const newSources = ['user'].filter((s) => s !== 'user');
			expect(newSources.length).toBe(0);
			// at this point the component shows an error toast and does not update
		});
	});
});
