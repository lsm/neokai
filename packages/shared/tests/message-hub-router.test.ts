import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { MessageHubRouter, type ClientConnection } from '../src/message-hub/router';
import type { HubMessage } from '../src/message-hub/types';
import { MessageType, createEventMessage, createCallMessage } from '../src/message-hub/protocol';
import { generateUUID } from '../src/utils';

// Mock WebSocket
class MockWebSocket {
	public readyState = 1; // WebSocket.OPEN
	public sentMessages: string[] = [];

	send(data: string): void {
		this.sentMessages.push(data);
	}

	close(): void {
		this.readyState = 3; // WebSocket.CLOSED
	}
}

// Helper to create ClientConnection from MockWebSocket
function createMockConnection(ws: MockWebSocket, id?: string): ClientConnection {
	return {
		id: id || generateUUID(),
		send: (data: string) => ws.send(data),
		isOpen: () => ws.readyState === 1,
		metadata: { ws },
	};
}

describe('MessageHubRouter', () => {
	let router: MessageHubRouter;
	let mockWs1: MockWebSocket;
	let mockWs2: MockWebSocket;

	beforeEach(() => {
		router = new MessageHubRouter();
		mockWs1 = new MockWebSocket();
		mockWs2 = new MockWebSocket();
	});

	describe('Client Registration', () => {
		test('should register a client and return clientId', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);

			expect(clientId).toBeTruthy();
			expect(router.getClientCount()).toBe(1);
		});

		test('should register multiple clients', () => {
			const conn1 = createMockConnection(mockWs1);
			const conn2 = createMockConnection(mockWs2);
			const clientId1 = router.registerConnection(conn1);
			const clientId2 = router.registerConnection(conn2);

			expect(clientId1).toBeTruthy();
			expect(clientId2).toBeTruthy();
			expect(clientId1).not.toBe(clientId2);
			expect(router.getClientCount()).toBe(2);
		});

		test('should unregister a client', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);
			expect(router.getClientCount()).toBe(1);

			router.unregisterConnection(clientId);
			expect(router.getClientCount()).toBe(0);
		});

		test('should get client info by WebSocket', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);
			const info = router.getClientById(clientId);

			expect(info).toBeDefined();
			expect(info?.clientId).toBe(clientId);
			expect(info?.connection.metadata?.ws).toBe(mockWs1);
		});
	});

	describe('Subscription Management', () => {
		test('should subscribe client to method', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);
			router.subscribe('session1', 'user.created', clientId);

			const count = router.getSubscriptionCount('session1', 'user.created');
			expect(count).toBe(1);
		});

		test('should subscribe multiple clients to same method', () => {
			const conn1 = createMockConnection(mockWs1);
			const conn2 = createMockConnection(mockWs2);
			const clientId1 = router.registerConnection(conn1);
			const clientId2 = router.registerConnection(conn2);

			router.subscribe('session1', 'user.created', clientId1);
			router.subscribe('session1', 'user.created', clientId2);

			const count = router.getSubscriptionCount('session1', 'user.created');
			expect(count).toBe(2);
		});

		test('should unsubscribe client from method', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);
			router.subscribe('session1', 'user.created', clientId);

			router.unsubscribeClient('session1', 'user.created', clientId);

			const count = router.getSubscriptionCount('session1', 'user.created');
			expect(count).toBe(0);
		});

		test('should track subscriptions per session', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);

			router.subscribe('session1', 'user.created', clientId);
			router.subscribe('session2', 'user.created', clientId);

			expect(router.getSubscriptionCount('session1', 'user.created')).toBe(1);
			expect(router.getSubscriptionCount('session2', 'user.created')).toBe(1);
		});

		test('should unregister all subscriptions when client is removed', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);

			router.subscribe('session1', 'user.created', clientId);
			router.subscribe('session1', 'user.updated', clientId);

			router.unregisterConnection(clientId);

			expect(router.getSubscriptionCount('session1', 'user.created')).toBe(0);
			expect(router.getSubscriptionCount('session1', 'user.updated')).toBe(0);
		});
	});

	describe('Message Routing', () => {
		test('should route EVENT message to subscribed client', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);
			router.subscribe('session1', 'user.created', clientId);

			const eventMessage = createEventMessage({
				method: 'user.created',
				data: { userId: '123' },
				sessionId: 'session1',
			});

			router.routeEvent(eventMessage);

			expect(mockWs1.sentMessages.length).toBe(1);

			const sentMessage = JSON.parse(mockWs1.sentMessages[0]);
			expect(sentMessage.type).toBe(MessageType.EVENT);
			expect(sentMessage.method).toBe('user.created');
			expect(sentMessage.data).toEqual({ userId: '123' });
		});

		test('should route to multiple subscribed clients', () => {
			const conn1 = createMockConnection(mockWs1);
			const conn2 = createMockConnection(mockWs2);
			const clientId1 = router.registerConnection(conn1);
			const clientId2 = router.registerConnection(conn2);

			router.subscribe('session1', 'user.created', clientId1);
			router.subscribe('session1', 'user.created', clientId2);

			const eventMessage = createEventMessage({
				method: 'user.created',
				data: { userId: '123' },
				sessionId: 'session1',
			});

			router.routeEvent(eventMessage);

			expect(mockWs1.sentMessages.length).toBe(1);
			expect(mockWs2.sentMessages.length).toBe(1);
		});

		test('should not route to unsubscribed clients', () => {
			const conn1 = createMockConnection(mockWs1);
			const conn2 = createMockConnection(mockWs2);
			const clientId1 = router.registerConnection(conn1);
			const _clientId2 = router.registerConnection(conn2);

			router.subscribe('session1', 'user.created', clientId1);
			// clientId2 is not subscribed

			const eventMessage = createEventMessage({
				method: 'user.created',
				data: { userId: '123' },
				sessionId: 'session1',
			});

			router.routeEvent(eventMessage);

			expect(mockWs1.sentMessages.length).toBe(1);
			expect(mockWs2.sentMessages.length).toBe(0);
		});

		test('should not route to wrong session', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);
			router.subscribe('session1', 'user.created', clientId);

			const eventMessage = createEventMessage({
				method: 'user.created',
				data: { userId: '123' },
				sessionId: 'session2', // Different session
			});

			router.routeEvent(eventMessage);

			expect(mockWs1.sentMessages.length).toBe(0);
		});

		test('should skip clients with closed WebSocket', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);
			router.subscribe('session1', 'user.created', clientId);

			mockWs1.close();

			const eventMessage = createEventMessage({
				method: 'user.created',
				data: { userId: '123' },
				sessionId: 'session1',
			});

			router.routeEvent(eventMessage);

			// Should not send to closed WebSocket
			expect(mockWs1.sentMessages.length).toBe(0);
		});
	});

	describe('Direct Messaging', () => {
		test('should send message to specific client', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);

			const message: HubMessage = {
				id: 'msg1',
				type: MessageType.EVENT,
				method: 'test.event',
				sessionId: 'session1',
				data: { test: true },
				timestamp: new Date().toISOString(),
			};

			router.sendToClient(clientId, message);

			expect(mockWs1.sentMessages.length).toBe(1);

			const sentMessage = JSON.parse(mockWs1.sentMessages[0]);
			expect(sentMessage.method).toBe('test.event');
		});

		test('should not send to non-existent client', () => {
			router.sendToClient('non-existent-id', {
				id: 'msg1',
				type: MessageType.EVENT,
				method: 'test.event',
				sessionId: 'session1',
				data: {},
				timestamp: new Date().toISOString(),
			});

			// Should not throw, just log warning
			expect(mockWs1.sentMessages.length).toBe(0);
		});

		test('should broadcast to all clients', () => {
			const conn1 = createMockConnection(mockWs1);
			const conn2 = createMockConnection(mockWs2);
			router.registerConnection(conn1);
			router.registerConnection(conn2);

			const message: HubMessage = {
				id: 'msg1',
				type: MessageType.EVENT,
				method: 'broadcast.event',
				sessionId: 'global',
				data: { test: true },
				timestamp: new Date().toISOString(),
			};

			router.broadcast(message);

			expect(mockWs1.sentMessages.length).toBe(1);
			expect(mockWs2.sentMessages.length).toBe(1);
		});
	});

	// Auto-subscription tests removed - this is now application-layer logic
	// handled by SubscriptionManager, not Router
	// Router is pure infrastructure - no business logic

	describe('Error Handling', () => {
		test('should handle routing non-EVENT message gracefully', () => {
			const callMessage = createCallMessage({
				method: 'user.created',
				data: {},
				sessionId: 'session1',
			});

			// Should not throw
			expect(() => {
				router.routeEvent(callMessage);
			}).not.toThrow();
		});

		test('should handle sending to closed WebSocket gracefully', () => {
			const conn1 = createMockConnection(mockWs1);
			const clientId = router.registerConnection(conn1);
			mockWs1.close();

			const message: HubMessage = {
				id: 'msg1',
				type: MessageType.EVENT,
				method: 'test.event',
				sessionId: 'session1',
				data: {},
				timestamp: new Date().toISOString(),
			};

			// Should not throw
			expect(() => {
				router.sendToClient(clientId, message);
			}).not.toThrow();
		});
	});

	describe('Phase 1 Improvements', () => {
		describe('Duplicate Registration Prevention', () => {
			test('should return existing clientId when registering same WebSocket twice', () => {
				const conn1 = createMockConnection(mockWs1);
				const clientId1 = router.registerConnection(conn1);
				const clientId2 = router.registerConnection(conn1);

				expect(clientId1).toBe(clientId2);
				expect(router.getClientCount()).toBe(1);
			});
		});

		describe('O(1) Client Lookup', () => {
			test('should get client by clientId efficiently', () => {
				const conn1 = createMockConnection(mockWs1);
				const clientId = router.registerConnection(conn1);
				const client = router.getClientById(clientId);

				expect(client).toBeDefined();
				expect(client?.clientId).toBe(clientId);
				expect(client?.connection.metadata?.ws).toBe(mockWs1);
			});

			test('should return undefined for non-existent clientId', () => {
				const client = router.getClientById('non-existent');
				expect(client).toBeUndefined();
			});
		});

		describe('Route Result Observability', () => {
			test('should return delivery statistics from routeEvent', () => {
				const conn1 = createMockConnection(mockWs1);
				const conn2 = createMockConnection(mockWs2);
				const mockWs3 = new MockWebSocket();
				const conn3 = createMockConnection(mockWs3);
				const clientId1 = router.registerConnection(conn1);
				const clientId2 = router.registerConnection(conn2);
				const clientId3 = router.registerConnection(conn3);

				router.subscribe('session1', 'user.created', clientId1);
				router.subscribe('session1', 'user.created', clientId2);
				router.subscribe('session1', 'user.created', clientId3);

				// Close one websocket to create a failure
				mockWs3.close();

				const eventMessage = createEventMessage({
					method: 'user.created',
					data: { userId: '123' },
					sessionId: 'session1',
				});

				const result = router.routeEvent(eventMessage);

				expect(result.sent).toBe(2); // mockWs1 and mockWs2
				expect(result.failed).toBe(1); // mockWs3 is closed
				expect(result.totalSubscribers).toBe(3);
				expect(result.sessionId).toBe('session1');
				expect(result.method).toBe('user.created');
			});

			test('should return zero stats for unsubscribed event', () => {
				const conn1 = createMockConnection(mockWs1);
				router.registerConnection(conn1);

				const eventMessage = createEventMessage({
					method: 'unsubscribed.event',
					data: {},
					sessionId: 'session1',
				});

				const result = router.routeEvent(eventMessage);

				expect(result.sent).toBe(0);
				expect(result.failed).toBe(0);
				expect(result.totalSubscribers).toBe(0);
			});

			test('broadcast should return delivery statistics', () => {
				const conn1 = createMockConnection(mockWs1);
				const conn2 = createMockConnection(mockWs2);
				const mockWs3 = new MockWebSocket();
				mockWs3.close();
				const conn3 = createMockConnection(mockWs3);
				router.registerConnection(conn1);
				router.registerConnection(conn2);
				router.registerConnection(conn3);

				const message: HubMessage = {
					id: 'msg1',
					type: MessageType.EVENT,
					method: 'broadcast.event',
					sessionId: 'global',
					data: {},
					timestamp: new Date().toISOString(),
				};

				const result = router.broadcast(message);

				expect(result.sent).toBe(2); // mockWs1 and mockWs2
				expect(result.failed).toBe(1); // mockWs3 is closed
			});

			test('sendToClient should return boolean success indicator', () => {
				const conn1 = createMockConnection(mockWs1);
				const clientId = router.registerConnection(conn1);

				const message: HubMessage = {
					id: 'msg1',
					type: MessageType.EVENT,
					method: 'test.event',
					sessionId: 'session1',
					data: {},
					timestamp: new Date().toISOString(),
				};

				const success = router.sendToClient(clientId, message);
				expect(success).toBe(true);

				const failure = router.sendToClient('non-existent', message);
				expect(failure).toBe(false);
			});
		});

		describe('Memory Leak Prevention', () => {
			test('should cleanup empty subscription Maps', () => {
				const conn1 = createMockConnection(mockWs1);
				const clientId = router.registerConnection(conn1);

				router.subscribe('session1', 'user.created', clientId);
				router.subscribe('session1', 'user.updated', clientId);

				// Unsubscribe all
				router.unsubscribeClient('session1', 'user.created', clientId);
				router.unsubscribeClient('session1', 'user.updated', clientId);

				// Verify cleanup by checking subscriptions
				const subs = router.getSubscriptions();
				expect(subs.has('session1')).toBe(false);
			});

			test('should cleanup nested Maps when last method is unsubscribed', () => {
				const conn1 = createMockConnection(mockWs1);
				const conn2 = createMockConnection(mockWs2);
				const clientId1 = router.registerConnection(conn1);
				const clientId2 = router.registerConnection(conn2);

				router.subscribe('session1', 'user.created', clientId1);
				router.subscribe('session1', 'user.created', clientId2);

				// Unsubscribe first client
				router.unsubscribeClient('session1', 'user.created', clientId1);
				expect(router.getSubscriptionCount('session1', 'user.created')).toBe(1);

				// Unsubscribe second client - should cleanup Maps
				router.unsubscribeClient('session1', 'user.created', clientId2);
				expect(router.getSubscriptionCount('session1', 'user.created')).toBe(0);

				const subs = router.getSubscriptions();
				expect(subs.has('session1')).toBe(false);
			});
		});

		describe('Subscription Key Validation', () => {
			test('should reject sessionId with colon', () => {
				const conn1 = createMockConnection(mockWs1);
				const clientId = router.registerConnection(conn1);

				expect(() => {
					router.subscribe('session:1', 'user.created', clientId);
				}).toThrow('SessionId cannot contain colon character');
			});

			test('should reject method with colon', () => {
				const conn1 = createMockConnection(mockWs1);
				const clientId = router.registerConnection(conn1);

				expect(() => {
					router.subscribe('session1', 'user:created', clientId);
				}).toThrow('Method cannot contain colon character');
			});
		});

		describe('Custom Logger', () => {
			test('should use custom logger', () => {
				const mockLogger = {
					log: mock(() => {}),
					warn: mock(() => {}),
					error: mock(() => {}),
				};

				const customRouter = new MessageHubRouter({
					logger: mockLogger,
					debug: true,
				});

				const conn1 = createMockConnection(mockWs1);
				customRouter.registerConnection(conn1);

				expect(mockLogger.log).toHaveBeenCalled();
			});

			test('should not log when debug is false', () => {
				const mockLogger = {
					log: mock(() => {}),
					warn: mock(() => {}),
					error: mock(() => {}),
				};

				const customRouter = new MessageHubRouter({
					logger: mockLogger,
					debug: false,
				});

				const conn1 = createMockConnection(mockWs1);
				customRouter.registerConnection(conn1);

				// Should still call for registration (not debug log)
				// But internal debug logs should be skipped
				expect(mockLogger.log).toHaveBeenCalledTimes(0);
			});
		});

		// Configurable Auto-Subscribe tests removed - this is now application-layer logic
		// handled by SubscriptionManager, not Router

		describe('Subscription Storage', () => {
			test('should track subscriptions as Map<sessionId, Set<method>>', () => {
				const conn1 = createMockConnection(mockWs1);
				const clientId = router.registerConnection(conn1);

				router.subscribe('session1', 'user.created', clientId);
				router.subscribe('session1', 'user.updated', clientId);
				router.subscribe('session2', 'user.deleted', clientId);

				const client = router.getClientById(clientId);
				expect(client?.subscriptions.size).toBe(2); // 2 sessions
				expect(client?.subscriptions.get('session1')?.size).toBe(2); // 2 methods in session1
				expect(client?.subscriptions.get('session2')?.size).toBe(1); // 1 method in session2
			});
		});

		describe('handleMessage', () => {
			test('should handle incoming message from client (placeholder functionality)', () => {
				const conn1 = createMockConnection(mockWs1);
				const clientId = router.registerConnection(conn1);

				const message = createCallMessage({
					method: 'test.method',
					data: { foo: 'bar' },
					sessionId: 'session1',
				});

				// Should not throw - this is a placeholder method for future functionality
				expect(() => {
					router.handleMessage(message, clientId);
				}).not.toThrow();
			});
		});

		describe('getClientIds', () => {
			test('should return all connected client IDs', () => {
				const conn1 = createMockConnection(mockWs1);
				const conn2 = createMockConnection(mockWs2);
				const clientId1 = router.registerConnection(conn1);
				const clientId2 = router.registerConnection(conn2);

				const clientIds = router.getClientIds();
				expect(clientIds).toContain(clientId1);
				expect(clientIds).toContain(clientId2);
				expect(clientIds.length).toBe(2);
			});

			test('should return empty array when no clients', () => {
				const clientIds = router.getClientIds();
				expect(clientIds.length).toBe(0);
			});
		});
	});
});
