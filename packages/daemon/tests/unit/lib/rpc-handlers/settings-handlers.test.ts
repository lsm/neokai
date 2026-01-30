/**
 * Settings Handlers Tests
 *
 * Tests for settings RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { registerSettingsHandlers } from '../../../../src/lib/rpc-handlers/settings-handlers';
import type { MessageHub, GlobalSettings } from '@neokai/shared';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { Database } from '../../../../src/storage/database';

describe('Settings Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSettingsManager: SettingsManager;
	let mockDaemonHub: DaemonHub;
	let mockDb: Database;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;

	const defaultGlobalSettings: GlobalSettings = {
		theme: 'system',
		fontSize: 14,
		showArchived: false,
		sidebarCollapsed: false,
		enableSounds: true,
		showTimestamps: true,
	};

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
		} as unknown as MessageHub;

		// Mock SettingsManager
		mockSettingsManager = {
			getGlobalSettings: mock(() => ({ ...defaultGlobalSettings })),
			updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => ({
				...defaultGlobalSettings,
				...updates,
			})),
			saveGlobalSettings: mock(() => {}),
			toggleMcpServer: mock(async () => {}),
			getDisabledMcpServers: mock(() => []),
			setDisabledMcpServers: mock(async () => {}),
			readFileOnlySettings: mock(() => ({})),
			listMcpServersFromSources: mock(() => []),
			getMcpServerSettings: mock(() => ({})),
			updateMcpServerSettings: mock(() => {}),
		} as unknown as SettingsManager;

		// Mock DaemonHub
		mockDaemonHub = {
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		// Mock Database
		mockDb = {
			getSession: mock(() => ({
				id: 'test-session-id',
				workspacePath: '/test/workspace',
			})),
		} as unknown as Database;

		// Setup handlers
		registerSettingsHandlers(mockMessageHub, mockSettingsManager, mockDaemonHub, mockDb);
	});

	async function callHandler(name: string, data?: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register all settings handlers', () => {
			expect(handlers.has('settings.global.get')).toBe(true);
			expect(handlers.has('settings.global.update')).toBe(true);
			expect(handlers.has('settings.global.save')).toBe(true);
			expect(handlers.has('settings.mcp.toggle')).toBe(true);
			expect(handlers.has('settings.mcp.getDisabled')).toBe(true);
			expect(handlers.has('settings.mcp.setDisabled')).toBe(true);
			expect(handlers.has('settings.fileOnly.read')).toBe(true);
			expect(handlers.has('settings.mcp.listFromSources')).toBe(true);
			expect(handlers.has('settings.mcp.updateServerSettings')).toBe(true);
			expect(handlers.has('settings.session.get')).toBe(true);
			expect(handlers.has('settings.session.update')).toBe(true);
		});
	});

	describe('settings.global.get', () => {
		it('should return global settings', async () => {
			const result = await callHandler('settings.global.get');

			expect(result).toEqual(defaultGlobalSettings);
			expect(mockSettingsManager.getGlobalSettings).toHaveBeenCalled();
		});
	});

	describe('settings.global.update', () => {
		it('should update global settings', async () => {
			const updates = { theme: 'dark' as const, fontSize: 16 };

			const result = (await callHandler('settings.global.update', { updates })) as {
				success: boolean;
				settings: GlobalSettings;
			};

			expect(result.success).toBe(true);
			expect(mockSettingsManager.updateGlobalSettings).toHaveBeenCalledWith(updates);
			expect(mockDaemonHub.emit).toHaveBeenCalledWith('settings.updated', {
				sessionId: 'global',
				settings: expect.any(Object),
			});
		});

		it('should emit sessions.filterChanged when showArchived changes', async () => {
			const updates = { showArchived: true };

			await callHandler('settings.global.update', { updates });

			expect(mockDaemonHub.emit).toHaveBeenCalledWith('settings.updated', expect.any(Object));
			expect(mockDaemonHub.emit).toHaveBeenCalledWith('sessions.filterChanged', {
				sessionId: 'global',
			});
		});

		it('should not emit sessions.filterChanged for other setting changes', async () => {
			const updates = { fontSize: 18 };

			await callHandler('settings.global.update', { updates });

			expect(mockDaemonHub.emit).toHaveBeenCalledTimes(1);
			expect(mockDaemonHub.emit).toHaveBeenCalledWith('settings.updated', expect.any(Object));
		});
	});

	describe('settings.global.save', () => {
		it('should save global settings', async () => {
			const newSettings: GlobalSettings = {
				...defaultGlobalSettings,
				theme: 'light',
			};

			const result = (await callHandler('settings.global.save', { settings: newSettings })) as {
				success: boolean;
			};

			expect(result.success).toBe(true);
			expect(mockSettingsManager.saveGlobalSettings).toHaveBeenCalledWith(newSettings);
			expect(mockDaemonHub.emit).toHaveBeenCalledWith('settings.updated', {
				sessionId: 'global',
				settings: newSettings,
			});
		});
	});

	describe('settings.mcp.toggle', () => {
		it('should toggle MCP server enabled state', async () => {
			const result = (await callHandler('settings.mcp.toggle', {
				serverName: 'test-server',
				enabled: false,
			})) as { success: boolean };

			expect(result.success).toBe(true);
			expect(mockSettingsManager.toggleMcpServer).toHaveBeenCalledWith('test-server', false);
			expect(mockDaemonHub.emit).toHaveBeenCalledWith('settings.updated', expect.any(Object));
		});
	});

	describe('settings.mcp.getDisabled', () => {
		it('should return list of disabled MCP servers', async () => {
			(mockSettingsManager.getDisabledMcpServers as ReturnType<typeof mock>).mockReturnValue([
				'server1',
				'server2',
			]);

			const result = (await callHandler('settings.mcp.getDisabled')) as {
				disabledServers: string[];
			};

			expect(result.disabledServers).toEqual(['server1', 'server2']);
		});
	});

	describe('settings.mcp.setDisabled', () => {
		it('should set list of disabled MCP servers', async () => {
			const disabledServers = ['server1', 'server2'];

			const result = (await callHandler('settings.mcp.setDisabled', { disabledServers })) as {
				success: boolean;
			};

			expect(result.success).toBe(true);
			expect(mockSettingsManager.setDisabledMcpServers).toHaveBeenCalledWith(disabledServers);
			expect(mockDaemonHub.emit).toHaveBeenCalledWith('settings.updated', expect.any(Object));
		});
	});

	describe('settings.fileOnly.read', () => {
		it('should read file-only settings', async () => {
			const fileSettings = { someKey: 'someValue' };
			(mockSettingsManager.readFileOnlySettings as ReturnType<typeof mock>).mockReturnValue(
				fileSettings
			);

			const result = await callHandler('settings.fileOnly.read');

			expect(result).toEqual(fileSettings);
		});
	});

	describe('settings.mcp.listFromSources', () => {
		it('should list MCP servers from sources without sessionId', async () => {
			const mockServers = [{ name: 'server1', source: 'file' }];
			const mockServerSettings = { server1: { allowed: true } };
			(mockSettingsManager.listMcpServersFromSources as ReturnType<typeof mock>).mockReturnValue(
				mockServers
			);
			(mockSettingsManager.getMcpServerSettings as ReturnType<typeof mock>).mockReturnValue(
				mockServerSettings
			);

			const result = (await callHandler('settings.mcp.listFromSources')) as {
				servers: unknown[];
				serverSettings: unknown;
			};

			expect(result.servers).toEqual(mockServers);
			expect(result.serverSettings).toEqual(mockServerSettings);
		});

		it('should throw if session not found when sessionId provided', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			await expect(
				callHandler('settings.mcp.listFromSources', { sessionId: 'nonexistent' })
			).rejects.toThrow('Session not found');
		});
	});

	describe('settings.mcp.updateServerSettings', () => {
		it('should update MCP server settings', async () => {
			const result = (await callHandler('settings.mcp.updateServerSettings', {
				serverName: 'test-server',
				settings: { allowed: true, defaultOn: false },
			})) as { success: boolean };

			expect(result.success).toBe(true);
			expect(mockSettingsManager.updateMcpServerSettings).toHaveBeenCalledWith('test-server', {
				allowed: true,
				defaultOn: false,
			});
			expect(mockDaemonHub.emit).toHaveBeenCalledWith('settings.updated', expect.any(Object));
		});
	});

	describe('settings.session.get', () => {
		it('should return session settings (placeholder)', async () => {
			const result = (await callHandler('settings.session.get', {
				sessionId: 'test-session-id',
			})) as { sessionId: string; settings: unknown };

			expect(result.sessionId).toBe('test-session-id');
			expect(result.settings).toEqual({});
		});
	});

	describe('settings.session.update', () => {
		it('should update session settings (placeholder)', async () => {
			const result = (await callHandler('settings.session.update', {
				sessionId: 'test-session-id',
				updates: { someSetting: 'value' },
			})) as { success: boolean; sessionId: string };

			expect(result.success).toBe(true);
			expect(result.sessionId).toBe('test-session-id');
		});
	});
});
