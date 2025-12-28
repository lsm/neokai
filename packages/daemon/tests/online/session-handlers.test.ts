/**
 * Session Handlers Tests (API-dependent)
 *
 * Tests for session-related RPC handlers that require API access:
 * - message.send with real SDK
 * - models.list (requires SDK to fetch models)
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
	hasAnyCredentials,
} from '../test-utils';

describe('Session RPC Handlers (API-dependent)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('message.send', () => {
		test.skipIf(!hasAnyCredentials())(
			'should accept message for existing session',
			async () => {
				const tmpDir = process.env.TMPDIR || '/tmp';
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: `${tmpDir}/liuboer-test-message-send-${Date.now()}`,
					useWorktree: false, // Disable worktrees for test speed
				});

				const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
				await waitForWebSocketState(ws, WebSocket.OPEN);
				await firstMessagePromise;

				const responsePromise = waitForWebSocketMessage(ws, 12000); // Increased to 12s to match test timeout

				ws.send(
					JSON.stringify({
						id: 'msg-2',
						type: 'CALL',
						method: 'message.send',
						data: {
							sessionId,
							content: 'Hello, Claude!',
						},
						sessionId: 'global',
						timestamp: new Date().toISOString(),
						version: '1.0.0',
					})
				);

				const response = await responsePromise;

				if (response.type === 'ERROR') {
					console.error('Error response:', response.error);
				}
				expect(response.type).toBe('RESULT');
				expect(response.data.messageId).toBeString();

				ws.close();
			},
			{ timeout: 15000 }
		); // Increase timeout to 15s for SDK initialization
	});

	describe('models.list', () => {
		// Note: Now using Agent SDK's supportedModels() which supports both API key and OAuth
		test.skipIf(!hasAnyCredentials())('should return list of models with cache', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws, 10000);

			ws.send(
				JSON.stringify({
					id: 'models-list-1',
					type: 'CALL',
					method: 'models.list',
					data: {
						useCache: true,
						forceRefresh: false,
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.models).toBeArray();

			ws.close();
		});

		test.skipIf(!hasAnyCredentials())('should return list of models without cache', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws, 10000);

			ws.send(
				JSON.stringify({
					id: 'models-list-2',
					type: 'CALL',
					method: 'models.list',
					data: {
						useCache: false,
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.models).toBeArray();
			expect(response.data.cached).toBe(false);

			ws.close();
		});

		test.skipIf(!hasAnyCredentials())('should force refresh cache', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws, 10000);

			ws.send(
				JSON.stringify({
					id: 'models-list-3',
					type: 'CALL',
					method: 'models.list',
					data: {
						useCache: true,
						forceRefresh: true,
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.models).toBeArray();

			ws.close();
		});
	});
});
