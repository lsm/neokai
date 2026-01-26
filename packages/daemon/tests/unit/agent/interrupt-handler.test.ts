/**
 * InterruptHandler Tests
 *
 * Tests for query interrupt handling.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	InterruptHandler,
	type InterruptHandlerDependencies,
} from '../../../src/lib/agent/interrupt-handler';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { MessageHub } from '@liuboer/shared';
import type { MessageQueue } from '../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { Logger } from '../../../src/lib/logger';

describe('InterruptHandler', () => {
	let handler: InterruptHandler;
	let mockMessageHub: MessageHub;
	let mockMessageQueue: MessageQueue;
	let mockStateManager: ProcessingStateManager;
	let mockLogger: Logger;
	let mockQueryObject: Query | null;
	let mockAbortController: AbortController | null;
	let mockQueryPromise: Promise<void> | null;

	let publishSpy: ReturnType<typeof mock>;
	let setInterruptedSpy: ReturnType<typeof mock>;
	let setIdleSpy: ReturnType<typeof mock>;
	let getStateSpy: ReturnType<typeof mock>;
	let queueSizeSpy: ReturnType<typeof mock>;
	let queueClearSpy: ReturnType<typeof mock>;
	let queueStopSpy: ReturnType<typeof mock>;
	let sdkInterruptSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		publishSpy = mock(async () => {});
		mockMessageHub = {
			publish: publishSpy,
		} as unknown as MessageHub;

		queueSizeSpy = mock(() => 0);
		queueClearSpy = mock(() => {});
		queueStopSpy = mock(() => {});
		mockMessageQueue = {
			size: queueSizeSpy,
			clear: queueClearSpy,
			stop: queueStopSpy,
		} as unknown as MessageQueue;

		setInterruptedSpy = mock(async () => {});
		setIdleSpy = mock(async () => {});
		getStateSpy = mock(() => ({ status: 'processing', phase: 'streaming' }));
		mockStateManager = {
			setInterrupted: setInterruptedSpy,
			setIdle: setIdleSpy,
			getState: getStateSpy,
		} as unknown as ProcessingStateManager;

		mockLogger = {
			log: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock(() => {}),
			info: mock(() => {}),
		} as unknown as Logger;

		sdkInterruptSpy = mock(async () => {});
		mockQueryObject = {
			interrupt: sdkInterruptSpy,
		} as unknown as Query;

		mockAbortController = new AbortController();
		mockQueryPromise = null;
	});

	function createHandler(overrides: Partial<InterruptHandlerDependencies> = {}): InterruptHandler {
		const setQueryObjectSpy = mock(() => {});
		const setAbortControllerSpy = mock(() => {});

		const deps: InterruptHandlerDependencies = {
			sessionId: 'test-session-id',
			messageHub: mockMessageHub,
			messageQueue: mockMessageQueue,
			stateManager: mockStateManager,
			logger: mockLogger,
			getQueryObject: () => mockQueryObject,
			setQueryObject: setQueryObjectSpy,
			getQueryPromise: () => mockQueryPromise,
			getQueryAbortController: () => mockAbortController,
			setQueryAbortController: setAbortControllerSpy,
			...overrides,
		};
		return new InterruptHandler(deps);
	}

	describe('constructor', () => {
		it('should create handler with dependencies', () => {
			handler = createHandler();
			expect(handler).toBeDefined();
		});
	});

	describe('getInterruptPromise', () => {
		it('should return null when no interrupt is in progress', () => {
			handler = createHandler();
			expect(handler.getInterruptPromise()).toBeNull();
		});
	});

	describe('handleInterrupt', () => {
		it('should skip interrupt if already idle', async () => {
			getStateSpy.mockReturnValue({ status: 'idle' });
			handler = createHandler();

			await handler.handleInterrupt();

			expect(setInterruptedSpy).not.toHaveBeenCalled();
			expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Already idle'));
		});

		it('should skip interrupt if already interrupted', async () => {
			getStateSpy.mockReturnValue({ status: 'interrupted' });
			handler = createHandler();

			await handler.handleInterrupt();

			expect(setInterruptedSpy).not.toHaveBeenCalled();
			expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Already interrupted'));
		});

		it('should set state to interrupted', async () => {
			handler = createHandler();

			await handler.handleInterrupt();

			expect(setInterruptedSpy).toHaveBeenCalled();
		});

		it('should clear message queue if has pending messages', async () => {
			queueSizeSpy.mockReturnValue(5);
			handler = createHandler();

			await handler.handleInterrupt();

			expect(queueClearSpy).toHaveBeenCalled();
			expect(mockLogger.log).toHaveBeenCalledWith(
				expect.stringContaining('Clearing 5 queued messages')
			);
		});

		it('should abort the query controller', async () => {
			const abortController = new AbortController();
			const setAbortControllerSpy = mock(() => {});
			handler = createHandler({
				getQueryAbortController: () => abortController,
				setQueryAbortController: setAbortControllerSpy,
			});

			await handler.handleInterrupt();

			expect(abortController.signal.aborted).toBe(true);
			expect(setAbortControllerSpy).toHaveBeenCalledWith(null);
		});

		it('should call SDK interrupt()', async () => {
			handler = createHandler();

			await handler.handleInterrupt();

			expect(sdkInterruptSpy).toHaveBeenCalled();
		});

		it('should handle SDK interrupt() failure gracefully', async () => {
			sdkInterruptSpy.mockRejectedValue(new Error('Interrupt failed'));
			handler = createHandler();

			await handler.handleInterrupt();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('SDK interrupt() failed'),
				'Interrupt failed'
			);
		});

		it('should handle missing query object gracefully', async () => {
			mockQueryObject = null;
			handler = createHandler({ getQueryObject: () => null });

			await handler.handleInterrupt();

			expect(sdkInterruptSpy).not.toHaveBeenCalled();
			expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('No query object'));
		});

		it('should wait for old query to finish', async () => {
			mockQueryPromise = new Promise((resolve) => setTimeout(resolve, 10));
			handler = createHandler({ getQueryPromise: () => mockQueryPromise });

			await handler.handleInterrupt();

			expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Waiting for old query'));
		});

		it('should handle error waiting for old query', async () => {
			mockQueryPromise = Promise.reject(new Error('Query error'));
			handler = createHandler({ getQueryPromise: () => mockQueryPromise });

			await handler.handleInterrupt();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Error waiting for old query'),
				expect.any(Error)
			);
		});

		it('should clear queryObject reference', async () => {
			const setQueryObjectSpy = mock(() => {});
			handler = createHandler({ setQueryObject: setQueryObjectSpy });

			await handler.handleInterrupt();

			expect(setQueryObjectSpy).toHaveBeenCalledWith(null);
		});

		it('should stop the message queue', async () => {
			handler = createHandler();

			await handler.handleInterrupt();

			expect(queueStopSpy).toHaveBeenCalled();
		});

		it('should publish session.interrupted event', async () => {
			handler = createHandler();

			await handler.handleInterrupt();

			expect(publishSpy).toHaveBeenCalledWith(
				'session.interrupted',
				{},
				{ sessionId: 'test-session-id' }
			);
		});

		it('should set state back to idle', async () => {
			handler = createHandler();

			await handler.handleInterrupt();

			expect(setIdleSpy).toHaveBeenCalled();
		});

		it('should resolve interrupt promise in finally block', async () => {
			handler = createHandler();

			// Verify interrupt promise is resolved
			const interruptComplete = handler.handleInterrupt();
			await interruptComplete;

			// Promise should be cleared
			expect(handler.getInterruptPromise()).toBeNull();
		});

		it('should handle query object without interrupt method', async () => {
			mockQueryObject = {} as Query; // No interrupt method
			handler = createHandler({ getQueryObject: () => mockQueryObject });

			await handler.handleInterrupt();

			// Should not throw, should log and continue
			expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('No query object'));
		});
	});
});
