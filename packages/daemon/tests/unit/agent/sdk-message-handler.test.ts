/**
 * SDKMessageHandler Tests
 *
 * Tests for processing incoming SDK messages.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { SDKMessageHandler } from '../../../src/lib/agent/sdk-message-handler';
import type { Session, MessageHub } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { ContextTracker } from '../../../src/lib/agent/context-tracker';

describe('SDKMessageHandler', () => {
	let handler: SDKMessageHandler;
	let mockSession: Session;
	let mockDb: Database;
	let mockMessageHub: MessageHub;
	let mockDaemonHub: DaemonHub;
	let mockStateManager: ProcessingStateManager;
	let mockContextTracker: ContextTracker;

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
			publish: publishSpy,
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
		mockStateManager = {
			detectPhaseFromMessage: detectPhaseFromMessageSpy,
			setIdle: setIdleSpy,
			setCompacting: setCompactingSpy,
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

		handler = new SDKMessageHandler(
			mockSession,
			mockDb,
			mockMessageHub,
			mockDaemonHub,
			mockStateManager,
			mockContextTracker
		);
	});

	describe('constructor', () => {
		it('should create handler with dependencies', () => {
			expect(handler).toBeDefined();
		});
	});

	describe('setQueueMessageCallback', () => {
		it('should set the queue message callback', () => {
			const callback = mock(async () => 'message-id');
			handler.setQueueMessageCallback(callback);
			// No direct way to verify, but should not throw
			expect(handler).toBeDefined();
		});
	});

	describe('setCircuitBreakerTripCallback', () => {
		it('should set the circuit breaker trip callback', () => {
			const callback = mock(async () => {});
			handler.setCircuitBreakerTripCallback(callback);
			expect(handler).toBeDefined();
		});
	});

	describe('setCheckpointCallback', () => {
		it('should set the checkpoint callback', () => {
			const callback = mock(() => {});
			handler.setCheckpointCallback(callback);
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
				{ sessionId: 'test-session-id' }
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

		it('should call checkpoint callback if set', async () => {
			const checkpointCallback = mock(() => {});
			handler.setCheckpointCallback(checkpointCallback);

			const message: SDKMessage = {
				type: 'user',
				uuid: 'test-uuid',
				message: { role: 'user', content: 'Hello' },
			} as unknown as SDKMessage;

			await handler.handleMessage(message);

			expect(checkpointCallback).toHaveBeenCalledWith(message);
		});

		it('should handle checkpoint callback errors gracefully', async () => {
			const checkpointCallback = mock(() => {
				throw new Error('Checkpoint error');
			});
			handler.setCheckpointCallback(checkpointCallback);

			const message: SDKMessage = {
				type: 'assistant',
				uuid: 'test-uuid',
				message: { role: 'assistant', content: [] },
			} as unknown as SDKMessage;

			// Should not throw
			await handler.handleMessage(message);
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
			const queueMessageSpy = mock(async () => 'context-id');
			handler.setQueueMessageCallback(queueMessageSpy);

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

			expect(queueMessageSpy).toHaveBeenCalledWith('/context', true);
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
});
