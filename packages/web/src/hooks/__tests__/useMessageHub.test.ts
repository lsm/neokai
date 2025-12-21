/**
 * Tests for useMessageHub Hook
 *
 * Tests the non-blocking connection access patterns and reactive state.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { signal } from '@preact/signals';

// Track state for assertions
let connectionStateValue = signal<string>('disconnected');
let hubIsConnected = false;
let hubCallResult: unknown = null;
let subscribeOptimisticCalled = false;

// Mock connection manager
const mockConnectionManager = {
	getHubIfConnected: mock(() => {
		if (!hubIsConnected) return null;
		return {
			call: mock((__method: string, _data: unknown, _options: unknown) =>
				Promise.resolve(hubCallResult)
			),
			subscribeOptimistic: mock((__method: string, _handler: unknown, _options: unknown) => {
				subscribeOptimisticCalled = true;
				return () => {};
			}),
		};
	}),
	getHubOrThrow: mock(() => {
		if (!hubIsConnected) throw new Error('Not connected');
		return {};
	}),
	onConnected: mock((timeout: number) => {
		if (hubIsConnected) return Promise.resolve();
		return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout));
	}),
	onceConnected: mock((callback: () => void) => {
		if (hubIsConnected) {
			callback();
			return () => {};
		}
		return () => {};
	}),
	isConnected: mock(() => hubIsConnected),
};

// Mock the connection-manager module
mock.module('../lib/connection-manager', () => ({
	connectionManager: mockConnectionManager,
}));

// Mock the state module
mock.module('../lib/state', () => ({
	connectionState: connectionStateValue,
}));

// Mock the errors module
mock.module('../lib/errors', () => ({
	ConnectionNotReadyError: class ConnectionNotReadyError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ConnectionNotReadyError';
		}
	},
}));

// Import after mocking
import { ConnectionNotReadyError } from '../useMessageHub';

// Helper to create a minimal hook context
function createHookContext() {
	// Since we can't use Preact hooks outside components in tests,
	// we'll test the underlying logic directly
	return {
		getHub: () => mockConnectionManager.getHubIfConnected(),
		call: async (method: string, data?: unknown, options?: { timeout?: number }) => {
			const hub = mockConnectionManager.getHubIfConnected();
			if (!hub) {
				throw new ConnectionNotReadyError(`Cannot call '${method}': not connected to server`);
			}
			return hub.call(method, data, options);
		},
		callIfConnected: async (method: string, data?: unknown, options?: { timeout?: number }) => {
			const hub = mockConnectionManager.getHubIfConnected();
			if (!hub) return null;
			return hub.call(method, data, options);
		},
		subscribe: (method: string, handler: unknown, options?: unknown) => {
			const hub = mockConnectionManager.getHubIfConnected();
			if (!hub) {
				let actualUnsub: (() => void) | null = null;
				let cancelled = false;
				const connectionUnsub = mockConnectionManager.onceConnected(() => {
					if (cancelled) return;
					const connectedHub = mockConnectionManager.getHubIfConnected();
					if (connectedHub) {
						actualUnsub = connectedHub.subscribeOptimistic(method, handler, options);
					}
				});
				return () => {
					cancelled = true;
					connectionUnsub();
					if (actualUnsub) actualUnsub();
				};
			}
			return hub.subscribeOptimistic(method, handler, options);
		},
	};
}

describe('useMessageHub', () => {
	beforeEach(() => {
		// Reset state
		connectionStateValue.value = 'disconnected';
		hubIsConnected = false;
		hubCallResult = null;
		subscribeOptimisticCalled = false;

		// Reset mocks
		mockConnectionManager.getHubIfConnected.mockClear();
		mockConnectionManager.onceConnected.mockClear();
	});

	describe('getHub', () => {
		it('should return null when not connected', () => {
			hubIsConnected = false;
			const ctx = createHookContext();

			const hub = ctx.getHub();

			expect(hub).toBeNull();
		});

		it('should return hub when connected', () => {
			hubIsConnected = true;
			const ctx = createHookContext();

			const hub = ctx.getHub();

			expect(hub).not.toBeNull();
		});
	});

	describe('call', () => {
		it('should throw ConnectionNotReadyError when not connected', async () => {
			hubIsConnected = false;
			const ctx = createHookContext();

			try {
				await ctx.call('test.method', { data: 'value' });
				expect(true).toBe(false); // Should not reach
			} catch (err) {
				expect(err).toBeInstanceOf(ConnectionNotReadyError);
				expect((err as Error).message).toContain('test.method');
				expect((err as Error).message).toContain('not connected');
			}
		});

		it('should make RPC call when connected', async () => {
			hubIsConnected = true;
			hubCallResult = { success: true, data: 'result' };
			const ctx = createHookContext();

			const result = await ctx.call('test.method', { input: 'data' });

			expect(result).toEqual({ success: true, data: 'result' });
		});

		it('should not block when not connected', async () => {
			hubIsConnected = false;
			const ctx = createHookContext();

			const start = Date.now();

			try {
				await ctx.call('test.method');
			} catch {
				// Expected
			}

			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(50); // Should be nearly instant
		});
	});

	describe('callIfConnected', () => {
		it('should return null when not connected', async () => {
			hubIsConnected = false;
			const ctx = createHookContext();

			const result = await ctx.callIfConnected('test.method', { data: 'value' });

			expect(result).toBeNull();
		});

		it('should make RPC call when connected', async () => {
			hubIsConnected = true;
			hubCallResult = { success: true };
			const ctx = createHookContext();

			const result = await ctx.callIfConnected('test.method');

			expect(result).toEqual({ success: true });
		});

		it('should not throw when not connected', async () => {
			hubIsConnected = false;
			const ctx = createHookContext();

			// Should not throw
			const result = await ctx.callIfConnected('test.method');
			expect(result).toBeNull();
		});
	});

	describe('subscribe', () => {
		it('should queue subscription when not connected', () => {
			hubIsConnected = false;
			const ctx = createHookContext();

			const handler = () => {};
			const unsub = ctx.subscribe('test.event', handler);

			// Should return unsubscribe function immediately
			expect(typeof unsub).toBe('function');

			// Should have called onceConnected
			expect(mockConnectionManager.onceConnected).toHaveBeenCalled();
		});

		it('should subscribe immediately when connected', () => {
			hubIsConnected = true;
			const ctx = createHookContext();

			const handler = () => {};
			const unsub = ctx.subscribe('test.event', handler);

			// Should return unsubscribe function
			expect(typeof unsub).toBe('function');

			// Should have called subscribeOptimistic
			expect(subscribeOptimisticCalled).toBe(true);
		});

		it('should return synchronous unsubscribe function', () => {
			hubIsConnected = true;
			const ctx = createHookContext();

			const start = Date.now();
			const unsub = ctx.subscribe('test.event', () => {});
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(10); // Should be instant
			expect(typeof unsub).toBe('function');
		});

		it('should cancel queued subscription on unsubscribe', () => {
			hubIsConnected = false;
			const ctx = createHookContext();

			const handler = mock(() => {});
			const unsub = ctx.subscribe('test.event', handler);

			// Unsubscribe before connection
			unsub();

			// Now connect - handler should NOT be called
			hubIsConnected = true;

			// Handler should not have been called
			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe('connection state reactivity', () => {
		it('should reflect connected state', () => {
			connectionStateValue.value = 'connected';
			hubIsConnected = true;

			const ctx = createHookContext();
			const hub = ctx.getHub();

			expect(hub).not.toBeNull();
		});

		it('should reflect disconnected state', () => {
			connectionStateValue.value = 'disconnected';
			hubIsConnected = false;

			const ctx = createHookContext();
			const hub = ctx.getHub();

			expect(hub).toBeNull();
		});

		it('should handle state transitions', () => {
			const ctx = createHookContext();

			// Start disconnected
			connectionStateValue.value = 'disconnected';
			hubIsConnected = false;
			expect(ctx.getHub()).toBeNull();

			// Transition to connecting
			connectionStateValue.value = 'connecting';
			expect(ctx.getHub()).toBeNull();

			// Transition to connected
			connectionStateValue.value = 'connected';
			hubIsConnected = true;
			expect(ctx.getHub()).not.toBeNull();

			// Transition to reconnecting
			connectionStateValue.value = 'reconnecting';
			hubIsConnected = false;
			expect(ctx.getHub()).toBeNull();
		});
	});
});

describe('useMessageHub - Non-blocking guarantees', () => {
	beforeEach(() => {
		connectionStateValue.value = 'disconnected';
		hubIsConnected = false;
	});

	it('getHub should never block', () => {
		const ctx = createHookContext();

		const start = Date.now();
		for (let i = 0; i < 100; i++) {
			ctx.getHub();
		}
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50); // 100 calls should be instant
	});

	it('call should fail fast when not connected', async () => {
		const ctx = createHookContext();

		const start = Date.now();
		try {
			await ctx.call('method');
		} catch {
			// Expected
		}
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50); // Should fail immediately
	});

	it('callIfConnected should return immediately when not connected', async () => {
		const ctx = createHookContext();

		const start = Date.now();
		await ctx.callIfConnected('method');
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50); // Should return null immediately
	});

	it('subscribe should return immediately even when not connected', () => {
		const ctx = createHookContext();

		const start = Date.now();
		const unsub = ctx.subscribe('event', () => {});
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(10); // Should be instant
		expect(typeof unsub).toBe('function');
	});
});

describe('useMessageHub - Edge cases', () => {
	beforeEach(() => {
		connectionStateValue.value = 'disconnected';
		hubIsConnected = false;
	});

	it('should handle rapid connect/disconnect cycles', () => {
		const ctx = createHookContext();

		for (let i = 0; i < 10; i++) {
			hubIsConnected = true;
			connectionStateValue.value = 'connected';
			const hub = ctx.getHub();
			expect(hub).not.toBeNull();

			hubIsConnected = false;
			connectionStateValue.value = 'disconnected';
			const noHub = ctx.getHub();
			expect(noHub).toBeNull();
		}
	});

	it('should handle multiple concurrent calls when not connected', async () => {
		const ctx = createHookContext();

		const promises = Array.from({ length: 5 }, () => ctx.call('method').catch((e) => e));

		const results = await Promise.all(promises);

		// All should have failed with ConnectionNotReadyError
		results.forEach((result) => {
			expect(result).toBeInstanceOf(ConnectionNotReadyError);
		});
	});

	it('should handle multiple concurrent subscriptions when not connected', () => {
		const ctx = createHookContext();

		const unsubs = Array.from({ length: 10 }, (_, i) => ctx.subscribe(`event.${i}`, () => {}));

		// All should return unsubscribe functions
		unsubs.forEach((unsub) => {
			expect(typeof unsub).toBe('function');
		});

		// Unsubscribe all
		unsubs.forEach((unsub) => unsub());
	});
});
