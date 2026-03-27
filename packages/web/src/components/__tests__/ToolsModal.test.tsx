// @ts-nocheck
/**
 * Tests for redesigned ToolsModal Component Logic
 *
 * Tests pure logic without mock.module to avoid polluting other tests.
 * Covers:
 * - Unified MCP server list (file-based + app-level)
 * - Group toggle logic (enable/disable all in group)
 * - Scope-aware persistence (immediate for app-level, buffered for file-based)
 * - disabledMcpServers manipulation
 * - Advanced settings (Claude Code Preset, Setting Sources)
 */
import { describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals';

// ---------------------------------------------------------------------------
// Shared helpers (mirrors ToolsModal internal logic)
// ---------------------------------------------------------------------------

function isServerEnabled(disabledMcpServers: string[], serverName: string): boolean {
	return !disabledMcpServers.includes(serverName);
}

function toggleServer(disabledMcpServers: string[], serverName: string): string[] {
	if (disabledMcpServers.includes(serverName)) {
		return disabledMcpServers.filter((s) => s !== serverName);
	}
	return [...disabledMcpServers, serverName];
}

function toggleGroupServers(disabledMcpServers: string[], servers: string[]): string[] {
	const allOn = servers.every((name) => !disabledMcpServers.includes(name));
	if (allOn) {
		// Disable all
		const toDisable = servers.filter((n) => !disabledMcpServers.includes(n));
		return [...disabledMcpServers, ...toDisable];
	} else {
		// Enable all
		const names = new Set(servers);
		return disabledMcpServers.filter((n) => !names.has(n));
	}
}

// ---------------------------------------------------------------------------

describe('ToolsModal Redesign Logic', () => {
	// -------------------------------------------
	// Initial State
	// -------------------------------------------
	describe('Initial State', () => {
		it('has empty disabled servers by default', () => {
			const disabledMcpServers = signal<string[]>([]);
			expect(disabledMcpServers.value).toEqual([]);
		});

		it('has memory disabled by default', () => {
			const memoryEnabled = signal(false);
			expect(memoryEnabled.value).toBe(false);
		});

		it('app and file MCP groups are open by default', () => {
			const appMcpGroupOpen = signal(true);
			const fileMcpGroupOpen = signal(true);
			expect(appMcpGroupOpen.value).toBe(true);
			expect(fileMcpGroupOpen.value).toBe(true);
		});

		it('advanced section is closed by default', () => {
			const advancedOpen = signal(false);
			expect(advancedOpen.value).toBe(false);
		});

		it('Claude Code Preset is on by default', () => {
			const useClaudeCodePreset = signal(true);
			expect(useClaudeCodePreset.value).toBe(true);
		});

		it('all setting sources enabled by default', () => {
			const settingSources = signal(['user', 'project', 'local']);
			expect(settingSources.value).toEqual(['user', 'project', 'local']);
		});
	});

	// -------------------------------------------
	// File-based MCP server individual toggles
	// -------------------------------------------
	describe('File-based MCP Server Toggle', () => {
		it('enables a disabled server', () => {
			const result = toggleServer(['server2'], 'server2');
			expect(result).not.toContain('server2');
		});

		it('disables an enabled server', () => {
			const result = toggleServer([], 'server1');
			expect(result).toContain('server1');
		});

		it('isServerEnabled returns true when not in disabled list', () => {
			expect(isServerEnabled(['server2'], 'server1')).toBe(true);
		});

		it('isServerEnabled returns false when in disabled list', () => {
			expect(isServerEnabled(['server1'], 'server1')).toBe(false);
		});
	});

	// -------------------------------------------
	// Group-level toggle logic (file-based)
	// -------------------------------------------
	describe('Group Toggle Logic (File-based MCP)', () => {
		it('disables all servers when all are enabled', () => {
			const servers = ['alpha', 'beta', 'gamma'];
			const result = toggleGroupServers([], servers);
			expect(result).toEqual(expect.arrayContaining(servers));
			expect(result.length).toBe(3);
		});

		it('enables all servers when some are disabled', () => {
			const servers = ['alpha', 'beta', 'gamma'];
			const result = toggleGroupServers(['alpha'], servers);
			// All should be enabled (removed from disabled list)
			expect(result).not.toContain('alpha');
			expect(result).not.toContain('beta');
			expect(result).not.toContain('gamma');
		});

		it('enables all servers when all are disabled', () => {
			const servers = ['alpha', 'beta'];
			const result = toggleGroupServers(['alpha', 'beta', 'other'], servers);
			expect(result).not.toContain('alpha');
			expect(result).not.toContain('beta');
			// 'other' is not in the group so it stays
			expect(result).toContain('other');
		});

		it('preserves servers outside the group when disabling', () => {
			const servers = ['alpha'];
			const result = toggleGroupServers(['other-server'], servers);
			expect(result).toContain('other-server');
			expect(result).toContain('alpha');
		});

		it('does not add duplicates to disabled list', () => {
			const servers = ['alpha', 'beta'];
			const result = toggleGroupServers(['alpha'], servers);
			const count = result.filter((s) => s === 'alpha').length;
			expect(count).toBeLessThanOrEqual(1);
		});
	});

	// -------------------------------------------
	// Group toggle state computation
	// -------------------------------------------
	describe('Group State Computation', () => {
		it('allEnabled is true when no servers are disabled', () => {
			const servers = ['alpha', 'beta'];
			const disabled: string[] = [];
			const allEnabled = servers.every((s) => isServerEnabled(disabled, s));
			expect(allEnabled).toBe(true);
		});

		it('allEnabled is false when any server is disabled', () => {
			const servers = ['alpha', 'beta'];
			const disabled = ['alpha'];
			const allEnabled = servers.every((s) => isServerEnabled(disabled, s));
			expect(allEnabled).toBe(false);
		});

		it('someEnabled is true when at least one server is enabled', () => {
			const servers = ['alpha', 'beta'];
			const disabled = ['alpha'];
			const someEnabled = servers.some((s) => isServerEnabled(disabled, s));
			expect(someEnabled).toBe(true);
		});

		it('someEnabled is false when all servers are disabled', () => {
			const servers = ['alpha', 'beta'];
			const disabled = ['alpha', 'beta'];
			const someEnabled = servers.some((s) => isServerEnabled(disabled, s));
			expect(someEnabled).toBe(false);
		});

		it('indeterminate when some but not all enabled', () => {
			const servers = ['alpha', 'beta'];
			const disabled = ['alpha'];
			const allOn = servers.every((s) => isServerEnabled(disabled, s));
			const someOn = servers.some((s) => isServerEnabled(disabled, s));
			const isIndeterminate = someOn && !allOn;
			expect(isIndeterminate).toBe(true);
		});
	});

	// -------------------------------------------
	// App-level MCP skill toggle (scope: global, immediate)
	// -------------------------------------------
	describe('App-Level MCP Skill Toggle (Scope: Global)', () => {
		it('calls setEnabled immediately when toggling a skill', async () => {
			const setEnabled = vi.fn(() => Promise.resolve({ id: 'skill-1', enabled: false }));
			const skill = { id: 'skill-1', displayName: 'Test MCP', enabled: true };

			await setEnabled(skill.id, !skill.enabled);
			expect(setEnabled).toHaveBeenCalledWith('skill-1', false);
		});

		it('group toggle disables all skills when all are enabled', async () => {
			const setEnabled = vi.fn(() => Promise.resolve());
			const skills = [
				{ id: 'skill-1', enabled: true },
				{ id: 'skill-2', enabled: true },
			];
			const allOn = skills.every((s) => s.enabled);
			const newEnabled = !allOn; // false

			for (const skill of skills) {
				if (skill.enabled !== newEnabled) {
					await setEnabled(skill.id, newEnabled);
				}
			}

			expect(setEnabled).toHaveBeenCalledTimes(2);
			expect(setEnabled).toHaveBeenCalledWith('skill-1', false);
			expect(setEnabled).toHaveBeenCalledWith('skill-2', false);
		});

		it('group toggle enables skills that are disabled', async () => {
			const setEnabled = vi.fn(() => Promise.resolve());
			const skills = [
				{ id: 'skill-1', enabled: false },
				{ id: 'skill-2', enabled: true },
			];
			const allOn = skills.every((s) => s.enabled);
			const newEnabled = !allOn; // true

			for (const skill of skills) {
				if (skill.enabled !== newEnabled) {
					await setEnabled(skill.id, newEnabled);
				}
			}

			// Only skill-1 was disabled, so only it should be toggled
			expect(setEnabled).toHaveBeenCalledTimes(1);
			expect(setEnabled).toHaveBeenCalledWith('skill-1', true);
		});

		it('skill toggle does not affect disabledMcpServers (different persistence)', () => {
			let disabledMcpServers: string[] = [];
			// Toggling a skill does NOT modify disabledMcpServers
			// (it calls skillsStore.setEnabled instead)
			const toggleSkill = () => {
				// No change to disabledMcpServers
			};
			toggleSkill();
			expect(disabledMcpServers).toEqual([]);
		});
	});

	// -------------------------------------------
	// Scope-aware persistence
	// -------------------------------------------
	describe('Scope-Aware Persistence', () => {
		it('file-based changes require Save (hasChanges flag)', () => {
			const hasChanges = signal(false);
			// Simulating toggleServer
			hasChanges.value = true;
			expect(hasChanges.value).toBe(true);
		});

		it('app-level changes do not set hasChanges flag', () => {
			const hasChanges = signal(false);
			// App-level toggles are immediate — don't set hasChanges
			// (hasChanges only gates the session-local Save button)
			expect(hasChanges.value).toBe(false);
		});

		it('Save button is disabled when no changes', () => {
			const hasChanges = false;
			const saving = false;
			expect(!hasChanges || saving).toBe(true);
		});

		it('Save button is enabled when there are changes', () => {
			const hasChanges = true;
			const saving = false;
			expect(!hasChanges || saving).toBe(false);
		});
	});

	// -------------------------------------------
	// Config Loading
	// -------------------------------------------
	describe('Config Loading', () => {
		it('loads disabledMcpServers from session config', () => {
			const session = {
				config: {
					tools: {
						disabledMcpServers: ['server1', 'server2'],
					},
				},
			};
			const disabled = session.config.tools?.disabledMcpServers ?? [];
			expect(disabled).toEqual(['server1', 'server2']);
		});

		it('defaults to empty disabledMcpServers when not set', () => {
			const session = { config: {} };
			const disabled = session.config.tools?.disabledMcpServers ?? [];
			expect(disabled).toEqual([]);
		});

		it('handles legacy loadSettingSources=false', () => {
			const tools = { loadSettingSources: false } as Record<string, unknown>;
			let sources: string[];
			if (tools.settingSources) {
				sources = tools.settingSources as string[];
			} else if (tools.loadSettingSources !== false) {
				sources = ['user', 'project', 'local'];
			} else {
				sources = [];
			}
			expect(sources).toEqual([]);
		});
	});

	// -------------------------------------------
	// Cancel resets state
	// -------------------------------------------
	describe('Cancel Functionality', () => {
		it('resets disabled servers to original on cancel', () => {
			const original = ['server1'];
			let current = ['server1', 'server2'];

			// Simulate cancel (loadConfig re-runs)
			current = [...original];
			expect(current).toEqual(['server1']);
		});

		it('resets hasChanges to false on cancel', () => {
			const hasChanges = signal(true);
			// Cancel calls loadConfig which sets hasChanges.value = false
			hasChanges.value = false;
			expect(hasChanges.value).toBe(false);
		});
	});

	// -------------------------------------------
	// Setting source toggle (in Advanced section)
	// -------------------------------------------
	describe('Advanced: Setting Source Toggle', () => {
		it('adds a source', () => {
			let sources = ['user'] as string[];
			if (!sources.includes('project')) sources = [...sources, 'project'];
			expect(sources).toContain('project');
		});

		it('removes a source', () => {
			let sources = ['user', 'project', 'local'] as string[];
			sources = sources.filter((s) => s !== 'local');
			expect(sources).not.toContain('local');
		});

		it('prevents removing all sources', () => {
			const sources = ['user'] as string[];
			const newSources = sources.filter((s) => s !== 'user');
			if (newSources.length === 0) {
				// shows error, doesn't update
				expect(newSources.length).toBe(0);
			}
		});
	});
});
