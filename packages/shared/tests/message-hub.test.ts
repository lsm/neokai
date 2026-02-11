import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { MessageHub } from '../src/message-hub/message-hub';
import type { IMessageTransport, ConnectionState, HubMessage } from '../src/message-hub/types';
import {
	MessageType,
	createRequestMessage,
	createResponseMessage,
	createErrorResponseMessage,
	createEventMessage,
} from '../src/message-hub/protocol';

class MockTransport implements IMessageTransport {
	readonly name = 'mock-transport';
	private state: ConnectionState = 'connected';
	private messageHandlers: Set<(message: HubMessage) => void> = new Set();
	private stateHandlers: Set<(state: ConnectionState) => void> = new Set();
	public sentMessages: HubMessage[] = [];

	async initialize(): Promise<void> {
		this.state = 'connected';
		this.notifyStateChange('connected');
	}

	async close(): Promise<void> {
		this.state = 'disconnected';
		this.notifyStateChange('disconnected');
	}

	async connect(): Promise<void> {
		this.state = 'connected';
		this.notifyStateChange('connected');
	}

	async disconnect(): Promise<void> {
		this.state = 'disconnected';
		this.notifyStateChange('disconnected');
	}

	async send(message: HubMessage): Promise<void> {
		this.sentMessages.push(message);
	}

	onMessage(handler: (message: HubMessage) => void): () => void {
		this.messageHandlers.add(handler);
		return () => {
			this.messageHandlers.delete(handler);
		};
	}

	onConnectionChange(handler: (state: ConnectionState) => void): () => void {
		this.stateHandlers.add(handler);
		return () => {
			this.stateHandlers.delete(handler);
		};
	}

	getState(): ConnectionState {
		return this.state;
	}

	isReady(): boolean {
		return this.state === 'connected';
	}

	// Test helpers
	simulateMessage(message: HubMessage): void {
		for (const handler of this.messageHandlers) {
			handler(message);
		}
	}

	simulateStateChange(state: ConnectionState): void {
		this.state = state;
		this.notifyStateChange(state);
	}

	private notifyStateChange(state: ConnectionState): void {
		for (const handler of this.stateHandlers) {
			handler(state);
		}
	}

	clearSentMessages(): void {
		this.sentMessages = [];
	}
}

