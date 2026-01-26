/**
 * Settings Repository Unit Tests
 *
 * Tests for global settings and tools configuration.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SettingsRepository } from '../../../src/storage/repositories/settings-repository';
import type { GlobalToolsConfig, GlobalSettings } from '@liuboer/shared';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@liuboer/shared';

describe('SettingsRepository', () => {
	let db: Database;
	let repo: SettingsRepository;

	beforeEach(() => {
		// Create in-memory database
		db = new Database(':memory:');

		// Create settings tables
		db.run(`
			CREATE TABLE global_tools_config (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				config TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);

		db.run(`
			CREATE TABLE global_settings (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				settings TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);

		repo = new SettingsRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	describe('getGlobalToolsConfig', () => {
		it('should return default config when no config exists', () => {
			const config = repo.getGlobalToolsConfig();
			expect(config).toEqual(DEFAULT_GLOBAL_TOOLS_CONFIG);
		});

		it('should return stored config', () => {
			const customConfig: GlobalToolsConfig = {
				systemPrompt: { claudeCodePreset: { allowed: false, defaultEnabled: false } },
				settingSources: { project: { allowed: false, defaultEnabled: false } },
				mcp: { allowProjectMcp: false, defaultProjectMcp: false },
				liuboerTools: { memory: { allowed: false, defaultEnabled: false } },
			};

			repo.saveGlobalToolsConfig(customConfig);
			const config = repo.getGlobalToolsConfig();

			expect(config.systemPrompt.claudeCodePreset.allowed).toBe(false);
			expect(config.mcp.allowProjectMcp).toBe(false);
		});

		it('should handle backward compatibility from old preset format', () => {
			// Insert old format directly
			db.run(
				`INSERT INTO global_tools_config (id, config, updated_at) VALUES (1, ?, datetime('now'))`,
				[
					JSON.stringify({
						preset: {
							claudeCode: { allowed: false, defaultEnabled: false },
						},
					}),
				]
			);

			const config = repo.getGlobalToolsConfig();

			// Should map old preset.claudeCode to new systemPrompt.claudeCodePreset
			expect(config.systemPrompt.claudeCodePreset.allowed).toBe(false);
			expect(config.systemPrompt.claudeCodePreset.defaultEnabled).toBe(false);
			// And also to settingSources.project
			expect(config.settingSources.project.allowed).toBe(false);
		});

		it('should prefer new format over old format', () => {
			// Insert config with both old and new format
			db.run(
				`INSERT INTO global_tools_config (id, config, updated_at) VALUES (1, ?, datetime('now'))`,
				[
					JSON.stringify({
						preset: {
							claudeCode: { allowed: false, defaultEnabled: false },
						},
						systemPrompt: {
							claudeCodePreset: { allowed: true, defaultEnabled: true },
						},
					}),
				]
			);

			const config = repo.getGlobalToolsConfig();

			// New format should take precedence
			expect(config.systemPrompt.claudeCodePreset.allowed).toBe(true);
		});

		it('should return default on invalid JSON', () => {
			db.run(
				`INSERT INTO global_tools_config (id, config, updated_at) VALUES (1, 'invalid json', datetime('now'))`
			);

			const config = repo.getGlobalToolsConfig();
			expect(config).toEqual(DEFAULT_GLOBAL_TOOLS_CONFIG);
		});

		it('should merge missing fields with defaults', () => {
			// Insert partial config
			db.run(
				`INSERT INTO global_tools_config (id, config, updated_at) VALUES (1, ?, datetime('now'))`,
				[
					JSON.stringify({
						systemPrompt: {
							claudeCodePreset: { allowed: false },
							// missing defaultEnabled
						},
						// missing other fields
					}),
				]
			);

			const config = repo.getGlobalToolsConfig();

			// Should have the stored value
			expect(config.systemPrompt.claudeCodePreset.allowed).toBe(false);
			// Missing fields should use defaults
			expect(config.systemPrompt.claudeCodePreset.defaultEnabled).toBe(
				DEFAULT_GLOBAL_TOOLS_CONFIG.systemPrompt.claudeCodePreset.defaultEnabled
			);
			expect(config.mcp.allowProjectMcp).toBe(DEFAULT_GLOBAL_TOOLS_CONFIG.mcp.allowProjectMcp);
		});
	});

	describe('saveGlobalToolsConfig', () => {
		it('should save and retrieve config', () => {
			const config: GlobalToolsConfig = {
				systemPrompt: { claudeCodePreset: { allowed: true, defaultEnabled: false } },
				settingSources: { project: { allowed: true, defaultEnabled: false } },
				mcp: { allowProjectMcp: true, defaultProjectMcp: false },
				liuboerTools: { memory: { allowed: true, defaultEnabled: true } },
			};

			repo.saveGlobalToolsConfig(config);
			const retrieved = repo.getGlobalToolsConfig();

			expect(retrieved).toEqual(config);
		});

		it('should replace existing config', () => {
			const config1: GlobalToolsConfig = {
				...DEFAULT_GLOBAL_TOOLS_CONFIG,
				mcp: { allowProjectMcp: true, defaultProjectMcp: true },
			};
			const config2: GlobalToolsConfig = {
				...DEFAULT_GLOBAL_TOOLS_CONFIG,
				mcp: { allowProjectMcp: false, defaultProjectMcp: false },
			};

			repo.saveGlobalToolsConfig(config1);
			repo.saveGlobalToolsConfig(config2);

			const retrieved = repo.getGlobalToolsConfig();
			expect(retrieved.mcp.allowProjectMcp).toBe(false);
		});
	});

	describe('getGlobalSettings', () => {
		it('should return default settings when no settings exist', () => {
			const settings = repo.getGlobalSettings();
			expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
		});

		it('should return stored settings', () => {
			const customSettings: GlobalSettings = {
				...DEFAULT_GLOBAL_SETTINGS,
				permissionMode: 'acceptEdits',
			};

			repo.saveGlobalSettings(customSettings);
			const settings = repo.getGlobalSettings();

			expect(settings.permissionMode).toBe('acceptEdits');
		});

		it('should merge with defaults for missing fields', () => {
			// Insert partial settings
			db.run(
				`INSERT INTO global_settings (id, settings, updated_at) VALUES (1, ?, datetime('now'))`,
				[JSON.stringify({ permissionMode: 'bypassPermissions' })]
			);

			const settings = repo.getGlobalSettings();

			expect(settings.permissionMode).toBe('bypassPermissions');
			// Other fields should come from defaults
		});

		it('should return default on invalid JSON', () => {
			db.run(
				`INSERT INTO global_settings (id, settings, updated_at) VALUES (1, 'invalid', datetime('now'))`
			);

			const settings = repo.getGlobalSettings();
			expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
		});
	});

	describe('saveGlobalSettings', () => {
		it('should save and retrieve settings', () => {
			const settings: GlobalSettings = {
				...DEFAULT_GLOBAL_SETTINGS,
				permissionMode: 'acceptEdits',
			};

			repo.saveGlobalSettings(settings);
			const retrieved = repo.getGlobalSettings();

			expect(retrieved.permissionMode).toBe('acceptEdits');
		});

		it('should replace existing settings', () => {
			repo.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, permissionMode: 'bypassPermissions' });
			repo.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, permissionMode: 'acceptEdits' });

			const settings = repo.getGlobalSettings();
			expect(settings.permissionMode).toBe('acceptEdits');
		});
	});

	describe('updateGlobalSettings', () => {
		it('should partially update settings', () => {
			// Save initial settings
			repo.saveGlobalSettings({
				...DEFAULT_GLOBAL_SETTINGS,
				permissionMode: 'bypassPermissions',
			});

			// Partial update
			const updated = repo.updateGlobalSettings({ permissionMode: 'acceptEdits' });

			expect(updated.permissionMode).toBe('acceptEdits');
		});

		it('should preserve existing settings not in update', () => {
			repo.saveGlobalSettings({
				...DEFAULT_GLOBAL_SETTINGS,
				permissionMode: 'bypassPermissions',
			});

			const updated = repo.updateGlobalSettings({});

			// Original settings should be preserved
			expect(updated.permissionMode).toBe('bypassPermissions');
		});

		it('should work when no settings exist yet', () => {
			const updated = repo.updateGlobalSettings({ permissionMode: 'acceptEdits' });

			expect(updated.permissionMode).toBe('acceptEdits');
		});
	});
});
