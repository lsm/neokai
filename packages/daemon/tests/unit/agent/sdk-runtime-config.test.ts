/**
 * SDKRuntimeConfig Tests
 *
 * Tests for SDK runtime configuration management.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	SDKRuntimeConfig,
	type SDKRuntimeConfigContext,
} from '../../../src/lib/agent/sdk-runtime-config';
import type { Session } from '@neokai/shared';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import type { MessageQueue } from '../../../src/lib/agent/message-queue';
import type { Logger } from '../../../src/lib/logger';

describe('SDKRuntimeConfig', () => {
	let config: SDKRuntimeConfig;
	let mockSession: Session;
	let mockDb: Database;
	let mockDaemonHub: DaemonHub;
	let mockSettingsManager: SettingsManager;
	let mockMessageQueue: MessageQueue;
	let mockLogger: Logger;
	let mockQueryObject: Query | null;
	let firstMessageReceived: boolean;

	let updateSessionSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;
	let setDisabledMcpServersSpy: ReturnType<typeof mock>;
	let enqueueSpy: ReturnType<typeof mock>;
	let isRunningSpy: ReturnType<typeof mock>;
	let restartQuerySpy: ReturnType<typeof mock>;

	// SDK method spies
	let setMaxThinkingTokensSpy: ReturnType<typeof mock>;
	let setPermissionModeSpy: ReturnType<typeof mock>;
	let mcpServerStatusSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/path',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'default',
				maxTokens: 8192,
				temperature: 1.0,
				maxThinkingTokens: null,
				permissionMode: 'default',
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
			},
		};

		updateSessionSpy = mock(() => {});
		mockDb = {
			updateSession: updateSessionSpy,
		} as unknown as Database;

		emitSpy = mock(async () => {});
		mockDaemonHub = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		setDisabledMcpServersSpy = mock(async () => {});
		mockSettingsManager = {
			setDisabledMcpServers: setDisabledMcpServersSpy,
		} as unknown as SettingsManager;

		enqueueSpy = mock(async () => {});
		isRunningSpy = mock(() => true);
		mockMessageQueue = {
			enqueue: enqueueSpy,
			isRunning: isRunningSpy,
		} as unknown as MessageQueue;

		mockLogger = {
			log: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock(() => {}),
			info: mock(() => {}),
		} as unknown as Logger;

		// SDK method spies
		setMaxThinkingTokensSpy = mock(async () => {});
		setPermissionModeSpy = mock(async () => {});
		mcpServerStatusSpy = mock(async () => []);

		mockQueryObject = {
			setMaxThinkingTokens: setMaxThinkingTokensSpy,
			setPermissionMode: setPermissionModeSpy,
			mcpServerStatus: mcpServerStatusSpy,
		} as unknown as Query;

		restartQuerySpy = mock(async () => {});
		firstMessageReceived = true;
	});

	function createContext(
		overrides: Partial<SDKRuntimeConfigContext> = {}
	): SDKRuntimeConfigContext {
		return {
			session: mockSession,
			db: mockDb,
			daemonHub: mockDaemonHub,
			settingsManager: mockSettingsManager,
			messageQueue: mockMessageQueue,
			logger: mockLogger,
			queryObject: mockQueryObject,
			firstMessageReceived,
			restartQuery: restartQuerySpy,
			...overrides,
		};
	}

	function createConfig(overrides: Partial<SDKRuntimeConfigContext> = {}): SDKRuntimeConfig {
		return new SDKRuntimeConfig(createContext(overrides));
	}

	describe('constructor', () => {
		it('should create config with dependencies', () => {
			config = createConfig();
			expect(config).toBeDefined();
		});
	});

	describe('setMaxThinkingTokens', () => {
		it('should set tokens when query not active', async () => {
			config = createConfig({ queryObject: null });

			const result = await config.setMaxThinkingTokens(10000);

			expect(result).toEqual({ success: true });
			expect(mockSession.config.maxThinkingTokens).toBe(10000);
			expect(updateSessionSpy).toHaveBeenCalledWith('test-session-id', {
				config: mockSession.config,
			});
		});

		it('should set tokens when transport not ready', async () => {
			config = createConfig({ firstMessageReceived: false });

			const result = await config.setMaxThinkingTokens(5000);

			expect(result).toEqual({ success: true });
			expect(mockSession.config.maxThinkingTokens).toBe(5000);
			expect(setMaxThinkingTokensSpy).not.toHaveBeenCalled();
		});

		it('should call SDK setMaxThinkingTokens when query active', async () => {
			config = createConfig();

			const result = await config.setMaxThinkingTokens(20000);

			expect(result).toEqual({ success: true });
			expect(setMaxThinkingTokensSpy).toHaveBeenCalledWith(20000);
			expect(mockSession.config.maxThinkingTokens).toBe(20000);
			expect(updateSessionSpy).toHaveBeenCalled();
		});

		it('should emit session.updated event', async () => {
			config = createConfig();

			await config.setMaxThinkingTokens(15000);

			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: 'test-session-id',
				source: 'thinking-tokens',
				session: { config: mockSession.config },
			});
		});

		it('should handle null tokens (disable thinking)', async () => {
			mockSession.config.maxThinkingTokens = 10000;
			config = createConfig();

			const result = await config.setMaxThinkingTokens(null);

			expect(result).toEqual({ success: true });
			expect(mockSession.config.maxThinkingTokens).toBeNull();
			expect(setMaxThinkingTokensSpy).toHaveBeenCalledWith(null);
		});

		it('should return error on failure', async () => {
			setMaxThinkingTokensSpy.mockRejectedValue(new Error('SDK error'));
			config = createConfig();

			const result = await config.setMaxThinkingTokens(10000);

			expect(result).toEqual({ success: false, error: 'SDK error' });
			expect(mockLogger.error).toHaveBeenCalledWith(
				'Failed to set max thinking tokens:',
				expect.any(Error)
			);
		});

		it('should handle non-Error throws', async () => {
			setMaxThinkingTokensSpy.mockRejectedValue('string error');
			config = createConfig();

			const result = await config.setMaxThinkingTokens(10000);

			expect(result).toEqual({ success: false, error: 'string error' });
		});

		it('should handle query without setMaxThinkingTokens method', async () => {
			config = createConfig({ queryObject: {} as Query }); // No setMaxThinkingTokens method

			const result = await config.setMaxThinkingTokens(10000);

			expect(result).toEqual({ success: true });
			expect(mockSession.config.maxThinkingTokens).toBe(10000);
		});
	});

	describe('setPermissionMode', () => {
		it('should set mode when query not active', async () => {
			config = createConfig({ queryObject: null });

			const result = await config.setPermissionMode('acceptEdits');

			expect(result).toEqual({ success: true });
			expect(mockSession.config.permissionMode).toBe('acceptEdits');
			expect(updateSessionSpy).toHaveBeenCalledWith('test-session-id', {
				config: mockSession.config,
			});
		});

		it('should set mode when transport not ready', async () => {
			config = createConfig({ firstMessageReceived: false });

			const result = await config.setPermissionMode('bypassPermissions');

			expect(result).toEqual({ success: true });
			expect(mockSession.config.permissionMode).toBe('bypassPermissions');
			expect(setPermissionModeSpy).not.toHaveBeenCalled();
		});

		it('should call SDK setPermissionMode when query active', async () => {
			config = createConfig();

			const result = await config.setPermissionMode('prompt');

			expect(result).toEqual({ success: true });
			expect(setPermissionModeSpy).toHaveBeenCalledWith('prompt');
			expect(mockSession.config.permissionMode).toBe('prompt');
		});

		it('should emit session.updated event', async () => {
			config = createConfig();

			await config.setPermissionMode('acceptEdits');

			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: 'test-session-id',
				source: 'permission-mode',
				session: { config: mockSession.config },
			});
		});

		it('should return error on failure', async () => {
			setPermissionModeSpy.mockRejectedValue(new Error('Permission error'));
			config = createConfig();

			const result = await config.setPermissionMode('invalid');

			expect(result).toEqual({ success: false, error: 'Permission error' });
			expect(mockLogger.error).toHaveBeenCalledWith(
				'Failed to set permission mode:',
				expect.any(Error)
			);
		});

		it('should handle non-Error throws', async () => {
			setPermissionModeSpy.mockRejectedValue('string error');
			config = createConfig();

			const result = await config.setPermissionMode('invalid');

			expect(result).toEqual({ success: false, error: 'string error' });
		});

		it('should handle query without setPermissionMode method', async () => {
			config = createConfig({ queryObject: {} as Query }); // No setPermissionMode method

			const result = await config.setPermissionMode('acceptEdits');

			expect(result).toEqual({ success: true });
			expect(mockSession.config.permissionMode).toBe('acceptEdits');
		});
	});

	describe('getMcpServerStatus', () => {
		it('should return empty array when query not active', async () => {
			config = createConfig({ queryObject: null });

			const result = await config.getMcpServerStatus();

			expect(result).toEqual([]);
		});

		it('should return empty array when transport not ready', async () => {
			config = createConfig({ firstMessageReceived: false });

			const result = await config.getMcpServerStatus();

			expect(result).toEqual([]);
		});

		it('should return MCP server status from SDK', async () => {
			const mockStatus = [
				{ name: 'server1', status: 'connected' },
				{ name: 'server2', status: 'disconnected', error: 'Connection failed' },
			];
			mcpServerStatusSpy.mockResolvedValue(mockStatus);
			config = createConfig();

			const result = await config.getMcpServerStatus();

			expect(result).toEqual(mockStatus);
			expect(mcpServerStatusSpy).toHaveBeenCalled();
		});

		it('should return empty array when query has no mcpServerStatus method', async () => {
			config = createConfig({ queryObject: {} as Query }); // No mcpServerStatus method

			const result = await config.getMcpServerStatus();

			expect(result).toEqual([]);
		});

		it('should return empty array and warn on error', async () => {
			mcpServerStatusSpy.mockRejectedValue(new Error('MCP error'));
			config = createConfig();

			const result = await config.getMcpServerStatus();

			expect(result).toEqual([]);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Failed to get MCP server status:',
				expect.any(Error)
			);
		});
	});

	describe('updateToolsConfig', () => {
		it('should update session config in memory and DB', async () => {
			config = createConfig();

			const tools = { disabledTools: ['Read', 'Write'] };
			const result = await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(result).toEqual({ success: true });
			expect(mockSession.config.tools).toEqual(tools);
			expect(updateSessionSpy).toHaveBeenCalledWith('test-session-id', {
				config: mockSession.config,
			});
		});

		it('should write disabledMcpServers to settings and restart query', async () => {
			config = createConfig();

			const tools = { disabledMcpServers: ['server1', 'server2'] };
			await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(setDisabledMcpServersSpy).toHaveBeenCalledWith(['server1', 'server2']);
			expect(restartQuerySpy).toHaveBeenCalled();
		});

		it('should not restart query when no disabledMcpServers', async () => {
			config = createConfig();

			const tools = { disabledTools: ['Bash'] };
			await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(setDisabledMcpServersSpy).not.toHaveBeenCalled();
			expect(restartQuerySpy).not.toHaveBeenCalled();
		});

		it('should queue /context when message queue is running', async () => {
			isRunningSpy.mockReturnValue(true);
			config = createConfig();

			const tools = { disabledTools: ['Edit'] };
			await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(enqueueSpy).toHaveBeenCalledWith('/context', true);
		});

		it('should not queue /context when message queue is not running', async () => {
			isRunningSpy.mockReturnValue(false);
			config = createConfig();

			const tools = { disabledTools: ['Edit'] };
			await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		it('should emit session.updated event', async () => {
			config = createConfig();

			const tools = { disabledTools: ['Write'] };
			await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: 'test-session-id',
				source: 'config',
				session: { config: mockSession.config },
			});
		});

		it('should handle /context queue failure gracefully', async () => {
			enqueueSpy.mockRejectedValue(new Error('Queue error'));
			config = createConfig();

			const tools = { disabledTools: ['Glob'] };
			const result = await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(result).toEqual({ success: true });
			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Failed to queue /context after tools update:',
				expect.any(Error)
			);
		});

		it('should return error on failure', async () => {
			updateSessionSpy.mockImplementation(() => {
				throw new Error('DB error');
			});
			config = createConfig();

			const tools = { disabledTools: ['Grep'] };
			const result = await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(result).toEqual({ success: false, error: 'DB error' });
			expect(mockLogger.error).toHaveBeenCalledWith(
				'Failed to update tools config:',
				expect.any(Error)
			);
		});

		it('should handle non-Error throws', async () => {
			updateSessionSpy.mockImplementation(() => {
				throw 'string error';
			});
			config = createConfig();

			const tools = { disabledTools: ['Bash'] };
			const result = await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(result).toEqual({ success: false, error: 'Unknown error' });
		});

		it('should handle empty disabledMcpServers array', async () => {
			config = createConfig();

			const tools = { disabledMcpServers: [] };
			await config.updateToolsConfig(tools as Session['config']['tools']);

			expect(setDisabledMcpServersSpy).toHaveBeenCalledWith([]);
			expect(restartQuerySpy).toHaveBeenCalled();
		});
	});
});
