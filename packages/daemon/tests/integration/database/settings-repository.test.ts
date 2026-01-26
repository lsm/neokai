/**
 * Settings Repository Integration Tests
 *
 * Tests for global settings and tools configuration persistence through the Database facade.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../src/storage/database';
import type { GlobalToolsConfig, GlobalSettings } from '@liuboer/shared';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@liuboer/shared';

describe('SettingsRepository', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database(':memory:');
		await db.initialize();
	});

	afterEach(() => {
		db.close();
	});

	describe('GlobalToolsConfig', () => {
		describe('getGlobalToolsConfig', () => {
			it('should return defaults when no config exists', () => {
				const config = db.getGlobalToolsConfig();

				expect(config).toEqual(DEFAULT_GLOBAL_TOOLS_CONFIG);
			});

			it('should return stored config merged with defaults', () => {
				const customConfig: GlobalToolsConfig = {
					...DEFAULT_GLOBAL_TOOLS_CONFIG,
					systemPrompt: {
						claudeCodePreset: {
							allowed: false,
							defaultEnabled: false,
						},
					},
				};
				db.saveGlobalToolsConfig(customConfig);

				const retrieved = db.getGlobalToolsConfig();

				expect(retrieved.systemPrompt.claudeCodePreset.allowed).toBe(false);
				expect(retrieved.systemPrompt.claudeCodePreset.defaultEnabled).toBe(false);
				// Other defaults should be preserved
				expect(retrieved.mcp).toEqual(DEFAULT_GLOBAL_TOOLS_CONFIG.mcp);
			});

			it('should handle MCP settings', () => {
				const customConfig: GlobalToolsConfig = {
					...DEFAULT_GLOBAL_TOOLS_CONFIG,
					mcp: {
						allowProjectMcp: false,
						defaultProjectMcp: true,
					},
				};
				db.saveGlobalToolsConfig(customConfig);

				const retrieved = db.getGlobalToolsConfig();

				expect(retrieved.mcp.allowProjectMcp).toBe(false);
				expect(retrieved.mcp.defaultProjectMcp).toBe(true);
			});

			it('should handle liuboerTools settings', () => {
				const customConfig: GlobalToolsConfig = {
					...DEFAULT_GLOBAL_TOOLS_CONFIG,
					liuboerTools: {
						memory: {
							allowed: true,
							defaultEnabled: true,
						},
					},
				};
				db.saveGlobalToolsConfig(customConfig);

				const retrieved = db.getGlobalToolsConfig();

				expect(retrieved.liuboerTools.memory.allowed).toBe(true);
				expect(retrieved.liuboerTools.memory.defaultEnabled).toBe(true);
			});

			it('should handle settingSources settings', () => {
				const customConfig: GlobalToolsConfig = {
					...DEFAULT_GLOBAL_TOOLS_CONFIG,
					settingSources: {
						project: {
							allowed: false,
							defaultEnabled: false,
						},
					},
				};
				db.saveGlobalToolsConfig(customConfig);

				const retrieved = db.getGlobalToolsConfig();

				expect(retrieved.settingSources.project.allowed).toBe(false);
				expect(retrieved.settingSources.project.defaultEnabled).toBe(false);
			});
		});

		describe('saveGlobalToolsConfig', () => {
			it('should save and retrieve config', () => {
				const config: GlobalToolsConfig = {
					systemPrompt: {
						claudeCodePreset: { allowed: true, defaultEnabled: false },
					},
					settingSources: {
						project: { allowed: true, defaultEnabled: true },
					},
					mcp: {
						allowProjectMcp: true,
						defaultProjectMcp: false,
					},
					liuboerTools: {
						memory: { allowed: true, defaultEnabled: false },
					},
				};

				db.saveGlobalToolsConfig(config);

				const retrieved = db.getGlobalToolsConfig();
				expect(retrieved.systemPrompt.claudeCodePreset.defaultEnabled).toBe(false);
				expect(retrieved.mcp.defaultProjectMcp).toBe(false);
			});

			it('should overwrite existing config', () => {
				db.saveGlobalToolsConfig({
					...DEFAULT_GLOBAL_TOOLS_CONFIG,
					mcp: { allowProjectMcp: true, defaultProjectMcp: true },
				});

				db.saveGlobalToolsConfig({
					...DEFAULT_GLOBAL_TOOLS_CONFIG,
					mcp: { allowProjectMcp: false, defaultProjectMcp: false },
				});

				const retrieved = db.getGlobalToolsConfig();
				expect(retrieved.mcp.allowProjectMcp).toBe(false);
				expect(retrieved.mcp.defaultProjectMcp).toBe(false);
			});
		});
	});

	describe('GlobalSettings', () => {
		describe('getGlobalSettings', () => {
			it('should return defaults when no settings exist', () => {
				const settings = db.getGlobalSettings();

				expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
			});

			it('should return stored settings merged with defaults', () => {
				const customSettings: GlobalSettings = {
					...DEFAULT_GLOBAL_SETTINGS,
					theme: 'dark',
					fontSize: 16,
				};
				db.saveGlobalSettings(customSettings);

				const retrieved = db.getGlobalSettings();

				expect(retrieved.theme).toBe('dark');
				expect(retrieved.fontSize).toBe(16);
			});
		});

		describe('saveGlobalSettings', () => {
			it('should save and retrieve settings', () => {
				const settings: GlobalSettings = {
					theme: 'dark',
					fontSize: 18,
					showArchived: true,
					sidebarCollapsed: true,
					enableSounds: false,
					showTimestamps: false,
				};

				db.saveGlobalSettings(settings);

				const retrieved = db.getGlobalSettings();
				// Check that saved properties are correct (getter merges with defaults)
				expect(retrieved.theme).toBe('dark');
				expect(retrieved.fontSize).toBe(18);
				expect(retrieved.showArchived).toBe(true);
				expect(retrieved.sidebarCollapsed).toBe(true);
				expect(retrieved.enableSounds).toBe(false);
				expect(retrieved.showTimestamps).toBe(false);
			});

			it('should overwrite existing settings', () => {
				db.saveGlobalSettings({
					...DEFAULT_GLOBAL_SETTINGS,
					theme: 'dark',
				});

				db.saveGlobalSettings({
					...DEFAULT_GLOBAL_SETTINGS,
					theme: 'light',
				});

				const retrieved = db.getGlobalSettings();
				expect(retrieved.theme).toBe('light');
			});
		});

		describe('updateGlobalSettings', () => {
			it('should partially update settings', () => {
				db.saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS);

				const updated = db.updateGlobalSettings({ theme: 'dark' });

				expect(updated.theme).toBe('dark');
				expect(updated.fontSize).toBe(DEFAULT_GLOBAL_SETTINGS.fontSize);
			});

			it('should return the updated settings', () => {
				const updated = db.updateGlobalSettings({
					fontSize: 20,
					showArchived: true,
				});

				expect(updated.fontSize).toBe(20);
				expect(updated.showArchived).toBe(true);
			});

			it('should persist partial updates', () => {
				db.updateGlobalSettings({ theme: 'dark' });

				// Retrieve again to verify persistence
				const retrieved = db.getGlobalSettings();
				expect(retrieved.theme).toBe('dark');
			});

			it('should handle multiple sequential updates', () => {
				db.updateGlobalSettings({ theme: 'dark' });
				db.updateGlobalSettings({ fontSize: 16 });
				db.updateGlobalSettings({ showArchived: true });

				const retrieved = db.getGlobalSettings();
				expect(retrieved.theme).toBe('dark');
				expect(retrieved.fontSize).toBe(16);
				expect(retrieved.showArchived).toBe(true);
			});
		});
	});
});
