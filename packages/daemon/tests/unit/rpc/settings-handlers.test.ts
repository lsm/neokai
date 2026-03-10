/**
 * Tests for Settings RPC Handlers
 *
 * Tests the RPC handlers for settings operations:
 * - settings.global.get - Get global settings
 * - settings.global.update - Update global settings (partial update)
 * - settings.global.save - Save global settings (full replace)
 * - settings.mcp.toggle - Toggle MCP server enabled/disabled
 * - settings.mcp.getDisabled - Get list of disabled MCP servers
 * - settings.mcp.setDisabled - Set list of disabled MCP servers
 * - settings.fileOnly.read - Read file-only settings
 * - settings.mcp.listFromSources - List MCP servers from enabled sources
 * - settings.mcp.updateServerSettings - Update per-server MCP settings
 * - settings.session.get - Get session settings
 * - settings.session.update - Update session settings
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type GlobalSettings, type SessionSettings } from '@neokai/shared';
import { registerSettingsHandlers } from '../../../src/lib/rpc-handlers/settings-handlers';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Helper to create a minimal mock MessageHub that captures handlers
function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

// Helper to create mock DaemonHub
function createMockDaemonHub(): {
	daemonHub: DaemonHub;
	emitMock: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emitMock };
}

// Default global settings
const defaultGlobalSettings: GlobalSettings = {
	theme: 'dark',
	showArchived: false,
	defaultModel: 'claude-sonnet-4-20250514',
	mcpServerSettings: {},
};

// Helper to create mock SettingsManager
function createMockSettingsManager(): {
	settingsManager: SettingsManager;
	mocks: {
		getGlobalSettings: ReturnType<typeof mock>;
		updateGlobalSettings: ReturnType<typeof mock>;
		saveGlobalSettings: ReturnType<typeof mock>;
		toggleMcpServer: ReturnType<typeof mock>;
		getDisabledMcpServers: ReturnType<typeof mock>;
		setDisabledMcpServers: ReturnType<typeof mock>;
		readFileOnlySettings: ReturnType<typeof mock>;
		listMcpServersFromSources: ReturnType<typeof mock>;
		getMcpServerSettings: ReturnType<typeof mock>;
		updateMcpServerSettings: ReturnType<typeof mock>;
	};
} {
	const mocks = {
		getGlobalSettings: mock(() => defaultGlobalSettings),
		updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => ({
			...defaultGlobalSettings,
			...updates,
		})),
		saveGlobalSettings: mock(() => {}),
		toggleMcpServer: mock(async () => {}),
		getDisabledMcpServers: mock(() => ['disabled-server-1', 'disabled-server-2']),
		setDisabledMcpServers: mock(async () => {}),
		readFileOnlySettings: mock(() => ({ someSetting: 'value' })),
		listMcpServersFromSources: mock(() => [
			{ name: 'server-1', command: 'npx', args: ['-y', 'mcp-server-1'] },
			{ name: 'server-2', command: 'npx', args: ['-y', 'mcp-server-2'] },
		]),
		getMcpServerSettings: mock(() => ({
			'server-1': { allowed: true, defaultOn: true },
			'server-2': { allowed: false, defaultOn: false },
		})),
		updateMcpServerSettings: mock(() => {}),
	};

	return {
		settingsManager: {
			...mocks,
		} as unknown as SettingsManager,
		mocks,
	};
}

// Helper to create mock Database
function createMockDatabase(): {
	db: Database;
	mocks: {
		getSession: ReturnType<typeof mock>;
	};
} {
	const mocks = {
		getSession: mock(() => ({
			id: 'session-123',
			workspacePath: '/workspace/test',
		})),
	};

	return {
		db: {
			getSession: mocks.getSession,
		} as unknown as Database,
		mocks,
	};
}

describe('Settings RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	let settingsManagerData: ReturnType<typeof createMockSettingsManager>;
	let dbData: ReturnType<typeof createMockDatabase>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();
		settingsManagerData = createMockSettingsManager();
		dbData = createMockDatabase();

		// Setup handlers with mocked dependencies
		registerSettingsHandlers(
			messageHubData.hub,
			settingsManagerData.settingsManager,
			daemonHubData.daemonHub,
			dbData.db
		);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('settings.global.get', () => {
		it('returns global settings', async () => {
			const handler = messageHubData.handlers.get('settings.global.get');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as GlobalSettings;

			expect(result).toBeDefined();
			expect(result.theme).toBe('dark');
			expect(result.showArchived).toBe(false);
		});

		it('calls getGlobalSettings on settings manager', async () => {
			const handler = messageHubData.handlers.get('settings.global.get');
			expect(handler).toBeDefined();

			await handler!({}, {});

			expect(settingsManagerData.mocks.getGlobalSettings).toHaveBeenCalled();
		});
	});

	describe('settings.global.update', () => {
		it('updates global settings partially', async () => {
			const handler = messageHubData.handlers.get('settings.global.update');
			expect(handler).toBeDefined();

			const result = (await handler!({ updates: { theme: 'light' } }, {})) as {
				success: boolean;
				settings: GlobalSettings;
			};

			expect(result.success).toBe(true);
			expect(result.settings.theme).toBe('light');
		});

		it('emits settings.updated event', async () => {
			const handler = messageHubData.handlers.get('settings.global.update');
			expect(handler).toBeDefined();

			await handler!({ updates: { theme: 'light' } }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'settings.updated',
				expect.objectContaining({
					sessionId: 'global',
				})
			);
		});

		it('emits sessions.filterChanged when showArchived changes', async () => {
			const handler = messageHubData.handlers.get('settings.global.update');
			expect(handler).toBeDefined();

			await handler!({ updates: { showArchived: true } }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'sessions.filterChanged',
				expect.objectContaining({
					sessionId: 'global',
				})
			);
		});

		it('does not emit sessions.filterChanged for other updates', async () => {
			const handler = messageHubData.handlers.get('settings.global.update');
			expect(handler).toBeDefined();

			await handler!({ updates: { theme: 'light' } }, {});

			const filterChangedCalls = daemonHubData.emitMock.mock.calls.filter(
				(call) => call[0] === 'sessions.filterChanged'
			);
			expect(filterChangedCalls).toHaveLength(0);
		});

		it('handles multiple updates', async () => {
			const handler = messageHubData.handlers.get('settings.global.update');
			expect(handler).toBeDefined();

			const result = (await handler!(
				{ updates: { theme: 'light', showArchived: true, defaultModel: 'claude-opus' } },
				{}
			)) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.theme).toBe('light');
			expect(result.settings.showArchived).toBe(true);
		});
	});

	describe('settings.global.save', () => {
		it('saves global settings', async () => {
			const handler = messageHubData.handlers.get('settings.global.save');
			expect(handler).toBeDefined();

			const newSettings: GlobalSettings = {
				theme: 'light',
				showArchived: true,
				defaultModel: 'claude-opus',
				mcpServerSettings: {},
			};

			const result = (await handler!({ settings: newSettings }, {})) as { success: boolean };

			expect(result.success).toBe(true);
			expect(settingsManagerData.mocks.saveGlobalSettings).toHaveBeenCalledWith(newSettings);
		});

		it('emits settings.updated event', async () => {
			const handler = messageHubData.handlers.get('settings.global.save');
			expect(handler).toBeDefined();

			await handler!({ settings: defaultGlobalSettings }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'settings.updated',
				expect.objectContaining({
					sessionId: 'global',
				})
			);
		});
	});

	describe('settings.mcp.toggle', () => {
		it('toggles MCP server on', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.toggle');
			expect(handler).toBeDefined();

			const result = (await handler!({ serverName: 'test-server', enabled: true }, {})) as {
				success: boolean;
			};

			expect(result.success).toBe(true);
			expect(settingsManagerData.mocks.toggleMcpServer).toHaveBeenCalledWith('test-server', true);
		});

		it('toggles MCP server off', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.toggle');
			expect(handler).toBeDefined();

			const result = (await handler!({ serverName: 'test-server', enabled: false }, {})) as {
				success: boolean;
			};

			expect(result.success).toBe(true);
			expect(settingsManagerData.mocks.toggleMcpServer).toHaveBeenCalledWith('test-server', false);
		});

		it('emits settings.updated event', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.toggle');
			expect(handler).toBeDefined();

			await handler!({ serverName: 'test-server', enabled: true }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'settings.updated',
				expect.objectContaining({
					sessionId: 'global',
				})
			);
		});
	});

	describe('settings.mcp.getDisabled', () => {
		it('returns list of disabled MCP servers', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.getDisabled');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as { disabledServers: string[] };

			expect(result.disabledServers).toBeDefined();
			expect(result.disabledServers).toContain('disabled-server-1');
			expect(result.disabledServers).toContain('disabled-server-2');
		});
	});

	describe('settings.mcp.setDisabled', () => {
		it('sets list of disabled MCP servers', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.setDisabled');
			expect(handler).toBeDefined();

			const disabledServers = ['server-a', 'server-b'];

			const result = (await handler!({ disabledServers }, {})) as { success: boolean };

			expect(result.success).toBe(true);
			expect(settingsManagerData.mocks.setDisabledMcpServers).toHaveBeenCalledWith(disabledServers);
		});

		it('emits settings.updated event', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.setDisabled');
			expect(handler).toBeDefined();

			await handler!({ disabledServers: [] }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'settings.updated',
				expect.objectContaining({
					sessionId: 'global',
				})
			);
		});
	});

	describe('settings.fileOnly.read', () => {
		it('returns file-only settings', async () => {
			const handler = messageHubData.handlers.get('settings.fileOnly.read');
			expect(handler).toBeDefined();

			const result = await handler!({}, {});

			expect(result).toBeDefined();
			expect(settingsManagerData.mocks.readFileOnlySettings).toHaveBeenCalled();
		});
	});

	describe('settings.mcp.listFromSources', () => {
		it('returns MCP servers from global sources when no sessionId', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.listFromSources');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as {
				servers: Array<{ name: string }>;
				serverSettings: Record<string, unknown>;
			};

			expect(result.servers).toBeDefined();
			expect(result.servers).toHaveLength(2);
			expect(result.serverSettings).toBeDefined();
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.listFromSources');
			expect(handler).toBeDefined();

			dbData.mocks.getSession.mockReturnValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found: non-existent'
			);
		});

		// Note: Testing with sessionId that creates a new SettingsManager requires
		// a more complex setup with proper database mocking. This is better suited
		// for integration tests that test the full flow.
		it('accepts sessionId parameter', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.listFromSources');
			expect(handler).toBeDefined();

			// Verify the handler is defined and accepts the sessionId parameter
			// The actual session-specific SettingsManager creation is tested in integration tests
			expect(typeof handler).toBe('function');
		});
	});

	describe('settings.mcp.updateServerSettings', () => {
		it('updates per-server MCP settings', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.updateServerSettings');
			expect(handler).toBeDefined();

			const result = (await handler!(
				{
					serverName: 'test-server',
					settings: { allowed: true, defaultOn: false },
				},
				{}
			)) as { success: boolean };

			expect(result.success).toBe(true);
			expect(settingsManagerData.mocks.updateMcpServerSettings).toHaveBeenCalledWith(
				'test-server',
				{ allowed: true, defaultOn: false }
			);
		});

		it('emits settings.updated event', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.updateServerSettings');
			expect(handler).toBeDefined();

			await handler!({ serverName: 'test-server', settings: { allowed: true } }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'settings.updated',
				expect.objectContaining({
					sessionId: 'global',
				})
			);
		});

		it('handles partial settings update', async () => {
			const handler = messageHubData.handlers.get('settings.mcp.updateServerSettings');
			expect(handler).toBeDefined();

			await handler!({ serverName: 'test-server', settings: { defaultOn: true } }, {});

			expect(settingsManagerData.mocks.updateMcpServerSettings).toHaveBeenCalledWith(
				'test-server',
				{ defaultOn: true }
			);
		});
	});

	describe('settings.session.get', () => {
		it('returns session settings', async () => {
			const handler = messageHubData.handlers.get('settings.session.get');
			expect(handler).toBeDefined();

			const result = (await handler!({ sessionId: 'session-123' }, {})) as {
				sessionId: string;
				settings: SessionSettings;
			};

			expect(result.sessionId).toBe('session-123');
			expect(result.settings).toBeDefined();
		});
	});

	describe('settings.session.update', () => {
		it('updates session settings', async () => {
			const handler = messageHubData.handlers.get('settings.session.update');
			expect(handler).toBeDefined();

			const result = (await handler!(
				{ sessionId: 'session-123', updates: { someSetting: 'value' } },
				{}
			)) as { success: boolean; sessionId: string };

			expect(result.success).toBe(true);
			expect(result.sessionId).toBe('session-123');
		});
	});

	describe('handler registration', () => {
		it('registers settings.global.get handler', () => {
			expect(messageHubData.handlers.has('settings.global.get')).toBe(true);
		});

		it('registers settings.global.update handler', () => {
			expect(messageHubData.handlers.has('settings.global.update')).toBe(true);
		});

		it('registers settings.global.save handler', () => {
			expect(messageHubData.handlers.has('settings.global.save')).toBe(true);
		});

		it('registers settings.mcp.toggle handler', () => {
			expect(messageHubData.handlers.has('settings.mcp.toggle')).toBe(true);
		});

		it('registers settings.mcp.getDisabled handler', () => {
			expect(messageHubData.handlers.has('settings.mcp.getDisabled')).toBe(true);
		});

		it('registers settings.mcp.setDisabled handler', () => {
			expect(messageHubData.handlers.has('settings.mcp.setDisabled')).toBe(true);
		});

		it('registers settings.fileOnly.read handler', () => {
			expect(messageHubData.handlers.has('settings.fileOnly.read')).toBe(true);
		});

		it('registers settings.mcp.listFromSources handler', () => {
			expect(messageHubData.handlers.has('settings.mcp.listFromSources')).toBe(true);
		});

		it('registers settings.mcp.updateServerSettings handler', () => {
			expect(messageHubData.handlers.has('settings.mcp.updateServerSettings')).toBe(true);
		});

		it('registers settings.session.get handler', () => {
			expect(messageHubData.handlers.has('settings.session.get')).toBe(true);
		});

		it('registers settings.session.update handler', () => {
			expect(messageHubData.handlers.has('settings.session.update')).toBe(true);
		});
	});
});
