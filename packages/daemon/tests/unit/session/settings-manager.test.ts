/**
 * SettingsManager Tests
 *
 * Unit tests for global and session-specific settings management.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsManager, type McpServerInfo } from '../../../src/lib/settings-manager';
import type { Database } from '../../../src/storage/database';
import type { GlobalSettings, SettingSource } from '@neokai/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

describe('SettingsManager', () => {
	let settingsManager: SettingsManager;
	let mockDb: Database;
	let tempDir: string;
	let workspacePath: string;
	let originalEnv: string | undefined;

	beforeEach(() => {
		// Create temp directories
		tempDir = join(tmpdir(), `settings-test-${Date.now()}`);
		workspacePath = join(tempDir, 'workspace');
		mkdirSync(workspacePath, { recursive: true });

		// Save original env
		originalEnv = process.env.TEST_USER_SETTINGS_DIR;

		// Create isolated user settings dir
		const userSettingsDir = join(tempDir, 'user-settings');
		mkdirSync(userSettingsDir, { recursive: true });
		process.env.TEST_USER_SETTINGS_DIR = userSettingsDir;

		// Mock Database
		mockDb = {
			getGlobalSettings: mock(() => ({ ...DEFAULT_GLOBAL_SETTINGS })),
			updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => ({
				...DEFAULT_GLOBAL_SETTINGS,
				...updates,
			})),
			saveGlobalSettings: mock(() => {}),
		} as unknown as Database;

		settingsManager = new SettingsManager(mockDb, workspacePath);
	});

	afterEach(() => {
		// Restore original env
		if (originalEnv !== undefined) {
			process.env.TEST_USER_SETTINGS_DIR = originalEnv;
		} else {
			delete process.env.TEST_USER_SETTINGS_DIR;
		}

		// Cleanup temp directory
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('getGlobalSettings', () => {
		it('should return global settings from database', () => {
			const settings = settingsManager.getGlobalSettings();

			expect(mockDb.getGlobalSettings).toHaveBeenCalled();
			expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
		});
	});

	describe('updateGlobalSettings', () => {
		it('should update global settings partially', () => {
			const updates = { showArchived: true };
			const result = settingsManager.updateGlobalSettings(updates);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith(updates);
			expect(result.showArchived).toBe(true);
		});

		it('should merge with existing settings', () => {
			const updates = { model: 'claude-opus-4-20250514' };
			const result = settingsManager.updateGlobalSettings(updates);

			expect(result.model).toBe('claude-opus-4-20250514');
			expect(result.settingSources).toEqual(DEFAULT_GLOBAL_SETTINGS.settingSources);
		});
	});

	describe('saveGlobalSettings', () => {
		it('should save complete settings to database', () => {
			const newSettings: GlobalSettings = {
				...DEFAULT_GLOBAL_SETTINGS,
				model: 'claude-opus-4-20250514',
			};

			settingsManager.saveGlobalSettings(newSettings);

			expect(mockDb.saveGlobalSettings).toHaveBeenCalledWith(newSettings);
		});
	});

	describe('prepareSDKOptions', () => {
		it('should merge global settings with session overrides', async () => {
			const sessionOverrides = {
				model: 'claude-opus-4-20250514',
				maxTurns: 10,
			};

			const result = await settingsManager.prepareSDKOptions(sessionOverrides);

			expect(result.model).toBe('claude-opus-4-20250514');
			expect(result.maxTurns).toBe(10);
		});

		it('should write file-only settings', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				disabledMcpServers: ['server1', 'server2'],
			});

			await settingsManager.prepareSDKOptions();

			// Check that settings.local.json was created
			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			expect(existsSync(settingsPath)).toBe(true);

			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
			expect(content.disabledMcpjsonServers).toEqual(['server1', 'server2']);
		});

		it('should extract SDK-supported options', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				model: 'claude-sonnet-4-20250514',
				permissionMode: 'acceptEdits',
				allowedTools: ['tool1', 'tool2'],
				maxThinkingTokens: 10000,
				maxTurns: 5,
				maxBudgetUsd: 10,
			});

			const result = await settingsManager.prepareSDKOptions();

			expect(result.model).toBe('claude-sonnet-4-20250514');
			expect(result.permissionMode).toBe('acceptEdits');
			expect(result.allowedTools).toEqual(['tool1', 'tool2']);
			expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 10000 });
			expect(result.maxTurns).toBe(5);
			expect(result.maxBudgetUsd).toBe(10);
		});

		it('should handle disabled thinking', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				maxThinkingTokens: null,
			});

			const result = await settingsManager.prepareSDKOptions();

			expect(result.thinking).toEqual({ type: 'disabled' });
		});

		it('should include sandbox settings', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				sandbox: {
					enabled: true,
					autoAllowBashIfSandboxed: true,
					network: {
						allowLocalBinding: true,
					},
				},
			});

			const result = await settingsManager.prepareSDKOptions();

			expect(result.sandbox).toEqual({
				enabled: true,
				autoAllowBashIfSandboxed: true,
				network: {
					allowLocalBinding: true,
				},
			});
		});

		it('should include env settings', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				env: {
					CUSTOM_VAR: 'value',
				},
			});

			const result = await settingsManager.prepareSDKOptions();

			expect(result.env).toEqual({ CUSTOM_VAR: 'value' });
		});

		it('should include betas', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				betas: ['context-1m-2025-08-07'],
			});

			const result = await settingsManager.prepareSDKOptions();

			expect(result.betas).toEqual(['context-1m-2025-08-07']);
		});

		it('should include system prompt', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				systemPrompt: 'You are a helpful assistant.',
			});

			const result = await settingsManager.prepareSDKOptions();

			expect(result.systemPrompt).toBe('You are a helpful assistant.');
		});
	});

	describe('readFileOnlySettings', () => {
		it('should return empty object when file does not exist', () => {
			const result = settingsManager.readFileOnlySettings();

			expect(result).toEqual({});
		});

		it('should read existing settings file', () => {
			// Create settings file
			const settingsDir = join(workspacePath, '.claude');
			mkdirSync(settingsDir, { recursive: true });
			const settingsPath = join(settingsDir, 'settings.local.json');
			writeFileSync(
				settingsPath,
				JSON.stringify({
					disabledMcpjsonServers: ['server1'],
					permissions: { ask: ['permission1'] },
					outputStyle: 'concise',
				})
			);

			const result = settingsManager.readFileOnlySettings();

			expect(result.disabledMcpServers).toEqual(['server1']);
			expect(result.askPermissions).toEqual(['permission1']);
			expect(result.outputStyle).toBe('concise');
		});

		it('should handle malformed JSON gracefully', () => {
			// Create malformed settings file
			const settingsDir = join(workspacePath, '.claude');
			mkdirSync(settingsDir, { recursive: true });
			const settingsPath = join(settingsDir, 'settings.local.json');
			writeFileSync(settingsPath, 'not valid json');

			const result = settingsManager.readFileOnlySettings();

			expect(result).toEqual({});
		});
	});

	describe('toggleMcpServer', () => {
		it('should remove server from disabled list when enabled', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				disabledMcpServers: ['server1', 'server2', 'server3'],
			});

			await settingsManager.toggleMcpServer('server2', true);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					disabledMcpServers: ['server1', 'server3'],
				})
			);
		});

		it('should add server to disabled list when disabled', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				disabledMcpServers: ['server1'],
			});

			await settingsManager.toggleMcpServer('server2', false);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					disabledMcpServers: ['server1', 'server2'],
				})
			);
		});

		it('should not add duplicate to disabled list', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				disabledMcpServers: ['server1', 'server2'],
			});

			await settingsManager.toggleMcpServer('server2', false);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					disabledMcpServers: ['server1', 'server2'],
				})
			);
		});

		it('should handle empty disabled list', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				disabledMcpServers: undefined,
			});

			await settingsManager.toggleMcpServer('server1', false);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					disabledMcpServers: ['server1'],
				})
			);
		});
	});

	describe('getDisabledMcpServers', () => {
		it('should return disabled servers list', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				disabledMcpServers: ['server1', 'server2'],
			});

			const result = settingsManager.getDisabledMcpServers();

			expect(result).toEqual(['server1', 'server2']);
		});

		it('should return empty array when undefined', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				disabledMcpServers: undefined,
			});

			const result = settingsManager.getDisabledMcpServers();

			expect(result).toEqual([]);
		});
	});

	describe('setDisabledMcpServers', () => {
		it('should update disabled servers and write to file', async () => {
			await settingsManager.setDisabledMcpServers(['server1', 'server2']);

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				disabledMcpServers: ['server1', 'server2'],
			});
		});
	});

	describe('listMcpServersFromSources', () => {
		it('should return empty lists when no settings files exist', () => {
			const result = settingsManager.listMcpServersFromSources();

			expect(result.user).toEqual([]);
			expect(result.project).toEqual([]);
			expect(result.local).toEqual([]);
		});

		it('should read MCP servers from user settings', () => {
			const userSettingsDir = process.env.TEST_USER_SETTINGS_DIR!;
			const userSettingsPath = join(userSettingsDir, 'settings.json');
			writeFileSync(
				userSettingsPath,
				JSON.stringify({
					mcpServers: {
						'user-server': {
							command: 'node',
							args: ['server.js'],
						},
					},
				})
			);

			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
			});

			const result = settingsManager.listMcpServersFromSources();

			expect(result.user).toHaveLength(1);
			expect(result.user[0]).toEqual({
				name: 'user-server',
				source: 'user',
				command: 'node',
				args: ['server.js'],
			});
		});

		it('should read MCP servers from project settings', () => {
			const projectSettingsDir = join(workspacePath, '.claude');
			mkdirSync(projectSettingsDir, { recursive: true });
			const projectSettingsPath = join(projectSettingsDir, 'settings.json');
			writeFileSync(
				projectSettingsPath,
				JSON.stringify({
					mcpServers: {
						'project-server': {
							command: 'python',
							args: ['-m', 'server'],
						},
					},
				})
			);

			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
			});

			const result = settingsManager.listMcpServersFromSources();

			expect(result.project).toHaveLength(1);
			expect(result.project[0].name).toBe('project-server');
		});

		it('should read MCP servers from local settings', () => {
			const localSettingsDir = join(workspacePath, '.claude');
			mkdirSync(localSettingsDir, { recursive: true });
			const localSettingsPath = join(localSettingsDir, 'settings.local.json');
			writeFileSync(
				localSettingsPath,
				JSON.stringify({
					mcpServers: {
						'local-server': {
							command: 'bash',
							args: ['run.sh'],
						},
					},
				})
			);

			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
			});

			const result = settingsManager.listMcpServersFromSources();

			expect(result.local).toHaveLength(1);
			expect(result.local[0].name).toBe('local-server');
		});

		it('should filter sources based on settingSources', () => {
			// Create user settings
			const userSettingsDir = process.env.TEST_USER_SETTINGS_DIR!;
			writeFileSync(
				join(userSettingsDir, 'settings.json'),
				JSON.stringify({
					mcpServers: { 'user-server': { command: 'node' } },
				})
			);

			// Create project settings
			const projectSettingsDir = join(workspacePath, '.claude');
			mkdirSync(projectSettingsDir, { recursive: true });
			writeFileSync(
				join(projectSettingsDir, 'settings.json'),
				JSON.stringify({
					mcpServers: { 'project-server': { command: 'python' } },
				})
			);

			// Only enable project source
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['project'] as SettingSource[],
			});

			const result = settingsManager.listMcpServersFromSources();

			expect(result.user).toEqual([]);
			expect(result.project).toHaveLength(1);
			expect(result.local).toEqual([]);
		});

		it('should read from .mcp.json files', () => {
			// Create project .mcp.json
			const projectMcpPath = join(workspacePath, '.mcp.json');
			writeFileSync(
				projectMcpPath,
				JSON.stringify({
					mcpServers: {
						'mcp-json-server': {
							command: 'npx',
							args: ['mcp-server'],
						},
					},
				})
			);

			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['project'],
			});

			const result = settingsManager.listMcpServersFromSources();

			expect(result.project).toHaveLength(1);
			expect(result.project[0].name).toBe('mcp-json-server');
		});

		it('should handle malformed settings files gracefully', () => {
			const projectSettingsDir = join(workspacePath, '.claude');
			mkdirSync(projectSettingsDir, { recursive: true });
			writeFileSync(join(projectSettingsDir, 'settings.json'), 'not json');

			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['project'],
			});

			// Should not throw
			const result = settingsManager.listMcpServersFromSources();
			expect(result.project).toEqual([]);
		});
	});

	describe('updateMcpServerSettings', () => {
		it('should update per-server settings', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				mcpServerSettings: {},
			});

			settingsManager.updateMcpServerSettings('server1', {
				allowed: true,
				defaultOn: true,
			});

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				mcpServerSettings: {
					server1: { allowed: true, defaultOn: true },
				},
			});
		});

		it('should merge with existing server settings', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				mcpServerSettings: {
					server1: { allowed: true },
				},
			});

			settingsManager.updateMcpServerSettings('server1', {
				defaultOn: true,
			});

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				mcpServerSettings: {
					server1: { allowed: true, defaultOn: true },
				},
			});
		});

		it('should add new server to existing settings', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				mcpServerSettings: {
					server1: { allowed: true },
				},
			});

			settingsManager.updateMcpServerSettings('server2', {
				allowed: false,
			});

			expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith({
				mcpServerSettings: {
					server1: { allowed: true },
					server2: { allowed: false },
				},
			});
		});
	});

	describe('getMcpServerSettings', () => {
		it('should return per-server settings', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				mcpServerSettings: {
					server1: { allowed: true, defaultOn: true },
				},
			});

			const result = settingsManager.getMcpServerSettings();

			expect(result).toEqual({
				server1: { allowed: true, defaultOn: true },
			});
		});

		it('should return empty object when undefined', () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				mcpServerSettings: undefined,
			});

			const result = settingsManager.getMcpServerSettings();

			expect(result).toEqual({});
		});
	});

	describe('writeFileOnlySettings', () => {
		it('should write MCP server control settings', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				disabledMcpServers: ['disabled1'],
				enabledMcpServers: ['enabled1'],
				enableAllProjectMcpServers: true,
			});

			await settingsManager.prepareSDKOptions();

			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

			expect(content.disabledMcpjsonServers).toEqual(['disabled1']);
			expect(content.enabledMcpjsonServers).toEqual(['enabled1']);
			expect(content.enableAllProjectMcpServers).toBe(true);
		});

		it('should write permission settings', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				askPermissions: ['ask1', 'ask2'],
			});

			await settingsManager.prepareSDKOptions();

			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

			expect(content.permissions.ask).toEqual(['ask1', 'ask2']);
		});

		it('should write sandbox settings', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				excludedCommands: ['cmd1', 'cmd2'],
				allowUnsandboxedCommands: true,
			});

			await settingsManager.prepareSDKOptions();

			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

			expect(content.sandbox.excludedCommands).toEqual(['cmd1', 'cmd2']);
			expect(content.sandbox.allowUnsandboxedCommands).toBe(true);
		});

		it('should write output style', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				outputStyle: 'concise',
			});

			await settingsManager.prepareSDKOptions();

			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

			expect(content.outputStyle).toBe('concise');
		});

		it('should write attribution', async () => {
			(mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				attribution: { commit: 'abc123' },
			});

			await settingsManager.prepareSDKOptions();

			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

			expect(content.attribution).toEqual({ commit: 'abc123' });
		});

		it('should preserve existing settings not managed by NeoKai', async () => {
			// Create existing settings file with custom settings
			const settingsDir = join(workspacePath, '.claude');
			mkdirSync(settingsDir, { recursive: true });
			const settingsPath = join(settingsDir, 'settings.local.json');
			writeFileSync(
				settingsPath,
				JSON.stringify({
					customSetting: 'preserved',
					anotherSetting: 123,
				})
			);

			await settingsManager.prepareSDKOptions();

			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

			expect(content.customSetting).toBe('preserved');
			expect(content.anotherSetting).toBe(123);
		});

		it('should create .claude directory if it does not exist', async () => {
			await settingsManager.prepareSDKOptions();

			const settingsDir = join(workspacePath, '.claude');
			expect(existsSync(settingsDir)).toBe(true);
		});
	});
});
