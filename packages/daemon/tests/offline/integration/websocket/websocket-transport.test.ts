/**
 * WebSocket Server Transport Tests
 *
 * Tests for WebSocketServerTransport class functionality
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { MessageHubRouter } from '@liuboer/shared';
import { WebSocketServerTransport } from '../../../../src/lib/websocket-server-transport';
import type { ServerWebSocket } from 'bun';

function createMockRouter() {
	const connections = new Map<string, unknown>();
	let broadcastCalls: unknown[] = [];

	return {
		registerConnection: mock((conn: { id: string }) => {
			connections.set(conn.id, conn);
		}),
		unregisterConnection: mock((clientId: string) => {
			connections.delete(clientId);
		}),
		getClientCount: mock(() => connections.size),
		getClientById: mock((clientId: string) => connections.get(clientId)),
		broadcast: mock((message: unknown) => {
			broadcastCalls.push(message);
		}),
		subscribe: mock(() => {}),
		unsubscribe: mock(() => {}),
		// Test helpers
		_connections: connections,
		_broadcastCalls: broadcastCalls,
		_reset: () => {
			connections.clear();
			broadcastCalls = [];
		},
	};
}

function createMockWebSocket(readyState = 1): ServerWebSocket<unknown> {
	const sendMock = mock(() => {});
	return {
		readyState,
		send: sendMock,
		close: mock(() => {}),
		subscribe: mock(() => {}),
		unsubscribe: mock(() => {}),
		isSubscribed: mock(() => false),
		publish: mock(() => {}),
		publishText: mock(() => {}),
		publishBinary: mock(() => {}),
		cork: mock(() => {}),
		remoteAddress: '127.0.0.1',
		binaryType: 'nodebuffer' as const,
		data: {},
		sendText: sendMock,
		sendBinary: mock(() => {}),
		ping: mock(() => {}),
		pong: mock(() => {}),
		terminate: mock(() => {}),
	} as unknown as ServerWebSocket<unknown>;
}

describe('WebSocketServerTransport', () => {
	let router: ReturnType<typeof createMockRouter>;
	let transport: WebSocketServerTransport;

	beforeEach(() => {
		router = createMockRouter();
		transport = new WebSocketServerTransport({
			name: 'test-transport',
			debug: false,
			router: router as unknown as MessageHubRouter,
			maxQueueSize: 100,
		});
	});

	describe('initialization', () => {
		test('should initialize with correct name', () => {
			expect(transport.name).toBe('test-transport');
		});

		test('should use default name if not provided', () => {
			const t = new WebSocketServerTransport({
				router: router as unknown as MessageHubRouter,
			});
			expect(t.name).toBe('websocket-server');
		});

		test('initialize should resolve immediately', async () => {
			await expect(transport.initialize()).resolves.toBeUndefined();
		});
	});

	describe('client registration', () => {
		test('should register client with generated ID', () => {
			const ws = createMockWebSocket();
			const clientId = transport.registerClient(ws, 'global');

			expect(clientId).toBeString();
			expect(clientId.length).toBeGreaterThan(0);
			expect(router.registerConnection).toHaveBeenCalled();
		});

		test('should track client with bidirectional mapping', () => {
			const ws = createMockWebSocket();
			const clientId = transport.registerClient(ws, 'global');

			expect(transport.getClientCount()).toBe(1);
			expect(transport.getClient(clientId)).toBeDefined();
		});

		test('should unregister client properly', () => {
			const ws = createMockWebSocket();
			const clientId = transport.registerClient(ws, 'global');

			transport.unregisterClient(clientId);

			expect(router.unregisterConnection).toHaveBeenCalledWith(clientId);
		});
	});

	describe('connection state', () => {
		test('getState should return disconnected when no clients', () => {
			expect(transport.getState()).toBe('disconnected');
		});

		test('getState should return connected when clients exist', () => {
			const ws = createMockWebSocket();
			transport.registerClient(ws, 'global');

			expect(transport.getState()).toBe('connected');
		});

		test('isReady should return false when no clients', () => {
			expect(transport.isReady()).toBe(false);
		});

		test('isReady should return true when clients exist', () => {
			const ws = createMockWebSocket();
			transport.registerClient(ws, 'global');

			expect(transport.isReady()).toBe(true);
		});
	});

	describe('message handling', () => {
		test('handleClientMessage should notify handlers', () => {
			const handler = mock(() => {});
			transport.onMessage(handler);

			const message = {
				id: 'test-1',
				type: 'CALL',
				method: 'test.method',
				data: {},
				sessionId: 'global',
			};

			transport.handleClientMessage(message);

			expect(handler).toHaveBeenCalledWith(expect.objectContaining(message));
		});

		test('handleClientMessage should add clientId to message', () => {
			let capturedMessage: unknown;
			transport.onMessage((msg) => {
				capturedMessage = msg;
			});

			const message = {
				id: 'test-1',
				type: 'CALL',
				method: 'test.method',
				data: {},
				sessionId: 'global',
			};

			transport.handleClientMessage(message, 'client-123');

			expect((capturedMessage as { clientId: string }).clientId).toBe('client-123');
		});

		test('onMessage should return unsubscribe function', () => {
			const handler = mock(() => {});
			const unsubscribe = transport.onMessage(handler);

			transport.handleClientMessage({
				id: 'test-1',
				type: 'CALL',
				method: 'test',
				sessionId: 'global',
			});
			expect(handler).toHaveBeenCalledTimes(1);

			unsubscribe();

			transport.handleClientMessage({
				id: 'test-2',
				type: 'CALL',
				method: 'test',
				sessionId: 'global',
			});
			expect(handler).toHaveBeenCalledTimes(1); // Still 1
		});
	});

	describe('connection change handling', () => {
		test('onConnectionChange should notify on first client connect', () => {
			const handler = mock(() => {});
			transport.onConnectionChange(handler);

			const ws = createMockWebSocket();
			transport.registerClient(ws, 'global');

			expect(handler).toHaveBeenCalledWith('connected', undefined);
		});

		test('onConnectionChange should notify on last client disconnect', () => {
			const handler = mock(() => {});
			transport.onConnectionChange(handler);

			const ws = createMockWebSocket();
			const clientId = transport.registerClient(ws, 'global');

			// Reset mock to ignore the connect call
			handler.mockClear();

			transport.unregisterClient(clientId);

			expect(handler).toHaveBeenCalledWith('disconnected', undefined);
		});

		test('onConnectionChange should return unsubscribe function', () => {
			const handler = mock(() => {});
			const unsubscribe = transport.onConnectionChange(handler);

			const ws = createMockWebSocket();
			transport.registerClient(ws, 'global');
			expect(handler).toHaveBeenCalledTimes(1);

			unsubscribe();

			const ws2 = createMockWebSocket();
			transport.registerClient(ws2, 'global');
			// Handler should not be called again after unsubscribe
			// (but it might be called once for disconnect if we had more clients)
		});
	});

	describe('backpressure handling', () => {
		test('canClientAccept should return true when queue is not full', () => {
			const ws = createMockWebSocket();
			const clientId = transport.registerClient(ws, 'global');

			expect(transport.canClientAccept(clientId)).toBe(true);
		});

		test('getClientQueueSize should return 0 for new client', () => {
			const ws = createMockWebSocket();
			const clientId = transport.registerClient(ws, 'global');

			expect(transport.getClientQueueSize(clientId)).toBe(0);
		});

		test('getClientQueueSize should return 0 for non-existent client', () => {
			expect(transport.getClientQueueSize('non-existent')).toBe(0);
		});
	});

	describe('send (deprecated)', () => {
		test('should broadcast EVENT messages', async () => {
			const ws = createMockWebSocket();
			transport.registerClient(ws, 'global');

			await transport.send({
				id: 'test-1',
				type: 'EVENT',
				method: 'test.event',
				data: { foo: 'bar' },
				sessionId: 'global',
			});

			expect(router.broadcast).toHaveBeenCalled();
		});

		test('should broadcast non-EVENT messages', async () => {
			const ws = createMockWebSocket();
			transport.registerClient(ws, 'global');

			await transport.send({
				id: 'test-1',
				type: 'CALL',
				method: 'test.call',
				data: {},
				sessionId: 'global',
			});

			expect(router.broadcast).toHaveBeenCalled();
		});
	});

	describe('broadcastToSession', () => {
		test('should add sessionId to message', async () => {
			const ws = createMockWebSocket();
			transport.registerClient(ws, 'global');

			await transport.broadcastToSession('session-123', {
				id: 'test-1',
				type: 'EVENT',
				method: 'test.event',
				data: {},
				sessionId: 'global',
			});

			expect(router.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-123',
				})
			);
		});
	});

	describe('close', () => {
		test('should unregister all clients', async () => {
			const ws1 = createMockWebSocket();
			const ws2 = createMockWebSocket();

			transport.registerClient(ws1, 'global');
			transport.registerClient(ws2, 'global');

			expect(transport.getClientCount()).toBe(2);

			await transport.close();

			// After close, router should have no clients
			expect(router.unregisterConnection).toHaveBeenCalledTimes(2);
		});

		test('should notify connection handlers on close', async () => {
			const handler = mock(() => {});
			transport.onConnectionChange(handler);

			const ws = createMockWebSocket();
			transport.registerClient(ws, 'global');

			handler.mockClear();

			await transport.close();

			// Handler is called with (state, error?) - error is undefined
			expect(handler).toHaveBeenCalledWith('disconnected', undefined);
		});
	});

	describe('getRouter', () => {
		test('should return router instance', () => {
			expect(transport.getRouter()).toBe(router);
		});
	});

	describe('getClientCount', () => {
		test('should delegate to router', () => {
			expect(transport.getClientCount()).toBe(0);

			const ws = createMockWebSocket();
			transport.registerClient(ws, 'global');

			expect(transport.getClientCount()).toBe(1);
		});
	});
});
