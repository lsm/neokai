/**
 * MCP RPC Handlers Tests (Offline)
 *
 * Tests for MCP configuration and tools management:
 * - tools.save
 * - mcp.updateDisabledServers
 * - mcp.getDisabledServers
 * - mcp.listServers
 * - globalTools.getConfig
 * - globalTools.saveConfig
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test';
import { registerMcpHandlers } from '../../../../src/lib/rpc-handlers/mcp-handlers';

describe('MCP RPC Handlers', () => {
	let handlers: Map<string, Function>;
	let mockMessageHub: {
		handle: ReturnType<typeof mock>;
	};
	let mockSessionManager: {
		getSession: ReturnType<typeof mock>;
		getGlobalToolsConfig: ReturnType<typeof mock>;
		saveGlobalToolsConfig: ReturnType<typeof mock>;
	};

	beforeAll(() => {
		handlers = new Map();
		mockMessageHub = {
			handle: mock((method: string, handler: Function) => {
				handlers.set(method, handler);
			}),
		};

		const mockSession = {
			id: 'valid-session',
			workspacePath: '/test/workspace',
			config: {
				tools: {
					disabledMcpServers: ['disabled-server-1'],
				},
			},
		};

		mockSessionManager = {
			getSession: mock((sessionId: string) => {
				if (sessionId === 'valid-session') {
					return {
						getSessionData: mock(() => mockSession),
						updateToolsConfig: mock(async () => ({ success: true })),
					};
				}
				return null;
			}),
			getGlobalToolsConfig: mock(() => ({
				enableBuiltInTools: true,
				enableMcpTools: true,
			})),
			saveGlobalToolsConfig: mock(() => {}),
		};

		registerMcpHandlers(
			mockMessageHub as unknown as Parameters<typeof registerMcpHandlers>[0],
			mockSessionManager as unknown as Parameters<typeof registerMcpHandlers>[1]
		);
	});

	describe('tools.save', () => {
		test('should register handler', () => {
			expect(handlers.has('tools.save')).toBe(true);
		});

		test('should save tools configuration', async () => {
			const handler = handlers.get('tools.save')!;
			const result = await handler({
				sessionId: 'valid-session',
				tools: {
					disabledMcpServers: ['server-1'],
				},
			});

			expect(result.success).toBe(true);
		});

		test('should throw for non-existent session', async () => {
			const handler = handlers.get('tools.save')!;
			await expect(
				handler({
					sessionId: 'invalid-session',
					tools: {},
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('mcp.updateDisabledServers', () => {
		test('should register handler', () => {
			expect(handlers.has('mcp.updateDisabledServers')).toBe(true);
		});

		test('should update disabled servers', async () => {
			const handler = handlers.get('mcp.updateDisabledServers')!;
			const result = await handler({
				sessionId: 'valid-session',
				disabledServers: ['server-1', 'server-2'],
			});

			expect(result.success).toBe(true);
		});

		test('should throw for non-existent session', async () => {
			const handler = handlers.get('mcp.updateDisabledServers')!;
			await expect(
				handler({
					sessionId: 'invalid-session',
					disabledServers: [],
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('mcp.getDisabledServers', () => {
		test('should register handler', () => {
			expect(handlers.has('mcp.getDisabledServers')).toBe(true);
		});

		test('should get disabled servers', async () => {
			const handler = handlers.get('mcp.getDisabledServers')!;
			const result = await handler({
				sessionId: 'valid-session',
			});

			expect(result.disabledServers).toBeDefined();
			expect(Array.isArray(result.disabledServers)).toBe(true);
			expect(result.disabledServers).toContain('disabled-server-1');
		});

		test('should throw for non-existent session', async () => {
			const handler = handlers.get('mcp.getDisabledServers')!;
			await expect(
				handler({
					sessionId: 'invalid-session',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('mcp.listServers', () => {
		test('should register handler', () => {
			expect(handlers.has('mcp.listServers')).toBe(true);
		});

		test('should return empty servers when no .mcp.json', async () => {
			const handler = handlers.get('mcp.listServers')!;
			const result = await handler({
				sessionId: 'valid-session',
			});

			expect(result.servers).toBeDefined();
			expect(typeof result.servers).toBe('object');
		});

		test('should throw for non-existent session', async () => {
			const handler = handlers.get('mcp.listServers')!;
			await expect(
				handler({
					sessionId: 'invalid-session',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('globalTools.getConfig', () => {
		test('should register handler', () => {
			expect(handlers.has('globalTools.getConfig')).toBe(true);
		});

		test('should get global tools config', async () => {
			const handler = handlers.get('globalTools.getConfig')!;
			const result = await handler({});

			expect(result.config).toBeDefined();
			expect(result.config.enableBuiltInTools).toBe(true);
			expect(result.config.enableMcpTools).toBe(true);
		});
	});

	describe('globalTools.saveConfig', () => {
		test('should register handler', () => {
			expect(handlers.has('globalTools.saveConfig')).toBe(true);
		});

		test('should save global tools config', async () => {
			const handler = handlers.get('globalTools.saveConfig')!;
			const result = await handler({
				config: {
					enableBuiltInTools: false,
					enableMcpTools: true,
				},
			});

			expect(result.success).toBe(true);
			expect(mockSessionManager.saveGlobalToolsConfig).toHaveBeenCalled();
		});
	});
});
