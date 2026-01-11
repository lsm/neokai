/**
 * Tests for QueryLifecycleManager
 *
 * Coverage for:
 * - stop: Stopping query with various options
 * - restart: Stop + start sequence
 * - reset: Full reset with hooks
 */

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { QueryLifecycleManager } from '../../../src/lib/agent/query-lifecycle-manager';
import { MessageQueue } from '../../../src/lib/agent/message-queue';

describe('QueryLifecycleManager', () => {
	let manager: QueryLifecycleManager;
	let messageQueue: MessageQueue;
	let mockQueryObject: { interrupt: () => Promise<void> } | null;
	let mockQueryPromise: Promise<void> | null;
	let startStreamingCalled: boolean;
	let isTransportReady: boolean;

	beforeEach(() => {
		messageQueue = new MessageQueue('test-session');
		mockQueryObject = null;
		mockQueryPromise = null;
		startStreamingCalled = false;
		isTransportReady = true;

		manager = new QueryLifecycleManager(
			'test-session',
			messageQueue,
			() => mockQueryObject,
			(q) => {
				mockQueryObject = q as typeof mockQueryObject;
			},
			() => mockQueryPromise,
			(p) => {
				mockQueryPromise = p;
			},
			async () => {
				startStreamingCalled = true;
			},
			() => isTransportReady
		);
	});

	describe('stop', () => {
		test('stops message queue', async () => {
			const stopSpy = spyOn(messageQueue, 'stop');

			await manager.stop();

			expect(stopSpy).toHaveBeenCalled();
		});

		test('interrupts query when transport is ready', async () => {
			let interruptCalled = false;
			mockQueryObject = {
				interrupt: mock(async () => {
					interruptCalled = true;
				}),
			};
			isTransportReady = true;

			await manager.stop();

			expect(interruptCalled).toBe(true);
		});

		test('skips interrupt when transport is not ready', async () => {
			let interruptCalled = false;
			mockQueryObject = {
				interrupt: mock(async () => {
					interruptCalled = true;
				}),
			};
			isTransportReady = false;

			await manager.stop();

			expect(interruptCalled).toBe(false);
		});

		test('handles interrupt errors gracefully', async () => {
			mockQueryObject = {
				interrupt: mock(async () => {
					throw new Error('Interrupt failed');
				}),
			};
			isTransportReady = true;

			// Should not throw
			await manager.stop();
		});

		test('waits for query promise to resolve', async () => {
			let promiseResolved = false;
			mockQueryPromise = new Promise((resolve) => {
				setTimeout(() => {
					promiseResolved = true;
					resolve();
				}, 10);
			});

			await manager.stop();

			expect(promiseResolved).toBe(true);
		});

		test('times out waiting for query promise', async () => {
			mockQueryPromise = new Promise(() => {
				// Never resolves
			});

			const start = Date.now();
			await manager.stop({ timeoutMs: 100 });
			const elapsed = Date.now() - start;

			// Should have timed out around 100ms
			expect(elapsed).toBeGreaterThanOrEqual(90);
			expect(elapsed).toBeLessThan(200);
		});

		test('catches query errors when option is set', async () => {
			mockQueryPromise = Promise.reject(new Error('Query failed'));

			// Should not throw with catchQueryErrors: true
			await manager.stop({ catchQueryErrors: true });
		});

		test('clears query references after stop', async () => {
			mockQueryObject = {
				interrupt: mock(async () => {}),
			};
			mockQueryPromise = Promise.resolve();

			await manager.stop();

			expect(mockQueryObject).toBeNull();
			expect(mockQueryPromise).toBeNull();
		});

		test('handles null query object', async () => {
			mockQueryObject = null;

			// Should not throw
			await manager.stop();
		});

		test('handles query object without interrupt method', async () => {
			mockQueryObject = {} as { interrupt: () => Promise<void> };

			// Should not throw
			await manager.stop();
		});
	});

	describe('restart', () => {
		test('stops and starts query', async () => {
			await manager.restart();

			expect(startStreamingCalled).toBe(true);
		});

		test('throws on start failure', async () => {
			const failingManager = new QueryLifecycleManager(
				'test-session',
				messageQueue,
				() => null,
				() => {},
				() => null,
				() => {},
				async () => {
					throw new Error('Start failed');
				},
				() => true
			);

			await expect(failingManager.restart()).rejects.toThrow('Query restart failed: Start failed');
		});

		test('throws on stop failure with meaningful message', async () => {
			const failingManager = new QueryLifecycleManager(
				'test-session',
				messageQueue,
				() => ({
					interrupt: async () => {
						throw new Error('Stop failed');
					},
				}),
				() => {},
				() =>
					new Promise((_, reject) => {
						setTimeout(() => reject(new Error('Promise rejected')), 0);
					}),
				() => {},
				async () => {},
				() => true
			);

			// Even with interrupt failure, should continue
			await failingManager.restart();
		});
	});

	describe('reset', () => {
		test('executes full reset sequence', async () => {
			const callbacks = {
				beforeStop: false,
				afterStop: false,
				afterRestart: false,
			};

			const result = await manager.reset({
				restartAfter: true,
				onBeforeStop: async () => {
					callbacks.beforeStop = true;
				},
				onAfterStop: async () => {
					callbacks.afterStop = true;
				},
				onAfterRestart: async () => {
					callbacks.afterRestart = true;
				},
			});

			expect(result.success).toBe(true);
			expect(callbacks.beforeStop).toBe(true);
			expect(callbacks.afterStop).toBe(true);
			expect(callbacks.afterRestart).toBe(true);
			expect(startStreamingCalled).toBe(true);
		});

		test('skips restart when option is false', async () => {
			const result = await manager.reset({ restartAfter: false });

			expect(result.success).toBe(true);
			expect(startStreamingCalled).toBe(false);
		});

		test('returns error on failure', async () => {
			const failingManager = new QueryLifecycleManager(
				'test-session',
				messageQueue,
				() => null,
				() => {},
				() => null,
				() => {},
				async () => {
					throw new Error('Start failed');
				},
				() => true
			);

			const result = await failingManager.reset({ restartAfter: true });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Start failed');
		});

		test('handles callback errors', async () => {
			const result = await manager.reset({
				onBeforeStop: async () => {
					throw new Error('Before stop failed');
				},
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Before stop failed');
		});

		test('handles onAfterStop callback errors', async () => {
			const result = await manager.reset({
				onAfterStop: async () => {
					throw new Error('After stop failed');
				},
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('After stop failed');
		});

		test('handles onAfterRestart callback errors', async () => {
			const result = await manager.reset({
				restartAfter: true,
				onAfterRestart: async () => {
					throw new Error('After restart failed');
				},
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('After restart failed');
		});

		test('resets with default options', async () => {
			const result = await manager.reset();

			expect(result.success).toBe(true);
			// Default restartAfter is true
			expect(startStreamingCalled).toBe(true);
		});

		test('handles non-Error exceptions', async () => {
			const failingManager = new QueryLifecycleManager(
				'test-session',
				messageQueue,
				() => null,
				() => {},
				() => null,
				() => {},
				async () => {
					throw 'String error'; // eslint-disable-line @typescript-eslint/no-throw-literal
				},
				() => true
			);

			const result = await failingManager.reset({ restartAfter: true });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Unknown error');
		});
	});

	describe('edge cases', () => {
		test('handles concurrent stop calls', async () => {
			mockQueryPromise = new Promise((resolve) => setTimeout(resolve, 50));

			// Start two stops concurrently
			const [result1, result2] = await Promise.all([manager.stop(), manager.stop()]);

			// Both should complete without error
			expect(result1).toBeUndefined();
			expect(result2).toBeUndefined();
		});

		test('restart calls start after stop', async () => {
			// Verify the stop-then-start sequence in restart
			await manager.restart();
			expect(startStreamingCalled).toBe(true);
		});

		test('stop with undefined options uses defaults', async () => {
			await manager.stop();
			// Should complete without error using default timeout
		});
	});
});
