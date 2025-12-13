/**
 * ProcessingStateManager Tests
 *
 * Tests state machine transitions, phase tracking,
 * and EventBus integration.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../src/lib/processing-state-manager';
import { EventBus } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';

describe('ProcessingStateManager', () => {
	let stateManager: ProcessingStateManager;
	let mockEventBus: EventBus;
	let emitSpy: ReturnType<typeof mock>;
	const testSessionId = generateUUID();

	beforeEach(() => {
		// Create mock EventBus
		emitSpy = mock(async () => {});
		mockEventBus = {
			emit: emitSpy,
		} as unknown as EventBus;

		stateManager = new ProcessingStateManager(testSessionId, mockEventBus);
	});

	describe('initial state', () => {
		it('should start in idle state', () => {
			const state = stateManager.getState();
			expect(state.status).toBe('idle');
		});

		it('should report isIdle as true', () => {
			expect(stateManager.isIdle()).toBe(true);
		});

		it('should report isProcessing as false', () => {
			expect(stateManager.isProcessing()).toBe(false);
		});
	});

	describe('state transitions', () => {
		it('should transition from idle to queued', async () => {
			await stateManager.setQueued('msg-123');

			const state = stateManager.getState();
			expect(state.status).toBe('queued');
			expect(state.messageId).toBe('msg-123');
			expect(stateManager.isIdle()).toBe(false);

			// Should emit event
			expect(emitSpy).toHaveBeenCalledWith('agent-state:changed', {
				sessionId: testSessionId,
				state: expect.objectContaining({
					status: 'queued',
					messageId: 'msg-123',
				}),
			});
		});

		it('should transition from queued to processing', async () => {
			await stateManager.setQueued('msg-123');
			await stateManager.setProcessing('msg-123', 'initializing');

			const state = stateManager.getState();
			expect(state.status).toBe('processing');
			expect(state.messageId).toBe('msg-123');
			expect(state.phase).toBe('initializing');
			expect(stateManager.isProcessing()).toBe(true);
		});

		it('should transition from processing to idle', async () => {
			await stateManager.setProcessing('msg-123', 'initializing');
			await stateManager.setIdle();

			const state = stateManager.getState();
			expect(state.status).toBe('idle');
			expect(stateManager.isIdle()).toBe(true);
			expect(stateManager.isProcessing()).toBe(false);
		});

		it('should transition to interrupted state', async () => {
			await stateManager.setProcessing('msg-123', 'streaming');
			await stateManager.setInterrupted();

			const state = stateManager.getState();
			expect(state.status).toBe('interrupted');
		});
	});

	describe('phase tracking', () => {
		beforeEach(async () => {
			await stateManager.setProcessing('msg-123', 'initializing');
		});

		it('should update phase during processing', async () => {
			await stateManager.updatePhase('thinking');

			const state = stateManager.getState();
			expect(state.phase).toBe('thinking');
		});

		it('should track all phases: initializing -> thinking -> streaming -> finalizing', async () => {
			await stateManager.updatePhase('thinking');
			expect(stateManager.getState().phase).toBe('thinking');

			await stateManager.updatePhase('streaming');
			expect(stateManager.getState().phase).toBe('streaming');

			await stateManager.updatePhase('finalizing');
			expect(stateManager.getState().phase).toBe('finalizing');
		});

		it('should track streamingStartedAt when entering streaming phase', async () => {
			const beforeTime = Date.now();

			await stateManager.updatePhase('streaming');

			const state = stateManager.getState();
			expect(state.streamingStartedAt).toBeDefined();
			expect(state.streamingStartedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should not update phase when not processing', async () => {
			await stateManager.setIdle();

			// Attempt to update phase
			await stateManager.updatePhase('streaming');

			// Should still be idle
			const state = stateManager.getState();
			expect(state.status).toBe('idle');
			expect(state.phase).toBeUndefined();
		});
	});

	describe('phase detection from messages', () => {
		beforeEach(async () => {
			await stateManager.setProcessing('msg-123', 'initializing');
		});

		it('should detect streaming phase from stream_event message', async () => {
			const streamEvent = { type: 'stream_event', event: {} };

			await stateManager.detectPhaseFromMessage(streamEvent);

			expect(stateManager.getState().phase).toBe('streaming');
		});

		it('should detect thinking phase from assistant message with tool use', async () => {
			const assistantMsg = {
				type: 'assistant',
				message: {
					content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }],
				},
			};

			await stateManager.detectPhaseFromMessage(assistantMsg);

			expect(stateManager.getState().phase).toBe('thinking');
		});

		it('should detect finalizing phase from result message', async () => {
			const resultMsg = { type: 'result', subtype: 'success' };

			await stateManager.detectPhaseFromMessage(resultMsg);

			expect(stateManager.getState().phase).toBe('finalizing');
		});

		it('should not detect phase when not processing', async () => {
			await stateManager.setIdle();

			const streamEvent = { type: 'stream_event', event: {} };
			await stateManager.detectPhaseFromMessage(streamEvent);

			// Should remain idle with no phase
			expect(stateManager.getState().status).toBe('idle');
			expect(stateManager.getState().phase).toBeUndefined();
		});
	});

	describe('EventBus integration', () => {
		it('should emit event on every state change', async () => {
			emitSpy.mockClear();

			await stateManager.setQueued('msg-123');
			expect(emitSpy).toHaveBeenCalledTimes(1);

			await stateManager.setProcessing('msg-123', 'initializing');
			expect(emitSpy).toHaveBeenCalledTimes(2);

			await stateManager.updatePhase('streaming');
			expect(emitSpy).toHaveBeenCalledTimes(3);

			await stateManager.setIdle();
			expect(emitSpy).toHaveBeenCalledTimes(4);
		});

		it('should include sessionId and state in event payload', async () => {
			emitSpy.mockClear();

			await stateManager.setProcessing('msg-123', 'streaming');

			expect(emitSpy).toHaveBeenCalledWith('agent-state:changed', {
				sessionId: testSessionId,
				state: expect.objectContaining({
					status: 'processing',
					messageId: 'msg-123',
					phase: 'streaming',
				}),
			});
		});
	});

	describe('state reset', () => {
		it('should reset phase tracking when transitioning to idle', async () => {
			await stateManager.setProcessing('msg-123', 'streaming');
			await stateManager.updatePhase('streaming');

			// Verify we're in streaming phase
			expect(stateManager.getState().phase).toBe('streaming');
			expect(stateManager.getState().streamingStartedAt).toBeDefined();

			// Transition to idle
			await stateManager.setIdle();

			// Phase tracking should be reset
			const state = stateManager.getState();
			expect(state.phase).toBeUndefined();
			expect(state.streamingStartedAt).toBeUndefined();
		});

		it('should reset phase tracking when interrupted', async () => {
			await stateManager.setProcessing('msg-123', 'thinking');

			await stateManager.setInterrupted();

			// Phase tracking should be reset (will be reflected in next processing state)
			await stateManager.setProcessing('msg-456', 'initializing');
			expect(stateManager.getState().phase).toBe('initializing');
		});
	});
});
