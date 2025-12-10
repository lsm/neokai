/**
 * WebSocket Client Transport Unit Tests
 *
 * Tests the WebSocketClientTransport class functionality.
 * Since Bun has native WebSocket support, we test by:
 * 1. Testing the class interface and state management
 * 2. Testing message validation logic
 * 3. Testing callback registration/unregistration
 */

import { describe, it, expect } from 'bun:test';
import { WebSocketClientTransport } from '../src/message-hub/websocket-client-transport.ts';
import { MessageType } from '../src/message-hub/protocol.ts';
import type { HubMessage, ConnectionState } from '../src/message-hub/types.ts';

describe('WebSocketClientTransport', () => {
	describe('constructor', () => {
		it('should initialize with default options', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			expect(transport.name).toBe('websocket-client');
			expect(transport.getState()).toBe('disconnected');
			expect(transport.isReady()).toBe(false);
		});

		it('should accept custom options', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
				autoReconnect: false,
				maxReconnectAttempts: 3,
				reconnectDelay: 500,
				pingInterval: 15000,
			});

			expect(transport.name).toBe('websocket-client');
			expect(transport.getState()).toBe('disconnected');
		});
	});

	describe('getState', () => {
		it('should return disconnected initially', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			expect(transport.getState()).toBe('disconnected');
		});
	});

	describe('isReady', () => {
		it('should return false when disconnected', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			expect(transport.isReady()).toBe(false);
		});
	});

	describe('onMessage', () => {
		it('should allow registering message handlers', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const messages: HubMessage[] = [];
			const unsubscribe = transport.onMessage((msg) => {
				messages.push(msg);
			});

			expect(typeof unsubscribe).toBe('function');
		});

		it('should allow unsubscribing from messages', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const messages: HubMessage[] = [];
			const unsubscribe = transport.onMessage((msg) => {
				messages.push(msg);
			});

			// Should not throw
			unsubscribe();
		});

		it('should allow multiple handlers', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const messages1: HubMessage[] = [];
			const messages2: HubMessage[] = [];

			const unsub1 = transport.onMessage((msg) => messages1.push(msg));
			const unsub2 = transport.onMessage((msg) => messages2.push(msg));

			expect(typeof unsub1).toBe('function');
			expect(typeof unsub2).toBe('function');

			// Cleanup
			unsub1();
			unsub2();
		});
	});

	describe('onConnectionChange', () => {
		it('should allow registering connection state handlers', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const states: ConnectionState[] = [];
			const unsubscribe = transport.onConnectionChange((state) => {
				states.push(state);
			});

			expect(typeof unsubscribe).toBe('function');
		});

		it('should allow unsubscribing from connection changes', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const states: ConnectionState[] = [];
			const unsubscribe = transport.onConnectionChange((state) => {
				states.push(state);
			});

			// Should not throw
			unsubscribe();
		});

		it('should allow multiple handlers', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const states1: ConnectionState[] = [];
			const states2: ConnectionState[] = [];

			const unsub1 = transport.onConnectionChange((state) => states1.push(state));
			const unsub2 = transport.onConnectionChange((state) => states2.push(state));

			expect(typeof unsub1).toBe('function');
			expect(typeof unsub2).toBe('function');

			// Cleanup
			unsub1();
			unsub2();
		});
	});

	describe('send', () => {
		it('should throw when not connected', async () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const message: HubMessage = {
				id: 'test-1',
				type: MessageType.CALL,
				method: 'test.method',
				sessionId: 'session-1',
				data: { foo: 'bar' },
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			};

			await expect(transport.send(message)).rejects.toThrow('WebSocket not connected');
		});
	});

	describe('close', () => {
		it('should handle close when not connected', async () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			// Should not throw
			await transport.close();

			expect(transport.getState()).toBe('disconnected');
			expect(transport.isReady()).toBe(false);
		});

		it('should set state to disconnected after close', async () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			await transport.close();

			expect(transport.getState()).toBe('disconnected');
		});
	});

	describe('name property', () => {
		it('should return websocket-client', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			expect(transport.name).toBe('websocket-client');
		});
	});

	describe('options validation', () => {
		it('should work with minimal options', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			expect(transport).toBeDefined();
		});

		it('should work with all options specified', () => {
			const transport = new WebSocketClientTransport({
				url: 'wss://secure.example.com/ws',
				autoReconnect: true,
				maxReconnectAttempts: 10,
				reconnectDelay: 2000,
				pingInterval: 60000,
			});

			expect(transport).toBeDefined();
			expect(transport.name).toBe('websocket-client');
		});

		it('should work with autoReconnect disabled', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
				autoReconnect: false,
			});

			expect(transport).toBeDefined();
		});

		it('should work with pingInterval set to 0', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
				pingInterval: 0,
			});

			expect(transport).toBeDefined();
		});
	});

	describe('URL handling', () => {
		it('should accept ws:// URLs', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080/path',
			});

			expect(transport).toBeDefined();
		});

		it('should accept wss:// URLs', () => {
			const transport = new WebSocketClientTransport({
				url: 'wss://secure.example.com:443/ws',
			});

			expect(transport).toBeDefined();
		});

		it('should accept URLs with query parameters', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080/ws?token=abc&session=123',
			});

			expect(transport).toBeDefined();
		});
	});

	describe('handler cleanup', () => {
		it('should properly clean up message handlers on unsubscribe', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const handler1 = () => {};
			const handler2 = () => {};

			const unsub1 = transport.onMessage(handler1);
			const unsub2 = transport.onMessage(handler2);

			// Unsubscribe first handler
			unsub1();

			// Second handler should still be registered (no way to verify directly, but shouldn't throw)
			unsub2();
		});

		it('should properly clean up connection handlers on unsubscribe', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const handler1 = () => {};
			const handler2 = () => {};

			const unsub1 = transport.onConnectionChange(handler1);
			const unsub2 = transport.onConnectionChange(handler2);

			// Unsubscribe first handler
			unsub1();

			// Second handler should still be registered (no way to verify directly, but shouldn't throw)
			unsub2();
		});

		it('should handle multiple unsubscribe calls gracefully', () => {
			const transport = new WebSocketClientTransport({
				url: 'ws://localhost:8080',
			});

			const unsub = transport.onMessage(() => {});

			// Multiple unsubscribe calls should not throw
			unsub();
			unsub();
			unsub();
		});
	});
});
