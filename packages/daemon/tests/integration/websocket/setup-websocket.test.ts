/**
 * Setup WebSocket Handlers Tests
 *
 * Tests for WebSocket message handling including:
 * - Large message rejection
 * - Ping/pong handling
 * - Session validation errors
 * - Error handler
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../helpers/test-app';
import {
	createTestApp,
	createWebSocket,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../helpers/test-app';

describe('Setup WebSocket Handlers', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Ping/Pong Handling', () => {
		test('should respond to ping with pong', async () => {
			// Use createWebSocketWithFirstMessage to avoid race conditions
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise; // Drain connection event

			// Set up response promise BEFORE sending
			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'ping-1',
					type: 'ping',
					sessionId: 'global',
					method: 'heartbeat',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('PONG');
			expect(response.requestId).toBe('ping-1');
			expect(response.method).toBe('heartbeat');

			ws.close();
		});

		test('should respond to PING (uppercase) with pong', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'ping-2',
					type: 'PING',
					sessionId: 'global',
					method: 'heartbeat',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('PONG');
			expect(response.requestId).toBe('ping-2');

			ws.close();
		});

		test('should use global sessionId for pong if not provided', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'ping-3',
					type: 'ping',
					sessionId: 'global',
					method: 'heartbeat',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('PONG');
			expect(response.sessionId).toBe('global');

			ws.close();
		});
	});

	describe('Session Validation', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'test-1',
					type: 'REQ',
					method: 'message.send',
					data: { content: 'test' },
					sessionId: 'non-existent-session-id',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RSP');
			expect(response.error).toBeDefined();
			expect(response.errorCode).toBe('SESSION_NOT_FOUND');
			expect(response.error).toContain('Session not found');

			ws.close();
		});

		// REMOVED: SUBSCRIBE/UNSUBSCRIBE no longer supported in new protocol (use rooms)
		// test('should allow SUBSCRIBE for non-existent session (protocol-level)', async () => {
		// 	const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		// 	await waitForWebSocketState(ws, WebSocket.OPEN);
		// 	await firstMessagePromise;

		// 	const responsePromise = waitForWebSocketMessage(ws, 2000);

		// 	ws.send(
		// 		JSON.stringify({
		// 			id: 'sub-1',
		// 			type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
		// 			method: 'test.event',
		// 			sessionId: 'non-existent-session',
		// 			timestamp: new Date().toISOString(),
		// 			version: '1.0.0',
		// 		})
		// 	);

		// 	const response = await responsePromise;
		// 	// Protocol messages like SUBSCRIBE should get a success response
		// 	expect(response.type).not.toBe('ERROR');

		// 	ws.close();
		// });

		// REMOVED: SUBSCRIBE/UNSUBSCRIBE no longer supported in new protocol (use rooms)
		// test('should allow UNSUBSCRIBE for non-existent session (protocol-level)', async () => {
		// 	const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		// 	await waitForWebSocketState(ws, WebSocket.OPEN);
		// 	await firstMessagePromise;

		// 	const responsePromise = waitForWebSocketMessage(ws, 2000);

		// 	ws.send(
		// 		JSON.stringify({
		// 			id: 'unsub-1',
		// 			type: 'UNSUBSCRIBE',
		// 			method: 'test.event',
		// 			sessionId: 'non-existent-session',
		// 			timestamp: new Date().toISOString(),
		// 			version: '1.0.0',
		// 		})
		// 	);

		// 	const response = await responsePromise;
		// 	expect(response.type).not.toBe('ERROR');

		// 	ws.close();
		// });

		test('should default to global sessionId when not provided', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'test-1',
					type: 'REQ',
					method: 'session.list',
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RSP');
			expect(response.data.sessions).toBeArray();

			ws.close();
		});
	});

	describe('Connection Event', () => {
		test('should send connection.established event on connect', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);

			const message = await firstMessagePromise;

			expect(message.type).toBe('EVENT');
			expect(message.method).toBe('connection.established');
			expect(message.data.message).toBe('WebSocket connection established');
			expect(message.data.protocol).toBe('MessageHub');
			expect(message.data.version).toBe('1.0.0');

			ws.close();
		});
	});

	describe('Error Handler', () => {
		test('should handle WebSocket error gracefully', async () => {
			const ws = createWebSocket(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);

			// Get the client count before close
			const initialCount = ctx.transport.getClientCount();
			expect(initialCount).toBe(1);

			// Force close (simulates disconnect)
			ws.close();
			await waitForWebSocketState(ws, WebSocket.CLOSED);

			// Wait for cleanup
			await Bun.sleep(100);

			// Client should be unregistered
			expect(ctx.transport.getClientCount()).toBe(0);
		});
	});

	describe('Large Message Rejection', () => {
		// 30s timeout needed for creating and sending 51MB message
		test(
			'should reject messages larger than 50MB',
			async () => {
				const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
				await waitForWebSocketState(ws, WebSocket.OPEN);
				await firstMessagePromise;

				const responsePromise = waitForWebSocketMessage(ws, 15000);

				// Create a message larger than 50MB
				const largeContent = 'x'.repeat(51 * 1024 * 1024); // 51MB of 'x'

				ws.send(
					JSON.stringify({
						id: 'large-1',
						type: 'REQ',
						method: 'test.method',
						data: { content: largeContent },
						sessionId: 'global',
						timestamp: new Date().toISOString(),
						version: '1.0.0',
					})
				);

				const response = await responsePromise;

				expect(response.type).toBe('RSP');
				expect(response.error).toBeDefined();
				expect(response.errorCode).toBe('MESSAGE_TOO_LARGE');
				expect(response.error).toContain('exceeds maximum');

				ws.close();
			},
			{ timeout: 30000 }
		);

		test('should accept messages smaller than 50MB', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'normal-1',
					type: 'REQ',
					method: 'session.list',
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RSP');

			ws.close();
		});
	});
});
