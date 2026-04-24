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
import type { AppMcpServer, AppSkill, SessionMcpServerEntry } from '@neokai/shared';
import {
	computeMcpServerSkillLinkage,
	computeMcpSkillRuntimeState,
	computeSkillGroupState,
	getMcpSkillRuntimeClasses,
} from '../ToolsModal.utils.ts';

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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMcpSkill(overrides: Partial<AppSkill> = {}): AppSkill {
	return {
		id: 'skill-1',
		name: 'chrome-devtools-mcp',
		displayName: 'Chrome DevTools (MCP)',
		description: '',
		sourceType: 'mcp_server',
		config: { type: 'mcp_server', appMcpServerId: 'server-1' },
		enabled: true,
		builtIn: false,
		validationStatus: 'valid',
		createdAt: 0,
		...overrides,
	};
}

function makeBuiltinSkill(overrides: Partial<AppSkill> = {}): AppSkill {
	return {
		id: 'skill-builtin',
		name: 'playwright',
		displayName: 'Playwright',
		description: '',
		sourceType: 'builtin',
		config: { type: 'builtin', commandName: 'playwright' },
		enabled: true,
		builtIn: true,
		validationStatus: 'valid',
		createdAt: 0,
		...overrides,
	};
}

function makeAppMcpServer(overrides: Partial<AppMcpServer> = {}): AppMcpServer {
	return {
		id: 'server-1',
		name: 'chrome-devtools',
		sourceType: 'stdio',
		command: 'bunx',
		args: ['chrome-devtools-mcp@latest'],
		env: {},
		enabled: true,
		source: 'builtin',
		...overrides,
	};
}

