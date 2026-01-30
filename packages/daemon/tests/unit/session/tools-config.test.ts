/**
 * Tools Config Manager Tests
 *
 * Tests for global tools configuration management.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ToolsConfigManager } from '../../../src/lib/session/tools-config';
import type { Database } from '../../../src/storage/database';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import type { GlobalToolsConfig, GlobalSettings } from '@neokai/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

describe('ToolsConfigManager', () => {
	let mockDb: Database;
	let mockSettingsManager: SettingsManager;
	let manager: ToolsConfigManager;

	const defaultGlobalToolsConfig: GlobalToolsConfig = {
		systemPrompt: { claudeCodePreset: { allowed: true, defaultEnabled: true } },
		settingSources: { project: { allowed: true, defaultEnabled: true } },
		mcp: { allowProjectMcp: true, defaultProjectMcp: true },
		kaiTools: { memory: { allowed: true, defaultEnabled: false } },
	};

	const defaultGlobalSettings: GlobalSettings = {
		...DEFAULT_GLOBAL_SETTINGS,
		mcpServerSettings: {},
		settingSources: ['user', 'project', 'local'],
	};

	beforeEach(() => {
		// Mock Database
		mockDb = {
			getGlobalToolsConfig: mock(() => defaultGlobalToolsConfig),
			saveGlobalToolsConfig: mock(() => {}),
		} as unknown as Database;

		// Mock SettingsManager
		mockSettingsManager = {
			getGlobalSettings: mock(() => defaultGlobalSettings),
			listMcpServersFromSources: mock(() => ({
				user: [],
				project: [],
				local: [],
			})),
		} as unknown as SettingsManager;

		manager = new ToolsConfigManager(mockDb, mockSettingsManager);
	});

	describe('getGlobal', () => {
		it('should return global tools configuration from database', () => {
			const config = manager.getGlobal();

			expect(config).toEqual(defaultGlobalToolsConfig);
			expect(mockDb.getGlobalToolsConfig).toHaveBeenCalled();
		});
	});

	describe('saveGlobal', () => {
		it('should save global tools configuration to database', () => {
			const newConfig: GlobalToolsConfig = {
				...defaultGlobalToolsConfig,
				mcp: { allowProjectMcp: false, defaultProjectMcp: false },
			};

			manager.saveGlobal(newConfig);

			expect(mockDb.saveGlobalToolsConfig).toHaveBeenCalledWith(newConfig);
		});
	});

	describe('getDefaultForNewSession', () => {
		it('should return default tools config based on global settings', () => {
			const result = manager.getDefaultForNewSession();

			expect(result).toHaveProperty('useClaudeCodePreset', true);
			expect(result).toHaveProperty('settingSources', ['user', 'project', 'local']);
			expect(result).toHaveProperty('disabledMcpServers');
			expect(result).toHaveProperty('kaiTools');
		});

		it('should disable Claude Code preset when not allowed', () => {
			(mockDb.getGlobalToolsConfig as ReturnType<typeof mock>).mockReturnValue({
				...defaultGlobalToolsConfig,
				systemPrompt: { claudeCodePreset: { allowed: false, defaultEnabled: true } },
			});

			const result = manager.getDefaultForNewSession();

			expect(result.useClaudeCodePreset).toBe(false);
		});

		it('should disable Claude Code preset when default is disabled', () => {
			(mockDb.getGlobalToolsConfig as ReturnType<typeof mock>).mockReturnValue({
				...defaultGlobalToolsConfig,
				systemPrompt: { claudeCodePreset: { allowed: true, defaultEnabled: false } },
			});

			const result = manager.getDefaultForNewSession();

			expect(result.useClaudeCodePreset).toBe(false);
		});

		it('should disable memory tool when not allowed', () => {
			(mockDb.getGlobalToolsConfig as ReturnType<typeof mock>).mockReturnValue({
				...defaultGlobalToolsConfig,
				kaiTools: { memory: { allowed: false, defaultEnabled: true } },
			});

			const result = manager.getDefaultForNewSession();

			expect(result.kaiTools?.memory).toBe(false);
		});

		it('should populate disabledMcpServers from MCP settings', () => {
			(mockSettingsManager.listMcpServersFromSources as ReturnType<typeof mock>).mockReturnValue({
				user: [{ name: 'server1' }],
				project: [{ name: 'server2' }],
				local: [],
			});

			(mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultGlobalSettings,
				mcpServerSettings: {
					server1: { allowed: true, defaultOn: true },
					server2: { allowed: true, defaultOn: false },
				},
			});

			const result = manager.getDefaultForNewSession();

			// server2 should be disabled because defaultOn is false
			expect(result.disabledMcpServers).toContain('server2');
			// server1 should not be disabled
			expect(result.disabledMcpServers).not.toContain('server1');
		});

		it('should disable servers that are not allowed', () => {
			(mockSettingsManager.listMcpServersFromSources as ReturnType<typeof mock>).mockReturnValue({
				user: [{ name: 'blocked-server' }],
				project: [],
				local: [],
			});

			(mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultGlobalSettings,
				mcpServerSettings: {
					'blocked-server': { allowed: false, defaultOn: true },
				},
			});

			const result = manager.getDefaultForNewSession();

			expect(result.disabledMcpServers).toContain('blocked-server');
		});

		it('should use default setting sources from global settings', () => {
			(mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...defaultGlobalSettings,
				settingSources: ['user', 'local'],
			});

			const result = manager.getDefaultForNewSession();

			expect(result.settingSources).toEqual(['user', 'local']);
		});
	});
});
