/**
 * UnixSocketTransport Tests
 *
 * Tests for IPC communication via Unix domain sockets using newline-delimited JSON.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { UnixSocketTransport, getDaemonSocketPath } from '../src/message-hub/unix-socket-transport';
import {
	MessageType,
	createCallMessage,
	createResultMessage,
	createEventMessage,
} from '../src/message-hub/protocol';
import * as fs from 'node:fs';

describe('UnixSocketTransport', () => {
	describe('constructor', () => {
		it('should create transport with required options', () => {
			const transport = new UnixSocketTransport({
				socketPath: '/tmp/test.sock',
				mode: 'server',
			});

			expect(transport.name).toBe('unix-socket');
			expect(transport.getState()).toBe('disconnected');
			expect(transport.isReady()).toBe(false);
		});

		it('should accept custom name', () => {
			const transport = new UnixSocketTransport({
				name: 'custom-socket',
				socketPath: '/tmp/test.sock',
				mode: 'client',
			});

			expect(transport.name).toBe('custom-socket');
		});

		it('should accept debug option', () => {
			const transport = new UnixSocketTransport({
				socketPath: '/tmp/test.sock',
				mode: 'server',
				debug: true,
			});

			expect(transport).toBeDefined();
		});

		it('should accept server mode', () => {
			const transport = new UnixSocketTransport({
				socketPath: '/tmp/test.sock',
				mode: 'server',
			});

			expect(transport).toBeDefined();
		});

		it('should accept client mode', () => {
			const transport = new UnixSocketTransport({
				socketPath: '/tmp/test.sock',
				mode: 'client',
			});

			expect(transport).toBeDefined();
		});
	});

	describe('connection state', () => {
		it('should start disconnected', () => {
			const transport = new UnixSocketTransport({
				socketPath: '/tmp/test.sock',
				mode: 'server',
			});

			expect(transport.getState()).toBe('disconnected');
			expect(transport.isReady()).toBe(false);
		});

		it('should notify connection state changes', async () => {
			const transport = new UnixSocketTransport({
				socketPath: '/tmp/test-notify.sock',
				mode: 'server',
			});

			const states: string[] = [];
			transport.onConnectionChange((state) => states.push(state));

			// Initialize will transition to connecting then connected
			await transport.initialize();

			expect(states).toContain('connecting');
			expect(states).toContain('connected');

			await transport.close();
		});

		it('should allow unsubscribing from connection changes', async () => {
			const transport = new UnixSocketTransport({
				socketPath: '/tmp/test-unsub.sock',
				mode: 'server',
			});

			const states: string[] = [];
			const unsub = transport.onConnectionChange((state) => states.push(state));

			// Unsubscribe immediately
			unsub();

			// Initialize - should not record states
			await transport.initialize();

			expect(states.length).toBe(0);

			await transport.close();
		});
	});

	describe('server mode', () => {
		const socketPath = '/tmp/liuboer-test-server.sock';
		let transport: UnixSocketTransport;

		beforeEach(() => {
			// Clean up any existing socket
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// Ignore if doesn't exist
			}
		});

		afterEach(async () => {
			if (transport) {
				await transport.close();
			}
			// Clean up socket file
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// Ignore
			}
		});

		it('should create socket file when initialized', async () => {
			transport = new UnixSocketTransport({
				socketPath,
				mode: 'server',
			});

			await transport.initialize();

			expect(transport.isReady()).toBe(true);
			expect(transport.getState()).toBe('connected');

			// Check socket file exists
			expect(fs.existsSync(socketPath)).toBe(true);
		});

		it('should remove existing socket file before creating new one', async () => {
			// Create a file at the socket path
			fs.writeFileSync(socketPath, 'dummy');
			expect(fs.existsSync(socketPath)).toBe(true);

			transport = new UnixSocketTransport({
				socketPath,
				mode: 'server',
			});

			await transport.initialize();

			expect(transport.isReady()).toBe(true);
		});

		it('should clean up socket file on close', async () => {
			transport = new UnixSocketTransport({
				socketPath,
				mode: 'server',
			});

			await transport.initialize();
			expect(fs.existsSync(socketPath)).toBe(true);

			await transport.close();
			expect(fs.existsSync(socketPath)).toBe(false);
		});

		it('should throw when sending without client connection', async () => {
			transport = new UnixSocketTransport({
				socketPath,
				mode: 'server',
			});

			await transport.initialize();

			const message = createCallMessage({
				method: 'test.method',
				data: {},
				sessionId: 'test-session',
			});

			// Server is ready but has no connected client
			await expect(transport.send(message)).rejects.toThrow();
		});
	});

	describe('client mode', () => {
		it('should fail to connect to non-existent socket', async () => {
			const transport = new UnixSocketTransport({
				socketPath: '/tmp/liuboer-nonexistent-test.sock',
				mode: 'client',
			});

			// Should reject when socket doesn't exist
			await expect(transport.initialize()).rejects.toThrow();
		});

		it('should throw when sending before connect', async () => {
			const transport = new UnixSocketTransport({
				socketPath: '/tmp/test.sock',
				mode: 'client',
			});

			const message = createCallMessage({
				method: 'test.method',
				data: {},
				sessionId: 'test-session',
			});

			await expect(transport.send(message)).rejects.toThrow('not connected');
		});
	});

	describe('server-client communication', () => {
		const socketPath = '/tmp/liuboer-test-comm.sock';
		let server: UnixSocketTransport;
		let client: UnixSocketTransport;

		beforeEach(async () => {
			// Clean up
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// Ignore
			}

			// Create and initialize server
			server = new UnixSocketTransport({
				name: 'test-server',
				socketPath,
				mode: 'server',
			});
			await server.initialize();

			// Create and initialize client
			client = new UnixSocketTransport({
				name: 'test-client',
				socketPath,
				mode: 'client',
			});
			await client.initialize();
		});

		afterEach(async () => {
			await client?.close();
			await server?.close();
		});

		it('should connect client to server', () => {
			expect(server.isReady()).toBe(true);
			expect(client.isReady()).toBe(true);
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

		it('should handle EVENT messages', async () => {
			const received: unknown[] = [];
			client.onMessage((msg) => received.push(msg));

			const event = createEventMessage({
				method: 'state.changed',
				data: { status: 'updated' },
				sessionId: 'test-session',
			});

			await server.send(event);
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(received.length).toBe(1);
			expect((received[0] as { type: MessageType }).type).toBe(MessageType.EVENT);
			expect((received[0] as { method: string }).method).toBe('state.changed');
		});
	});

	describe('unsubscribe', () => {
		const socketPath = '/tmp/liuboer-test-unsub.sock';

		it('should allow unsubscribing from messages', async () => {
			// Clean up
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// Ignore
			}

			const server = new UnixSocketTransport({
				socketPath,
				mode: 'server',
			});
			await server.initialize();

			const client = new UnixSocketTransport({
				socketPath,
				mode: 'client',
			});
			await client.initialize();

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
	});
});

describe('getDaemonSocketPath', () => {
	it('should generate correct path for yuanshen', () => {
		const path = getDaemonSocketPath('yuanshen');
		expect(path).toMatch(/liuboer-yuanshen\.sock$/);
	});

	it('should generate correct path for shishen', () => {
		const path = getDaemonSocketPath('shishen');
		expect(path).toMatch(/liuboer-shishen\.sock$/);
	});

	it('should use TMPDIR if available', () => {
		const originalTmpdir = process.env.TMPDIR;

		// Set custom TMPDIR
		process.env.TMPDIR = '/custom/tmp';
		const path = getDaemonSocketPath('test');
		expect(path).toBe('/custom/tmp/liuboer-test.sock');

		// Restore
		if (originalTmpdir) {
			process.env.TMPDIR = originalTmpdir;
		} else {
			delete process.env.TMPDIR;
		}
	});

	it('should use /tmp as fallback', () => {
		const originalTmpdir = process.env.TMPDIR;

		// Remove TMPDIR
		delete process.env.TMPDIR;
		const path = getDaemonSocketPath('test');
		expect(path).toBe('/tmp/liuboer-test.sock');

		// Restore
		if (originalTmpdir) {
			process.env.TMPDIR = originalTmpdir;
		}
	});

	it('should handle daemon names with special characters', () => {
		const path = getDaemonSocketPath('my-daemon');
		expect(path).toMatch(/liuboer-my-daemon\.sock$/);
	});

	it('should generate unique paths for different daemons', () => {
		const path1 = getDaemonSocketPath('daemon1');
		const path2 = getDaemonSocketPath('daemon2');

		expect(path1).not.toBe(path2);
	});
});
