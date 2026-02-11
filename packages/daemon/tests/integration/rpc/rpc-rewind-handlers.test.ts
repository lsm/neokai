/**
 * Rewind RPC Handlers Integration Tests (Offline)
 *
 * Tests for the rewind feature RPC handlers:
 * - rewind.checkpoints - Get all checkpoints for a session
 * - rewind.preview - Preview a rewind operation (dry run)
 * - rewind.execute - Execute a rewind operation
 *
 * These tests verify the RPC handlers work correctly without
 * requiring actual SDK calls (which are covered by online tests).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../helpers/test-app';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../helpers/test-app';

describe('Rewind RPC Handlers', () => {
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
				type: 'REQ',
				method,
				data,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		return responsePromise;
	}

	describe('rewind.checkpoints', () => {
		test('should return empty checkpoints for new session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/rewind-checkpoints-empty',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.checkpoints', {
				sessionId,
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { rewindPoints: unknown[]; error?: string };
			expect(data.rewindPoints).toEqual([]);
			expect(data.error).toBeUndefined();
			ws.close();
		});

		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.checkpoints', {
				sessionId: 'non-existent-session-id',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { rewindPoints: unknown[]; error?: string };
			expect(data.rewindPoints).toEqual([]);
			expect(data.error).toBe('Session not found');
			ws.close();
		});

		test('should handle missing sessionId parameter', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.checkpoints', {});

			// Should return an error or empty result
			expect(response.type).toBe('RSP');
			const data = response.data as { rewindPoints: unknown[]; error?: string };
			expect(data.rewindPoints).toEqual([]);
			ws.close();
		});
	});

	describe('rewind.preview', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.preview', {
				sessionId: 'non-existent-session-id',
				checkpointId: 'some-checkpoint-id',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { preview: { canRewind: boolean; error?: string } };
			expect(data.preview.canRewind).toBe(false);
			expect(data.preview.error).toBe('Session not found');
			ws.close();
		});

		test('should return error when SDK query not active', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/rewind-preview-no-query',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.preview', {
				sessionId,
				checkpointId: 'some-checkpoint-id',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { preview: { canRewind: boolean; error?: string } };
			expect(data.preview.canRewind).toBe(false);
			// Either checkpoint not found or SDK query not active
			expect(data.preview.error).toBeDefined();
			ws.close();
		});

		test('should return error for non-existent checkpoint', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/rewind-preview-no-checkpoint',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.preview', {
				sessionId,
				checkpointId: 'non-existent-checkpoint',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { preview: { canRewind: boolean; error?: string } };
			expect(data.preview.canRewind).toBe(false);
			expect(data.preview.error).toContain('not found');
			ws.close();
		});
	});

	describe('rewind.execute', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.execute', {
				sessionId: 'non-existent-session-id',
				checkpointId: 'some-checkpoint-id',
				mode: 'files',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { result: { success: boolean; error?: string } };
			expect(data.result.success).toBe(false);
			expect(data.result.error).toBe('Session not found');
			ws.close();
		});

		test('should return error when SDK query not active', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/rewind-execute-no-query',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.execute', {
				sessionId,
				checkpointId: 'some-checkpoint-id',
				mode: 'files',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { result: { success: boolean; error?: string } };
			expect(data.result.success).toBe(false);
			// Either checkpoint not found or SDK query not active
			expect(data.result.error).toBeDefined();
			ws.close();
		});

		test('should return error for non-existent checkpoint', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/rewind-execute-no-checkpoint',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.execute', {
				sessionId,
				checkpointId: 'non-existent-checkpoint',
				mode: 'files',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { result: { success: boolean; error?: string } };
			expect(data.result.success).toBe(false);
			expect(data.result.error).toContain('not found');
			ws.close();
		});

		test('should default to files mode when mode not specified', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/rewind-execute-default-mode',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Send without mode - should default to 'files'
			const response = await sendRpcCall(ws, 'rewind.execute', {
				sessionId,
				checkpointId: 'some-checkpoint-id',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { result: { success: boolean; error?: string } };
			// Should fail due to checkpoint not found, but not due to mode
			expect(data.result.success).toBe(false);
			expect(data.result.error).toContain('not found');
			ws.close();
		});

		test('should accept conversation mode', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/rewind-execute-conversation-mode',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.execute', {
				sessionId,
				checkpointId: 'some-checkpoint-id',
				mode: 'conversation',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { result: { success: boolean; error?: string } };
			// Should fail due to checkpoint not found
			expect(data.result.success).toBe(false);
			ws.close();
		});

		test('should accept both mode', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/rewind-execute-both-mode',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'rewind.execute', {
				sessionId,
				checkpointId: 'some-checkpoint-id',
				mode: 'both',
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { result: { success: boolean; error?: string } };
			// Should fail due to checkpoint not found
			expect(data.result.success).toBe(false);
			ws.close();
		});
	});

	describe('rewind handler registration', () => {
		test('should have all rewind handlers registered', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Test that all handlers respond (even if with errors for invalid data)
			const checkpointsResponse = await sendRpcCall(ws, 'rewind.checkpoints', {
				sessionId: 'test',
			});
			expect(checkpointsResponse.type).toBe('RSP');

			const previewResponse = await sendRpcCall(ws, 'rewind.preview', {
				sessionId: 'test',
				checkpointId: 'test',
			});
			expect(previewResponse.type).toBe('RSP');

			const executeResponse = await sendRpcCall(ws, 'rewind.execute', {
				sessionId: 'test',
				checkpointId: 'test',
			});
			expect(executeResponse.type).toBe('RSP');

			ws.close();
		});
	});
});
