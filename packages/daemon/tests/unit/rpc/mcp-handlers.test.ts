/**
 * Tests for MCP/Tools RPC Handlers
 *
 * Tests the RPC handlers for MCP and tools operations:
 * - tools.save - Save tools configuration
 * - mcp.updateDisabledServers - Update disabled MCP servers
 * - mcp.getDisabledServers - Get disabled MCP servers
 * - mcp.listServers - List available MCP servers
 * - globalTools.getConfig - Get global tools config
 * - globalTools.saveConfig - Save global tools config
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type ToolsConfig, type GlobalToolsConfig } from '@neokai/shared';
import { registerMcpHandlers } from '../../../src/lib/rpc-handlers/mcp-handlers';
import type { SessionManager } from '../../../src/lib/session-manager';
import type { AgentSession } from '../../../src/lib/agent/agent-session';
import type { Session } from '@neokai/shared';
import * as fs from 'node:fs/promises';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock fs/promises
mock.module('node:fs/promises', () => ({
	readFile: mock(async () => '{}'),
}));

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

// Helper to create a mock AgentSession
function createMockAgentSession(overrides: Partial<AgentSession> = {}): {
	agentSession: AgentSession;
	mocks: {
		getSessionData: ReturnType<typeof mock>;
		updateToolsConfig: ReturnType<typeof mock>;
	};
} {
	const sessionData: Session = {
		id: 'session-123',
		workspacePath: '/workspace/test',
		status: 'active',
		config: {
			model: 'claude-sonnet-4-20250514',
			tools: {},
		},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	} as Session;

	const mocks = {
		getSessionData: mock(() => sessionData),
		updateToolsConfig: mock(async () => ({ success: true })),
	};

	const agentSession = {
		...mocks,
		...overrides,
	} as unknown as AgentSession;

	return { agentSession, mocks };
}

// Helper to create mock SessionManager
function createMockSessionManager(): {
	sessionManager: SessionManager;
	mocks: {
		getSession: ReturnType<typeof mock>;
		getGlobalToolsConfig: ReturnType<typeof mock>;
		saveGlobalToolsConfig: ReturnType<typeof mock>;
	};
	agentSessionData: ReturnType<typeof createMockAgentSession>;
} {
	const agentSessionData = createMockAgentSession();

	const mocks = {
		getSession: mock(() => agentSessionData.agentSession),
		getGlobalToolsConfig: mock(
			() =>
				({
					disabledMcpServers: ['server1', 'server2'],
				}) as GlobalToolsConfig
		),
		saveGlobalToolsConfig: mock(() => {}),
	};

	const sessionManager = {
		...mocks,
	} as unknown as SessionManager;

	return { sessionManager, mocks, agentSessionData };
}

describe('MCP/Tools RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let sessionManagerData: ReturnType<typeof createMockSessionManager>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		sessionManagerData = createMockSessionManager();

		// Setup handlers with mocked dependencies
		registerMcpHandlers(messageHubData.hub, sessionManagerData.sessionManager);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('tools.save', () => {
		it('saves tools configuration successfully', async () => {
			const handler = messageHubData.handlers.get('tools.save');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				tools: {
					disabledMcpServers: ['server1'],
				} as ToolsConfig,
			};

			const result = await handler!(params, {});

			expect(sessionManagerData.agentSessionData.mocks.updateToolsConfig).toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('tools.save');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSession.mockReturnValueOnce(null);

			const params = {
				sessionId: 'non-existent',
				tools: {} as ToolsConfig,
			};

			await expect(handler!(params, {})).rejects.toThrow('Session not found: non-existent');
		});

		it('handles tools config with allowedTools', async () => {
			const handler = messageHubData.handlers.get('tools.save');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				tools: {
					allowedTools: ['Read', 'Write', 'Edit'],
				} as ToolsConfig,
			};

			const result = await handler!(params, {});

			expect(result).toEqual({ success: true });
		});

		it('handles tools config with disallowedTools', async () => {
			const handler = messageHubData.handlers.get('tools.save');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				tools: {
					disallowedTools: ['Bash', 'Execute'],
				} as ToolsConfig,
			};

			const result = await handler!(params, {});

			expect(result).toEqual({ success: true });
		});

		it('handles updateToolsConfig error', async () => {
			const handler = messageHubData.handlers.get('tools.save');
			expect(handler).toBeDefined();

			sessionManagerData.agentSessionData.mocks.updateToolsConfig.mockResolvedValueOnce({
				success: false,
				error: 'Failed to update tools',
			});

			const params = {
				sessionId: 'session-123',
				tools: {} as ToolsConfig,
			};

			const result = await handler!(params, {});

			expect(result).toEqual({ success: false, error: 'Failed to update tools' });
		});
	});

	describe('mcp.updateDisabledServers', () => {
		it('updates disabled MCP servers list', async () => {
			const handler = messageHubData.handlers.get('mcp.updateDisabledServers');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				disabledServers: ['server1', 'server2'],
			};

			const result = await handler!(params, {});

			expect(sessionManagerData.agentSessionData.mocks.updateToolsConfig).toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});

		it('clears disabled servers list with empty array', async () => {
			const handler = messageHubData.handlers.get('mcp.updateDisabledServers');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				disabledServers: [],
			};

			const result = await handler!(params, {});

			expect(result).toEqual({ success: true });
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('mcp.updateDisabledServers');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSession.mockReturnValueOnce(null);

			const params = {
				sessionId: 'non-existent',
				disabledServers: ['server1'],
			};

			await expect(handler!(params, {})).rejects.toThrow('Session not found: non-existent');
		});

		it('preserves existing tools config when updating', async () => {
			const handler = messageHubData.handlers.get('mcp.updateDisabledServers');
			expect(handler).toBeDefined();

			// Create session with existing tools config
			const { agentSession, mocks } = createMockAgentSession();
			mocks.getSessionData.mockReturnValue({
				id: 'session-123',
				config: {
					model: 'claude-sonnet',
					tools: {
						allowedTools: ['Read', 'Write'],
						disabledMcpServers: ['old-server'],
					},
				},
			} as Session);
			sessionManagerData.mocks.getSession.mockReturnValue(agentSession);

			const params = {
				sessionId: 'session-123',
				disabledServers: ['new-server'],
			};

			await handler!(params, {});

			// Should call updateToolsConfig with merged config
			expect(mocks.updateToolsConfig).toHaveBeenCalled();
		});
	});

	describe('mcp.getDisabledServers', () => {
		it('returns disabled servers list', async () => {
			const handler = messageHubData.handlers.get('mcp.getDisabledServers');
			expect(handler).toBeDefined();

			const { agentSession, mocks } = createMockAgentSession();
			mocks.getSessionData.mockReturnValue({
				id: 'session-123',
				config: {
					model: 'claude-sonnet',
					tools: {
						disabledMcpServers: ['server1', 'server2'],
					},
				},
			} as Session);
			sessionManagerData.mocks.getSession.mockReturnValue(agentSession);

			const params = {
				sessionId: 'session-123',
			};

			const result = (await handler!(params, {})) as { disabledServers: string[] };

			expect(result.disabledServers).toEqual(['server1', 'server2']);
		});

		it('returns empty array when no disabled servers', async () => {
			const handler = messageHubData.handlers.get('mcp.getDisabledServers');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
			};

			const result = (await handler!(params, {})) as { disabledServers: string[] };

			expect(result.disabledServers).toEqual([]);
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('mcp.getDisabledServers');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSession.mockReturnValueOnce(null);

			const params = {
				sessionId: 'non-existent',
			};

			await expect(handler!(params, {})).rejects.toThrow('Session not found: non-existent');
		});
	});

	describe('mcp.listServers', () => {
		it('returns list of MCP servers from .mcp.json', async () => {
			const handler = messageHubData.handlers.get('mcp.listServers');
			expect(handler).toBeDefined();

			// Mock readFile to return MCP config
			const mockConfig = JSON.stringify({
				mcpServers: {
					filesystem: {
						command: 'npx',
						args: ['-y', '@modelcontextprotocol/server-filesystem'],
					},
					github: {
						command: 'npx',
						args: ['-y', '@modelcontextprotocol/server-github'],
					},
				},
			});

			mock.module('node:fs/promises', () => ({
				readFile: mock(async () => mockConfig),
			}));

			const params = {
				sessionId: 'session-123',
			};

			const result = (await handler!(params, {})) as { servers: Record<string, unknown> };

			expect(result.servers).toBeDefined();
		});

		it('returns empty object when .mcp.json does not exist', async () => {
			const handler = messageHubData.handlers.get('mcp.listServers');
			expect(handler).toBeDefined();

			// Mock readFile to throw error (file not found)
			mock.module('node:fs/promises', () => ({
				readFile: mock(async () => {
					throw new Error('ENOENT: no such file');
				}),
			}));

			const params = {
				sessionId: 'session-123',
			};

			const result = (await handler!(params, {})) as { servers: Record<string, unknown> };

			expect(result.servers).toEqual({});
		});

		it('returns empty object when .mcp.json is invalid JSON', async () => {
			const handler = messageHubData.handlers.get('mcp.listServers');
			expect(handler).toBeDefined();

			// Mock readFile to return invalid JSON
			mock.module('node:fs/promises', () => ({
				readFile: mock(async () => 'not valid json'),
			}));

			const params = {
				sessionId: 'session-123',
			};

			const result = (await handler!(params, {})) as { servers: Record<string, unknown> };

			expect(result.servers).toEqual({});
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('mcp.listServers');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSession.mockReturnValueOnce(null);

			const params = {
				sessionId: 'non-existent',
			};

			await expect(handler!(params, {})).rejects.toThrow('Session not found: non-existent');
		});
	});

	describe('globalTools.getConfig', () => {
		it('returns global tools configuration', async () => {
			const handler = messageHubData.handlers.get('globalTools.getConfig');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as { config: GlobalToolsConfig };

			expect(sessionManagerData.mocks.getGlobalToolsConfig).toHaveBeenCalled();
			expect(result.config).toBeDefined();
		});

		it('returns config with disabled servers', async () => {
			const handler = messageHubData.handlers.get('globalTools.getConfig');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getGlobalToolsConfig.mockReturnValueOnce({
				disabledMcpServers: ['disabled-server-1', 'disabled-server-2'],
			});

			const result = (await handler!({}, {})) as { config: GlobalToolsConfig };

			expect(result.config.disabledMcpServers).toContain('disabled-server-1');
			expect(result.config.disabledMcpServers).toContain('disabled-server-2');
		});
	});

	describe('globalTools.saveConfig', () => {
		it('saves global tools configuration', async () => {
			const handler = messageHubData.handlers.get('globalTools.saveConfig');
			expect(handler).toBeDefined();

			const params = {
				config: {
					disabledMcpServers: ['server1', 'server2'],
				} as GlobalToolsConfig,
			};

			await handler!(params, {});

			expect(sessionManagerData.mocks.saveGlobalToolsConfig).toHaveBeenCalledWith(params.config);
		});

		it('saves empty configuration', async () => {
			const handler = messageHubData.handlers.get('globalTools.saveConfig');
			expect(handler).toBeDefined();

			const params = {
				config: {
					disabledMcpServers: [],
				} as GlobalToolsConfig,
			};

			await handler!(params, {});

			expect(sessionManagerData.mocks.saveGlobalToolsConfig).toHaveBeenCalledWith(params.config);
		});
	});
});
