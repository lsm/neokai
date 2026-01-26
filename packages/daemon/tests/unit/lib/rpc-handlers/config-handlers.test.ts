/**
 * Config Handlers Tests
 *
 * Tests for SDK configuration RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupConfigHandlers } from '../../../../src/lib/rpc-handlers/config-handlers';
import type { MessageHub, Session } from '@liuboer/shared';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { SessionManager } from '../../../../src/lib/session-manager';

describe('Config Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let mockDaemonHub: DaemonHub;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;
	let mockAgentSession: {
		getSessionData: ReturnType<typeof mock>;
		handleModelSwitch: ReturnType<typeof mock>;
		setMaxThinkingTokens: ReturnType<typeof mock>;
		setPermissionMode: ReturnType<typeof mock>;
		updateConfig: ReturnType<typeof mock>;
		resetQuery: ReturnType<typeof mock>;
		getMcpServerStatus: ReturnType<typeof mock>;
	};
	let mockSession: Session;

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
			workspacePath: '/test/path',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-20250514',
				maxTokens: 8192,
				temperature: 1.0,
				maxThinkingTokens: null,
				permissionMode: 'default',
				systemPrompt: 'You are a helpful assistant.',
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
			handleModelSwitch: mock(async () => ({ success: true })),
			setMaxThinkingTokens: mock(async () => ({ success: true })),
			setPermissionMode: mock(async () => ({ success: true })),
			updateConfig: mock(async () => {}),
			resetQuery: mock(async () => ({ success: true })),
			getMcpServerStatus: mock(async () => []),
		};

		// Mock SessionManager
		mockSessionManager = {
			getSessionAsync: mock(async () => mockAgentSession),
		} as unknown as SessionManager;

		// Mock DaemonHub
		mockDaemonHub = {
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		// Setup handlers
		setupConfigHandlers(mockMessageHub, mockSessionManager, mockDaemonHub);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register all config handlers', () => {
			expect(handlers.has('config.model.get')).toBe(true);
			expect(handlers.has('config.model.update')).toBe(true);
			expect(handlers.has('config.systemPrompt.get')).toBe(true);
			expect(handlers.has('config.systemPrompt.update')).toBe(true);
			expect(handlers.has('config.tools.get')).toBe(true);
			expect(handlers.has('config.tools.update')).toBe(true);
			expect(handlers.has('config.agents.get')).toBe(true);
			expect(handlers.has('config.agents.update')).toBe(true);
			expect(handlers.has('config.sandbox.get')).toBe(true);
			expect(handlers.has('config.sandbox.update')).toBe(true);
			expect(handlers.has('config.mcp.get')).toBe(true);
			expect(handlers.has('config.mcp.update')).toBe(true);
			expect(handlers.has('config.mcp.addServer')).toBe(true);
			expect(handlers.has('config.mcp.removeServer')).toBe(true);
			expect(handlers.has('config.outputFormat.get')).toBe(true);
			expect(handlers.has('config.outputFormat.update')).toBe(true);
			expect(handlers.has('config.betas.get')).toBe(true);
			expect(handlers.has('config.betas.update')).toBe(true);
			expect(handlers.has('config.env.get')).toBe(true);
			expect(handlers.has('config.env.update')).toBe(true);
			expect(handlers.has('config.permissions.get')).toBe(true);
			expect(handlers.has('config.permissions.update')).toBe(true);
			expect(handlers.has('config.getAll')).toBe(true);
			expect(handlers.has('config.updateBulk')).toBe(true);
		});
	});

	describe('config.model.get', () => {
		it('should return model settings', async () => {
			const result = await callHandler('config.model.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({
				model: 'claude-sonnet-4-20250514',
				fallbackModel: undefined,
				maxTurns: undefined,
				maxBudgetUsd: undefined,
				maxThinkingTokens: null,
			});
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('config.model.get', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('config.model.update', () => {
		it('should update model via handleModelSwitch', async () => {
			const result = await callHandler('config.model.update', {
				sessionId: 'test-session-id',
				settings: { model: 'claude-opus-4-20250514' },
			});

			expect(mockAgentSession.handleModelSwitch).toHaveBeenCalledWith('claude-opus-4-20250514');
			expect(result).toEqual({
				applied: ['model'],
				pending: [],
				errors: [],
			});
		});

		it('should update maxThinkingTokens', async () => {
			const result = await callHandler('config.model.update', {
				sessionId: 'test-session-id',
				settings: { maxThinkingTokens: 10000 },
			});

			expect(mockAgentSession.setMaxThinkingTokens).toHaveBeenCalledWith(10000);
			expect(result).toEqual({
				applied: ['maxThinkingTokens'],
				pending: [],
				errors: [],
			});
		});

		it('should persist other settings as pending', async () => {
			const result = await callHandler('config.model.update', {
				sessionId: 'test-session-id',
				settings: { fallbackModel: 'claude-haiku-3-20250514', maxTurns: 50 },
			});

			expect(mockAgentSession.updateConfig).toHaveBeenCalled();
			expect(result).toEqual({
				applied: [],
				pending: ['fallbackModel', 'maxTurns'],
				errors: [],
			});
		});

		it('should report errors for failed model switch', async () => {
			mockAgentSession.handleModelSwitch.mockResolvedValue({
				success: false,
				error: 'Model not available',
			});

			const result = await callHandler('config.model.update', {
				sessionId: 'test-session-id',
				settings: { model: 'invalid-model' },
			});

			expect(result).toEqual({
				applied: [],
				pending: [],
				errors: [{ field: 'model', error: 'Model not available' }],
			});
		});
	});

	describe('config.systemPrompt.get', () => {
		it('should return system prompt', async () => {
			const result = await callHandler('config.systemPrompt.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({
				systemPrompt: 'You are a helpful assistant.',
			});
		});
	});

	describe('config.systemPrompt.update', () => {
		it('should update system prompt without restart', async () => {
			const result = await callHandler('config.systemPrompt.update', {
				sessionId: 'test-session-id',
				systemPrompt: 'New system prompt',
				restartQuery: false,
			});

			expect(mockAgentSession.updateConfig).toHaveBeenCalledWith({
				systemPrompt: 'New system prompt',
			});
			expect(result).toEqual({
				success: true,
				applied: false,
				message: 'Restart query to apply changes',
			});
		});

		it('should update system prompt with restart', async () => {
			const result = await callHandler('config.systemPrompt.update', {
				sessionId: 'test-session-id',
				systemPrompt: 'New system prompt',
				restartQuery: true,
			});

			expect(mockAgentSession.resetQuery).toHaveBeenCalledWith({ restartQuery: true });
			expect(result).toEqual({ success: true, applied: true });
		});

		it('should return error if restart fails', async () => {
			mockAgentSession.resetQuery.mockResolvedValue({ success: false, error: 'Restart failed' });

			const result = await callHandler('config.systemPrompt.update', {
				sessionId: 'test-session-id',
				systemPrompt: 'New prompt',
				restartQuery: true,
			});

			expect(result).toEqual({
				success: false,
				applied: false,
				error: 'Restart failed',
				message: 'Config saved but restart failed',
			});
		});
	});

	describe('config.permissions.get', () => {
		it('should return permissions config', async () => {
			const result = await callHandler('config.permissions.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({
				permissionMode: 'default',
				allowDangerouslySkipPermissions: undefined,
			});
		});
	});

	describe('config.permissions.update', () => {
		it('should update permission mode', async () => {
			const result = await callHandler('config.permissions.update', {
				sessionId: 'test-session-id',
				permissionMode: 'acceptEdits',
			});

			expect(mockAgentSession.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
			expect(result).toEqual({ success: true, applied: true });
		});

		it('should reject invalid permission mode', async () => {
			const result = await callHandler('config.permissions.update', {
				sessionId: 'test-session-id',
				permissionMode: 'invalid',
			});

			expect(result).toEqual({
				success: false,
				applied: false,
				error: expect.stringContaining('Invalid permission mode'),
			});
		});
	});

	describe('config.getAll', () => {
		it('should return all config', async () => {
			const result = await callHandler('config.getAll', { sessionId: 'test-session-id' });

			expect(result).toEqual({
				config: mockSession.config,
			});
		});
	});

	describe('config.updateBulk', () => {
		it('should apply runtime changes immediately', async () => {
			const result = await callHandler('config.updateBulk', {
				sessionId: 'test-session-id',
				config: {
					model: 'claude-opus-4-20250514',
					maxThinkingTokens: 5000,
				},
				restartQuery: false,
			});

			expect(mockAgentSession.handleModelSwitch).toHaveBeenCalledWith('claude-opus-4-20250514');
			expect(mockAgentSession.setMaxThinkingTokens).toHaveBeenCalledWith(5000);
			expect(result).toEqual({
				applied: ['model', 'maxThinkingTokens'],
				pending: [],
				errors: [],
			});
		});

		it('should persist non-runtime settings', async () => {
			const result = await callHandler('config.updateBulk', {
				sessionId: 'test-session-id',
				config: { systemPrompt: 'New prompt' },
				restartQuery: false,
			});

			expect(mockAgentSession.updateConfig).toHaveBeenCalled();
			expect(result).toEqual({
				applied: [],
				pending: ['systemPrompt'],
				errors: [],
			});
		});

		it('should apply pending settings with restart', async () => {
			const result = await callHandler('config.updateBulk', {
				sessionId: 'test-session-id',
				config: { systemPrompt: 'New prompt' },
				restartQuery: true,
			});

			expect(mockAgentSession.resetQuery).toHaveBeenCalledWith({ restartQuery: true });
			expect(result).toEqual({
				applied: ['systemPrompt'],
				pending: [],
				errors: [],
			});
		});
	});

	describe('config.mcp.get', () => {
		it('should return MCP config with runtime status', async () => {
			mockAgentSession.getMcpServerStatus.mockResolvedValue([
				{ name: 'server1', status: 'connected' },
			]);

			const result = await callHandler('config.mcp.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({
				mcpServers: undefined,
				strictMcpConfig: undefined,
				runtimeStatus: [{ name: 'server1', status: 'connected' }],
			});
		});
	});

	describe('config.mcp.addServer', () => {
		it('should add MCP server', async () => {
			const result = await callHandler('config.mcp.addServer', {
				sessionId: 'test-session-id',
				name: 'new-server',
				config: { command: 'test-server' },
				restartQuery: false,
			});

			expect(mockAgentSession.updateConfig).toHaveBeenCalled();
			expect(result).toEqual({
				success: true,
				applied: false,
				message: 'Restart query to apply changes',
			});
		});
	});

	describe('config.mcp.removeServer', () => {
		it('should remove MCP server', async () => {
			mockSession.config.mcpServers = { server1: { command: 'test' } };

			const result = await callHandler('config.mcp.removeServer', {
				sessionId: 'test-session-id',
				name: 'server1',
				restartQuery: false,
			});

			expect(mockAgentSession.updateConfig).toHaveBeenCalled();
			expect(result).toEqual({
				success: true,
				applied: false,
				message: 'Restart query to apply changes',
			});
		});
	});

	describe('config.tools.get', () => {
		it('should return tools config', async () => {
			const result = await callHandler('config.tools.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({
				tools: undefined,
				allowedTools: undefined,
				disallowedTools: undefined,
			});
		});
	});

	describe('config.tools.update', () => {
		it('should update tools config', async () => {
			const result = await callHandler('config.tools.update', {
				sessionId: 'test-session-id',
				settings: { allowedTools: ['Read', 'Write'] },
				restartQuery: false,
			});

			expect(mockAgentSession.updateConfig).toHaveBeenCalled();
			expect(result).toEqual({
				success: true,
				applied: false,
				message: 'Restart query to apply changes',
			});
		});
	});

	describe('config.betas.get', () => {
		it('should return betas config', async () => {
			const result = await callHandler('config.betas.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({ betas: [] });
		});
	});

	describe('config.outputFormat.get', () => {
		it('should return output format', async () => {
			const result = await callHandler('config.outputFormat.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({ outputFormat: undefined });
		});
	});

	describe('config.env.get', () => {
		it('should return env config', async () => {
			const result = await callHandler('config.env.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({
				cwd: undefined,
				additionalDirectories: undefined,
				env: undefined,
				executable: undefined,
				executableArgs: undefined,
			});
		});
	});

	describe('config.agents.get', () => {
		it('should return agents config', async () => {
			const result = await callHandler('config.agents.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({ agents: undefined });
		});
	});

	describe('config.sandbox.get', () => {
		it('should return sandbox config', async () => {
			const result = await callHandler('config.sandbox.get', { sessionId: 'test-session-id' });

			expect(result).toEqual({ sandbox: undefined });
		});
	});
});
