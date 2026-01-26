/**
 * EventSubscriptionSetup Tests
 *
 * Tests for DaemonHub event subscription setup.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	EventSubscriptionSetup,
	type EventHandlers,
} from '../../../src/lib/agent/event-subscription-setup';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Logger } from '../../../src/lib/logger';

describe('EventSubscriptionSetup', () => {
	let setup: EventSubscriptionSetup;
	let mockDaemonHub: DaemonHub;
	let mockLogger: Logger;
	let mockHandlers: EventHandlers;

	let onSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;
	let unsubscribeSpy: ReturnType<typeof mock>;

	// Store callbacks registered via daemonHub.on()
	let registeredCallbacks: Map<string, (data: unknown) => Promise<void>>;

	beforeEach(() => {
		registeredCallbacks = new Map();
		unsubscribeSpy = mock(() => {});

		// Mock daemonHub.on to capture callbacks and return unsubscribe function
		onSpy = mock((event: string, callback: (data: unknown) => Promise<void>) => {
			registeredCallbacks.set(event, callback);
			return unsubscribeSpy;
		});

		emitSpy = mock(async () => {});

		mockDaemonHub = {
			on: onSpy,
			emit: emitSpy,
		} as unknown as DaemonHub;

		mockLogger = {
			log: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock(() => {}),
			info: mock(() => {}),
		} as unknown as Logger;

		mockHandlers = {
			onModelSwitchRequest: mock(async () => ({ success: true, model: 'test-model' })),
			onInterruptRequest: mock(async () => {}),
			onResetRequest: mock(async () => ({ success: true })),
			onMessagePersisted: mock(async () => {}),
			onQueryTrigger: mock(async () => ({ success: true, messageCount: 1 })),
			onSendQueuedOnTurnEnd: mock(async () => {}),
		};

		setup = new EventSubscriptionSetup('test-session-id', mockDaemonHub, mockLogger);
	});

	describe('constructor', () => {
		it('should create setup with dependencies', () => {
			expect(setup).toBeDefined();
		});
	});

	describe('setup', () => {
		it('should register all event subscriptions', () => {
			setup.setup(mockHandlers);

			// Should register 6 event handlers
			expect(onSpy).toHaveBeenCalledTimes(6);
			expect(registeredCallbacks.has('model.switchRequest')).toBe(true);
			expect(registeredCallbacks.has('agent.interruptRequest')).toBe(true);
			expect(registeredCallbacks.has('agent.resetRequest')).toBe(true);
			expect(registeredCallbacks.has('message.persisted')).toBe(true);
			expect(registeredCallbacks.has('query.trigger')).toBe(true);
			expect(registeredCallbacks.has('query.sendQueuedOnTurnEnd')).toBe(true);
		});

		it('should pass sessionId to subscription options', () => {
			setup.setup(mockHandlers);

			// All subscriptions should include sessionId option
			for (const call of onSpy.mock.calls) {
				expect(call[2]).toEqual({ sessionId: 'test-session-id' });
			}
		});

		it('should log initialization message', () => {
			setup.setup(mockHandlers);

			expect(mockLogger.log).toHaveBeenCalledWith(
				expect.stringContaining('DaemonHub subscriptions initialized')
			);
		});

		describe('model.switchRequest handler', () => {
			it('should call onModelSwitchRequest and emit result', async () => {
				setup.setup(mockHandlers);

				const callback = registeredCallbacks.get('model.switchRequest')!;
				await callback({ sessionId: 'test-session-id', model: 'opus' });

				expect(mockHandlers.onModelSwitchRequest).toHaveBeenCalledWith('opus');
				expect(emitSpy).toHaveBeenCalledWith('model.switched', {
					sessionId: 'test-session-id',
					success: true,
					model: 'test-model',
					error: undefined,
				});
			});

			it('should handle switch errors', async () => {
				(mockHandlers.onModelSwitchRequest as ReturnType<typeof mock>).mockResolvedValue({
					success: false,
					model: 'opus',
					error: 'Invalid model',
				});

				setup.setup(mockHandlers);

				const callback = registeredCallbacks.get('model.switchRequest')!;
				await callback({ sessionId: 'test-session-id', model: 'opus' });

				expect(emitSpy).toHaveBeenCalledWith('model.switched', {
					sessionId: 'test-session-id',
					success: false,
					model: 'opus',
					error: 'Invalid model',
				});
			});
		});

		describe('agent.interruptRequest handler', () => {
			it('should call onInterruptRequest and emit interrupted', async () => {
				setup.setup(mockHandlers);

				const callback = registeredCallbacks.get('agent.interruptRequest')!;
				await callback({ sessionId: 'test-session-id' });

				expect(mockHandlers.onInterruptRequest).toHaveBeenCalled();
				expect(emitSpy).toHaveBeenCalledWith('agent.interrupted', {
					sessionId: 'test-session-id',
				});
			});
		});

		describe('agent.resetRequest handler', () => {
			it('should call onResetRequest with restartQuery flag', async () => {
				setup.setup(mockHandlers);

				const callback = registeredCallbacks.get('agent.resetRequest')!;
				await callback({ sessionId: 'test-session-id', restartQuery: false });

				expect(mockHandlers.onResetRequest).toHaveBeenCalledWith(false);
				expect(emitSpy).toHaveBeenCalledWith('agent.reset', {
					sessionId: 'test-session-id',
					success: true,
					error: undefined,
				});
			});

			it('should default restartQuery to true if not provided', async () => {
				setup.setup(mockHandlers);

				const callback = registeredCallbacks.get('agent.resetRequest')!;
				await callback({ sessionId: 'test-session-id' });

				expect(mockHandlers.onResetRequest).toHaveBeenCalledWith(true);
			});

			it('should handle reset errors', async () => {
				(mockHandlers.onResetRequest as ReturnType<typeof mock>).mockResolvedValue({
					success: false,
					error: 'Reset failed',
				});

				setup.setup(mockHandlers);

				const callback = registeredCallbacks.get('agent.resetRequest')!;
				await callback({ sessionId: 'test-session-id', restartQuery: true });

				expect(emitSpy).toHaveBeenCalledWith('agent.reset', {
					sessionId: 'test-session-id',
					success: false,
					error: 'Reset failed',
				});
			});
		});

		describe('message.persisted handler', () => {
			it('should call onMessagePersisted with messageId and content', async () => {
				setup.setup(mockHandlers);

				const callback = registeredCallbacks.get('message.persisted')!;
				await callback({
					sessionId: 'test-session-id',
					messageId: 'msg-123',
					messageContent: { text: 'Hello' },
				});

				expect(mockHandlers.onMessagePersisted).toHaveBeenCalledWith('msg-123', {
					text: 'Hello',
				});
			});
		});

		describe('query.trigger handler', () => {
			it('should call onQueryTrigger', async () => {
				setup.setup(mockHandlers);

				const callback = registeredCallbacks.get('query.trigger')!;
				await callback({ sessionId: 'test-session-id' });

				expect(mockHandlers.onQueryTrigger).toHaveBeenCalled();
			});
		});

		describe('query.sendQueuedOnTurnEnd handler', () => {
			it('should call onSendQueuedOnTurnEnd', async () => {
				setup.setup(mockHandlers);

				const callback = registeredCallbacks.get('query.sendQueuedOnTurnEnd')!;
				await callback({ sessionId: 'test-session-id' });

				expect(mockHandlers.onSendQueuedOnTurnEnd).toHaveBeenCalled();
			});
		});
	});

	describe('cleanup', () => {
		it('should call all unsubscribe functions', () => {
			setup.setup(mockHandlers);
			setup.cleanup();

			// 6 subscriptions = 6 unsubscribe calls
			expect(unsubscribeSpy).toHaveBeenCalledTimes(6);
		});

		it('should clear unsubscribers array', () => {
			setup.setup(mockHandlers);
			setup.cleanup();

			// Second cleanup should not call unsubscribe again
			setup.cleanup();
			expect(unsubscribeSpy).toHaveBeenCalledTimes(6); // Still 6, not 12
		});

		it('should handle unsubscribe errors gracefully', () => {
			// Make unsubscribe throw
			unsubscribeSpy.mockImplementation(() => {
				throw new Error('Unsubscribe failed');
			});

			setup.setup(mockHandlers);

			// Should not throw
			setup.cleanup();

			expect(mockLogger.error).toHaveBeenCalledWith('Error during unsubscribe:', expect.any(Error));
		});

		it('should work when called before setup', () => {
			// Should not throw
			setup.cleanup();
			expect(unsubscribeSpy).not.toHaveBeenCalled();
		});
	});
});
