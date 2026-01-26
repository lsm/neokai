/**
 * setup-websocket.ts Tests
 *
 * Tests for the WebSocket handlers that manage client connections
 * and message routing.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { createWebSocketHandlers } from '../../../src/routes/setup-websocket';
import {
	createMockServerWebSocket,
	createMockHandlerDependencies,
	parseSentMessage,
	getAllSentMessages,
	type MockWebSocketData,
} from '../mocks/websocket-mock';
import type { WebSocketServerTransport } from '../../../src/lib/websocket-server-transport';
import type { SessionManager } from '../../../src/lib/session-manager';
import type { SubscriptionManager } from '../../../src/lib/subscription-manager';

describe('createWebSocketHandlers', () => {
	let mockDeps: ReturnType<typeof createMockHandlerDependencies>;
	let handlers: ReturnType<typeof createWebSocketHandlers>;

	beforeEach(() => {
		mockDeps = createMockHandlerDependencies();
		handlers = createWebSocketHandlers(
			mockDeps.transport as unknown as WebSocketServerTransport,
			mockDeps.sessionManager as unknown as SessionManager,
			mockDeps.subscriptionManager as unknown as SubscriptionManager
		);
	});

	describe('open handler', () => {
		it('should register client with transport', () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();

			handlers.open(mockWs);

			expect(mockDeps.transport.registerClient).toHaveBeenCalledWith(mockWs, 'global');
		});

		it('should store clientId in websocket data', () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockDeps.transport.registerClient = mock(() => 'test-client-id');

			handlers.open(mockWs);

			expect(mockWs.data.clientId).toBe('test-client-id');
		});

		it('should send connection confirmation event', () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();

			handlers.open(mockWs);

			expect(mockWs.send).toHaveBeenCalled();
			const sentMessage = parseSentMessage(mockWs) as {
				type: string;
				method: string;
				data: { protocol: string };
			};
			expect(sentMessage.type).toBe('EVENT');
			expect(sentMessage.method).toBe('connection.established');
			expect(sentMessage.data.protocol).toBe('MessageHub');
		});
	});

	describe('message handler', () => {
		beforeEach(() => {
			// Register the client first
			mockDeps.transport.registerClient = mock(() => 'test-client-id');
		});

		it('should handle ping messages', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			const pingMessage = JSON.stringify({
				type: 'ping',
				id: 'ping-123',
				sessionId: 'global',
			});

			await handlers.message(mockWs, pingMessage);

			// Should update client activity
			expect(mockDeps.transport.updateClientActivity).toHaveBeenCalledWith('test-client-id');

			// Should respond with pong
			const sentMessage = parseSentMessage(mockWs) as { type: string; requestId: string };
			expect(sentMessage.type).toBe('PONG');
			expect(sentMessage.requestId).toBe('ping-123');
		});

		it('should handle PING messages (uppercase)', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			const pingMessage = JSON.stringify({
				type: 'PING',
				id: 'ping-456',
				sessionId: 'global',
			});

			await handlers.message(mockWs, pingMessage);

			const sentMessage = parseSentMessage(mockWs) as { type: string };
			expect(sentMessage.type).toBe('PONG');
		});

		it('should reject messages exceeding size limit', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			// Create a message larger than 10MB
			const largeData = 'x'.repeat(11 * 1024 * 1024);
			const largeMessage = JSON.stringify({
				type: 'CALL',
				method: 'test.method',
				sessionId: 'global',
				data: largeData,
			});

			await handlers.message(mockWs, largeMessage);

			const sentMessage = parseSentMessage(mockWs) as {
				type: string;
				errorCode: string;
			};
			expect(sentMessage.type).toBe('ERROR');
			expect(sentMessage.errorCode).toBe('MESSAGE_TOO_LARGE');
		});

		it('should default sessionId to global if missing', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			const message = JSON.stringify({
				type: 'CALL',
				method: 'test.method',
			});

			await handlers.message(mockWs, message);

			expect(mockDeps.transport.handleClientMessage).toHaveBeenCalled();
		});

		it('should allow SUBSCRIBE messages without session validation', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			const subscribeMessage = JSON.stringify({
				type: 'SUBSCRIBE',
				method: 'state.session',
				sessionId: 'nonexistent-session',
			});

			await handlers.message(mockWs, subscribeMessage);

			// Should pass to transport without error
			expect(mockDeps.transport.handleClientMessage).toHaveBeenCalled();
		});

		it('should allow UNSUBSCRIBE messages without session validation', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			const unsubscribeMessage = JSON.stringify({
				type: 'UNSUBSCRIBE',
				method: 'state.session',
				sessionId: 'nonexistent-session',
			});

			await handlers.message(mockWs, unsubscribeMessage);

			// Should pass to transport without error
			expect(mockDeps.transport.handleClientMessage).toHaveBeenCalled();
		});

		it('should reject non-protocol messages for nonexistent sessions', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';
			mockDeps.sessionManager.getSessionAsync = mock(async () => null);

			const callMessage = JSON.stringify({
				type: 'CALL',
				id: 'call-123',
				method: 'session.get',
				sessionId: 'nonexistent-session',
			});

			await handlers.message(mockWs, callMessage);

			const sentMessage = parseSentMessage(mockWs) as {
				type: string;
				errorCode: string;
				error: string;
			};
			expect(sentMessage.type).toBe('ERROR');
			expect(sentMessage.errorCode).toBe('SESSION_NOT_FOUND');
			expect(sentMessage.error).toContain('nonexistent-session');
		});

		it('should forward valid session messages to transport', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			const callMessage = JSON.stringify({
				type: 'CALL',
				id: 'call-123',
				method: 'session.get',
				sessionId: 'valid-session-id',
			});

			await handlers.message(mockWs, callMessage);

			expect(mockDeps.transport.handleClientMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'CALL',
					method: 'session.get',
					sessionId: 'valid-session-id',
				}),
				'test-client-id'
			);
		});

		it('should handle invalid JSON gracefully', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			await handlers.message(mockWs, 'not valid json {{{');

			const sentMessage = parseSentMessage(mockWs) as {
				type: string;
				errorCode: string;
			};
			expect(sentMessage.type).toBe('ERROR');
			expect(sentMessage.errorCode).toBe('INVALID_MESSAGE');
		});

		it('should handle Buffer messages', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			const message = Buffer.from(
				JSON.stringify({
					type: 'CALL',
					method: 'test.method',
					sessionId: 'global',
				})
			);

			await handlers.message(mockWs, message);

			expect(mockDeps.transport.handleClientMessage).toHaveBeenCalled();
		});

		it('should not forward messages without clientId', async () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			// Don't set clientId

			const message = JSON.stringify({
				type: 'CALL',
				method: 'test.method',
				sessionId: 'global',
			});

			await handlers.message(mockWs, message);

			expect(mockDeps.transport.handleClientMessage).not.toHaveBeenCalled();
		});
	});

	describe('close handler', () => {
		it('should unregister client from transport', () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			handlers.close(mockWs);

			expect(mockDeps.transport.unregisterClient).toHaveBeenCalledWith('test-client-id');
		});

		it('should handle close without clientId', () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			// No clientId set

			// Should not throw
			handlers.close(mockWs);

			expect(mockDeps.transport.unregisterClient).not.toHaveBeenCalled();
		});
	});

	describe('error handler', () => {
		it('should unregister client on error', () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			mockWs.data.clientId = 'test-client-id';

			handlers.error(mockWs, new Error('Connection reset'));

			expect(mockDeps.transport.unregisterClient).toHaveBeenCalledWith('test-client-id');
		});

		it('should handle error without clientId', () => {
			const mockWs = createMockServerWebSocket<MockWebSocketData>();
			// No clientId set

			// Should not throw
			handlers.error(mockWs, new Error('Some error'));

			expect(mockDeps.transport.unregisterClient).not.toHaveBeenCalled();
		});
	});
});

describe('WebSocket message types', () => {
	let mockDeps: ReturnType<typeof createMockHandlerDependencies>;
	let handlers: ReturnType<typeof createWebSocketHandlers>;

	beforeEach(() => {
		mockDeps = createMockHandlerDependencies();
		mockDeps.transport.registerClient = mock(() => 'test-client-id');
		handlers = createWebSocketHandlers(
			mockDeps.transport as unknown as WebSocketServerTransport,
			mockDeps.sessionManager as unknown as SessionManager,
			mockDeps.subscriptionManager as unknown as SubscriptionManager
		);
	});

	it('should handle CALL message type', async () => {
		const mockWs = createMockServerWebSocket<MockWebSocketData>();
		mockWs.data.clientId = 'test-client-id';

		const message = JSON.stringify({
			type: 'CALL',
			id: 'call-id',
			method: 'session.list',
			sessionId: 'global',
			params: {},
		});

		await handlers.message(mockWs, message);

		expect(mockDeps.transport.handleClientMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'CALL',
				method: 'session.list',
			}),
			'test-client-id'
		);
	});

	it('should handle EVENT message type', async () => {
		const mockWs = createMockServerWebSocket<MockWebSocketData>();
		mockWs.data.clientId = 'test-client-id';

		const message = JSON.stringify({
			type: 'EVENT',
			method: 'message.send',
			sessionId: 'valid-session',
			params: { content: 'Hello' },
		});

		await handlers.message(mockWs, message);

		expect(mockDeps.transport.handleClientMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'EVENT',
				method: 'message.send',
			}),
			'test-client-id'
		);
	});

	it('should include sessionId in pong response', async () => {
		const mockWs = createMockServerWebSocket<MockWebSocketData>();
		mockWs.data.clientId = 'test-client-id';

		const message = JSON.stringify({
			type: 'ping',
			id: 'ping-id',
			sessionId: 'my-session',
		});

		await handlers.message(mockWs, message);

		const sentMessage = parseSentMessage(mockWs) as { sessionId: string };
		expect(sentMessage.sessionId).toBe('my-session');
	});
});

describe('WebSocket connection lifecycle', () => {
	let mockDeps: ReturnType<typeof createMockHandlerDependencies>;
	let handlers: ReturnType<typeof createWebSocketHandlers>;

	beforeEach(() => {
		mockDeps = createMockHandlerDependencies();
		handlers = createWebSocketHandlers(
			mockDeps.transport as unknown as WebSocketServerTransport,
			mockDeps.sessionManager as unknown as SessionManager,
			mockDeps.subscriptionManager as unknown as SubscriptionManager
		);
	});

	it('should handle full connection lifecycle', async () => {
		const mockWs = createMockServerWebSocket<MockWebSocketData>();
		let clientId = '';

		// Open connection
		mockDeps.transport.registerClient = mock(() => {
			clientId = 'lifecycle-client';
			return clientId;
		});

		handlers.open(mockWs);

		// Verify connection
		expect(mockWs.data.clientId).toBe('lifecycle-client');

		// Send a message
		const message = JSON.stringify({
			type: 'ping',
			sessionId: 'global',
		});
		await handlers.message(mockWs, message);

		// Close connection
		handlers.close(mockWs);

		expect(mockDeps.transport.unregisterClient).toHaveBeenCalledWith('lifecycle-client');
	});

	it('should track multiple messages in sequence', async () => {
		const mockWs = createMockServerWebSocket<MockWebSocketData>();
		mockWs.data.clientId = 'multi-msg-client';

		const messages = [
			{ type: 'ping', id: '1', sessionId: 'global' },
			{ type: 'ping', id: '2', sessionId: 'global' },
			{ type: 'ping', id: '3', sessionId: 'global' },
		];

		for (const msg of messages) {
			await handlers.message(mockWs, JSON.stringify(msg));
		}

		const allSent = getAllSentMessages(mockWs) as Array<{ requestId: string }>;
		expect(allSent).toHaveLength(3);
		expect(allSent[0].requestId).toBe('1');
		expect(allSent[1].requestId).toBe('2');
		expect(allSent[2].requestId).toBe('3');
	});
});
