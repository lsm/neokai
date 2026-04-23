/**
 * Tests for ToolsModal utility functions.
 *
 * Imports the real utility functions from ToolsModal.utils.ts so tests cover
 * the actual code used by the component, not re-implementations.
 *
 * NOTE: Legacy per-server disabled-list helpers and `resolveSettingSources`
 * were removed in M5 of `unify-mcp-config-model`; their tests went with them.
 */
import { describe, it, expect } from 'vitest';
import { computeSkillGroupState } from '../ToolsModal.utils.ts';

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
