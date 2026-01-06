/**
 * IPC Socket Integration Tests
 *
 * Tests for IPC socket initialization and communication between
 * the daemon server and yuanshen orchestrator.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { UnixSocketTransport } from '@liuboer/shared';
import { existsSync, unlinkSync } from 'fs';
import type { HubMessage } from '@liuboer/shared/message-hub/protocol';

describe('IPC Socket Integration', () => {
	const testSocketPath = `/tmp/liuboer-test-${Date.now()}.sock`;

	afterEach(async () => {
		// Clean up socket file
		if (existsSync(testSocketPath)) {
			try {
				unlinkSync(testSocketPath);
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	test('server transport initializes on socket path', async () => {
		const transport = new UnixSocketTransport({
			name: 'test-server',
			socketPath: testSocketPath,
			mode: 'server',
			debug: false,
		});

		await transport.initialize();

		expect(transport.isReady()).toBe(true);
		expect(existsSync(testSocketPath)).toBe(true);

		await transport.close();
	});

	test('server transport can receive messages from client', async () => {
		const server = new UnixSocketTransport({
			name: 'test-server',
			socketPath: testSocketPath,
			mode: 'server',
			debug: false,
		});

		await server.initialize();

		// Collect received messages
		const receivedMessages: HubMessage[] = [];
		server.onMessage((msg) => {
			receivedMessages.push(msg);
		});

		// Create client and connect
		const client = new UnixSocketTransport({
			name: 'test-client',
			socketPath: testSocketPath,
			mode: 'client',
			debug: false,
		});

		await client.initialize();

		// Send a test message
		const testMessage: HubMessage = {
			id: 'test-1',
			type: 'EVENT',
			sessionId: 'session-1',
			method: 'test.event',
			timestamp: new Date().toISOString(),
			data: { key: 'value' },
		};

		await client.send(testMessage);

		// Wait a bit for message to be received
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(receivedMessages.length).toBeGreaterThanOrEqual(1);

		const received = receivedMessages.find((m) => m.id === 'test-1');
		expect(received).toBeDefined();
		expect(received?.type).toBe('EVENT');
		expect(received?.method).toBe('test.event');

		await client.close();
		await server.close();
	});

	test('server transport handles EVENT messages', async () => {
		const server = new UnixSocketTransport({
			name: 'test-server',
			socketPath: testSocketPath,
			mode: 'server',
			debug: false,
		});

		await server.initialize();

		const eventMessages: HubMessage[] = [];
		server.onMessage((msg) => {
			if (msg.type === 'EVENT') {
				eventMessages.push(msg);
			}
		});

		const client = new UnixSocketTransport({
			name: 'test-client',
			socketPath: testSocketPath,
			mode: 'client',
			debug: false,
		});

		await client.initialize();

		// Send an EVENT message (like yuanshen would)
		await client.send({
			id: 'evt-1',
			type: 'EVENT',
			sessionId: 'global',
			method: 'state.update',
			timestamp: new Date().toISOString(),
			data: { state: 'ready' },
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(eventMessages.length).toBe(1);
		expect(eventMessages[0].method).toBe('state.update');

		await client.close();
		await server.close();
	});

	test('server transport handles CALL messages', async () => {
		const server = new UnixSocketTransport({
			name: 'test-server',
			socketPath: testSocketPath,
			mode: 'server',
			debug: false,
		});

		await server.initialize();

		const callMessages: HubMessage[] = [];
		server.onMessage((msg) => {
			if (msg.type === 'CALL') {
				callMessages.push(msg);
			}
		});

		const client = new UnixSocketTransport({
			name: 'test-client',
			socketPath: testSocketPath,
			mode: 'client',
			debug: false,
		});

		await client.initialize();

		// Send a CALL message (RPC request)
		await client.send({
			id: 'call-1',
			type: 'CALL',
			sessionId: 'global',
			method: 'session.create',
			timestamp: new Date().toISOString(),
			data: { workspacePath: '/test/workspace' },
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(callMessages.length).toBe(1);
		expect(callMessages[0].method).toBe('session.create');

		await client.close();
		await server.close();
	});

	test('server can send messages back to client', async () => {
		const server = new UnixSocketTransport({
			name: 'test-server',
			socketPath: testSocketPath,
			mode: 'server',
			debug: false,
		});

		await server.initialize();

		const client = new UnixSocketTransport({
			name: 'test-client',
			socketPath: testSocketPath,
			mode: 'client',
			debug: false,
		});

		const clientReceived: HubMessage[] = [];
		client.onMessage((msg) => {
			clientReceived.push(msg);
		});

		await client.initialize();

		// Wait for connection to be established
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Server sends a message
		await server.send({
			id: 'server-msg-1',
			type: 'EVENT',
			sessionId: 'global',
			method: 'server.ready',
			timestamp: new Date().toISOString(),
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(clientReceived.length).toBeGreaterThanOrEqual(1);
		expect(clientReceived.some((m) => m.method === 'server.ready')).toBe(true);

		await client.close();
		await server.close();
	});

	test('multiple clients can connect to same server', async () => {
		const server = new UnixSocketTransport({
			name: 'test-server',
			socketPath: testSocketPath,
			mode: 'server',
			debug: false,
		});

		await server.initialize();

		const serverReceived: HubMessage[] = [];
		server.onMessage((msg) => {
			serverReceived.push(msg);
		});

		const client1 = new UnixSocketTransport({
			name: 'test-client-1',
			socketPath: testSocketPath,
			mode: 'client',
			debug: false,
		});

		const client2 = new UnixSocketTransport({
			name: 'test-client-2',
			socketPath: testSocketPath,
			mode: 'client',
			debug: false,
		});

		await client1.initialize();
		await client2.initialize();

		// Both clients send messages
		await client1.send({
			id: 'client1-msg',
			type: 'EVENT',
			sessionId: 'sess-1',
			method: 'from.client1',
			timestamp: new Date().toISOString(),
		});

		await client2.send({
			id: 'client2-msg',
			type: 'EVENT',
			sessionId: 'sess-2',
			method: 'from.client2',
			timestamp: new Date().toISOString(),
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(serverReceived.length).toBe(2);
		expect(serverReceived.some((m) => m.method === 'from.client1')).toBe(true);
		expect(serverReceived.some((m) => m.method === 'from.client2')).toBe(true);

		await client1.close();
		await client2.close();
		await server.close();
	});
});
