/**
 * SDKMessageHandler Tests
 *
 * Tests for processing incoming SDK messages.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	SDKMessageHandler,
	type SDKMessageHandlerContext,
} from '../../../src/lib/agent/sdk-message-handler';
import type { Session, MessageHub } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { ContextTracker } from '../../../src/lib/agent/context-tracker';
import type { MessageQueue } from '../../../src/lib/agent/message-queue';
import type { ErrorManager } from '../../../src/lib/error-manager';
import type { QueryLifecycleManager } from '../../../src/lib/agent/query-lifecycle-manager';

describe('SDKMessageHandler', () => {
	let handler: SDKMessageHandler;
	let mockSession: Session;
	let mockDb: Database;
	let mockMessageHub: MessageHub;
	let mockDaemonHub: DaemonHub;
	let mockStateManager: ProcessingStateManager;
	let mockContextTracker: ContextTracker;
	let mockMessageQueue: MessageQueue;
	let mockErrorManager: ErrorManager;
	let mockLifecycleManager: QueryLifecycleManager;
	let mockContext: SDKMessageHandlerContext;

	// Spy functions
	let saveSDKMessageSpy: ReturnType<typeof mock>;
	let updateSessionSpy: ReturnType<typeof mock>;
	let publishSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;
	let detectPhaseFromMessageSpy: ReturnType<typeof mock>;
	let setIdleSpy: ReturnType<typeof mock>;
	let setCompactingSpy: ReturnType<typeof mock>;
	let handleResultUsageSpy: ReturnType<typeof mock>;
	let getContextInfoSpy: ReturnType<typeof mock>;
	let updateWithDetailedBreakdownSpy: ReturnType<typeof mock>;
	let enqueueMessageSpy: ReturnType<typeof mock>;
	let handleErrorSpy: ReturnType<typeof mock>;
	let lifecycleStopSpy: ReturnType<typeof mock>;
	let messageQueueClearSpy: ReturnType<typeof mock>;
	let getStateSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/path',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'default',
				maxTokens: 8192,
				temperature: 1.0,
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
			},
		};

		// Database spies
		saveSDKMessageSpy = mock(() => true);
		updateSessionSpy = mock(() => {});
		mockDb = {
			saveSDKMessage: saveSDKMessageSpy,
			updateSession: updateSessionSpy,
		} as unknown as Database;

		// MessageHub spies
		publishSpy = mock(async () => {});
		mockMessageHub = {
			event: publishSpy,
			onRequest: mock((_method: string, _handler: Function) => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		// DaemonHub spies
		emitSpy = mock(async () => {});
		mockDaemonHub = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		// StateManager spies
		detectPhaseFromMessageSpy = mock(async () => {});
		setIdleSpy = mock(async () => {});
		setCompactingSpy = mock(async () => {});
		getStateSpy = mock(() => ({ phase: 'idle' }));
		mockStateManager = {
			detectPhaseFromMessage: detectPhaseFromMessageSpy,
			setIdle: setIdleSpy,
			setCompacting: setCompactingSpy,
			getState: getStateSpy,
		} as unknown as ProcessingStateManager;

		// ContextTracker spies
		handleResultUsageSpy = mock(async () => {});
		getContextInfoSpy = mock(() => ({ totalTokens: 1000, maxTokens: 128000 }));
		updateWithDetailedBreakdownSpy = mock(() => {});
		mockContextTracker = {
			handleResultUsage: handleResultUsageSpy,
			getContextInfo: getContextInfoSpy,
			updateWithDetailedBreakdown: updateWithDetailedBreakdownSpy,
		} as unknown as ContextTracker;

		// MessageQueue spies
		enqueueMessageSpy = mock(async () => 'context-id');
		messageQueueClearSpy = mock(() => {});
		mockMessageQueue = {
			enqueue: enqueueMessageSpy,
			clear: messageQueueClearSpy,
		} as unknown as MessageQueue;

		// ErrorManager spy
		handleErrorSpy = mock(async () => {});
		mockErrorManager = {
			handleError: handleErrorSpy,
		} as unknown as ErrorManager;

		// LifecycleManager spy
		lifecycleStopSpy = mock(async () => {});
		mockLifecycleManager = {
			stop: lifecycleStopSpy,
		} as unknown as QueryLifecycleManager;

		// Create context
		mockContext = {
			session: mockSession,
			db: mockDb,
			messageHub: mockMessageHub,
			daemonHub: mockDaemonHub,
			stateManager: mockStateManager,
			contextTracker: mockContextTracker,
			messageQueue: mockMessageQueue,
			errorManager: mockErrorManager,
			lifecycleManager: mockLifecycleManager,
			queryObject: null,
			queryPromise: null,
		};

		handler = new SDKMessageHandler(mockContext);
	});

	describe('constructor', () => {
		it('should create handler with dependencies', () => {
			expect(handler).toBeDefined();
		});
	});

	describe('resetCircuitBreaker', () => {
		it('should reset the circuit breaker', () => {
			handler.resetCircuitBreaker();
			// Should not throw
			expect(handler).toBeDefined();
		});
	});

	describe('markApiSuccess', () => {
		it('should mark API success', () => {
			handler.markApiSuccess();
			// Should not throw
			expect(handler).toBeDefined();
		});
	});

	describe('handleMessage', () => {
		it('should detect phase from message', async () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: 'test-uuid',
				message: { role: 'assistant', content: [] },
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(detectPhaseFromMessageSpy).toHaveBeenCalledWith(message);
		});

		it('should save message to database', async () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: 'test-uuid',
				message: { role: 'assistant', content: [] },
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(saveSDKMessageSpy).toHaveBeenCalledWith('test-session-id', message);
		});

		it('should publish message delta', async () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: 'test-uuid',
				message: { role: 'assistant', content: [] },
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(publishSpy).toHaveBeenCalledWith(
				'state.sdkMessages.delta',
				expect.objectContaining({
					added: [message],
					timestamp: expect.any(Number),
					version: expect.any(Number),
				}),
				{ room: 'session:test-session-id' }
			);
		});

		it('should skip broadcasting if DB save fails', async () => {
			saveSDKMessageSpy.mockReturnValue(false);

			const message: SDKMessage = {
				type: 'assistant',
				uuid: 'test-uuid',
				message: { role: 'assistant', content: [] },
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(publishSpy).not.toHaveBeenCalled();
		});

		it('should mark user messages as synthetic', async () => {
			const message: SDKMessage = {
				type: 'user',
				uuid: 'test-uuid',
				message: { role: 'user', content: 'Hello' },
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect((message as unknown as { isSynthetic: boolean }).isSynthetic).toBe(true);
		});
	});

	describe('handleSystemMessage', () => {
		it('should capture SDK session ID', async () => {
			const message: SDKMessage = {
				type: 'system',
				subtype: 'init',
				uuid: 'test-uuid',
				session_id: 'sdk-session-123',
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(mockSession.sdkSessionId).toBe('sdk-session-123');
			expect(updateSessionSpy).toHaveBeenCalledWith('test-session-id', {
				sdkSessionId: 'sdk-session-123',
			});
			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: 'test-session-id',
				source: 'sdk-session',
				session: { sdkSessionId: 'sdk-session-123' },
			});
		});

		it('should not update if SDK session ID already set', async () => {
			mockSession.sdkSessionId = 'existing-session-id';

			const message: SDKMessage = {
				type: 'system',
				subtype: 'init',
				uuid: 'test-uuid',
				session_id: 'new-session-123',
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(mockSession.sdkSessionId).toBe('existing-session-id');
		});
	});

	describe('handleResultMessage', () => {
		it('should update session metadata with token usage', async () => {
			const message: SDKMessage = {
				type: 'result',
				subtype: 'success',
				uuid: 'test-uuid',
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_read_input_tokens: 10,
					cache_creation_input_tokens: 5,
				},
				total_cost_usd: 0.001,
				modelUsage: {},
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(mockSession.metadata?.inputTokens).toBe(100);
			expect(mockSession.metadata?.outputTokens).toBe(50);
			expect(mockSession.metadata?.totalTokens).toBe(150);
			expect(updateSessionSpy).toHaveBeenCalled();
		});

		it('should emit session.updated event', async () => {
			const message: SDKMessage = {
				type: 'result',
				subtype: 'success',
				uuid: 'test-uuid',
				usage: {
					input_tokens: 100,
					output_tokens: 50,
				},
				total_cost_usd: 0.001,
				modelUsage: {},
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(emitSpy).toHaveBeenCalledWith(
				'session.updated',
				expect.objectContaining({
					sessionId: 'test-session-id',
					source: 'metadata',
				})
			);
		});

		it('should call context tracker handleResultUsage', async () => {
			const message: SDKMessage = {
				type: 'result',
				subtype: 'success',
				uuid: 'test-uuid',
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_read_input_tokens: 10,
					cache_creation_input_tokens: 5,
				},
				total_cost_usd: 0.001,
				modelUsage: { model1: { tokens: 100 } },
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(handleResultUsageSpy).toHaveBeenCalled();
		});

		it('should queue /context command', async () => {
			const message: SDKMessage = {
				type: 'result',
				subtype: 'success',
				uuid: 'test-uuid',
				usage: {
					input_tokens: 100,
					output_tokens: 50,
				},
				total_cost_usd: 0.001,
				modelUsage: {},
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(enqueueMessageSpy).toHaveBeenCalledWith('/context', true);
		});

		it('should set state to idle', async () => {
			const message: SDKMessage = {
				type: 'result',
				subtype: 'success',
				uuid: 'test-uuid',
				usage: {
					input_tokens: 100,
					output_tokens: 50,
				},
				total_cost_usd: 0.001,
				modelUsage: {},
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(setIdleSpy).toHaveBeenCalled();
		});

		it('should emit session.errorClear event', async () => {
			const message: SDKMessage = {
				type: 'result',
				subtype: 'success',
				uuid: 'test-uuid',
				usage: {
					input_tokens: 100,
					output_tokens: 50,
				},
				total_cost_usd: 0.001,
				modelUsage: {},
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(emitSpy).toHaveBeenCalledWith('session.errorClear', {
				sessionId: 'test-session-id',
			});
		});

		it('should detect SDK cost reset and update baseline', async () => {
			// First result - SDK reports 1.0
			mockSession.metadata = {
				...mockSession.metadata,
				lastSdkCost: 1.0,
				costBaseline: 0,
				totalCost: 1.0,
			};

			// SDK reset - now reports 0.5 (less than last 1.0)
			const message: SDKMessage = {
				type: 'result',
				subtype: 'success',
				uuid: 'test-uuid',
				usage: { input_tokens: 100, output_tokens: 50 },
				total_cost_usd: 0.5, // Less than lastSdkCost (1.0)
				modelUsage: {},
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			// New baseline should be old baseline (0) + old lastSdkCost (1.0) = 1.0
			// Total cost should be new baseline (1.0) + current SDK cost (0.5) = 1.5
			expect(mockSession.metadata?.costBaseline).toBe(1.0);
			expect(mockSession.metadata?.totalCost).toBe(1.5);
			expect(mockSession.metadata?.lastSdkCost).toBe(0.5);
		});
	});

	describe('handleAssistantMessage', () => {
		it('should update tool call count', async () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: 'test-uuid',
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
						{ type: 'tool_use', id: 'tool-2', name: 'Write', input: {} },
					],
				},
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(mockSession.metadata?.toolCallCount).toBe(2);
		});

		it('should emit session.updated event for tool calls', async () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: 'test-uuid',
				message: {
					role: 'assistant',
					content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
				},
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(emitSpy).toHaveBeenCalledWith(
				'session.updated',
				expect.objectContaining({
					sessionId: 'test-session-id',
					source: 'metadata',
				})
			);
		});

		it('should not update if no tool calls', async () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: 'test-uuid',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
				},
			} as unknown as SDKMessage;

			const initialToolCount = mockSession.metadata?.toolCallCount || 0;

			await handler.handleMessage(message);

			expect(mockSession.metadata?.toolCallCount).toBe(initialToolCount);
		});
	});

	describe('handleStatusMessage', () => {
		it('should set compacting state when status is compacting', async () => {
			const message: SDKMessage = {
				type: 'system',
				subtype: 'status',
				uuid: 'test-uuid',
				status: 'compacting',
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(setCompactingSpy).toHaveBeenCalledWith(true);
		});

		it('should not set compacting for other statuses', async () => {
			const message: SDKMessage = {
				type: 'system',
				subtype: 'status',
				uuid: 'test-uuid',
				status: 'thinking',
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			// setCompacting should not be called for 'thinking' status
			expect(setCompactingSpy).not.toHaveBeenCalled();
		});
	});

	describe('handleCompactBoundary', () => {
		it('should clear compacting state', async () => {
			const message: SDKMessage = {
				type: 'system',
				subtype: 'compact_boundary',
				uuid: 'test-uuid',
				compact_metadata: {
					trigger: 'auto',
					pre_tokens: 50000,
				},
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(setCompactingSpy).toHaveBeenCalledWith(false);
		});
	});

	describe('circuit breaker integration', () => {
		it('should handle circuit breaker trip with active query', async () => {
			// Set up context with active query
			mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();

			// Create handler fresh with the context that has query
			const handlerWithQuery = new SDKMessageHandler(mockContext);

			// Send many error messages to trip the circuit breaker
			const errorMessage: SDKMessage = {
				type: 'user',
				uuid: 'error-uuid',
				message: {
					role: 'user',
					content:
						'<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
				},
			} as unknown as SDKMessage;

			// Trip the circuit breaker by sending multiple error messages
			for (let i = 0; i < 4; i++) {
				await handlerWithQuery.handleMessage({
					...errorMessage,
					uuid: `error-uuid-${i}`,
				} as SDKMessage);
			}

			// Give async callback time to execute
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify circuit breaker tripped and stopped the query
			expect(lifecycleStopSpy).toHaveBeenCalledWith({ catchQueryErrors: true });
			expect(setIdleSpy).toHaveBeenCalled();
		});

		it('should handle circuit breaker trip without active query', async () => {
			// No query object or promise
			mockContext.queryObject = null;
			mockContext.queryPromise = null;

			// Create handler fresh
			const handlerNoQuery = new SDKMessageHandler(mockContext);

			// Trip the circuit breaker
			const errorMessage: SDKMessage = {
				type: 'user',
				uuid: 'error-uuid',
				message: {
					role: 'user',
					content:
						'<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
				},
			} as unknown as SDKMessage;

			for (let i = 0; i < 4; i++) {
				await handlerNoQuery.handleMessage({
					...errorMessage,
					uuid: `error-uuid-${i}`,
				} as SDKMessage);
			}

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should NOT call stop if no query running
			expect(lifecycleStopSpy).not.toHaveBeenCalled();
			// But should still reset to idle
			expect(setIdleSpy).toHaveBeenCalled();
		});

		it('should display error as assistant message when circuit breaker trips', async () => {
			mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();

			const handlerWithQuery = new SDKMessageHandler(mockContext);

			// Trip the circuit breaker
			const errorMessage: SDKMessage = {
				type: 'user',
				uuid: 'error-uuid',
				message: {
					role: 'user',
					content:
						'<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
				},
			} as unknown as SDKMessage;

			for (let i = 0; i < 4; i++) {
				await handlerWithQuery.handleMessage({
					...errorMessage,
					uuid: `error-uuid-${i}`,
				} as SDKMessage);
			}

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify an assistant message was saved
			const saveCalls = saveSDKMessageSpy.mock.calls;
			const assistantSaves = saveCalls.filter(
				(call: unknown[]) => (call[1] as SDKMessage).type === 'assistant'
			);
			expect(assistantSaves.length).toBeGreaterThan(0);
		});

		it('should report error to error manager on trip', async () => {
			mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();

			const handlerWithQuery = new SDKMessageHandler(mockContext);

			// Trip the circuit breaker
			const errorMessage: SDKMessage = {
				type: 'user',
				uuid: 'error-uuid',
				message: {
					role: 'user',
					content:
						'<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
				},
			} as unknown as SDKMessage;

			for (let i = 0; i < 4; i++) {
				await handlerWithQuery.handleMessage({
					...errorMessage,
					uuid: `error-uuid-${i}`,
				} as SDKMessage);
			}

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify error manager was called
			expect(handleErrorSpy).toHaveBeenCalled();
		});

		it('should clear message queue when circuit breaker trips', async () => {
			mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();

			const handlerWithQuery = new SDKMessageHandler(mockContext);

			// Trip the circuit breaker
			const errorMessage: SDKMessage = {
				type: 'user',
				uuid: 'error-uuid',
				message: {
					role: 'user',
					content:
						'<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
				},
			} as unknown as SDKMessage;

			for (let i = 0; i < 4; i++) {
				await handlerWithQuery.handleMessage({
					...errorMessage,
					uuid: `error-uuid-${i}`,
				} as SDKMessage);
			}

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify message queue was cleared
			expect(messageQueueClearSpy).toHaveBeenCalled();
		});

		it('should emit session.errorClear when circuit breaker trips', async () => {
			mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();

			const handlerWithQuery = new SDKMessageHandler(mockContext);

			// Trip the circuit breaker
			const errorMessage: SDKMessage = {
				type: 'user',
				uuid: 'error-uuid',
				message: {
					role: 'user',
					content:
						'<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
				},
			} as unknown as SDKMessage;

			for (let i = 0; i < 4; i++) {
				await handlerWithQuery.handleMessage({
					...errorMessage,
					uuid: `error-uuid-${i}`,
				} as SDKMessage);
			}

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify session.errorClear was emitted
			expect(emitSpy).toHaveBeenCalledWith('session.errorClear', {
				sessionId: 'test-session-id',
			});
		});
	});

	describe('handleContextResponse', () => {
		it('should process valid /context response and update context tracker', async () => {
			// Create a valid /context response message (type: user, isReplay: true)
			const contextResponseMessage: SDKMessage = {
				type: 'user',
				uuid: 'context-response-uuid',
				isReplay: true,
				message: {
					role: 'user',
					content: `<local-command-stdout>
# Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 62.5k / 200.0k (31%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.2k | 1.6% |
| System tools | 14.3k | 7.1% |
| Messages | 40k | 20% |
| Free space | 137.5k | 68.7% |
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			await handler.handleMessage(contextResponseMessage);

			// Context response should NOT be saved to DB (early return)
			expect(saveSDKMessageSpy).not.toHaveBeenCalled();

			// But context tracker should be updated
			expect(updateWithDetailedBreakdownSpy).toHaveBeenCalled();
		});

		it('should emit context update event via DaemonHub', async () => {
			const contextResponseMessage: SDKMessage = {
				type: 'user',
				uuid: 'context-response-uuid',
				isReplay: true,
				message: {
					role: 'user',
					content: `<local-command-stdout>
# Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 50.0k / 200.0k (25%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 5k | 2.5% |
| System tools | 10k | 5% |
| Messages | 35k | 17.5% |
| Free space | 150k | 75% |
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			await handler.handleMessage(contextResponseMessage);

			// Should emit context.updated via daemonHub
			expect(emitSpy).toHaveBeenCalledWith(
				'context.updated',
				expect.objectContaining({
					sessionId: 'test-session-id',
					contextInfo: expect.any(Object),
				})
			);
		});

		it('should skip context response without saving to DB', async () => {
			const contextResponseMessage: SDKMessage = {
				type: 'user',
				uuid: 'context-response-uuid',
				isReplay: true,
				message: {
					role: 'user',
					content: `<local-command-stdout>
# Context Usage

**Model:** claude-sonnet-4-5-20250929
**Tokens:** 10k / 200.0k (5%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2k | 1% |
| Free space | 190k | 95% |
</local-command-stdout>`,
				},
			} as unknown as SDKMessage;

			await handler.handleMessage(contextResponseMessage);

			// Should NOT save to DB
			expect(saveSDKMessageSpy).not.toHaveBeenCalled();
			// Should NOT publish to MessageHub
			expect(publishSpy).not.toHaveBeenCalled();
		});

		it('should handle context response parsing failure gracefully', async () => {
			// Create a context response with invalid format
			const invalidContextMessage: SDKMessage = {
				type: 'user',
				uuid: 'invalid-context-uuid',
				isReplay: true,
				message: {
					role: 'user',
					content: '<local-command-stdout>Context Usage - invalid format</local-command-stdout>',
				},
			} as unknown as SDKMessage;

			// Should not throw
			await handler.handleMessage(invalidContextMessage);

			// Context tracker should NOT be updated (parsing failed)
			expect(updateWithDetailedBreakdownSpy).not.toHaveBeenCalled();
		});
	});

	describe('markApiSuccess', () => {
		it('should not throw when called', () => {
			expect(() => handler.markApiSuccess()).not.toThrow();
		});

		it('should reset circuit breaker error tracking', async () => {
			// First, trigger some errors but not enough to trip
			const errorMessage: SDKMessage = {
				type: 'user',
				uuid: 'error-uuid',
				message: {
					role: 'user',
					content:
						'<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
				},
			} as unknown as SDKMessage;

			// Send 2 errors (not enough to trip with threshold of 3)
			await handler.handleMessage(errorMessage);
			await handler.handleMessage({ ...errorMessage, uuid: 'error-uuid-2' } as SDKMessage);

			// Mark success to reset error tracking
			handler.markApiSuccess();

			// Send one more error - should NOT trip since errors were reset
			await handler.handleMessage({ ...errorMessage, uuid: 'error-uuid-3' } as SDKMessage);

			// Should NOT have tripped (no stop called)
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(lifecycleStopSpy).not.toHaveBeenCalled();
		});
	});

	describe('resetCircuitBreaker', () => {
		it('should not throw when called', () => {
			expect(() => handler.resetCircuitBreaker()).not.toThrow();
		});

		it('should fully reset circuit breaker state', async () => {
			mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
			mockContext.queryPromise = Promise.resolve();

			const handlerWithQuery = new SDKMessageHandler(mockContext);

			// Trip the circuit breaker
			const errorMessage: SDKMessage = {
				type: 'user',
				uuid: 'error-uuid',
				message: {
					role: 'user',
					content:
						'<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
				},
			} as unknown as SDKMessage;

			for (let i = 0; i < 4; i++) {
				await handlerWithQuery.handleMessage({
					...errorMessage,
					uuid: `error-uuid-${i}`,
				} as SDKMessage);
			}

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify it was tripped
			expect(lifecycleStopSpy).toHaveBeenCalled();

			// Reset all mocks
			lifecycleStopSpy.mockClear();

			// Reset the circuit breaker
			handlerWithQuery.resetCircuitBreaker();

			// Try to trip again - should work after reset
			for (let i = 0; i < 4; i++) {
				await handlerWithQuery.handleMessage({
					...errorMessage,
					uuid: `error-uuid-new-${i}`,
				} as SDKMessage);
			}

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should have tripped again
			expect(lifecycleStopSpy).toHaveBeenCalled();
		});
	});
});
