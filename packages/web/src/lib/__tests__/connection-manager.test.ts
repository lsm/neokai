/**
 * Tests for Connection Manager
 *
 * Tests the non-blocking access patterns and event-driven connection handling.
 */

import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { ConnectionManager } from '../connection-manager';
import { ConnectionNotReadyError, ConnectionTimeoutError } from '../errors';

// Mock the imports
const mockMessageHub = {
	isConnected: mock(() => false),
	onConnection: mock((_callback: (state: string) => void) => () => {}),
	registerTransport: mock(() => {}),
	call: mock(() => Promise.resolve({})),
};

const mockTransport = {
	isReady: mock(() => false),
	initialize: mock(() => Promise.resolve()),
	close: mock(() => {}),
};

// Mock the modules
mock.module('@liuboer/shared', () => ({
	MessageHub: class MockMessageHub {
		isConnected = mockMessageHub.isConnected;
		onConnection = mockMessageHub.onConnection;
		registerTransport = mockMessageHub.registerTransport;
		call = mockMessageHub.call;
	},
	WebSocketClientTransport: class MockWebSocketClientTransport {
		isReady = mockTransport.isReady;
		initialize = mockTransport.initialize;
		close = mockTransport.close;
	},
}));

describe('ConnectionManager', () => {
	let connectionManager: ConnectionManager;

	beforeEach(() => {
		// Reset mocks
		mockMessageHub.isConnected.mockReset();
		mockMessageHub.onConnection.mockReset();
		mockTransport.isReady.mockReset();

		// Default: not connected
		mockMessageHub.isConnected.mockReturnValue(false);
		mockTransport.isReady.mockReturnValue(false);

		connectionManager = new ConnectionManager('ws://localhost:9283');
	});

	afterEach(async () => {
		await connectionManager.disconnect();
	});

	describe('getHubIfConnected', () => {
		it('should return null when not connected', () => {
			const hub = connectionManager.getHubIfConnected();
			expect(hub).toBeNull();
		});

		it('should return null when transport is not ready', async () => {
			// Simulate partial connection (hub exists but transport not ready)
			mockMessageHub.isConnected.mockReturnValue(true);
			mockTransport.isReady.mockReturnValue(false);

			const hub = connectionManager.getHubIfConnected();
			expect(hub).toBeNull();
		});

		it('should return hub when fully connected', async () => {
			// Simulate full connection
			mockMessageHub.isConnected.mockReturnValue(true);
			mockTransport.isReady.mockReturnValue(true);

			// Need to trigger connect first to create the hub
			mockMessageHub.onConnection.mockImplementation((callback: Function) => {
				// Immediately call with connected state
				setTimeout(() => callback('connected'), 0);
				return () => {};
			});

			await connectionManager.getHub();

			const hub = connectionManager.getHubIfConnected();
			expect(hub).not.toBeNull();
		});
	});

	describe('getHubOrThrow', () => {
		it('should throw ConnectionNotReadyError when not connected', () => {
			expect(() => connectionManager.getHubOrThrow()).toThrow(ConnectionNotReadyError);
		});

		it('should throw with descriptive message', () => {
			try {
				connectionManager.getHubOrThrow();
				expect(true).toBe(false); // Should not reach
			} catch (err) {
				expect(err).toBeInstanceOf(ConnectionNotReadyError);
				expect((err as Error).message).toContain('not connected');
			}
		});

		it('should return hub when connected', async () => {
			mockMessageHub.isConnected.mockReturnValue(true);
			mockTransport.isReady.mockReturnValue(true);
			mockMessageHub.onConnection.mockImplementation((callback: Function) => {
				setTimeout(() => callback('connected'), 0);
				return () => {};
			});

			await connectionManager.getHub();

			const hub = connectionManager.getHubOrThrow();
			expect(hub).not.toBeNull();
		});
	});

	describe('onConnected', () => {
		it('should resolve immediately when already connected', async () => {
			mockMessageHub.isConnected.mockReturnValue(true);
			mockTransport.isReady.mockReturnValue(true);
			mockMessageHub.onConnection.mockImplementation((callback: Function) => {
				setTimeout(() => callback('connected'), 0);
				return () => {};
			});

			// First connect
			await connectionManager.getHub();

			// Should resolve immediately
			const start = Date.now();
			await connectionManager.onConnected(5000);
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(100);
		});

		it('should timeout when connection does not happen', async () => {
			// Never connect
			mockMessageHub.isConnected.mockReturnValue(false);

			await expect(connectionManager.onConnected(100)).rejects.toThrow(ConnectionTimeoutError);
		});

		it('should include timeout value in error', async () => {
			mockMessageHub.isConnected.mockReturnValue(false);

			try {
				await connectionManager.onConnected(150);
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(ConnectionTimeoutError);
				expect((err as ConnectionTimeoutError).timeoutMs).toBe(150);
			}
		});
	});

	describe('onceConnected', () => {
		it('should call callback immediately when already connected', () => {
			mockMessageHub.isConnected.mockReturnValue(true);
			mockTransport.isReady.mockReturnValue(true);
			mockMessageHub.onConnection.mockImplementation((callback: Function) => {
				setTimeout(() => callback('connected'), 0);
				return () => {};
			});

			// Connect first
			connectionManager.getHub();

			let called = false;
			connectionManager.onceConnected(() => {
				called = true;
			});

			expect(called).toBe(true);
		});

		it('should return unsubscribe function', () => {
			mockMessageHub.isConnected.mockReturnValue(false);

			let called = false;
			const unsub = connectionManager.onceConnected(() => {
				called = true;
			});

			// Unsubscribe before connection
			unsub();

			// Simulate connection
			// The callback should NOT be called
			expect(called).toBe(false);
		});
	});

	describe('isConnected', () => {
		it('should return false when hub is null', () => {
			expect(connectionManager.isConnected()).toBe(false);
		});

		it('should return true when hub reports connected', async () => {
			mockMessageHub.isConnected.mockReturnValue(true);
			mockTransport.isReady.mockReturnValue(true);
			mockMessageHub.onConnection.mockImplementation((callback: Function) => {
				setTimeout(() => callback('connected'), 0);
				return () => {};
			});

			await connectionManager.getHub();

			expect(connectionManager.isConnected()).toBe(true);
		});
	});

	// Restore mocks after all tests to prevent leakage to other test files
	afterAll(() => {
		mock.restore();
	});

	describe('disconnect', () => {
		it('should clear connection handlers on disconnect', async () => {
			let handlerCalled = false;

			connectionManager.onceConnected(() => {
				handlerCalled = true;
			});

			await connectionManager.disconnect();

			// Handler should not be called after disconnect
			expect(handlerCalled).toBe(false);
		});

		it('should close transport on disconnect', async () => {
			mockMessageHub.isConnected.mockReturnValue(true);
			mockTransport.isReady.mockReturnValue(true);
			mockMessageHub.onConnection.mockImplementation((callback: Function) => {
				setTimeout(() => callback('connected'), 0);
				return () => {};
			});

			await connectionManager.getHub();
			await connectionManager.disconnect();

			expect(connectionManager.isConnected()).toBe(false);
		});
	});
});

describe('ConnectionManager - Non-blocking behavior', () => {
	it('getHubIfConnected should not block even if connection is in progress', async () => {
		const manager = new ConnectionManager('ws://localhost:9283');

		// Start measuring
		const start = Date.now();

		// This should return immediately (null)
		const hub = manager.getHubIfConnected();

		const elapsed = Date.now() - start;

		expect(hub).toBeNull();
		expect(elapsed).toBeLessThan(10); // Should be nearly instant

		await manager.disconnect();
	});

	it('getHubOrThrow should not block even if connection is in progress', async () => {
		const manager = new ConnectionManager('ws://localhost:9283');

		const start = Date.now();

		try {
			manager.getHubOrThrow();
		} catch {
			// Expected
		}

		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(10); // Should be nearly instant

		await manager.disconnect();
	});
});
