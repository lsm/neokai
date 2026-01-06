/**
 * InProcessTransport Unit Tests
 *
 * Tests for in-process MessageHub transport that enables
 * component communication within the same process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MessageHub } from '../src/message-hub/message-hub.ts';
import {
	InProcessTransport,
	InProcessTransportBus,
} from '../src/message-hub/in-process-transport.ts';
import { MessageType, type HubMessage } from '../src/message-hub/protocol.ts';

describe('InProcessTransport', () => {
	describe('createPair', () => {
		it('should create a connected pair of transports', async () => {
			const [client, server] = InProcessTransport.createPair();

			await client.initialize();
			await server.initialize();

			expect(client.isReady()).toBe(true);
			expect(server.isReady()).toBe(true);
			expect(client.getState()).toBe('connected');
			expect(server.getState()).toBe('connected');
		});

		it('should deliver messages from client to server', async () => {
			const [client, server] = InProcessTransport.createPair();
			await client.initialize();

			const receivedMessages: HubMessage[] = [];
			server.onMessage((msg) => receivedMessages.push(msg));

			const testMessage: HubMessage = {
				id: 'test-1',
				type: MessageType.CALL,
				method: 'test.method',
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				data: { foo: 'bar' },
			};

			await client.send(testMessage);

			// Wait for microtask
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedMessages.length).toBe(1);
			expect(receivedMessages[0].id).toBe('test-1');
			expect(receivedMessages[0].data).toEqual({ foo: 'bar' });
		});

		it('should deliver messages from server to client', async () => {
			const [client, server] = InProcessTransport.createPair();
			await client.initialize();

			const receivedMessages: HubMessage[] = [];
			client.onMessage((msg) => receivedMessages.push(msg));

			const testMessage: HubMessage = {
				id: 'test-2',
				type: MessageType.EVENT,
				method: 'test.event',
				sessionId: 'session-123',
				timestamp: new Date().toISOString(),
				data: { hello: 'world' },
			};

			await server.send(testMessage);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedMessages.length).toBe(1);
			expect(receivedMessages[0].method).toBe('test.event');
		});

		it('should support bidirectional communication', async () => {
			const [client, server] = InProcessTransport.createPair();
			await client.initialize();

			const clientReceived: HubMessage[] = [];
			const serverReceived: HubMessage[] = [];

			client.onMessage((msg) => clientReceived.push(msg));
			server.onMessage((msg) => serverReceived.push(msg));

			// Client -> Server
			await client.send({
				id: 'c2s',
				type: MessageType.CALL,
				method: 'client.to.server',
				sessionId: 'global',
				timestamp: new Date().toISOString(),
			});

			// Server -> Client
			await server.send({
				id: 's2c',
				type: MessageType.EVENT,
				method: 'server.to.client',
				sessionId: 'global',
				timestamp: new Date().toISOString(),
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(serverReceived.length).toBe(1);
			expect(serverReceived[0].id).toBe('c2s');
			expect(clientReceived.length).toBe(1);
			expect(clientReceived[0].id).toBe('s2c');
		});

		it('should handle close and notify peer', async () => {
			const [client, server] = InProcessTransport.createPair();
			await client.initialize();

			let disconnectedClientId: string | null = null;
			server.onClientDisconnect((clientId) => {
				disconnectedClientId = clientId;
			});

			await client.close();

			expect(client.isReady()).toBe(false);
			expect(client.getState()).toBe('disconnected');
			expect(disconnectedClientId).toBe(client.getClientId());
		});

		it('should notify connection state handlers', async () => {
			const [client, server] = InProcessTransport.createPair();

			const clientStates: string[] = [];
			client.onConnectionChange((state) => clientStates.push(state));

			await client.initialize();
			await client.close();

			expect(clientStates).toContain('connected');
			expect(clientStates).toContain('disconnected');
		});
	});

	describe('cloneMessages option', () => {
		it('should pass messages by reference when cloneMessages=false', async () => {
			const [client, server] = InProcessTransport.createPair({ cloneMessages: false });
			await client.initialize();

			let receivedMsg: HubMessage | null = null;
			server.onMessage((msg) => {
				receivedMsg = msg;
			});

			const sentData = { mutable: true };
			const testMessage: HubMessage = {
				id: 'ref-test',
				type: MessageType.CALL,
				method: 'test.ref',
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				data: sentData,
			};

			await client.send(testMessage);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Same reference
			expect(receivedMsg!.data).toBe(sentData);
		});

		it('should clone messages when cloneMessages=true', async () => {
			const [client, server] = InProcessTransport.createPair({ cloneMessages: true });
			await client.initialize();

			let receivedMsg: HubMessage | null = null;
			server.onMessage((msg) => {
				receivedMsg = msg;
			});

			const sentData = { mutable: true };
			const testMessage: HubMessage = {
				id: 'clone-test',
				type: MessageType.CALL,
				method: 'test.clone',
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				data: sentData,
			};

			await client.send(testMessage);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Different reference but same content
			expect(receivedMsg!.data).not.toBe(sentData);
			expect(receivedMsg!.data).toEqual(sentData);
		});
	});

	describe('simulatedLatency option', () => {
		it('should delay message delivery when latency is set', async () => {
			const latencyMs = 50;
			const [client, server] = InProcessTransport.createPair({ simulatedLatency: latencyMs });
			await client.initialize();

			let receivedAt = 0;
			server.onMessage(() => {
				receivedAt = Date.now();
			});

			const sentAt = Date.now();
			await client.send({
				id: 'latency-test',
				type: MessageType.CALL,
				method: 'test.latency',
				sessionId: 'global',
				timestamp: new Date().toISOString(),
			});

			// Wait for message
			await new Promise((resolve) => setTimeout(resolve, latencyMs + 20));

			const actualLatency = receivedAt - sentAt;
			expect(actualLatency).toBeGreaterThanOrEqual(latencyMs - 5); // Allow small tolerance
		});
	});

	describe('error handling', () => {
		it('should throw when sending on uninitialized transport', async () => {
			const transport = new InProcessTransport();

			await expect(
				transport.send({
					id: 'error-test',
					type: MessageType.CALL,
					method: 'test.error',
					sessionId: 'global',
					timestamp: new Date().toISOString(),
				})
			).rejects.toThrow('not connected');
		});

		it('should throw when initializing unpaired transport', async () => {
			const transport = new InProcessTransport();
			await expect(transport.initialize()).rejects.toThrow('not paired');
		});
	});
});

describe('InProcessTransportBus', () => {
	let bus: InProcessTransportBus;

	beforeEach(() => {
		bus = new InProcessTransportBus();
	});

	afterEach(async () => {
		await bus.close();
	});

	it('should create named transports', async () => {
		const t1 = bus.createTransport('component-1');
		const t2 = bus.createTransport('component-2');

		await t1.initialize();
		await t2.initialize();

		expect(t1.name).toBe('component-1');
		expect(t2.name).toBe('component-2');
		expect(bus.getTransportNames()).toContain('component-1');
		expect(bus.getTransportNames()).toContain('component-2');
	});

	it('should throw on duplicate transport names', () => {
		bus.createTransport('unique-name');
		expect(() => bus.createTransport('unique-name')).toThrow('already exists');
	});

	it('should broadcast messages to all other transports', async () => {
		const t1 = bus.createTransport('sender');
		const t2 = bus.createTransport('receiver-1');
		const t3 = bus.createTransport('receiver-2');

		await t1.initialize();
		await t2.initialize();
		await t3.initialize();

		const t2Received: HubMessage[] = [];
		const t3Received: HubMessage[] = [];

		t2.onMessage((msg) => t2Received.push(msg));
		t3.onMessage((msg) => t3Received.push(msg));

		await t1.send({
			id: 'broadcast-test',
			type: MessageType.EVENT,
			method: 'test.broadcast',
			sessionId: 'global',
			timestamp: new Date().toISOString(),
			data: { from: 'sender' },
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Both receivers should get the message
		expect(t2Received.length).toBe(1);
		expect(t3Received.length).toBe(1);
		expect(t2Received[0].id).toBe('broadcast-test');
		expect(t3Received[0].id).toBe('broadcast-test');
	});

	it('should not receive own messages', async () => {
		const t1 = bus.createTransport('self-test');
		await t1.initialize();

		const received: HubMessage[] = [];
		t1.onMessage((msg) => received.push(msg));

		await t1.send({
			id: 'self-msg',
			type: MessageType.EVENT,
			method: 'test.self',
			sessionId: 'global',
			timestamp: new Date().toISOString(),
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Sender should not receive its own message
		expect(received.length).toBe(0);
	});

	it('should remove transports correctly', async () => {
		const t1 = bus.createTransport('to-remove');
		await t1.initialize();

		bus.removeTransport('to-remove');

		expect(bus.getTransportNames()).not.toContain('to-remove');
		expect(bus.getTransport('to-remove')).toBeUndefined();
	});
});

describe('MessageHub with InProcessTransport', () => {
	it('should support full RPC via in-process transport', async () => {
		const [clientTransport, serverTransport] = InProcessTransport.createPair();

		const clientHub = new MessageHub({ defaultSessionId: 'global' });
		const serverHub = new MessageHub({ defaultSessionId: 'global' });

		clientHub.registerTransport(clientTransport);
		serverHub.registerTransport(serverTransport);

		await clientTransport.initialize();

		// Server handles RPC
		serverHub.handle('math.add', async (data: { a: number; b: number }) => {
			return { result: data.a + data.b };
		});

		// Client calls server
		const response = await clientHub.call<{ result: number }>('math.add', { a: 5, b: 3 });

		expect(response.result).toBe(8);

		await clientTransport.close();
		await serverTransport.close();
	});

	it('should support pub/sub via in-process transport (optimistic)', async () => {
		const [clientTransport, serverTransport] = InProcessTransport.createPair();

		const clientHub = new MessageHub({ defaultSessionId: 'global' });
		const serverHub = new MessageHub({ defaultSessionId: 'global' });

		clientHub.registerTransport(clientTransport);
		serverHub.registerTransport(serverTransport);

		await clientTransport.initialize();

		const receivedEvents: unknown[] = [];

		// Client subscribes (optimistic - doesn't wait for ACK)
		// Note: For full subscribe() with ACK, server needs MessageHubRouter
		clientHub.subscribeOptimistic(
			'session.created',
			(data) => {
				receivedEvents.push(data);
			},
			{ sessionId: 'global' }
		);

		// Server publishes directly to client transport
		// (In real setup, server would use MessageHub.publish which routes via Router)
		await serverTransport.send({
			id: 'event-1',
			type: MessageType.EVENT,
			method: 'session.created',
			sessionId: 'global',
			timestamp: new Date().toISOString(),
			data: { sessionId: 'new-session' },
		});

		// Wait for event delivery
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(receivedEvents.length).toBe(1);
		expect((receivedEvents[0] as { sessionId: string }).sessionId).toBe('new-session');

		await clientTransport.close();
		await serverTransport.close();
	});
});
