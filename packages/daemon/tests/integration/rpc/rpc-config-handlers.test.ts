/**
 * SDK Config RPC Handlers Tests (Offline)
 *
 * Tests for SDK configuration RPC handlers:
 * - config.model.get/update
 * - config.systemPrompt.get/update
 * - config.tools.get/update
 * - config.permissions.get/update
 * - config.getAll
 * - config.updateBulk
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../helpers/test-app';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../helpers/test-app';

describe('SDK Config RPC Handlers', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	// Helper to send RPC call
	async function sendRpcCall(
		ws: WebSocket,
		method: string,
		data: Record<string, unknown>
	): Promise<Record<string, unknown>> {
		const callId = `call-${Date.now()}-${Math.random()}`;
		ws.send(
			JSON.stringify({
				id: callId,
				type: 'QRY',
				method,
				data,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);

		// Wait for RSP (skip EVENTs) - max 10 attempts to prevent infinite loop
		let attempts = 0;
		while (attempts < 10) {
			const response = (await waitForWebSocketMessage(ws)) as Record<string, unknown>;
			if (response.type === 'RSP' && response.requestId === callId) {
				return response;
			}
			attempts++;
		}

		throw new Error(`Timeout waiting for RSP to ${method} (call ID: ${callId})`);
	}

	describe('config.model.get', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.model.get', {
				sessionId: 'non-existent',
			});

			expect(response.type).toBe('RSP');
			expect(response.error).toBeDefined();
			ws.close();
		});

		test('should return model settings for existing session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-model',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.model.get', { sessionId });

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('model');
			ws.close();
		});
	});

	describe('config.model.update', () => {
		test('should update model settings', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-model-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.model.update', {
				sessionId,
				settings: {
					model: 'claude-haiku-4-20250514',
					maxTurns: 50,
				},
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('applied');
			ws.close();
		});

		test('should return error for invalid model', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-model-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Invalid model ID
			const response = await sendRpcCall(ws, 'config.model.update', {
				sessionId,
				settings: {
					model: 'invalid-model-id',
				},
			});

			// Handler returns RESULT with errors array when model switch fails
			expect(response.type).toBe('RSP');
			const data = response.data as {
				errors?: Array<{ field: string; error: string }>;
			};
			expect(data.errors?.length).toBeGreaterThan(0);
			ws.close();
		});
	});

	describe('config.systemPrompt.get', () => {
		test('should return system prompt for session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-prompt',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.systemPrompt.get', {
				sessionId,
			});

			expect(response.type).toBe('RSP');
			// systemPrompt may be undefined for default
			expect(response.data).toBeDefined();
			ws.close();
		});
	});

	describe('config.systemPrompt.update', () => {
		test('should update system prompt with string', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-prompt-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.systemPrompt.update', {
				sessionId,
				systemPrompt: 'You are a helpful coding assistant',
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should update system prompt with preset', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-prompt-preset',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.systemPrompt.update', {
				sessionId,
				systemPrompt: {
					type: 'preset',
					preset: 'claude_code',
					append: 'Additional instructions here',
				},
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject invalid system prompt preset', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-prompt-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.systemPrompt.update', {
				sessionId,
				systemPrompt: {
					type: 'preset',
					preset: 'invalid_preset',
				},
			});

			// Handler returns RESULT with success: false for validation errors
			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.tools.get', () => {
		test('should return tools config for session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-tools',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.tools.get', { sessionId });

			expect(response.type).toBe('RSP');
			expect(response.data).toBeDefined();
			ws.close();
		});
	});

	describe('config.tools.update', () => {
		test('should update allowed tools', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-tools-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.tools.update', {
				sessionId,
				settings: {
					allowedTools: ['Bash', 'Read', 'Write'],
					disallowedTools: ['Edit'],
				},
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject invalid tools array', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-tools-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.tools.update', {
				sessionId,
				settings: {
					allowedTools: 'Bash', // Should be an array
				},
			});

			// Handler returns RESULT with success: false for validation errors
			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.permissions.get', () => {
		test('should return permissions config for session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-permissions',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.permissions.get', {
				sessionId,
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toBeDefined();
			ws.close();
		});
	});

	describe('config.permissions.update', () => {
		test('should update permission mode', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-permissions-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.permissions.update', {
				sessionId,
				permissionMode: 'acceptEdits',
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject invalid permission mode', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-permissions-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.permissions.update', {
				sessionId,
				permissionMode: 'invalidMode',
			});

			// Handler returns RESULT with success: false for validation errors
			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.getAll', () => {
		test('should return full config for session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-get-all',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.getAll', { sessionId });

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('config');
			expect((response.data as Record<string, unknown>).config).toHaveProperty('model');
			ws.close();
		});
	});

	describe('config.updateBulk', () => {
		test('should update multiple settings at once', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-bulk-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.updateBulk', {
				sessionId,
				config: {
					model: 'claude-haiku-4-20250514',
					maxTurns: 25,
					allowedTools: ['Read', 'Grep'],
					permissionMode: 'acceptEdits',
				},
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('applied');
			ws.close();
		});

		test('should handle partial updates with errors', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-bulk-partial',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.updateBulk', {
				sessionId,
				config: {
					model: 'invalid-model-id',
				},
			});

			// Handler returns RESULT but with errors in the result
			expect(response.type).toBe('RSP');
			const data = response.data as {
				applied?: string[];
				errors?: Array<{ field: string; error: string }>;
			};
			expect(data.errors?.length).toBeGreaterThan(0);
			ws.close();
		});
	});

	describe('config.agents.get/update', () => {
		test('should get agents config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-agents-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.agents.get', {
				sessionId,
			});

			expect(response.type).toBe('RSP');
			ws.close();
		});

		test('should update agents config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-agents-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.agents.update', {
				sessionId,
				agents: {
					explorer: {
						description: 'Explores the codebase',
						prompt: 'You are a code explorer',
						model: 'haiku',
					},
				},
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject invalid agent definition', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-agents-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.agents.update', {
				sessionId,
				agents: {
					explorer: {
						description: '', // Empty description should fail
						prompt: 'You are a code explorer',
					},
				},
			});

			// Handler returns RESULT with success: false for validation errors
			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.sandbox.get/update', () => {
		test('should get sandbox config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-sandbox-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.sandbox.get', {
				sessionId,
			});

			expect(response.type).toBe('RSP');
			ws.close();
		});

		test('should update sandbox config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-sandbox-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.sandbox.update', {
				sessionId,
				sandbox: {
					enabled: true,
					autoAllowBashIfSandboxed: true,
					excludedCommands: ['rm', 'sudo'],
				},
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});
	});

	describe('config.betas.get/update', () => {
		test('should get betas config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-betas-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.betas.get', { sessionId });

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('betas');
			ws.close();
		});

		test('should update betas config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-betas-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.betas.update', {
				sessionId,
				betas: ['context-1m-2025-08-07'],
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject invalid beta feature', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-betas-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.betas.update', {
				sessionId,
				betas: ['invalid-beta-feature'],
			});

			// Handler returns RESULT with success: false for validation errors
			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.outputFormat.get/update', () => {
		test('should get output format config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-output-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.outputFormat.get', {
				sessionId,
			});

			expect(response.type).toBe('RSP');
			ws.close();
		});

		test('should update output format config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-output-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.outputFormat.update', {
				sessionId,
				outputFormat: {
					type: 'json_schema',
					schema: {
						type: 'object',
						properties: {
							name: { type: 'string' },
						},
					},
				},
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should clear output format with null', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-output-clear',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.outputFormat.update', {
				sessionId,
				outputFormat: null,
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});
	});

	// === Extended config handler tests (merged from rpc-config-handlers-extended.test.ts) ===

	describe('config.mcp.get', () => {
		test('should return MCP config for session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.get', { sessionId });

			expect(response.type).toBe('RSP');
			// Response includes MCP config and runtime status
			// mcpServers may be undefined if not configured
			expect(response.data).toBeDefined();
			const data = response.data as { runtimeStatus?: unknown[] };
			expect(data.runtimeStatus).toBeArray();
			ws.close();
		});
	});

	describe('config.mcp.update', () => {
		test('should update MCP servers', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.update', {
				sessionId,
				mcpServers: {
					'test-server': {
						command: 'test-command',
						args: [],
					},
				},
				strictMcpConfig: false,
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject invalid MCP server config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.update', {
				sessionId,
				mcpServers: {
					'': {
						// Empty name should fail
						command: 'test-command',
						args: [],
					},
				},
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.mcp.addServer', () => {
		test('should add MCP server', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-add',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.addServer', {
				sessionId,
				name: 'new-server',
				config: {
					command: 'npx',
					args: ['-y', '@modelcontextprotocol/server-test'],
				},
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject adding invalid server', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-add-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.addServer', {
				sessionId,
				name: '', // Empty name should fail
				config: {
					command: 'test-command',
					args: [],
				},
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.mcp.removeServer', () => {
		test('should remove MCP server', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-remove',
			});

			// First add a server
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			await sendRpcCall(ws, 'config.mcp.addServer', {
				sessionId,
				name: 'temp-server',
				config: { command: 'test', args: [] },
			});

			// Then remove it
			const response = await sendRpcCall(ws, 'config.mcp.removeServer', {
				sessionId,
				name: 'temp-server',
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});
	});

	describe('config.env.get', () => {
		test('should return environment config for session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-env-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.env.get', { sessionId });

			expect(response.type).toBe('RSP');
			expect(response.data).toBeDefined();
			ws.close();
		});
	});

	describe('config.env.update', () => {
		test('should update environment settings', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-env-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.env.update', {
				sessionId,
				settings: {
					additionalDirectories: ['/extra/dir'],
					env: { MY_VAR: 'test-value' },
				},
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject invalid env settings', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-env-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.env.update', {
				sessionId,
				settings: {
					// additionalDirectories should be array of strings
					additionalDirectories: 'not-an-array',
				},
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.model.update with maxThinkingTokens', () => {
		test('should update maxThinkingTokens', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-thinking-tokens',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.model.update', {
				sessionId,
				settings: {
					maxThinkingTokens: 4096,
				},
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { applied?: string[] };
			expect(data.applied).toContain('maxThinkingTokens');
			ws.close();
		});
	});

	describe('config.model.update with fallback settings', () => {
		test('should update fallbackModel, maxTurns, maxBudgetUsd', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-model-fallback',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.model.update', {
				sessionId,
				settings: {
					fallbackModel: 'claude-haiku-4-20250514',
					maxTurns: 100,
					maxBudgetUsd: 10.0,
				},
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { pending?: string[] };
			expect(data.pending).toContain('fallbackModel');
			expect(data.pending).toContain('maxTurns');
			expect(data.pending).toContain('maxBudgetUsd');
			ws.close();
		});
	});

	describe('config.updateBulk with restartQuery', () => {
		test('should update config with restartQuery=false', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-bulk-no-restart',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.updateBulk', {
				sessionId,
				config: {
					systemPrompt: 'New system prompt',
				},
				restartQuery: false,
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { pending?: string[] };
			expect(data.pending).toContain('systemPrompt');
			ws.close();
		});

		test('should handle tools in bulk config (maps to sdkToolsPreset)', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-bulk-tools',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.updateBulk', {
				sessionId,
				config: {
					tools: 'sdk',
				},
				restartQuery: false,
			});

			expect(response.type).toBe('RSP');
			ws.close();
		});
	});

	describe('Error handling for non-existent sessions', () => {
		test('config.env.get should error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.env.get', {
				sessionId: 'non-existent',
			});

			expect(response.type).toBe('RSP');
			expect(response.error).toBeDefined();
			ws.close();
		});

		test('config.mcp.get should error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.get', {
				sessionId: 'non-existent',
			});

			expect(response.type).toBe('RSP');
			expect(response.error).toBeDefined();
			ws.close();
		});
	});
});
