// @ts-nocheck
/**
 * Tests for useMessageHub Hook Logic
 *
 * Tests pure logic without mock.module to avoid polluting other tests.
 * IMPORTANT: Bun's mock.module() persists across test files, so we test
 * the underlying logic without using module mocks.
 */

import { signal } from '@preact/signals';

// Error classes for testing
class ConnectionNotReadyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConnectionNotReadyError';
	}
}

// Type definitions
interface MockHub {
	call: (method: string, data?: unknown, options?: unknown) => Promise<unknown>;
	subscribeOptimistic: (method: string, handler: unknown, options?: unknown) => () => void;
}

interface MockConnectionManager {
	hubIsConnected: boolean;
	hubCallResult: unknown;
	onceConnectedCallbacks: (() => void)[];
	subscribeOptimisticCalled: boolean;

	getHubIfConnected: () => MockHub | null;
	getHubOrThrow: () => MockHub;
	onConnected: (timeout: number) => Promise<void>;
	onceConnected: (callback: () => void) => () => void;
	isConnected: () => boolean;
}

// Create a mock connection manager
function createMockConnectionManager(): MockConnectionManager {
	const state = {
		hubIsConnected: false,
		hubCallResult: null as unknown,
		onceConnectedCallbacks: [] as (() => void)[],
		subscribeOptimisticCalled: false,
	};

	const createHub = (): MockHub => ({
		call: vi.fn((__method: string, _data: unknown, _options: unknown) =>
			Promise.resolve(state.hubCallResult)
		),
		subscribeOptimistic: vi.fn((__method: string, _handler: unknown, _options: unknown) => {
			state.subscribeOptimisticCalled = true;
			return () => {};
		}),
	});

	return {
		get hubIsConnected() {
			return state.hubIsConnected;
		},
		set hubIsConnected(value: boolean) {
			state.hubIsConnected = value;
			if (value) {
				// Call pending callbacks
				state.onceConnectedCallbacks.forEach((cb) => cb());
				state.onceConnectedCallbacks = [];
			}
		},
		get hubCallResult() {
			return state.hubCallResult;
		},
		set hubCallResult(value: unknown) {
			state.hubCallResult = value;
		},
		get onceConnectedCallbacks() {
			return state.onceConnectedCallbacks;
		},
		get subscribeOptimisticCalled() {
			return state.subscribeOptimisticCalled;
		},
		set subscribeOptimisticCalled(value: boolean) {
			state.subscribeOptimisticCalled = value;
		},

		getHubIfConnected: () => {
			if (!state.hubIsConnected) return null;
			return createHub();
		},

		getHubOrThrow: () => {
			if (!state.hubIsConnected) throw new Error('Not connected');
			return createHub();
		},

		onConnected: (timeout: number) => {
			if (state.hubIsConnected) return Promise.resolve();
			return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout));
		},

		onceConnected: (callback: () => void) => {
			if (state.hubIsConnected) {
				callback();
				return () => {};
			}
			state.onceConnectedCallbacks.push(callback);
			return () => {
				const index = state.onceConnectedCallbacks.indexOf(callback);
				if (index > -1) {
					state.onceConnectedCallbacks.splice(index, 1);
				}
			};
		},

		isConnected: () => state.hubIsConnected,
	};
}

