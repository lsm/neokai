/**
 * ProcessingStateManager Phase Tests
 *
 * Tests for processing phase tracking and auto-detection from SDK messages:
 * - Phase tracking
 * - Phase detection from messages
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../../../src/lib/agent/processing-state-manager';
import type { DaemonHub } from '../../../../../src/lib/daemon-hub';
import { generateUUID } from '@liuboer/shared';
import { createMockDb } from './test-utils';

describe('ProcessingStateManager Phases', () => {
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

		it('should emit event on phase update', async () => {
			emitSpy.mockClear();

			await stateManager.updatePhase('thinking');

			expect(emitSpy).toHaveBeenCalledTimes(1);
			const [eventName, payload] = emitSpy.mock.calls[0];
			expect(eventName).toBe('session.updated');
			expect(payload.processingState.phase).toBe('thinking');
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
});