function makeEntry(overrides: Partial<SessionMcpServerEntry> = {}): SessionMcpServerEntry {
	return {
		server: makeAppMcpServer(),
		enabled: true,
		source: 'registry',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// computeMcpSkillRuntimeState
// ---------------------------------------------------------------------------

describe('computeMcpSkillRuntimeState', () => {
	it('returns "unknown" for builtin skills (no runtime linkage path)', () => {
		const skill = makeBuiltinSkill();
		const state = computeMcpSkillRuntimeState(skill, [], true);
		expect(state.status).toBe('unknown');
		expect(state.label).toBe('');
	});

	it('returns "unknown" while session MCP list is still loading', () => {
		const skill = makeMcpSkill();
		const state = computeMcpSkillRuntimeState(skill, [], false);
		expect(state.status).toBe('unknown');
	});

	it('returns "active" when the backing server is effectively enabled', () => {
		const skill = makeMcpSkill();
		const entries = [makeEntry({ enabled: true, source: 'registry' })];
		const state = computeMcpSkillRuntimeState(skill, entries, true);
		expect(state.status).toBe('active');
		expect(state.label).toMatch(/active/i);
	});

	it('returns "server-off" with registry source when registry default is false', () => {
		const skill = makeMcpSkill();
		const entries = [makeEntry({ enabled: false, source: 'registry' })];
		const state = computeMcpSkillRuntimeState(skill, entries, true);
		expect(state.status).toBe('server-off');
		expect(state.overrideSource).toBe('registry');
		expect(state.label).toMatch(/registry/i);
	});

	it('returns "server-off" with session source when session override disables', () => {
		const skill = makeMcpSkill();
		const entries = [makeEntry({ enabled: false, source: 'session' })];
		const state = computeMcpSkillRuntimeState(skill, entries, true);
		expect(state.status).toBe('server-off');
		expect(state.overrideSource).toBe('session');
		expect(state.label).toMatch(/this session/);
	});

	it('returns "server-off" with room source when room override disables', () => {
		const skill = makeMcpSkill();
		const entries = [makeEntry({ enabled: false, source: 'room' })];
		const state = computeMcpSkillRuntimeState(skill, entries, true);
		expect(state.status).toBe('server-off');
		expect(state.overrideSource).toBe('room');
		expect(state.label).toMatch(/room/);
	});

	it('returns "server-off" with space source when space override disables', () => {
		const skill = makeMcpSkill();
		const entries = [makeEntry({ enabled: false, source: 'space' })];
		const state = computeMcpSkillRuntimeState(skill, entries, true);
		expect(state.status).toBe('server-off');
		expect(state.overrideSource).toBe('space');
		expect(state.label).toMatch(/space/);
	});

	it('returns "server-missing" when backing app_mcp_servers entry is absent', () => {
		const skill = makeMcpSkill({
			config: { type: 'mcp_server', appMcpServerId: 'ghost-id' },
		});
		// Entries exist but none match the orphan skill's appMcpServerId.
		const entries = [makeEntry()];
		const state = computeMcpSkillRuntimeState(skill, entries, true);
		expect(state.status).toBe('server-missing');
		expect(state.label).toMatch(/missing|no backing/i);
	});

	it('returns "skill-disabled" when the skill itself is off but server exists', () => {
		const skill = makeMcpSkill({ enabled: false });
		const entries = [makeEntry({ enabled: true })];
		const state = computeMcpSkillRuntimeState(skill, entries, true);
		// Skill is off, so it's never injected regardless of server state — surface
		// that distinct reason instead of implying the server is broken.
		expect(state.status).toBe('skill-disabled');
	});

	it('prefers "server-missing" over "skill-disabled" when both apply', () => {
		// Orphaned skill that is also disabled. We prioritise "server-missing"
		// because that's a persistent data-integrity problem, whereas
		// "skill-disabled" is the user's own toggle — the former is actionable
		// regardless of what the user wants to do next.
		const skill = makeMcpSkill({
			enabled: false,
			config: { type: 'mcp_server', appMcpServerId: 'ghost-id' },
		});
		const entries = [makeEntry()];
		const state = computeMcpSkillRuntimeState(skill, entries, true);
		expect(state.status).toBe('server-missing');
	});
});

// ---------------------------------------------------------------------------
// computeMcpServerSkillLinkage
// ---------------------------------------------------------------------------

describe('computeMcpServerSkillLinkage', () => {
	it('returns empty map for empty skills list', () => {
		expect(computeMcpServerSkillLinkage([])).toEqual(new Map());
	});

	it('ignores builtin and plugin skills', () => {
		const skills = [
			makeBuiltinSkill({ id: 'a' }),
			makeBuiltinSkill({ id: 'b', sourceType: 'builtin' }),
		];
		expect(computeMcpServerSkillLinkage(skills).size).toBe(0);
	});

	it('maps mcp_server skills by appMcpServerId', () => {
		const skill = makeMcpSkill({
			id: 'wrap-1',
			config: { type: 'mcp_server', appMcpServerId: 'server-1' },
		});
		const map = computeMcpServerSkillLinkage([skill]);
		expect(map.get('server-1')).toBe(skill);
	});

	it('keeps the first wrapper when multiple skills point at the same server', () => {
		const first = makeMcpSkill({ id: 'first', displayName: 'First' });
		const second = makeMcpSkill({ id: 'second', displayName: 'Second' });
		const map = computeMcpServerSkillLinkage([first, second]);
		// Defensive behaviour: the UI should never render two annotations for
		// one server row, so we de-dup rather than surfacing the last-seen.
		expect(map.get('server-1')).toBe(first);
	});

	it('skips skills with empty appMcpServerId', () => {
		const skill = makeMcpSkill({
			// Deliberately construct a malformed config; the guard in the util
			// keeps the map consistent even if a bad row sneaks through the DB.
			config: { type: 'mcp_server', appMcpServerId: '' },
		});
		expect(computeMcpServerSkillLinkage([skill]).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// getMcpSkillRuntimeClasses
// ---------------------------------------------------------------------------

describe('getMcpSkillRuntimeClasses', () => {
	it('maps active → emerald', () => {
		expect(getMcpSkillRuntimeClasses('active')).toEqual({
			dot: 'bg-emerald-400',
			text: 'text-emerald-500/70',
		});
	});

	it('maps server-off → amber (distinct from skill-disabled gray)', () => {
		// Regression guard: `server-off` used to share gray with `skill-disabled`,
		// which hid a meaningful distinction — "a scope override the user may
		// not have set" vs "the user turned it off themselves." Amber also
		// matches the orphan-warning colour in AppMcpServersSettings so the
		// "this doesn't do what you think it does" signal reads the same in
		// both places.
		expect(getMcpSkillRuntimeClasses('server-off')).toEqual({
			dot: 'bg-amber-400',
			text: 'text-amber-500/70',
		});
	});

	it('maps server-missing → red', () => {
		expect(getMcpSkillRuntimeClasses('server-missing')).toEqual({
			dot: 'bg-red-400',
			text: 'text-red-400',
		});
	});

	it('maps skill-disabled → gray (user-owned state)', () => {
		expect(getMcpSkillRuntimeClasses('skill-disabled')).toEqual({
			dot: 'bg-gray-500',
			text: 'text-gray-500',
		});
	});

	it('maps unknown → gray (caller should suppress render)', () => {
		expect(getMcpSkillRuntimeClasses('unknown')).toEqual({
			dot: 'bg-gray-500',
			text: 'text-gray-500',
		});
	});
});
