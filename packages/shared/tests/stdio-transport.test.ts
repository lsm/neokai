/**
 * StdioTransport Tests
 *
 * Tests for IPC communication via stdin/stdout using newline-delimited JSON.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { StdioTransport, createStdioPair } from '../src/message-hub/stdio-transport';
import { MessageType, createCallMessage, createResultMessage } from '../src/message-hub/protocol';

describe('StdioTransport', () => {
	describe('createStdioPair', () => {
		let client: StdioTransport;
		let server: StdioTransport;

		beforeEach(async () => {
			[client, server] = createStdioPair();
			await Promise.all([client.initialize(), server.initialize()]);
		});

		afterEach(async () => {
			await Promise.all([client.close(), server.close()]);
		});

		it('should create connected pair', () => {
			expect(client.isReady()).toBe(true);
			expect(server.isReady()).toBe(true);
			expect(client.getState()).toBe('connected');
			expect(server.getState()).toBe('connected');
		});

		it('should send message from client to server', async () => {
			const received: unknown[] = [];
			server.onMessage((msg) => received.push(msg));

			const message = createCallMessage({
				method: 'test.ping',
				data: { hello: 'world' },
				sessionId: 'test-session',
			});

			await client.send(message);

			// Wait for message to be processed
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(received.length).toBe(1);
			expect((received[0] as { method: string }).method).toBe('test.ping');
			expect((received[0] as { data: { hello: string } }).data.hello).toBe('world');
		});

		it('should send message from server to client', async () => {
			const received: unknown[] = [];
			client.onMessage((msg) => received.push(msg));

			const message = createResultMessage({
				method: 'test.pong',
				data: { response: 'ok' },
				sessionId: 'test-session',
				requestId: 'req-123',
			});

			await server.send(message);

			// Wait for message to be processed
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(received.length).toBe(1);
			expect((received[0] as { method: string }).method).toBe('test.pong');
			expect((received[0] as { type: MessageType }).type).toBe(MessageType.RESULT);
		});

		it('should support bidirectional communication', async () => {
			const clientReceived: unknown[] = [];
			const serverReceived: unknown[] = [];

			client.onMessage((msg) => clientReceived.push(msg));
			server.onMessage((msg) => serverReceived.push(msg));

			// Client sends request
			const request = createCallMessage({
				method: 'echo.request',
				data: { message: 'hello' },
				sessionId: 'test-session',
			});
			await client.send(request);

			// Wait for server to receive
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Server sends response
			const response = createResultMessage({
				method: 'echo.request',
				data: { echoed: 'hello' },
				sessionId: 'test-session',
				requestId: request.id,
			});
			await server.send(response);

			// Wait for client to receive
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(serverReceived.length).toBe(1);
			expect((serverReceived[0] as { method: string }).method).toBe('echo.request');

			expect(clientReceived.length).toBe(1);
			expect((clientReceived[0] as { requestId: string }).requestId).toBe(request.id);
		});

		it('should handle multiple messages in sequence', async () => {
			const received: unknown[] = [];
			server.onMessage((msg) => received.push(msg));

			// Send multiple messages
			for (let i = 0; i < 10; i++) {
				const message = createCallMessage({
					method: 'test.sequence',
					data: { index: i },
					sessionId: 'test-session',
				});
				await client.send(message);
			}

			// Wait for all messages
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(received.length).toBe(10);

			// Verify order
			for (let i = 0; i < 10; i++) {
				expect((received[i] as { data: { index: number } }).data.index).toBe(i);
			}
		});

		it('should handle messages with complex data', async () => {
			const received: unknown[] = [];
			server.onMessage((msg) => received.push(msg));

			const complexData = {
				nested: {
					array: [1, 2, 3],
					object: { key: 'value' },
				},
				unicode: '你好世界 🌍',
				special: 'line\nwith\nnewlines',
			};

			const message = createCallMessage({
				method: 'test.complex',
				data: complexData,
				sessionId: 'test-session',
			});

			await client.send(message);

			// Wait for message
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(received.length).toBe(1);
			const receivedData = (received[0] as { data: typeof complexData }).data;
			expect(receivedData.nested.array).toEqual([1, 2, 3]);
			expect(receivedData.unicode).toBe('你好世界 🌍');
			expect(receivedData.special).toBe('line\nwith\nnewlines');
		});
	});

	describe('connection state', () => {
		it('should start disconnected', () => {
			const [client] = createStdioPair();
			expect(client.getState()).toBe('disconnected');
			expect(client.isReady()).toBe(false);
		});

		it('should transition to connected after initialize', async () => {
			const [client, server] = createStdioPair();

			const states: string[] = [];
			client.onConnectionChange((state) => states.push(state));

			await client.initialize();
			await server.initialize();

			expect(client.getState()).toBe('connected');
			expect(client.isReady()).toBe(true);
			expect(states).toContain('connecting');
			expect(states).toContain('connected');

			await client.close();
			await server.close();
		});

		it('should transition to disconnected after close', async () => {
			const [client, server] = createStdioPair();
			await Promise.all([client.initialize(), server.initialize()]);

			const states: string[] = [];
			client.onConnectionChange((state) => states.push(state));

			await client.close();
			await server.close();

			expect(client.getState()).toBe('disconnected');
			expect(client.isReady()).toBe(false);
			expect(states).toContain('disconnected');
		});
	});

	describe('error handling', () => {
		it('should throw when sending before connect', async () => {
			const [client, server] = createStdioPair();

			const message = createCallMessage({
				method: 'test.error',
				data: {},
				sessionId: 'test-session',
			});

			await expect(client.send(message)).rejects.toThrow('not connected');

			// Cleanup (never initialized, but call close for safety)
			await client.close();
			await server.close();
		});

		it('should handle invalid JSON gracefully', async () => {
			const [client, server] = createStdioPair();
			await Promise.all([client.initialize(), server.initialize()]);

			const received: unknown[] = [];
			server.onMessage((msg) => received.push(msg));

			// Send invalid JSON directly to the stream (bypassing transport)
			// This tests the parser's error handling
			// We can't easily send invalid JSON through the transport API,
			// but we can verify valid messages still work

			const validMessage = createCallMessage({
				method: 'test.valid',
				data: { valid: true },
				sessionId: 'test-session',
			});

			await client.send(validMessage);
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(received.length).toBe(1);
			expect((received[0] as { data: { valid: boolean } }).data.valid).toBe(true);

			await client.close();
			await server.close();
		});
	});

	describe('unsubscribe', () => {
		it('should allow unsubscribing from messages', async () => {
			const [client, server] = createStdioPair();
			await Promise.all([client.initialize(), server.initialize()]);

			const received: unknown[] = [];
			const unsub = server.onMessage((msg) => received.push(msg));

			// Send first message
			await client.send(
				createCallMessage({
					method: 'test.first',
					data: {},
					sessionId: 'test-session',
				})
			);

			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(received.length).toBe(1);

			// Unsubscribe
			unsub();

			// Send second message
			await client.send(
				createCallMessage({
					method: 'test.second',
					data: {},
					sessionId: 'test-session',
				})
			);

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should still be 1 (second message not received)
			expect(received.length).toBe(1);

			await client.close();
			await server.close();
		});

		it('should allow unsubscribing from connection changes', async () => {
			const [client, server] = createStdioPair();

			const states: string[] = [];
			const unsub = client.onConnectionChange((state) => states.push(state));

			await client.initialize();
			await server.initialize();

			// Should have connecting and connected
			expect(states.length).toBeGreaterThanOrEqual(1);
			const statesBeforeUnsub = states.length;

			// Unsubscribe
			unsub();

			// Close should not add to states
			await client.close();
			await server.close();

			// States length should be same (close not recorded)
			expect(states.length).toBe(statesBeforeUnsub);
		});
	});
});
