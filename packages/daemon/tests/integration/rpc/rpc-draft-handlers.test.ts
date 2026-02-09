/**
 * Draft RPC Handlers Tests (Offline)
 *
 * Tests for input draft persistence via session metadata:
 * - session.get (includes inputDraft)
 * - session.update (accepts inputDraft in metadata)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../helpers/test-app';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../helpers/test-app';

describe('Draft RPC Handlers', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Draft persistence via RPC', () => {
		test('session.get should include inputDraft in response', async () => {
			// Create a session
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/draft-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Set inputDraft via RPC
			ws.send(
				JSON.stringify({
					id: 'draft-get-set',
					type: 'QRY',
					method: 'session.update',
					data: {
						sessionId,
						metadata: {
							inputDraft: 'test draft content',
						},
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let setResponse: unknown;
			let attempts = 0;
			while (attempts < 10) {
				setResponse = await waitForWebSocketMessage(ws);
				if (setResponse.type === 'RSP' && setResponse.requestId === 'draft-get-set') break;
				attempts++;
			}
			expect(setResponse.type).toBe('RSP');

			// Get session and verify inputDraft is included
			ws.send(
				JSON.stringify({
					id: 'draft-get-1',
					type: 'QRY',
					method: 'session.get',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let getResponse: unknown;
			attempts = 0;
			while (attempts < 10) {
				getResponse = await waitForWebSocketMessage(ws);
				if (getResponse.type === 'RSP' && getResponse.requestId === 'draft-get-1') break;
				attempts++;
			}

			expect(getResponse.type).toBe('RSP');
			expect(getResponse.data.session).toBeDefined();
			expect(getResponse.data.session.metadata.inputDraft).toBe('test draft content');

			ws.close();
		});

		test('session.update should accept inputDraft in metadata', async () => {
			// Create a session
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/draft-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			ws.send(
				JSON.stringify({
					id: 'draft-update-1',
					type: 'QRY',
					method: 'session.update',
					data: {
						sessionId,
						metadata: {
							inputDraft: 'new draft content',
						},
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let updateResponse: unknown;
			let attempts = 0;
			while (attempts < 10) {
				updateResponse = await waitForWebSocketMessage(ws);
				if (updateResponse.type === 'RSP' && updateResponse.requestId === 'draft-update-1') break;
				attempts++;
			}

			expect(updateResponse.type).toBe('RSP');
			expect(updateResponse.data.success).toBe(true);

			// Verify database updated correctly via session.get
			ws.send(
				JSON.stringify({
					id: 'draft-update-2',
					type: 'QRY',
					method: 'session.get',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let getResponse: unknown;
			attempts = 0;
			while (attempts < 10) {
				getResponse = await waitForWebSocketMessage(ws);
				if (getResponse.type === 'RSP' && getResponse.requestId === 'draft-update-2') break;
				attempts++;
			}

			expect(getResponse.type).toBe('RSP');
			expect(getResponse.data.session.metadata.inputDraft).toBe('new draft content');

			ws.close();
		});

		test('session.update should merge partial metadata including inputDraft', async () => {
			// Create session with existing metadata
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/draft-merge',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Set some initial metadata via RPC
			ws.send(
				JSON.stringify({
					id: 'draft-merge-set',
					type: 'QRY',
					method: 'session.update',
					data: {
						sessionId,
						metadata: {
							messageCount: 5,
							titleGenerated: true,
						},
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let setInitialResponse: unknown;
			let attempts = 0;
			while (attempts < 10) {
				setInitialResponse = await waitForWebSocketMessage(ws);
				if (setInitialResponse.type === 'RSP' && setInitialResponse.requestId === 'draft-merge-set')
					break;
				attempts++;
			}
			expect(setInitialResponse.type).toBe('RSP');

			// Update only inputDraft
			ws.send(
				JSON.stringify({
					id: 'draft-merge-1',
					type: 'QRY',
					method: 'session.update',
					data: {
						sessionId,
						metadata: {
							inputDraft: 'merged draft',
						},
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let updateResponse: unknown;
			attempts = 0;
			while (attempts < 10) {
				updateResponse = await waitForWebSocketMessage(ws);
				if (updateResponse.type === 'RSP' && updateResponse.requestId === 'draft-merge-1') break;
				attempts++;
			}

			expect(updateResponse.type).toBe('RSP');
			expect(updateResponse.data.success).toBe(true);

			// Verify merge behavior (inputDraft updated, other fields preserved) via session.get
			ws.send(
				JSON.stringify({
					id: 'draft-merge-2',
					type: 'QRY',
					method: 'session.get',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let getResponse: unknown;
			attempts = 0;
			while (attempts < 10) {
				getResponse = await waitForWebSocketMessage(ws);
				if (getResponse.type === 'RSP' && getResponse.requestId === 'draft-merge-2') break;
				attempts++;
			}

			expect(getResponse.type).toBe('RSP');
			expect(getResponse.data.session.metadata.inputDraft).toBe('merged draft');
			expect(getResponse.data.session.metadata.messageCount).toBe(5);
			expect(getResponse.data.session.metadata.titleGenerated).toBe(true);

			ws.close();
		});

		test('should clear inputDraft via session.update', async () => {
			// Create session with inputDraft set
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/draft-clear',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Set inputDraft via RPC
			ws.send(
				JSON.stringify({
					id: 'draft-clear-set',
					type: 'QRY',
					method: 'session.update',
					data: {
						sessionId,
						metadata: {
							inputDraft: 'draft to clear',
						},
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let setResponse: unknown;
			let attempts = 0;
			while (attempts < 10) {
				setResponse = await waitForWebSocketMessage(ws);
				if (setResponse.type === 'RSP' && setResponse.requestId === 'draft-clear-set') break;
				attempts++;
			}
			expect(setResponse.type).toBe('RSP');

			// Clear inputDraft (use null instead of undefined, as JSON.stringify strips undefined)
			ws.send(
				JSON.stringify({
					id: 'draft-clear-1',
					type: 'QRY',
					method: 'session.update',
					data: {
						sessionId,
						metadata: {
							inputDraft: null,
						},
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let updateResponse: unknown;
			attempts = 0;
			while (attempts < 10) {
				updateResponse = await waitForWebSocketMessage(ws);
				if (updateResponse.type === 'RSP' && updateResponse.requestId === 'draft-clear-1') break;
				attempts++;
			}

			expect(updateResponse.type).toBe('RSP');
			expect(updateResponse.data.success).toBe(true);

			// Verify inputDraft cleared from database via session.get
			ws.send(
				JSON.stringify({
					id: 'draft-clear-2',
					type: 'QRY',
					method: 'session.get',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for RSP (skip EVENTs)
			let getResponse: unknown;
			attempts = 0;
			while (attempts < 10) {
				getResponse = await waitForWebSocketMessage(ws);
				if (getResponse.type === 'RSP' && getResponse.requestId === 'draft-clear-2') break;
				attempts++;
			}

			expect(getResponse.type).toBe('RSP');
			expect(getResponse.data.session.metadata.inputDraft).toBeUndefined();

			ws.close();
		});
	});
});
