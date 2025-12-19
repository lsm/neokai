/**
 * Unit tests for SettingsManager
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../src/storage/database';
import { SettingsManager } from '../../src/lib/settings-manager';
import { DEFAULT_GLOBAL_SETTINGS } from '@liuboer/shared';
import type { GlobalSettings } from '@liuboer/shared';

describe('SettingsManager', () => {
	let db: Database;
	let settingsManager: SettingsManager;
	let testDir: string;
	let workspacePath: string;

	beforeEach(async () => {
		// Create test directories
		testDir = join(process.cwd(), 'tmp', 'test-settings-manager', `test-${Date.now()}`);
		workspacePath = join(testDir, 'workspace');
		mkdirSync(testDir, { recursive: true });
		mkdirSync(workspacePath, { recursive: true });

		// Initialize database
		const dbPath = join(testDir, 'test.db');
		db = new Database(dbPath);
		await db.initialize();

		// Initialize SettingsManager
		settingsManager = new SettingsManager(db, workspacePath);
	});

	afterEach(() => {
		// Cleanup
		try {
			db.close();
		} catch {
			// Ignore errors
		}
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore errors
		}
	});

	describe('getGlobalSettings', () => {
		test('returns default settings on first load', () => {
			const settings = settingsManager.getGlobalSettings();

			expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
			expect(settings.settingSources).toEqual(['user', 'project', 'local']);
			expect(settings.disabledMcpServers).toEqual([]);
		});

		test('returns saved settings', () => {
			const customSettings: GlobalSettings = {
				...DEFAULT_GLOBAL_SETTINGS,
				model: 'claude-opus-4-5-20251101',
				disabledMcpServers: ['test-server'],
			};

			settingsManager.saveGlobalSettings(customSettings);
			const loaded = settingsManager.getGlobalSettings();

			expect(loaded.model).toBe('claude-opus-4-5-20251101');
			expect(loaded.disabledMcpServers).toEqual(['test-server']);
		});
	});

	describe('updateGlobalSettings', () => {
		test('performs partial update', () => {
			const updated = settingsManager.updateGlobalSettings({
				model: 'claude-haiku-3-5-20241022',
			});

			expect(updated.model).toBe('claude-haiku-3-5-20241022');
			expect(updated.settingSources).toEqual(['user', 'project', 'local']); // Unchanged
		});

		test('updates disabledMcpServers', () => {
			const updated = settingsManager.updateGlobalSettings({
				disabledMcpServers: ['server1', 'server2'],
			});

			expect(updated.disabledMcpServers).toEqual(['server1', 'server2']);
		});

		test('persists partial updates', () => {
			settingsManager.updateGlobalSettings({
				model: 'claude-opus-4-5-20251101',
			});

			const loaded = settingsManager.getGlobalSettings();
			expect(loaded.model).toBe('claude-opus-4-5-20251101');
		});
	});

	describe('saveGlobalSettings', () => {
		test('saves full settings', () => {
			const customSettings: GlobalSettings = {
				settingSources: ['project', 'local'],
				model: 'claude-opus-4-5-20251101',
				permissionMode: 'acceptEdits',
				maxThinkingTokens: 10000,
				disabledMcpServers: ['server1'],
			};

			settingsManager.saveGlobalSettings(customSettings);
			const loaded = settingsManager.getGlobalSettings();

			expect(loaded).toEqual(customSettings);
		});
	});

	describe('prepareSDKOptions', () => {
		test('returns SDK-supported options', async () => {
			settingsManager.updateGlobalSettings({
				model: 'claude-opus-4-5-20251101',
				permissionMode: 'acceptEdits',
				maxThinkingTokens: 10000,
			});

			const sdkOptions = await settingsManager.prepareSDKOptions();

			expect(sdkOptions.model).toBe('claude-opus-4-5-20251101');
			expect(sdkOptions.permissionMode).toBe('acceptEdits');
			expect(sdkOptions.maxThinkingTokens).toBe(10000);
			expect(sdkOptions.settingSources).toEqual(['user', 'project', 'local']);
		});

		test('excludes file-only settings from SDK options', async () => {
			settingsManager.updateGlobalSettings({
				disabledMcpServers: ['server1'],
				outputStyle: 'json',
			});

			const sdkOptions = await settingsManager.prepareSDKOptions();

			expect(sdkOptions).not.toHaveProperty('disabledMcpServers');
			expect(sdkOptions).not.toHaveProperty('outputStyle');
		});

		test('handles maxThinkingTokens null as undefined', async () => {
			settingsManager.updateGlobalSettings({
				maxThinkingTokens: null,
			});

			const sdkOptions = await settingsManager.prepareSDKOptions();

			expect(sdkOptions.maxThinkingTokens).toBeUndefined();
		});
	});

	describe('writeFileOnlySettings', () => {
		test('writes file-only settings to settings.local.json', async () => {
			settingsManager.updateGlobalSettings({
				disabledMcpServers: ['server1', 'server2'],
			});

			await settingsManager.prepareSDKOptions();

			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			expect(existsSync(settingsPath)).toBe(true);

			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
			expect(content.disabledMcpjsonServers).toEqual(['server1', 'server2']);
		});

		test('preserves non-Liuboer settings in file', async () => {
			// Pre-create settings.local.json with custom content
			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			mkdirSync(join(workspacePath, '.claude'), { recursive: true });
			const existingSettings = {
				customField: 'custom-value',
				disabledMcpjsonServers: ['old-server'],
			};
			await Bun.write(settingsPath, JSON.stringify(existingSettings, null, 2));

			// Update settings via SettingsManager
			settingsManager.updateGlobalSettings({
				disabledMcpServers: ['new-server'],
			});
			await settingsManager.prepareSDKOptions();

			// Verify custom field is preserved
			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
			expect(content.customField).toBe('custom-value');
			expect(content.disabledMcpjsonServers).toEqual(['new-server']);
		});

		test('creates .claude directory if missing', async () => {
			settingsManager.updateGlobalSettings({
				disabledMcpServers: ['server1'],
			});

			await settingsManager.prepareSDKOptions();

			const claudeDir = join(workspacePath, '.claude');
			expect(existsSync(claudeDir)).toBe(true);
		});
	});

	describe('readFileOnlySettings', () => {
		test('returns empty object if file does not exist', () => {
			const settings = settingsManager.readFileOnlySettings();

			expect(settings).toEqual({});
		});

		test('reads disabledMcpServers from file', async () => {
			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			mkdirSync(join(workspacePath, '.claude'), { recursive: true });
			const fileSettings = {
				disabledMcpjsonServers: ['server1', 'server2'],
			};
			await Bun.write(settingsPath, JSON.stringify(fileSettings, null, 2));

			const settings = settingsManager.readFileOnlySettings();

			expect(settings.disabledMcpServers).toEqual(['server1', 'server2']);
		});

		test('returns empty array for missing disabledMcpServers', async () => {
			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			mkdirSync(join(workspacePath, '.claude'), { recursive: true });
			const fileSettings = {
				otherField: 'value',
			};
			await Bun.write(settingsPath, JSON.stringify(fileSettings, null, 2));

			const settings = settingsManager.readFileOnlySettings();

			expect(settings.disabledMcpServers).toEqual([]);
		});
	});

	describe('toggleMcpServer', () => {
		test('disables MCP server', async () => {
			await settingsManager.toggleMcpServer('test-server', false);

			const settings = settingsManager.getGlobalSettings();
			expect(settings.disabledMcpServers).toContain('test-server');
		});

		test('enables MCP server', async () => {
			// First disable
			await settingsManager.toggleMcpServer('test-server', false);
			// Then enable
			await settingsManager.toggleMcpServer('test-server', true);

			const settings = settingsManager.getGlobalSettings();
			expect(settings.disabledMcpServers).not.toContain('test-server');
		});

		test('does not add duplicate disabled servers', async () => {
			await settingsManager.toggleMcpServer('test-server', false);
			await settingsManager.toggleMcpServer('test-server', false);

			const settings = settingsManager.getGlobalSettings();
			expect(settings.disabledMcpServers?.filter((s) => s === 'test-server').length).toBe(1);
		});

		test('writes to file immediately', async () => {
			await settingsManager.toggleMcpServer('test-server', false);

			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			expect(existsSync(settingsPath)).toBe(true);

			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
			expect(content.disabledMcpjsonServers).toContain('test-server');
		});
	});

	describe('getDisabledMcpServers', () => {
		test('returns empty array by default', () => {
			const disabled = settingsManager.getDisabledMcpServers();

			expect(disabled).toEqual([]);
		});

		test('returns disabled servers', async () => {
			await settingsManager.toggleMcpServer('server1', false);
			await settingsManager.toggleMcpServer('server2', false);

			const disabled = settingsManager.getDisabledMcpServers();

			expect(disabled).toEqual(['server1', 'server2']);
		});
	});

	describe('setDisabledMcpServers', () => {
		test('sets list of disabled servers', async () => {
			await settingsManager.setDisabledMcpServers(['server1', 'server2', 'server3']);

			const disabled = settingsManager.getDisabledMcpServers();
			expect(disabled).toEqual(['server1', 'server2', 'server3']);
		});

		test('replaces existing disabled servers', async () => {
			await settingsManager.setDisabledMcpServers(['old-server']);
			await settingsManager.setDisabledMcpServers(['new-server1', 'new-server2']);

			const disabled = settingsManager.getDisabledMcpServers();
			expect(disabled).toEqual(['new-server1', 'new-server2']);
			expect(disabled).not.toContain('old-server');
		});

		test('writes to file immediately', async () => {
			await settingsManager.setDisabledMcpServers(['server1', 'server2']);

			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
			expect(content.disabledMcpjsonServers).toEqual(['server1', 'server2']);
		});
	});
});
