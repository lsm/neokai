/**
 * Tests for Settings RPC Handlers
 *
 * Tests the RPC handlers for settings operations:
 * - settings.global.get - Get global settings
 * - settings.global.update - Update global settings (partial update)
 * - settings.global.save - Save global settings (full replace)
 * - settings.fileOnly.read - Read file-only settings
 * - settings.mcp.listFromSources - List MCP servers from enabled sources
 * - settings.session.get - Get session settings
 * - settings.session.update - Update session settings
 *
 * NOTE: The legacy `settings.mcp.toggle`, `settings.mcp.getDisabled`,
 * `settings.mcp.setDisabled`, and `settings.mcp.updateServerSettings` RPCs
 * were removed in M5 of `unify-mcp-config-model`. MCP enablement now flows
 * through the unified `app_mcp_servers` registry + `mcp_enablement` overrides.
 * `mcpServerSettings` and `disabledMcpServers` were also removed from
 * `GlobalSettings`; tests no longer set them.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import {
	MessageHub,
	type GlobalSettings,
	type SessionSettings,
	DEFAULT_GLOBAL_SETTINGS,
} from '@neokai/shared';
import {
	applyProviderModelAllowlistsToEnv,
	registerSettingsHandlers,
} from '../../../../src/lib/rpc-handlers/settings-handlers';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { Database } from '../../../../src/storage/database';

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

// Default global settings (mirrors the unified shape in @neokai/shared)
const defaultGlobalSettings: GlobalSettings = {
	...DEFAULT_GLOBAL_SETTINGS,
	showArchived: false,
	model: 'claude-sonnet-4-20250514',
};

// Helper to create mock SettingsManager
function createMockSettingsManager(): {
	settingsManager: SettingsManager;
	mocks: {
		getGlobalSettings: ReturnType<typeof mock>;
		updateGlobalSettings: ReturnType<typeof mock>;
		saveGlobalSettings: ReturnType<typeof mock>;
		readFileOnlySettings: ReturnType<typeof mock>;
		listMcpServersFromSources: ReturnType<typeof mock>;
	};
} {
	const mocks = {
		getGlobalSettings: mock(() => defaultGlobalSettings),
		updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => ({
			...defaultGlobalSettings,
			...updates,
		})),
		saveGlobalSettings: mock(() => {}),
		readFileOnlySettings: mock(() => ({ someSetting: 'value' })),
		listMcpServersFromSources: mock(() => [
			{ name: 'server-1', command: 'npx', args: ['-y', 'mcp-server-1'] },
			{ name: 'server-2', command: 'npx', args: ['-y', 'mcp-server-2'] },
		]),
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
		getDatabase: ReturnType<typeof mock>;
	};
} {
	// Stub the prepared statement chain that `usage.calculate` walks; we
	// exercise that handler indirectly via registration tests, so the chain
	// just needs to be callable without throwing.
	const stmt = {
		get: mock(() => ({ totalCost: 0, totalTokens: 0, totalMessages: 0, sessionCount: 0 })),
		all: mock(() => []),
	};
	const mocks = {
		getSession: mock(() => ({
			id: 'session-123',
			workspacePath: '/workspace/test',
		})),
		getDatabase: mock(() => ({
			prepare: mock(() => stmt),
		})),
	};

	return {
		db: {
			getSession: mocks.getSession,
			getDatabase: mocks.getDatabase,
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
		delete process.env.NEOKAI_PROVIDER_MODEL_ALLOWLISTS;
		mock.restore();
	});

	describe('provider model allowlist sync', () => {
		it('hydrates provider allowlists into env for startup model initialization', () => {
			applyProviderModelAllowlistsToEnv({
				openrouter: ['xai/grok-4.3', ' deepseek/deepseek-v4-pro '],
				anthropic: ['claude-sonnet-4.6'],
			});

			expect(process.env.NEOKAI_PROVIDER_MODEL_ALLOWLISTS).toBe(
				'openrouter:xai/grok-4.3\nopenrouter:deepseek/deepseek-v4-pro\nanthropic:claude-sonnet-4.6'
			);
		});

		it('clears provider allowlist env when no persisted allowlists exist', () => {
			process.env.NEOKAI_PROVIDER_MODEL_ALLOWLISTS = 'openrouter:xai/grok-4.3';

			applyProviderModelAllowlistsToEnv(undefined);

			expect(process.env.NEOKAI_PROVIDER_MODEL_ALLOWLISTS).toBeUndefined();
		});
	});

	describe('settings.global.get', () => {
		it('returns global settings', async () => {
			const handler = messageHubData.handlers.get('settings.global.get');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as GlobalSettings;

			expect(result).toBeDefined();
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

			const result = (await handler!({ updates: { model: 'claude-opus' } }, {})) as {
				success: boolean;
				settings: GlobalSettings;
			};

			expect(result.success).toBe(true);
			expect(result.settings.model).toBe('claude-opus');
		});

		it('emits settings.updated event', async () => {
			const handler = messageHubData.handlers.get('settings.global.update');
			expect(handler).toBeDefined();

			await handler!({ updates: { model: 'claude-opus' } }, {});

			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'settings.updated',
				expect.objectContaining({
					sessionId: 'global',
				})
			);
		});

		it('emits settings.updated when showArchived changes', async () => {
			const handler = messageHubData.handlers.get('settings.global.update');
			expect(handler).toBeDefined();

			await handler!({ updates: { showArchived: true } }, {});

			// showArchived filter is handled client-side via LiveQuery — no separate filterChanged event
			expect(daemonHubData.emitMock).toHaveBeenCalledWith(
				'settings.updated',
				expect.objectContaining({
					sessionId: 'global',
				})
			);
		});

		it('handles multiple updates', async () => {
			const handler = messageHubData.handlers.get('settings.global.update');
			expect(handler).toBeDefined();

			const result = (await handler!(
				{ updates: { model: 'claude-opus', showArchived: true } },
				{}
			)) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.model).toBe('claude-opus');
			expect(result.settings.showArchived).toBe(true);
		});
	});

	describe('settings.global.save', () => {
		it('saves global settings', async () => {
			const handler = messageHubData.handlers.get('settings.global.save');
			expect(handler).toBeDefined();

			const newSettings: GlobalSettings = {
				...defaultGlobalSettings,
				showArchived: true,
				model: 'claude-opus',
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
			};

			expect(result.servers).toBeDefined();
			expect(result.servers).toHaveLength(2);
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

		it('registers settings.fileOnly.read handler', () => {
			expect(messageHubData.handlers.has('settings.fileOnly.read')).toBe(true);
		});

		it('registers settings.mcp.listFromSources handler', () => {
			expect(messageHubData.handlers.has('settings.mcp.listFromSources')).toBe(true);
		});

		it('registers settings.session.get handler', () => {
			expect(messageHubData.handlers.has('settings.session.get')).toBe(true);
		});

		it('registers settings.session.update handler', () => {
			expect(messageHubData.handlers.has('settings.session.update')).toBe(true);
		});

		it('does NOT register removed legacy MCP handlers', () => {
			expect(messageHubData.handlers.has('settings.mcp.toggle')).toBe(false);
			expect(messageHubData.handlers.has('settings.mcp.setDisabled')).toBe(false);
			expect(messageHubData.handlers.has('settings.mcp.getDisabled')).toBe(false);
			expect(messageHubData.handlers.has('settings.mcp.updateServerSettings')).toBe(false);
		});
	});
});