describe('MessageHub', () => {
	let messageHub: MessageHub;
	let transport: MockTransport;

	beforeEach(async () => {
		messageHub = new MessageHub({
			defaultSessionId: 'test-session',
		});

		transport = new MockTransport();
		messageHub.registerTransport(transport);
		await transport.connect();
	});

	afterEach(() => {
		messageHub.cleanup();
	});

	describe('Transport Management', () => {
		test('should register transport successfully', () => {
			const newHub = new MessageHub({ defaultSessionId: 'test' });
			const newTransport = new MockTransport();

			newHub.registerTransport(newTransport);

			expect((newHub as unknown as { transport: unknown }).transport).toBe(newTransport);
		});

		test('should unregister transport successfully', () => {
			const newHub = new MessageHub({ defaultSessionId: 'test' });
			const newTransport = new MockTransport();

			const unregister = newHub.registerTransport(newTransport);
			expect((newHub as unknown as { transport: unknown }).transport).toBe(newTransport);

			unregister();
			expect((newHub as unknown as { transport: unknown }).transport).toBe(null);
		});

		test('should throw error when registering multiple transports', () => {
			const newTransport = new MockTransport();

			expect(() => {
				messageHub.registerTransport(newTransport);
			}).toThrow('Transport already registered');
		});

		test('should return disconnected state when no transport registered', () => {
			const newHub = new MessageHub({ defaultSessionId: 'test' });
			expect(newHub.getState()).toBe('disconnected');
		});

		test('should handle connection state changes', async () => {
			const stateChanges: ConnectionState[] = [];
			messageHub.onConnection((state) => {
				stateChanges.push(state);
			});

			transport.simulateStateChange('connecting');
			transport.simulateStateChange('connected');
			transport.simulateStateChange('disconnected');

			// Small delay to allow handlers to execute
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(stateChanges).toContain('connecting');
			expect(stateChanges).toContain('connected');
			expect(stateChanges).toContain('disconnected');
		});

		test('should unsubscribe from connection state changes', async () => {
			const stateChanges: ConnectionState[] = [];
			const unsubscribe = messageHub.onConnection((state) => {
				stateChanges.push(state);
			});

			transport.simulateStateChange('connecting');
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(stateChanges).toContain('connecting');

			unsubscribe();
			stateChanges.length = 0; // Clear array

			transport.simulateStateChange('disconnected');
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(stateChanges).not.toContain('disconnected');
		});

		test('should return correct connection state', () => {
			expect(messageHub.isConnected()).toBe(true);

			transport.simulateStateChange('disconnected');
			expect(messageHub.isConnected()).toBe(false);

			transport.simulateStateChange('connecting');
			expect(messageHub.isConnected()).toBe(false);
		});
	});

	describe('Query/Response Pattern', () => {
		test('should register query handler', () => {
			const handler = mock(async (_data: unknown) => ({ result: 'success' }));

			messageHub.onRequest('test.method', handler);

			expect(
				(messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
					'test.method'
				)
			).toBe(true);
		});

		test('should execute query handler when request message received', async () => {
			const handler = mock(async (data: { message?: string }) => {
				return { echo: data.message };
			});

			messageHub.onRequest('test.echo', handler);

			const requestMessage = createRequestMessage({
				method: 'test.echo',
				data: { message: 'hello' },
				sessionId: 'test-session',
			});

			transport.simulateMessage(requestMessage);

			// Wait for async handler
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(handler).toHaveBeenCalledWith(
				{ message: 'hello' },
				expect.objectContaining({
					sessionId: 'test-session',
					method: 'test.echo',
				})
			);

			// Check that response was sent back
			const sentMessages = transport.sentMessages;
			const responseMessage = sentMessages.find(
				(msg) => msg.type === MessageType.RESPONSE && msg.requestId === requestMessage.id
			);

			expect(responseMessage).toBeDefined();
			expect(responseMessage?.data).toEqual({ echo: 'hello' });
		});

		test('should send error response when handler throws', async () => {
			const handler = mock(async () => {
				throw new Error('Handler failed');
			});

			messageHub.onRequest('test.error', handler);

			const requestMessage = createRequestMessage({
				method: 'test.error',
				data: {},
				sessionId: 'test-session',
			});

			transport.simulateMessage(requestMessage);

			// Wait for async handler
			await new Promise((resolve) => setTimeout(resolve, 10));

			const sentMessages = transport.sentMessages;
			const errorMessage = sentMessages.find(
				(msg) =>
					msg.type === MessageType.RESPONSE && msg.requestId === requestMessage.id && msg.error
			);

			expect(errorMessage).toBeDefined();
			expect(errorMessage?.error).toContain('Handler failed');
		});

		test('should unregister query handler', () => {
			const handler = mock(async () => ({}));

			const unregister = messageHub.onRequest('test.method', handler);
			expect(
				(messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
					'test.method'
				)
			).toBe(true);

			unregister();
			expect(
				(messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
					'test.method'
				)
			).toBe(false);
		});
	});

	describe('Query Calls', () => {
		test('should send query message and receive response', async () => {
			const queryPromise = messageHub.request('test.method', { value: 42 });

			// Simulate receiving result
			await new Promise((resolve) => setTimeout(resolve, 10));

			const sentMessage = transport.sentMessages[0];
			expect(sentMessage.type).toBe(MessageType.REQUEST);
			expect(sentMessage.method).toBe('test.method');
			expect(sentMessage.data).toEqual({ value: 42 });

			// Simulate response from server
			const responseMessage = createResponseMessage({
				method: sentMessage.method,
				data: { result: 'success' },
				sessionId: sentMessage.sessionId,
				requestId: sentMessage.id,
			});

			transport.simulateMessage(responseMessage);

			const result = await queryPromise;
			expect(result).toEqual({ result: 'success' });
		});

		test('should handle query timeout', async () => {
			const queryPromise = messageHub.request('test.timeout', {}, { timeout: 100 });

			await expect(queryPromise).rejects.toThrow('Request timeout');
		});

		test('should receive error response for failed query', async () => {
			const queryPromise = messageHub.request('test.error', {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const sentMessage = transport.sentMessages[0];

			// Simulate error from server
			const errorMessage = createErrorResponseMessage({
				method: sentMessage.method,
				error: {
					message: 'Something went wrong',
					code: 'INTERNAL_ERROR',
				},
				sessionId: sentMessage.sessionId,
				requestId: sentMessage.id,
			});

			transport.simulateMessage(errorMessage);

			await expect(queryPromise).rejects.toThrow('Something went wrong');
		});

		test('should throw error when not connected', async () => {
			transport.simulateStateChange('disconnected');

			await expect(messageHub.request('test.method', {})).rejects.toThrow(
				'Not connected to transport'
			);
		});

		test('should handle sendMessage error in query', async () => {
			// Create a transport that throws on send
			class FailingTransport extends MockTransport {
				async send(_message: HubMessage): Promise<void> {
					throw new Error('Transport send failed');
				}
			}

			const newHub = new MessageHub({ defaultSessionId: 'test' });
			const failingTransport = new FailingTransport();
			newHub.registerTransport(failingTransport);
			await failingTransport.connect();

			await expect(newHub.request('test.method', {})).rejects.toThrow('Transport send failed');
		});

		test('should use custom room in query', async () => {
			const queryPromise = messageHub.request('test.method', {}, { room: 'custom-room' });

			await new Promise((resolve) => setTimeout(resolve, 10));

			const sentMessage = transport.sentMessages[0];
			expect(sentMessage.sessionId).toBe('custom-room');

			// Clean up pending query
			const responseMessage = createResponseMessage({
				method: sentMessage.method,
				data: {},
				sessionId: sentMessage.sessionId,
				requestId: sentMessage.id,
			});
			transport.simulateMessage(responseMessage);
			await queryPromise;
		});
	});

	describe('Request Handler Pattern', () => {
		test('should register request handler', () => {
			const handler = mock((_data: unknown) => {});

			messageHub.onRequest('test.request', handler);

			expect(
				(messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
					'test.request'
				)
			).toBe(true);
		});

		test('should execute request handler when request received', async () => {
			const handler = mock((data: { action?: string }) => {
				expect(data.action).toBe('test');
			});

			messageHub.onRequest('test.request', handler);

			const requestMessage = createRequestMessage({
				method: 'test.request',
				data: { action: 'test' },
				sessionId: 'test-session',
			});

			transport.simulateMessage(requestMessage);

			// Wait for async handler
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(handler).toHaveBeenCalledWith(
				{ action: 'test' },
				expect.objectContaining({
					method: 'test.request',
					sessionId: 'test-session',
				})
			);

			// All requests now send responses (ACK if handler returns void)
			const responses = transport.sentMessages.filter((m) => m.type === MessageType.RESPONSE);
			expect(responses.length).toBe(1);
			expect(responses[0].data).toEqual({ acknowledged: true });
		});

		test('should unregister request handler', () => {
			const handler = mock(() => {});

			const unregister = messageHub.onRequest('test.request', handler);
			expect(
				(messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
					'test.request'
				)
			).toBe(true);

			unregister();
			expect(
				(messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
					'test.request'
				)
			).toBe(false);
		});
	});

	describe('Event Pattern', () => {
		test('should emit event message', () => {
			messageHub.event('user.created', { userId: '123' });

			const sentMessage = transport.sentMessages[0];
			expect(sentMessage.type).toBe(MessageType.EVENT);
			expect(sentMessage.method).toBe('user.created');
			expect(sentMessage.data).toEqual({ userId: '123' });
		});

		test('should use custom room when emitting event', () => {
			messageHub.event('user.created', { userId: '123' }, { room: 'custom-room' });

			const sentMessage = transport.sentMessages[0];
			expect(sentMessage.sessionId).toBe('custom-room');
			expect(sentMessage.room).toBe('custom-room');
		});

		test('should not throw when emitting event while disconnected (skips send)', () => {
			transport.simulateStateChange('disconnected');

			// Should not throw, just skip sending
			messageHub.event('test.event', {});

			// No message should be sent
			expect(transport.sentMessages.length).toBe(0);
		});
	});

	describe('Event Listening', () => {
		test('should register event handler', () => {
			const handler = mock((_data: unknown) => {});

			messageHub.onEvent('user.created', handler);

			expect(
				(
					messageHub as unknown as { roomEventHandlers: Map<string, Set<unknown>> }
				).roomEventHandlers.has('user.created')
			).toBe(true);
		});

		test('should receive events matching handler', async () => {
			const handler = mock((_data: unknown) => {});

			messageHub.onEvent('user.created', handler);

			const eventMessage = createEventMessage({
				method: 'user.created',
				data: { userId: '123' },
				sessionId: 'test-session',
			});

			transport.simulateMessage(eventMessage);

			// Wait for async handling
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(handler).toHaveBeenCalledWith(
				{ userId: '123' },
				expect.objectContaining({
					method: 'user.created',
					sessionId: 'test-session',
				})
			);
		});

		test('should support multiple handlers for same event', async () => {
			const handler1 = mock((_data: unknown) => {});
			const handler2 = mock((_data: unknown) => {});

			messageHub.onEvent('user.created', handler1);
			messageHub.onEvent('user.created', handler2);

			const eventMessage = createEventMessage({
				method: 'user.created',
				data: { userId: '123' },
				sessionId: 'test-session',
			});

			transport.simulateMessage(eventMessage);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(handler1).toHaveBeenCalled();
			expect(handler2).toHaveBeenCalled();
		});

		test('should unregister event handler', async () => {
			const handler = mock((_data: unknown) => {});

			const unregister = messageHub.onEvent('user.created', handler);

			unregister();

			const eventMessage = createEventMessage({
				method: 'user.created',
				data: { userId: '123' },
				sessionId: 'test-session',
			});

			transport.simulateMessage(eventMessage);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe('Room Management', () => {
		test('should send room.join request', async () => {
			// Start joinRoom but don't await yet
			const joinPromise = messageHub.joinRoom('session-123');

			// Wait for message to be sent
			await new Promise((resolve) => setTimeout(resolve, 10));

			const sentMessage = transport.sentMessages[0];
			expect(sentMessage.type).toBe(MessageType.REQUEST);
			expect(sentMessage.method).toBe('room.join');
			expect(sentMessage.data).toEqual({ room: 'session-123' });

			// Simulate ACK response
			transport.simulateMessage(
				createResponseMessage({
					method: 'room.join',
					data: { acknowledged: true },
					sessionId: sentMessage.sessionId,
					requestId: sentMessage.id,
				})
			);

			await joinPromise;
		});

		test('should send room.leave request', async () => {
			// Start leaveRoom but don't await yet
			const leavePromise = messageHub.leaveRoom('session-123');

			// Wait for message to be sent
			await new Promise((resolve) => setTimeout(resolve, 10));

			const sentMessage = transport.sentMessages[0];
			expect(sentMessage.type).toBe(MessageType.REQUEST);
			expect(sentMessage.method).toBe('room.leave');
			expect(sentMessage.data).toEqual({ room: 'session-123' });

			// Simulate ACK response
			transport.simulateMessage(
				createResponseMessage({
					method: 'room.leave',
					data: { acknowledged: true },
					sessionId: sentMessage.sessionId,
					requestId: sentMessage.id,
				})
			);

			await leavePromise;
		});

		test('should skip room operations when disconnected', async () => {
			transport.simulateStateChange('disconnected');

			await messageHub.joinRoom('test-room');
			await messageHub.leaveRoom('test-room');

			expect(transport.sentMessages.length).toBe(0);
		});
	});

	describe('Message Routing', () => {
		test('should route messages to correct handlers', async () => {
			const requestHandler1 = mock(async () => ({}));
			const eventHandler = mock(() => {});
			const requestHandler2 = mock(() => {});

			messageHub.onRequest('test.request1', requestHandler1);
			messageHub.onEvent('test.event', eventHandler);
			messageHub.onRequest('test.request2', requestHandler2);

			// Send request 1
			const requestMessage1 = createRequestMessage({
				method: 'test.request1',
				data: {},
				sessionId: 'test-session',
			});
			transport.simulateMessage(requestMessage1);

			// Send event
			const eventMessage = createEventMessage({
				method: 'test.event',
				data: {},
				sessionId: 'test-session',
			});
			transport.simulateMessage(eventMessage);

			// Send request 2
			const requestMessage2 = createRequestMessage({
				method: 'test.request2',
				data: {},
				sessionId: 'test-session',
			});
			transport.simulateMessage(requestMessage2);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(requestHandler1).toHaveBeenCalled();
			expect(eventHandler).toHaveBeenCalled();
			expect(requestHandler2).toHaveBeenCalled();
		});

		test('should handle response messages for pending queries', async () => {
			const queryPromise = messageHub.request('test.method', {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const sentMessage = transport.sentMessages[0];
			const responseMessage = createResponseMessage({
				method: sentMessage.method,
				data: { value: 42 },
				sessionId: sentMessage.sessionId,
				requestId: sentMessage.id,
			});

			transport.simulateMessage(responseMessage);

			const result = await queryPromise;
			expect(result).toEqual({ value: 42 });
		});

		test('should ignore response for unknown query ID', () => {
			const responseMessage = createResponseMessage({
				method: 'test.method',
				data: {},
				sessionId: 'test-session',
				requestId: 'unknown-id',
			});

			// Should not throw
			expect(() => {
				transport.simulateMessage(responseMessage);
			}).not.toThrow();
		});

		test('should unsubscribe from onMessage handler on transport unregister', () => {
			const newHub = new MessageHub({ defaultSessionId: 'test' });
			const newTransport = new MockTransport();

			const unregister = newHub.registerTransport(newTransport);

			// Verify transport is registered
			expect((newHub as unknown as { transport: unknown }).transport).toBe(newTransport);

			// Verify transport has message handlers registered
			expect(newTransport['messageHandlers'].size).toBe(1);

			// Unregister transport
			unregister();

			// Verify transport is unregistered
			expect((newHub as unknown as { transport: unknown }).transport).toBe(null);

			// Verify transport's message handlers are removed
			expect(newTransport['messageHandlers'].size).toBe(0);
		});
	});

	describe('Message Inspection', () => {
		test('should call message handler for incoming and outgoing messages', async () => {
			const handler = mock(() => {});
			messageHub.onMessage(handler);

			// Send a request (outgoing)
			const requestPromise = messageHub.request('test.method', {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should have been called for outgoing REQUEST message
			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MessageType.REQUEST,
					method: 'test.method',
				}),
				'out'
			);

			// Simulate response (incoming)
			const sentMessage = transport.sentMessages[0];
			const responseMessage = createResponseMessage({
				method: sentMessage.method,
				data: {},
				sessionId: sentMessage.sessionId,
				requestId: sentMessage.id,
			});

			transport.simulateMessage(responseMessage);

			// Should have been called for incoming RESPONSE message
			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MessageType.RESPONSE,
				}),
				'in'
			);

			await requestPromise;
		});

		test('should unsubscribe from message handler', () => {
			const handler = mock(() => {});
			const unsubscribe = messageHub.onMessage(handler);

			// Send a message
			messageHub.event('test.event', {});

			// Handler should have been called
			expect(handler).toHaveBeenCalled();

			// Clear mock
			handler.mockClear();

			// Unsubscribe
			unsubscribe();

			// Send another message
			messageHub.event('test.event2', {});

			// Handler should NOT have been called
			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe('PING/PONG', () => {
		test('should respond to PING with PONG', async () => {
			transport.clearSentMessages();

			const pingMessage: HubMessage = {
				id: 'ping-123',
				type: MessageType.PING,
				sessionId: 'test-session',
				method: 'heartbeat',
				timestamp: new Date().toISOString(),
			};

			transport.simulateMessage(pingMessage);

			await new Promise((resolve) => setTimeout(resolve, 10));

			const pongMessages = transport.sentMessages.filter((m) => m.type === MessageType.PONG);
			expect(pongMessages.length).toBe(1);
			expect(pongMessages[0].requestId).toBe('ping-123');
		});

		test('should handle PONG message', () => {
			const pongMessage: HubMessage = {
				id: 'pong-123',
				type: MessageType.PONG,
				sessionId: 'test-session',
				method: 'heartbeat',
				requestId: 'ping-123',
				timestamp: new Date().toISOString(),
			};

			// Should not throw
			expect(() => {
				transport.simulateMessage(pongMessage);
			}).not.toThrow();
		});
	});

	describe('Cleanup and Disposal', () => {
		test('should cleanup pending queries on cleanup', async () => {
			const _query1 = messageHub.request('test.method1', {}).catch(() => {});
			const _query2 = messageHub.request('test.method2', {}).catch(() => {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			messageHub.cleanup();

			expect(
				(messageHub as unknown as { pendingCalls: Map<string, unknown> }).pendingCalls.size
			).toBe(0);
		});

		test('should clear all handlers on cleanup', () => {
			messageHub.onRequest('test.query', async () => ({}));
			messageHub.onRequest('test.command', () => {});
			messageHub.onEvent('test.event', () => {});

			messageHub.cleanup();

			expect(
				(messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.size
			).toBe(0);
			expect(
				(messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.size
			).toBe(0);
			expect(
				(messageHub as unknown as { roomEventHandlers: Map<string, unknown> }).roomEventHandlers
					.size
			).toBe(0);
		});

		test('should remove connection state handlers on cleanup', () => {
			messageHub.onConnection(() => {});

			messageHub.cleanup();

			expect(
				(messageHub as unknown as { connectionStateHandlers: Set<unknown> }).connectionStateHandlers
					.size
			).toBe(0);
		});

		test('should clear message inspection handlers on cleanup', () => {
			messageHub.onMessage(() => {});

			messageHub.cleanup();

			expect(
				(messageHub as unknown as { messageHandlers: Set<unknown> }).messageHandlers.size
			).toBe(0);
		});
	});

	describe('Utility Methods', () => {
		test('should get pending call count', async () => {
			// No pending calls initially
			expect(messageHub.getPendingCallCount()).toBe(0);

			// Create some pending queries
			const query1 = messageHub.request('test.method1', {});
			const query2 = messageHub.request('test.method2', {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(messageHub.getPendingCallCount()).toBe(2);

			// Resolve one query
			const sentMessage1 = transport.sentMessages[0];
			transport.simulateMessage(
				createResponseMessage({
					method: sentMessage1.method,
					data: {},
					sessionId: sentMessage1.sessionId,
					requestId: sentMessage1.id,
				})
			);

			await query1;
			expect(messageHub.getPendingCallCount()).toBe(1);

			// Resolve second query
			const sentMessage2 = transport.sentMessages[1];
			transport.simulateMessage(
				createResponseMessage({
					method: sentMessage2.method,
					data: {},
					sessionId: sentMessage2.sessionId,
					requestId: sentMessage2.id,
				})
			);

			await query2;
			expect(messageHub.getPendingCallCount()).toBe(0);
		});
	});
});
