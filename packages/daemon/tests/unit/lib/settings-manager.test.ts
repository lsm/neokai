/**
 * Settings Manager Tests
 *
 * Tests for global and session settings management.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { SettingsManager } from '../../../src/lib/settings-manager';
import type { Database } from '../../../src/storage/database';
import type { GlobalSettings } from '@neokai/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SettingsManager', () => {
	let mockDb: Database;
	let manager: SettingsManager;
	let testWorkspace: string;

	const defaultSettings: GlobalSettings = {
		...DEFAULT_GLOBAL_SETTINGS,
		permissionMode: 'bypassPermissions',
		settingSources: ['user', 'project', 'local'],
	};

	beforeEach(() => {
		// Create a temporary workspace for file operations
		testWorkspace = join(tmpdir(), `test-workspace-${Date.now()}`);
		mkdirSync(testWorkspace, { recursive: true });

		// Mock Database
		mockDb = {
			getGlobalSettings: mock(() => defaultSettings),
			updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => ({
				...defaultSettings,
				...updates,
			})),
			saveGlobalSettings: mock(() => {}),
		} as unknown as Database;

		manager = new SettingsManager(mockDb, testWorkspace);
	});

	afterEach(() => {
		// Cleanup test workspace
		try {
			rmSync(testWorkspace, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('getGlobalSettings', () => {
		it('should return global settings from database', () => {
			const settings = manager.getGlobalSettings();

			expect(settings).toEqual(defaultSettings);
			expect(mockDb.getGlobalSettings).toHaveBeenCalled();
		});
	});

	describe('updateGlobalSettings', () => {
		it('should update settings partially', () => {
			const updates = { permissionMode: 'acceptEdits' as const };
			const result = manager.updateGlobalSettings(updates);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith(updates);
			expect(result.permissionMode).toBe('acceptEdits');
		});
	});

	describe('saveGlobalSettings', () => {
		it('should save settings to database', () => {
			const newSettings: GlobalSettings = {
				...defaultSettings,
				permissionMode: 'acceptEdits',
			};

			manager.saveGlobalSettings(newSettings);

			expect(mockDb.saveGlobalSettings).toHaveBeenCalledWith(newSettings);
		});
	});

	describe('prepareSDKOptions', () => {
		it('should return SDK options from global settings', async () => {
			const options = await manager.prepareSDKOptions();

			expect(options).toHaveProperty('settingSources', ['user', 'project', 'local']);
			expect(options).toHaveProperty('permissionMode', 'bypassPermissions');
		});

		it('should merge session overrides with global settings', async () => {
			const overrides = { permissionMode: 'acceptEdits' as const };
			const options = await manager.prepareSDKOptions(overrides);

			expect(options.permissionMode).toBe('acceptEdits');
		});

		it('should create .claude directory if it does not exist', async () => {
			await manager.prepareSDKOptions();

			const claudeDir = join(testWorkspace, '.claude');
			expect(existsSync(claudeDir)).toBe(true);
		});

		it('should write settings.local.json', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				disabledMcpServers: ['server1', 'server2'],
			});

			await manager.prepareSDKOptions();

			const settingsPath = join(testWorkspace, '.claude', 'settings.local.json');
			expect(existsSync(settingsPath)).toBe(true);
		});

		it('should include model in SDK options when set', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				model: 'claude-opus-4-20250514',
			});

			const options = await manager.prepareSDKOptions();

			expect(options.model).toBe('claude-opus-4-20250514');
		});

		it('should include maxThinkingTokens when set', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				maxThinkingTokens: 5000,
			});

			const options = await manager.prepareSDKOptions();

			expect(options.maxThinkingTokens).toBe(5000);
		});

		it('should include sandbox options when set', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				sandbox: {
					enabled: true,
					autoAllowBashIfSandboxed: true,
					network: 'none',
				},
			});

			const options = await manager.prepareSDKOptions();

			expect(options.sandbox).toEqual({
				enabled: true,
				autoAllowBashIfSandboxed: true,
				network: 'none',
			});
		});
	});

	describe('readFileOnlySettings', () => {
		it('should return empty object when file does not exist', () => {
			const settings = manager.readFileOnlySettings();
			expect(settings).toEqual({});
		});

		it('should read settings from file', async () => {
			// Write test settings first
			const claudeDir = join(testWorkspace, '.claude');
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(
				join(claudeDir, 'settings.local.json'),
				JSON.stringify({
					disabledMcpjsonServers: ['server1'],
					outputStyle: 'compact',
				})
			);

			const settings = manager.readFileOnlySettings();

			expect(settings.disabledMcpServers).toEqual(['server1']);
			expect(settings.outputStyle).toBe('compact');
		});
	});

	describe('listMcpServersFromSources', () => {
		it('should return empty arrays when no sources exist', () => {
			const servers = manager.listMcpServersFromSources();

			expect(servers.user).toEqual([]);
			expect(servers.project).toEqual([]);
			expect(servers.local).toEqual([]);
		});

		it('should read MCP servers from .mcp.json', () => {
			// Write test .mcp.json
			writeFileSync(
				join(testWorkspace, '.mcp.json'),
				JSON.stringify({
					mcpServers: {
						'test-server': { command: 'test-cmd' },
					},
				})
			);

			const servers = manager.listMcpServersFromSources();

			expect(servers.project).toHaveLength(1);
			expect(servers.project[0].name).toBe('test-server');
			expect(servers.project[0].source).toBe('project');
		});

		it('should read MCP servers from local settings', () => {
			const claudeDir = join(testWorkspace, '.claude');
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(
				join(claudeDir, 'settings.local.json'),
				JSON.stringify({
					mcpServers: {
						'local-server': { command: 'local-cmd', args: ['arg1'] },
					},
				})
			);

			const servers = manager.listMcpServersFromSources();

			expect(servers.local).toHaveLength(1);
			expect(servers.local[0].name).toBe('local-server');
			expect(servers.local[0].command).toBe('local-cmd');
			expect(servers.local[0].args).toEqual(['arg1']);
		});

		it('should skip sources that are disabled', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				settingSources: ['user'], // Only user enabled
			});

			writeFileSync(
				join(testWorkspace, '.mcp.json'),
				JSON.stringify({
					mcpServers: { 'test-server': { command: 'test-cmd' } },
				})
			);

			const servers = manager.listMcpServersFromSources();

			expect(servers.project).toEqual([]);
		});
	});

	describe('toggleMcpServer', () => {
		it('should disable a server', async () => {
			await manager.toggleMcpServer('server1', false);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				disabledMcpServers: ['server1'],
			});
		});

		it('should enable a previously disabled server', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				disabledMcpServers: ['server1', 'server2'],
			});

			await manager.toggleMcpServer('server1', true);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				disabledMcpServers: ['server2'],
			});
		});

		it('should not duplicate when disabling already disabled server', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				disabledMcpServers: ['server1'],
			});

			await manager.toggleMcpServer('server1', false);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				disabledMcpServers: ['server1'],
			});
		});
	});

	describe('getDisabledMcpServers', () => {
		it('should return disabled MCP servers from settings', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				disabledMcpServers: ['server1', 'server2'],
			});

			const disabled = manager.getDisabledMcpServers();

			expect(disabled).toEqual(['server1', 'server2']);
		});

		it('should return empty array when none disabled', () => {
			const disabled = manager.getDisabledMcpServers();
			expect(disabled).toEqual([]);
		});
	});

	describe('setDisabledMcpServers', () => {
		it('should set disabled MCP servers', async () => {
			await manager.setDisabledMcpServers(['server1', 'server2']);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				disabledMcpServers: ['server1', 'server2'],
			});
		});
	});

	describe('updateMcpServerSettings', () => {
		it('should update MCP server settings', () => {
			manager.updateMcpServerSettings('test-server', {
				allowed: true,
				defaultOn: false,
			});

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				mcpServerSettings: {
					'test-server': { allowed: true, defaultOn: false },
				},
			});
		});

		it('should merge with existing server settings', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				mcpServerSettings: {
					'existing-server': { allowed: false },
				},
			});

			manager.updateMcpServerSettings('test-server', { allowed: true });

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				mcpServerSettings: {
					'existing-server': { allowed: false },
					'test-server': { allowed: true },
				},
			});
		});
	});

	describe('getMcpServerSettings', () => {
		it('should return MCP server settings', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultSettings,
				mcpServerSettings: {
					'test-server': { allowed: true, defaultOn: false },
				},
			});

			const settings = manager.getMcpServerSettings();

			expect(settings).toEqual({
				'test-server': { allowed: true, defaultOn: false },
			});
		});

		it('should return empty object when no settings exist', () => {
			const settings = manager.getMcpServerSettings();
			expect(settings).toEqual({});
		});
	});

	describe('readFileOnlySettings error handling', () => {
		it('should return empty object on parse error', () => {
			const claudeDir = join(testWorkspace, '.claude');
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(join(claudeDir, 'settings.local.json'), 'invalid json');

			const settings = manager.readFileOnlySettings();

			expect(settings).toEqual({});
		});
	});
});
