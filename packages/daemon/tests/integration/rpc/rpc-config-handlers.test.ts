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
import type { TestContext } from '../../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../test-utils';

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
		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: `call-${Date.now()}`,
				type: 'CALL',
				method,
				data,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		return responsePromise;
	}

	describe('config.model.get', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.model.get', {
				sessionId: 'non-existent',
			});

			expect(response.type).toBe('ERROR');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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
			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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
			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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
			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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
			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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
			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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
			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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
			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
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

			expect(response.type).toBe('RESULT');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});
	});
});
