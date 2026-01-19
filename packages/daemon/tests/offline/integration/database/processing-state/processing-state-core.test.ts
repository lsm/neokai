/**
 * ProcessingStateManager Core Tests
 *
 * Tests for core state machine behavior:
 * - Initial state
 * - State transitions
 * - DaemonHub integration
 * - State reset
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../../../src/lib/agent/processing-state-manager';
import type { DaemonHub } from '../../../../../src/lib/daemon-hub';
import { generateUUID } from '@liuboer/shared';
import { createMockDb } from './test-utils';

describe('ProcessingStateManager Core', () => {
	let stateManager: ProcessingStateManager;
	let mockEventBus: DaemonHub;
	let emitSpy: ReturnType<typeof mock>;
	const testSessionId = generateUUID();

	beforeEach(() => {
		// Create mock DaemonHub
		emitSpy = mock(async () => {});
		mockEventBus = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		const mockDb = createMockDb();
		stateManager = new ProcessingStateManager(testSessionId, mockEventBus, mockDb);
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

			// Should emit event with processingState included (event-sourced architecture)
			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: testSessionId,
				source: 'processing-state',
				processingState: { status: 'queued', messageId: 'msg-123' },
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

		it('should preserve messageId during phase updates', async () => {
			await stateManager.setProcessing('msg-123', 'initializing');
			await stateManager.updatePhase('thinking');
			await stateManager.updatePhase('streaming');

			const state = stateManager.getState();
			expect(state.messageId).toBe('msg-123');
		});
	});

	describe('DaemonHub integration', () => {
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

		it('should include sessionId, source, and processingState in event payload', async () => {
			emitSpy.mockClear();

			await stateManager.setProcessing('msg-123', 'streaming');

			// Verify event was emitted with correct structure
			expect(emitSpy).toHaveBeenCalledTimes(1);
			const [eventName, payload] = emitSpy.mock.calls[0];
			expect(eventName).toBe('session.updated');
			expect(payload.sessionId).toBe(testSessionId);
			expect(payload.source).toBe('processing-state');
			// processingState included for event-sourced architecture
			expect(payload.processingState).toBeDefined();
			expect(payload.processingState.status).toBe('processing');
			expect(payload.processingState.messageId).toBe('msg-123');
			expect(payload.processingState.phase).toBe('streaming');
			expect(payload.processingState.streamingStartedAt).toBeDefined();
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
