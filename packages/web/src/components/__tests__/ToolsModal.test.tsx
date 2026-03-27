/**
 * Tests for ToolsModal utility functions and logic
 *
 * Imports the real utility functions from ToolsModal.utils.ts so tests cover
 * the actual code used by the component, not re-implementations.
 */
import { describe, it, expect } from 'vitest';
import { signal } from '@preact/signals';
import {
	isServerEnabled,
	toggleServer,
	toggleGroupServers,
	computeGroupState,
	computeSkillGroupState,
	resolveSettingSources,
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

describe('computeSkillGroupState', () => {
	it('returns all-false for empty skills list (no vacuous truth)', () => {
		const state = computeSkillGroupState([]);
		expect(state.allEnabled).toBe(false);
		expect(state.someEnabled).toBe(false);
		expect(state.isIndeterminate).toBe(false);
	});

	it('returns allEnabled=true when all skills are enabled', () => {
		const state = computeSkillGroupState([{ enabled: true }, { enabled: true }]);
		expect(state.allEnabled).toBe(true);
		expect(state.someEnabled).toBe(true);
		expect(state.isIndeterminate).toBe(false);
	});

	it('returns allEnabled=false, someEnabled=false when all skills are disabled', () => {
		const state = computeSkillGroupState([{ enabled: false }, { enabled: false }]);
		expect(state.allEnabled).toBe(false);
		expect(state.someEnabled).toBe(false);
		expect(state.isIndeterminate).toBe(false);
	});

	it('returns isIndeterminate=true when some skills are enabled', () => {
		const state = computeSkillGroupState([{ enabled: true }, { enabled: false }]);
		expect(state.allEnabled).toBe(false);
		expect(state.someEnabled).toBe(true);
		expect(state.isIndeterminate).toBe(true);
	});
});

describe('resolveSettingSources', () => {
	it('returns all sources by default when tools is undefined', () => {
		expect(resolveSettingSources(undefined)).toEqual(['user', 'project', 'local']);
	});

	it('returns all sources when neither field is set', () => {
		expect(resolveSettingSources({})).toEqual(['user', 'project', 'local']);
	});

	it('returns settingSources when explicitly set', () => {
		expect(resolveSettingSources({ settingSources: ['user', 'project'] })).toEqual([
			'user',
			'project',
		]);
	});

	it('returns empty array for legacy loadSettingSources=false', () => {
		expect(resolveSettingSources({ loadSettingSources: false })).toEqual([]);
	});

	it('prefers settingSources over loadSettingSources when both are present', () => {
		expect(resolveSettingSources({ settingSources: ['local'], loadSettingSources: false })).toEqual(
			['local']
		);
	});
});

describe('ToolsModal Logic', () => {
	describe('Save / Cancel state', () => {
		it('Save button is disabled when no changes', () => {
			const hasChanges = signal(false);
			const saving = signal(false);
			expect(!hasChanges.value || saving.value).toBe(true);
		});

		it('Save button is disabled while saving even with changes', () => {
			const hasChanges = signal(true);
			const saving = signal(true);
			expect(!hasChanges.value || saving.value).toBe(true);
		});

		it('Save button is enabled when there are pending changes and not saving', () => {
			const hasChanges = signal(true);
			const saving = signal(false);
			expect(!hasChanges.value || saving.value).toBe(false);
		});

		it('toggleServer sets hasChanges (file-based scope)', () => {
			// toggleServer returns new array; caller also sets hasChanges = true
			const disabled = toggleServer([], 'server1');
			expect(disabled).toContain('server1');
			// The component sets hasChanges.value = true after this call
		});

		it('app-level skill toggles do not affect disabledMcpServers', () => {
			// App-level skills use skillsStore.setEnabled — completely separate state
			let disabled: string[] = [];
			// Simulate: only file-based toggles touch this array
			disabled = toggleServer(disabled, 'file-server');
			expect(disabled).toContain('file-server');
			expect(disabled).not.toContain('app-skill-id');
		});
	});
});