// Helper to create a simulated hook context
function createHookContext(connectionManager: MockConnectionManager) {
	return {
		getHub: () => connectionManager.getHubIfConnected(),

		call: async (method: string, data?: unknown, _options?: { timeout?: number }) => {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				throw new ConnectionNotReadyError(`Cannot call '${method}': not connected to server`);
			}
			return hub.call(method, data, _options);
		},

		callIfConnected: async (method: string, data?: unknown, options?: { timeout?: number }) => {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) return null;
			return hub.call(method, data, options);
		},

		subscribe: (method: string, handler: unknown, options?: unknown) => {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				let actualUnsub: (() => void) | null = null;
				let cancelled = false;

				const connectionUnsub = connectionManager.onceConnected(() => {
					if (cancelled) return;
					const connectedHub = connectionManager.getHubIfConnected();
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

// Test state
let connectionStateValue: ReturnType<typeof signal<string>>;
let mockConnectionManager: MockConnectionManager;

describe('useMessageHub', () => {
	beforeEach(() => {
		connectionStateValue = signal('disconnected');
		mockConnectionManager = createMockConnectionManager();
	});

	describe('getHub', () => {
		it('should return null when not connected', () => {
			mockConnectionManager.hubIsConnected = false;
			const ctx = createHookContext(mockConnectionManager);

			const hub = ctx.getHub();

			expect(hub).toBeNull();
		});

		it('should return hub when connected', () => {
			mockConnectionManager.hubIsConnected = true;
			const ctx = createHookContext(mockConnectionManager);

			const hub = ctx.getHub();

			expect(hub).not.toBeNull();
		});
	});

	describe('call', () => {
		it('should throw ConnectionNotReadyError when not connected', async () => {
			mockConnectionManager.hubIsConnected = false;
			const ctx = createHookContext(mockConnectionManager);

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
			mockConnectionManager.hubIsConnected = true;
			mockConnectionManager.hubCallResult = { success: true, data: 'result' };
			const ctx = createHookContext(mockConnectionManager);

			const result = await ctx.call('test.method', { input: 'data' });

			expect(result).toEqual({ success: true, data: 'result' });
		});

		it('should not block when not connected', async () => {
			mockConnectionManager.hubIsConnected = false;
			const ctx = createHookContext(mockConnectionManager);

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
			mockConnectionManager.hubIsConnected = false;
			const ctx = createHookContext(mockConnectionManager);

			const result = await ctx.callIfConnected('test.method', { data: 'value' });

			expect(result).toBeNull();
		});

		it('should make RPC call when connected', async () => {
			mockConnectionManager.hubIsConnected = true;
			mockConnectionManager.hubCallResult = { success: true };
			const ctx = createHookContext(mockConnectionManager);

			const result = await ctx.callIfConnected('test.method');

			expect(result).toEqual({ success: true });
		});

		it('should not throw when not connected', async () => {
			mockConnectionManager.hubIsConnected = false;
			const ctx = createHookContext(mockConnectionManager);

			// Should not throw
			const result = await ctx.callIfConnected('test.method');
			expect(result).toBeNull();
		});
	});

	describe('subscribe', () => {
		it('should queue subscription when not connected', () => {
			mockConnectionManager.hubIsConnected = false;
			const ctx = createHookContext(mockConnectionManager);

			const handler = () => {};
			const unsub = ctx.subscribe('test.event', handler);

			// Should return unsubscribe function immediately
			expect(typeof unsub).toBe('function');

			// Should have added to pending callbacks
			expect(mockConnectionManager.onceConnectedCallbacks.length).toBe(1);
		});

		it('should subscribe immediately when connected', () => {
			mockConnectionManager.hubIsConnected = true;
			const ctx = createHookContext(mockConnectionManager);

			const handler = () => {};
			const unsub = ctx.subscribe('test.event', handler);

			// Should return unsubscribe function
			expect(typeof unsub).toBe('function');

			// Should have called subscribeOptimistic
			expect(mockConnectionManager.subscribeOptimisticCalled).toBe(true);
		});

		it('should return synchronous unsubscribe function', () => {
			mockConnectionManager.hubIsConnected = true;
			const ctx = createHookContext(mockConnectionManager);

			const start = Date.now();
			const unsub = ctx.subscribe('test.event', () => {});
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(10); // Should be instant
			expect(typeof unsub).toBe('function');
		});

		it('should cancel queued subscription on unsubscribe', () => {
			mockConnectionManager.hubIsConnected = false;
			const ctx = createHookContext(mockConnectionManager);

			const handler = vi.fn(() => {});
			const unsub = ctx.subscribe('test.event', handler);

			// Unsubscribe before connection
			unsub();

			// Now connect - handler should NOT be called
			mockConnectionManager.hubIsConnected = true;

			// Handler should not have been called
			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe('connection state reactivity', () => {
		it('should reflect connected state', () => {
			connectionStateValue.value = 'connected';
			mockConnectionManager.hubIsConnected = true;

			const ctx = createHookContext(mockConnectionManager);
			const hub = ctx.getHub();

			expect(hub).not.toBeNull();
		});

		it('should reflect disconnected state', () => {
			connectionStateValue.value = 'disconnected';
			mockConnectionManager.hubIsConnected = false;

			const ctx = createHookContext(mockConnectionManager);
			const hub = ctx.getHub();

			expect(hub).toBeNull();
		});

		it('should handle state transitions', () => {
			const ctx = createHookContext(mockConnectionManager);

			// Start disconnected
			connectionStateValue.value = 'disconnected';
			mockConnectionManager.hubIsConnected = false;
			expect(ctx.getHub()).toBeNull();

			// Transition to connecting
			connectionStateValue.value = 'connecting';
			expect(ctx.getHub()).toBeNull();

			// Transition to connected
			connectionStateValue.value = 'connected';
			mockConnectionManager.hubIsConnected = true;
			expect(ctx.getHub()).not.toBeNull();

			// Transition to reconnecting
			connectionStateValue.value = 'reconnecting';
			mockConnectionManager.hubIsConnected = false;
			expect(ctx.getHub()).toBeNull();
		});
	});
});

describe('useMessageHub - Non-blocking guarantees', () => {
	beforeEach(() => {
		connectionStateValue = signal('disconnected');
		mockConnectionManager = createMockConnectionManager();
	});

	it('getHub should never block', () => {
		const ctx = createHookContext(mockConnectionManager);

		const start = Date.now();
		for (let i = 0; i < 100; i++) {
			ctx.getHub();
		}
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50); // 100 calls should be instant
	});

	it('call should fail fast when not connected', async () => {
		const ctx = createHookContext(mockConnectionManager);

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
		const ctx = createHookContext(mockConnectionManager);

		const start = Date.now();
		await ctx.callIfConnected('method');
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50); // Should return null immediately
	});

	it('subscribe should return immediately even when not connected', () => {
		const ctx = createHookContext(mockConnectionManager);

		const start = Date.now();
		const unsub = ctx.subscribe('event', () => {});
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(10); // Should be instant
		expect(typeof unsub).toBe('function');
	});
});

describe('useMessageHub - Edge cases', () => {
	beforeEach(() => {
		connectionStateValue = signal('disconnected');
		mockConnectionManager = createMockConnectionManager();
	});

	it('should handle rapid connect/disconnect cycles', () => {
		const ctx = createHookContext(mockConnectionManager);

		for (let i = 0; i < 10; i++) {
			mockConnectionManager.hubIsConnected = true;
			connectionStateValue.value = 'connected';
			const hub = ctx.getHub();
			expect(hub).not.toBeNull();

			mockConnectionManager.hubIsConnected = false;
			connectionStateValue.value = 'disconnected';
			const noHub = ctx.getHub();
			expect(noHub).toBeNull();
		}
	});

	it('should handle multiple concurrent calls when not connected', async () => {
		const ctx = createHookContext(mockConnectionManager);

		const promises = Array.from({ length: 5 }, () => ctx.call('method').catch((e) => e));

		const results = await Promise.all(promises);

		// All should have failed with ConnectionNotReadyError
		results.forEach((result) => {
			expect(result).toBeInstanceOf(ConnectionNotReadyError);
		});
	});

	it('should handle multiple concurrent subscriptions when not connected', () => {
		const ctx = createHookContext(mockConnectionManager);

		const unsubs = Array.from({ length: 10 }, (_, i) => ctx.subscribe(`event.${i}`, () => {}));

		// All should return unsubscribe functions
		unsubs.forEach((unsub) => {
			expect(typeof unsub).toBe('function');
		});

		// Unsubscribe all
		unsubs.forEach((unsub) => unsub());
	});
});
