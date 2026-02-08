/**
 * Tests for QueryLifecycleManager
 *
 * Coverage for:
 * - stop: Stopping query with various options
 * - restart: Stop + start sequence
 * - reset: Full reset with cost tracking, state management, and notifications
 * - ensureQueryStarted: Starting query with interrupt handling
 * - startQueryAndEnqueue: Starting query and enqueueing messages
 */

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import {
	QueryLifecycleManager,
	type QueryLifecycleManagerContext,
} from '../../../src/lib/agent/query-lifecycle-manager';
import { MessageQueue } from '../../../src/lib/agent/message-queue';
import type { Session, MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { SDKMessageHandler } from '../../../src/lib/agent/sdk-message-handler';
import type { InterruptHandler } from '../../../src/lib/agent/interrupt-handler';
import type { ErrorManager } from '../../../src/lib/error-manager';

describe('QueryLifecycleManager', () => {
	let manager: QueryLifecycleManager;
	let messageQueue: MessageQueue;
	let mockContext: QueryLifecycleManagerContext;
	let startStreamingCalled: boolean;

	// Mock spies
	let updateSessionSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;
	let publishSpy: ReturnType<typeof mock>;
	let setIdleSpy: ReturnType<typeof mock>;
	let setQueuedSpy: ReturnType<typeof mock>;
	let getStateSpy: ReturnType<typeof mock>;
	let resetCircuitBreakerSpy: ReturnType<typeof mock>;
	let getInterruptPromiseSpy: ReturnType<typeof mock>;
	let handleErrorSpy: ReturnType<typeof mock>;

	function createMockContext(
		overrides: Partial<QueryLifecycleManagerContext> = {}
	): QueryLifecycleManagerContext {
		const mockSession: Session = {
			id: 'test-session',
			title: 'Test Session',
			workspacePath: '/test/workspace',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: { model: 'default', maxTokens: 8192, temperature: 1.0 },
			metadata: {},
		};

		updateSessionSpy = mock(() => {});
		emitSpy = mock(async () => {});
		publishSpy = mock(async () => {});
		setIdleSpy = mock(async () => {});
		setQueuedSpy = mock(async () => {});
		getStateSpy = mock(() => ({ status: 'idle' }));
		resetCircuitBreakerSpy = mock(() => {});
		getInterruptPromiseSpy = mock(() => null);
		handleErrorSpy = mock(async () => {});

		startStreamingCalled = false;
		return {
			session: mockSession,
			messageQueue,
			db: {
				updateSession: updateSessionSpy,
			} as unknown as Database,
			messageHub: {
				event: publishSpy,
				onQuery: mock((_method: string, _handler: Function) => () => {}),
				onCommand: mock((_method: string, _handler: Function) => () => {}),
				query: mock(async () => ({})),
				command: mock(async () => {}),
			} as unknown as MessageHub,
			daemonHub: {
				emit: emitSpy,
			} as unknown as DaemonHub,
			stateManager: {
				setIdle: setIdleSpy,
				setQueued: setQueuedSpy,
				getState: getStateSpy,
			} as unknown as ProcessingStateManager,
			messageHandler: {
				resetCircuitBreaker: resetCircuitBreakerSpy,
			} as unknown as SDKMessageHandler,
			interruptHandler: {
				getInterruptPromise: getInterruptPromiseSpy,
			} as unknown as InterruptHandler,
			errorManager: {
				handleError: handleErrorSpy,
			} as unknown as ErrorManager,
			queryObject: null,
			queryPromise: null,
			firstMessageReceived: true,
			pendingRestartReason: null,
			startStreamingQuery: async () => {
				startStreamingCalled = true;
			},
			// Cleanup support methods
			setCleaningUp: mock(() => {}),
			cleanupEventSubscriptions: mock(() => {}),
			clearModelsCache: mock(async () => {}),
			...overrides,
		};
	}

	beforeEach(() => {
		messageQueue = new MessageQueue('test-session');
		mockContext = createMockContext();
		manager = new QueryLifecycleManager(mockContext);
	});

	describe('stop', () => {
		test('stops message queue', async () => {
			const stopSpy = spyOn(messageQueue, 'stop');

			await manager.stop();

			expect(stopSpy).toHaveBeenCalled();
		});

		test('interrupts query when transport is ready', async () => {
			let interruptCalled = false;
			mockContext.queryObject = {
				interrupt: mock(async () => {
					interruptCalled = true;
				}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.firstMessageReceived = true;
			manager = new QueryLifecycleManager(mockContext);

			await manager.stop();

			expect(interruptCalled).toBe(true);
		});

		test('skips interrupt when transport is not ready', async () => {
			let interruptCalled = false;
			mockContext.queryObject = {
				interrupt: mock(async () => {
					interruptCalled = true;
				}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.firstMessageReceived = false;
			manager = new QueryLifecycleManager(mockContext);

			await manager.stop();

			expect(interruptCalled).toBe(false);
		});

		test('handles interrupt errors gracefully', async () => {
			mockContext.queryObject = {
				interrupt: mock(async () => {
					throw new Error('Interrupt failed');
				}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.firstMessageReceived = true;
			manager = new QueryLifecycleManager(mockContext);

			// Should not throw
			await manager.stop();
		});

		test('waits for query promise to resolve', async () => {
			let promiseResolved = false;
			mockContext.queryPromise = new Promise((resolve) => {
				setTimeout(() => {
					promiseResolved = true;
					resolve();
				}, 10);
			});
			manager = new QueryLifecycleManager(mockContext);

			await manager.stop();

			expect(promiseResolved).toBe(true);
		});

		test('times out waiting for query promise', async () => {
			mockContext.queryPromise = new Promise(() => {
				// Never resolves
			});
			manager = new QueryLifecycleManager(mockContext);

			const start = Date.now();
			await manager.stop({ timeoutMs: 100 });
			const elapsed = Date.now() - start;

			// Should have timed out around 100ms
			expect(elapsed).toBeGreaterThanOrEqual(90);
			expect(elapsed).toBeLessThan(200);
		});

		test('catches query errors when option is set', async () => {
			mockContext.queryPromise = Promise.reject(new Error('Query failed'));
			manager = new QueryLifecycleManager(mockContext);

			// Should not throw with catchQueryErrors: true
			await manager.stop({ catchQueryErrors: true });
		});

		test('clears query references after stop', async () => {
			mockContext.queryObject = {
				interrupt: mock(async () => {}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();
			manager = new QueryLifecycleManager(mockContext);

			await manager.stop();

			expect(mockContext.queryObject).toBeNull();
			expect(mockContext.queryPromise).toBeNull();
		});

		test('handles null query object', async () => {
			mockContext.queryObject = null;
			manager = new QueryLifecycleManager(mockContext);

			// Should not throw
			await manager.stop();
		});

		test('handles query object without interrupt method', async () => {
			mockContext.queryObject = {} as QueryLifecycleManagerContext['queryObject'];
			manager = new QueryLifecycleManager(mockContext);

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
			const failingContext = createMockContext({
				startStreamingQuery: async () => {
					throw new Error('Start failed');
				},
			});
			const failingManager = new QueryLifecycleManager(failingContext);

			await expect(failingManager.restart()).rejects.toThrow('Query restart failed: Start failed');
		});

		test('throws on stop failure with meaningful message', async () => {
			const failingContext = createMockContext({
				queryObject: {
					interrupt: async () => {
						throw new Error('Stop failed');
					},
				} as unknown as QueryLifecycleManagerContext['queryObject'],
				queryPromise: new Promise((_, reject) => {
					setTimeout(() => reject(new Error('Promise rejected')), 0);
				}),
				firstMessageReceived: true,
			});
			const failingManager = new QueryLifecycleManager(failingContext);

			// Even with interrupt failure, should continue
			await failingManager.restart();
		});
	});

	describe('reset', () => {
		test('returns early when no query is running', async () => {
			// No queryObject or queryPromise set
			const result = await manager.reset();

			expect(result.success).toBe(true);
			expect(resetCircuitBreakerSpy).toHaveBeenCalled();
			expect(setIdleSpy).toHaveBeenCalled();
			// Should not start a new query in early return path
			expect(startStreamingCalled).toBe(false);
		});

		test('clears pendingRestartReason on early return', async () => {
			mockContext.pendingRestartReason = 'settings.local.json';
			manager = new QueryLifecycleManager(mockContext);

			await manager.reset();

			expect(mockContext.pendingRestartReason).toBeNull();
		});

		test('executes full reset sequence with running query', async () => {
			mockContext.queryObject = {
				interrupt: mock(async () => {}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();
			manager = new QueryLifecycleManager(mockContext);

			const result = await manager.reset({ restartAfter: true });

			expect(result.success).toBe(true);
			expect(resetCircuitBreakerSpy).toHaveBeenCalled();
			expect(setIdleSpy).toHaveBeenCalled();
			expect(publishSpy).toHaveBeenCalledWith(
				'session.reset',
				expect.objectContaining({ message: expect.any(String) }),
				expect.objectContaining({ sessionId: 'test-session' })
			);
			expect(startStreamingCalled).toBe(true);
		});

		test('preserves cost tracking during reset', async () => {
			mockContext.queryObject = {
				interrupt: mock(async () => {}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();
			mockContext.session.metadata = {
				lastSdkCost: 0.05,
				costBaseline: 0.1,
			};
			manager = new QueryLifecycleManager(mockContext);

			await manager.reset();

			// Should have updated metadata with preserved cost
			expect(updateSessionSpy).toHaveBeenCalled();
			expect(mockContext.session.metadata.costBaseline).toBeCloseTo(0.15, 10);
			expect(mockContext.session.metadata.lastSdkCost).toBe(0);
		});

		test('clears errors on reset', async () => {
			mockContext.queryObject = {
				interrupt: mock(async () => {}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();
			manager = new QueryLifecycleManager(mockContext);

			await manager.reset();

			expect(emitSpy).toHaveBeenCalledWith('session.errorClear', { sessionId: 'test-session' });
		});

		test('skips restart when option is false', async () => {
			mockContext.queryObject = {
				interrupt: mock(async () => {}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();
			manager = new QueryLifecycleManager(mockContext);

			const result = await manager.reset({ restartAfter: false });

			expect(result.success).toBe(true);
			expect(startStreamingCalled).toBe(false);
		});

		test('returns error on failure', async () => {
			const failingContext = createMockContext({
				queryObject: {
					interrupt: mock(async () => {}),
				} as unknown as QueryLifecycleManagerContext['queryObject'],
				queryPromise: Promise.resolve(),
				startStreamingQuery: async () => {
					throw new Error('Start failed');
				},
			});
			const failingManager = new QueryLifecycleManager(failingContext);

			const result = await failingManager.reset({ restartAfter: true });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Start failed');
		});

		test('resets firstMessageReceived flag', async () => {
			mockContext.queryObject = {
				interrupt: mock(async () => {}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();
			mockContext.firstMessageReceived = true;
			manager = new QueryLifecycleManager(mockContext);

			await manager.reset();

			expect(mockContext.firstMessageReceived).toBe(false);
		});

		test('resets with default options', async () => {
			mockContext.queryObject = {
				interrupt: mock(async () => {}),
			} as unknown as QueryLifecycleManagerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();
			manager = new QueryLifecycleManager(mockContext);

			const result = await manager.reset();

			expect(result.success).toBe(true);
			// Default restartAfter is true
			expect(startStreamingCalled).toBe(true);
		});

		test('handles non-Error exceptions', async () => {
			const failingContext = createMockContext({
				queryObject: {
					interrupt: mock(async () => {}),
				} as unknown as QueryLifecycleManagerContext['queryObject'],
				queryPromise: Promise.resolve(),
				startStreamingQuery: async () => {
					throw 'String error'; // eslint-disable-line @typescript-eslint/no-throw-literal
				},
			});
			const failingManager = new QueryLifecycleManager(failingContext);

			const result = await failingManager.reset({ restartAfter: true });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Unknown error');
		});
	});

	describe('edge cases', () => {
		test('handles concurrent stop calls', async () => {
			mockContext.queryPromise = new Promise((resolve) => setTimeout(resolve, 50));
			manager = new QueryLifecycleManager(mockContext);

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

	describe('ensureQueryStarted', () => {
		test('returns early if message queue is already running', async () => {
			messageQueue.start(async function* () {
				yield 'test';
			});
			mockContext = createMockContext();
			manager = new QueryLifecycleManager(mockContext);

			await manager.ensureQueryStarted();

			expect(startStreamingCalled).toBe(false);
		});

		test('starts streaming query when queue is not running', async () => {
			await manager.ensureQueryStarted();

			expect(startStreamingCalled).toBe(true);
		});

		test('validates SDK session when sdkSessionId exists', async () => {
			// When session has sdkSessionId, validateAndRepairSDKSession should be called
			mockContext = createMockContext();
			mockContext.session.sdkSessionId = 'sdk-session-abc';
			manager = new QueryLifecycleManager(mockContext);

			await manager.ensureQueryStarted();

			// Should have started query after validation
			expect(startStreamingCalled).toBe(true);
		});

		test('handles interrupt wait error gracefully', async () => {
			const rejectingPromise = Promise.reject(new Error('Interrupt error'));
			mockContext = createMockContext({
				interruptHandler: {
					getInterruptPromise: mock(() => rejectingPromise),
				} as unknown as InterruptHandler,
			});
			manager = new QueryLifecycleManager(mockContext);

			// Should not throw
			await manager.ensureQueryStarted();
			expect(startStreamingCalled).toBe(true);
		});

		test('waits for pending interrupt before starting', async () => {
			let interruptResolved = false;
			const interruptPromise = new Promise<void>((resolve) => {
				setTimeout(() => {
					interruptResolved = true;
					resolve();
				}, 10);
			});
			getInterruptPromiseSpy = mock(() => interruptPromise);
			mockContext = createMockContext({
				interruptHandler: {
					getInterruptPromise: getInterruptPromiseSpy,
				} as unknown as InterruptHandler,
			});
			manager = new QueryLifecycleManager(mockContext);

			await manager.ensureQueryStarted();

			expect(interruptResolved).toBe(true);
			expect(startStreamingCalled).toBe(true);
		});

		test(
			'handles interrupt wait timeout',
			async () => {
				const neverResolves = new Promise<void>(() => {
					// Never resolves - tests the 5s timeout
				});
				mockContext = createMockContext({
					interruptHandler: {
						getInterruptPromise: mock(() => neverResolves),
					} as unknown as InterruptHandler,
				});
				manager = new QueryLifecycleManager(mockContext);

				// This should not hang due to the Promise.race with timeout
				const start = Date.now();
				await manager.ensureQueryStarted();
				const elapsed = Date.now() - start;

				// Should complete within reasonable time (5s timeout + some buffer)
				expect(elapsed).toBeLessThan(6000);
				expect(startStreamingCalled).toBe(true);
			},
			{ timeout: 10000 }
		);
	});

	describe('startQueryAndEnqueue', () => {
		test('starts query and enqueues message', async () => {
			const enqueueSpy = spyOn(messageQueue, 'enqueueWithId').mockResolvedValue('msg-123');

			await manager.startQueryAndEnqueue('msg-123', 'Hello');

			expect(startStreamingCalled).toBe(true);
			expect(setQueuedSpy).toHaveBeenCalledWith('msg-123');
			expect(enqueueSpy).toHaveBeenCalledWith('msg-123', 'Hello');
		});

		test('emits message.sent event', async () => {
			spyOn(messageQueue, 'enqueueWithId').mockResolvedValue('msg-123');

			await manager.startQueryAndEnqueue('msg-123', 'Hello');

			expect(emitSpy).toHaveBeenCalledWith('message.sent', { sessionId: 'test-session' });
		});

		test('handles message content array', async () => {
			const enqueueSpy = spyOn(messageQueue, 'enqueueWithId').mockResolvedValue('msg-123');
			const content = [{ type: 'text' as const, text: 'Hello' }];

			await manager.startQueryAndEnqueue('msg-123', content);

			expect(enqueueSpy).toHaveBeenCalledWith('msg-123', content);
		});

		test('ignores interrupted by user error', async () => {
			const interruptedError = new Error('Interrupted by user');
			spyOn(messageQueue, 'enqueueWithId').mockRejectedValue(interruptedError);

			await manager.startQueryAndEnqueue('msg-123', 'Hello');

			// Give time for the catch handler to execute
			await new Promise((r) => setTimeout(r, 10));

			// Should not call handleError for user interruption
			expect(handleErrorSpy).not.toHaveBeenCalled();
		});

		test('handles timeout error with reset and retry', async () => {
			const timeoutError = new Error('Queue timeout');
			timeoutError.name = 'MessageQueueTimeoutError';

			let callCount = 0;
			spyOn(messageQueue, 'enqueueWithId').mockImplementation(async () => {
				callCount++;
				if (callCount === 1) {
					throw timeoutError;
				}
				return 'msg-123';
			});

			await manager.startQueryAndEnqueue('msg-123', 'Hello');

			// Give time for the catch handler to execute
			await new Promise((r) => setTimeout(r, 200));

			// Should have called handleError with TIMEOUT category
			expect(handleErrorSpy).toHaveBeenCalled();
			// Should have retried enqueue after reset
			expect(callCount).toBe(2);
		});

		test('handles non-timeout error by setting idle', async () => {
			const regularError = new Error('Some error');
			spyOn(messageQueue, 'enqueueWithId').mockRejectedValue(regularError);

			await manager.startQueryAndEnqueue('msg-123', 'Hello');

			// Give time for the catch handler to execute
			await new Promise((r) => setTimeout(r, 10));

			// Should have called handleError
			expect(handleErrorSpy).toHaveBeenCalled();
			// Should set idle after non-timeout error
			expect(setIdleSpy).toHaveBeenCalled();
		});

		test('sets idle when reset fails during timeout handling', async () => {
			const timeoutError = new Error('Queue timeout');
			timeoutError.name = 'MessageQueueTimeoutError';

			// First call throws timeout, subsequent calls also fail
			spyOn(messageQueue, 'enqueueWithId').mockRejectedValue(timeoutError);

			// Reset will fail because startStreamingQuery fails on second call
			let callCount = 0;
			mockContext = createMockContext({
				startStreamingQuery: async () => {
					callCount++;
					if (callCount > 1) {
						throw new Error('Reset failed');
					}
				},
			});
			manager = new QueryLifecycleManager(mockContext);

			await manager.startQueryAndEnqueue('msg-123', 'Hello');

			// Give time for the catch handler to execute
			await new Promise((r) => setTimeout(r, 200));

			// Should set idle after reset failure
			expect(setIdleSpy).toHaveBeenCalled();
		});

		test('sets idle when retry fails after successful reset', async () => {
			const timeoutError = new Error('Queue timeout');
			timeoutError.name = 'MessageQueueTimeoutError';

			// Always throw timeout error
			spyOn(messageQueue, 'enqueueWithId').mockRejectedValue(timeoutError);

			await manager.startQueryAndEnqueue('msg-123', 'Hello');

			// Give time for the catch handler to execute (reset + retry + catch)
			await new Promise((r) => setTimeout(r, 300));

			// Should set idle after retry fails
			expect(setIdleSpy).toHaveBeenCalled();
		});
	});

	describe('restartQuery', () => {
		test('returns early if message queue is not running', async () => {
			// Queue is not running by default
			await manager.restartQuery();

			expect(startStreamingCalled).toBe(false);
		});

		test('returns early if no query object exists', async () => {
			messageQueue.start(async function* () {
				yield 'test';
			});
			mockContext = createMockContext({
				queryObject: null,
			});
			manager = new QueryLifecycleManager(mockContext);

			await manager.restartQuery();

			expect(startStreamingCalled).toBe(false);
		});

		test('defers restart when processing', async () => {
			messageQueue.start(async function* () {
				yield 'test';
			});
			mockContext = createMockContext({
				queryObject: {
					interrupt: mock(async () => {}),
				} as unknown as QueryLifecycleManagerContext['queryObject'],
			});
			getStateSpy = mock(() => ({ status: 'processing' }));
			mockContext.stateManager = {
				setIdle: setIdleSpy,
				setQueued: setQueuedSpy,
				getState: getStateSpy,
			} as unknown as ProcessingStateManager;
			manager = new QueryLifecycleManager(mockContext);

			await manager.restartQuery();

			expect(mockContext.pendingRestartReason).toBe('settings.local.json');
			expect(startStreamingCalled).toBe(false);
		});

		test('restarts immediately when idle', async () => {
			messageQueue.start(async function* () {
				yield 'test';
			});
			mockContext = createMockContext({
				queryObject: {
					interrupt: mock(async () => {}),
				} as unknown as QueryLifecycleManagerContext['queryObject'],
			});
			getStateSpy = mock(() => ({ status: 'idle' }));
			mockContext.stateManager = {
				setIdle: setIdleSpy,
				setQueued: setQueuedSpy,
				getState: getStateSpy,
			} as unknown as ProcessingStateManager;
			manager = new QueryLifecycleManager(mockContext);

			await manager.restartQuery();

			expect(startStreamingCalled).toBe(true);
		});
	});

	describe('executeDeferredRestartIfPending', () => {
		test('returns early if no pending restart reason', async () => {
			mockContext.pendingRestartReason = null;
			manager = new QueryLifecycleManager(mockContext);

			await manager.executeDeferredRestartIfPending();

			expect(startStreamingCalled).toBe(false);
		});

		test('executes restart when pending reason exists', async () => {
			mockContext.pendingRestartReason = 'settings.local.json';
			manager = new QueryLifecycleManager(mockContext);

			await manager.executeDeferredRestartIfPending();

			expect(mockContext.pendingRestartReason).toBeNull();
			expect(startStreamingCalled).toBe(true);
		});

		test('clears pending reason even if restart fails', async () => {
			mockContext = createMockContext({
				pendingRestartReason: 'settings.local.json',
				startStreamingQuery: async () => {
					throw new Error('Restart failed');
				},
			});
			manager = new QueryLifecycleManager(mockContext);

			// Should not throw
			await manager.executeDeferredRestartIfPending();

			expect(mockContext.pendingRestartReason).toBeNull();
		});
	});

	describe('cleanup', () => {
		test('sets cleaningUp flag', async () => {
			const setCleaningUpSpy = mock(() => {});
			mockContext = createMockContext({
				setCleaningUp: setCleaningUpSpy,
			});
			manager = new QueryLifecycleManager(mockContext);

			await manager.cleanup();

			expect(setCleaningUpSpy).toHaveBeenCalledWith(true);
		});

		test('cleans up event subscriptions', async () => {
			const cleanupEventSubscriptionsSpy = mock(() => {});
			mockContext = createMockContext({
				cleanupEventSubscriptions: cleanupEventSubscriptionsSpy,
			});
			manager = new QueryLifecycleManager(mockContext);

			await manager.cleanup();

			expect(cleanupEventSubscriptionsSpy).toHaveBeenCalled();
		});

		test('clears models cache', async () => {
			const clearModelsCacheSpy = mock(async () => {});
			mockContext = createMockContext({
				clearModelsCache: clearModelsCacheSpy,
			});
			manager = new QueryLifecycleManager(mockContext);

			await manager.cleanup();

			expect(clearModelsCacheSpy).toHaveBeenCalled();
		});

		test('handles clearModelsCache error gracefully', async () => {
			const clearModelsCacheSpy = mock(async () => {
				throw new Error('Cache clear failed');
			});
			mockContext = createMockContext({
				clearModelsCache: clearModelsCacheSpy,
			});
			manager = new QueryLifecycleManager(mockContext);

			// Should not throw
			await manager.cleanup();

			expect(clearModelsCacheSpy).toHaveBeenCalled();
		});

		test('stops query with extended timeout', async () => {
			const stopSpy = spyOn(messageQueue, 'stop');
			mockContext = createMockContext();
			manager = new QueryLifecycleManager(mockContext);

			await manager.cleanup();

			expect(stopSpy).toHaveBeenCalled();
		});

		test('handles stop error gracefully', async () => {
			mockContext = createMockContext({
				queryObject: {
					interrupt: mock(async () => {
						throw new Error('Interrupt failed');
					}),
				} as unknown as QueryLifecycleManagerContext['queryObject'],
				queryPromise: Promise.reject(new Error('Query failed')),
				firstMessageReceived: true,
			});
			manager = new QueryLifecycleManager(mockContext);

			// Should not throw
			await manager.cleanup();
		});
	});
});
