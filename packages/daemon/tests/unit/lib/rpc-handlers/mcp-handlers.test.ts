/**
 * MCP Handlers Tests
 *
 * Tests for MCP/tools RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { registerMcpHandlers } from '../../../../src/lib/rpc-handlers/mcp-handlers';
import type { MessageHub, Session, ToolsConfig, GlobalToolsConfig } from '@liuboer/shared';
import type { SessionManager } from '../../../../src/lib/session-manager';

// Mock fs/promises
mock.module('node:fs/promises', () => ({
	readFile: mock(async (path: string) => {
		if (path.includes('.mcp.json')) {
			return JSON.stringify({
				mcpServers: {
					'test-server': { command: 'test' },
					'another-server': { command: 'another' },
				},
			});
		}
		throw new Error('File not found');
	}),
}));

describe('MCP Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;
	let mockSession: Session;
	let mockAgentSession: {
		getSessionData: ReturnType<typeof mock>;
		updateToolsConfig: ReturnType<typeof mock>;
	};

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
		} as unknown as MessageHub;

		// Mock session data
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/workspace',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-20250514',
				maxTokens: 8192,
				temperature: 1.0,
				tools: {
					disabledMcpServers: ['disabled-server'],
				},
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

		// Mock AgentSession
		mockAgentSession = {
			getSessionData: mock(() => mockSession),
			updateToolsConfig: mock(async () => ({ success: true, restarted: true })),
		};

		// Mock SessionManager
		mockSessionManager = {
			getSession: mock(() => mockAgentSession),
			getGlobalToolsConfig: mock(() => ({
				systemPrompt: { claudeCodePreset: { allowed: true, defaultEnabled: true } },
				settingSources: { project: { allowed: true, defaultEnabled: true } },
				mcp: { allowProjectMcp: true, defaultProjectMcp: true },
				liuboerTools: { memory: { allowed: true, defaultEnabled: false } },
			})),
			saveGlobalToolsConfig: mock(() => {}),
		} as unknown as SessionManager;

		// Setup handlers
		registerMcpHandlers(mockMessageHub, mockSessionManager);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register all MCP handlers', () => {
			expect(handlers.has('tools.save')).toBe(true);
			expect(handlers.has('mcp.updateDisabledServers')).toBe(true);
			expect(handlers.has('mcp.getDisabledServers')).toBe(true);
			expect(handlers.has('mcp.listServers')).toBe(true);
			expect(handlers.has('globalTools.getConfig')).toBe(true);
			expect(handlers.has('globalTools.saveConfig')).toBe(true);
		});
	});

	describe('tools.save', () => {
		it('should save tools configuration', async () => {
			const tools: ToolsConfig = {
				disabledMcpServers: ['server1'],
			};

			const result = await callHandler('tools.save', {
				sessionId: 'test-session-id',
				tools,
			});

			expect(result).toEqual({ success: true, restarted: true });
			expect(mockSessionManager.getSession).toHaveBeenCalledWith('test-session-id');
			expect(mockAgentSession.updateToolsConfig).toHaveBeenCalledWith(tools);
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			await expect(
				callHandler('tools.save', {
					sessionId: 'nonexistent',
					tools: {},
				})
			).rejects.toThrow('Session not found: nonexistent');
		});
	});

	describe('mcp.updateDisabledServers', () => {
		it('should update disabled MCP servers', async () => {
			const result = await callHandler('mcp.updateDisabledServers', {
				sessionId: 'test-session-id',
				disabledServers: ['server1', 'server2'],
			});

			expect(result).toEqual({ success: true });
			expect(mockAgentSession.updateToolsConfig).toHaveBeenCalledWith({
				disabledMcpServers: ['server1', 'server2'],
			});
		});

		it('should merge with existing tools config', async () => {
			mockSession.config.tools = {
				disabledMcpServers: ['old-server'],
			};

			await callHandler('mcp.updateDisabledServers', {
				sessionId: 'test-session-id',
				disabledServers: ['new-server'],
			});

			expect(mockAgentSession.updateToolsConfig).toHaveBeenCalledWith({
				disabledMcpServers: ['new-server'],
			});
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			await expect(
				callHandler('mcp.updateDisabledServers', {
					sessionId: 'nonexistent',
					disabledServers: [],
				})
			).rejects.toThrow('Session not found: nonexistent');
		});
	});

	describe('mcp.getDisabledServers', () => {
		it('should return disabled servers', async () => {
			const result = await callHandler('mcp.getDisabledServers', {
				sessionId: 'test-session-id',
			});

			expect(result).toEqual({
				disabledServers: ['disabled-server'],
			});
		});

		it('should return empty array if no tools config', async () => {
			mockSession.config.tools = undefined;

			const result = await callHandler('mcp.getDisabledServers', {
				sessionId: 'test-session-id',
			});

			expect(result).toEqual({ disabledServers: [] });
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			await expect(
				callHandler('mcp.getDisabledServers', { sessionId: 'nonexistent' })
			).rejects.toThrow('Session not found: nonexistent');
		});
	});

	describe('mcp.listServers', () => {
		it('should return MCP servers from .mcp.json', async () => {
			const result = await callHandler('mcp.listServers', {
				sessionId: 'test-session-id',
			});

			expect(result).toEqual({
				servers: {
					'test-server': { command: 'test' },
					'another-server': { command: 'another' },
				},
			});
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			await expect(callHandler('mcp.listServers', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found: nonexistent'
			);
		});
	});

	describe('globalTools.getConfig', () => {
		it('should return global tools configuration', async () => {
			const result = await callHandler('globalTools.getConfig', {});

			expect(result).toEqual({
				config: {
					systemPrompt: { claudeCodePreset: { allowed: true, defaultEnabled: true } },
					settingSources: { project: { allowed: true, defaultEnabled: true } },
					mcp: { allowProjectMcp: true, defaultProjectMcp: true },
					liuboerTools: { memory: { allowed: true, defaultEnabled: false } },
				},
			});
			expect(mockSessionManager.getGlobalToolsConfig).toHaveBeenCalled();
		});
	});

	describe('globalTools.saveConfig', () => {
		it('should save global tools configuration', async () => {
			const config: GlobalToolsConfig = {
				systemPrompt: { claudeCodePreset: { allowed: false, defaultEnabled: false } },
				settingSources: { project: { allowed: false, defaultEnabled: false } },
				mcp: { allowProjectMcp: false, defaultProjectMcp: false },
				liuboerTools: { memory: { allowed: false, defaultEnabled: false } },
			};

			const result = await callHandler('globalTools.saveConfig', { config });

			expect(result).toEqual({ success: true });
			expect(mockSessionManager.saveGlobalToolsConfig).toHaveBeenCalledWith(config);
		});
	});
});
