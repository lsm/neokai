/**
 * ProcessingStateManager Tests
 *
 * Tests the state machine for agent processing phases:
 * idle → queued → processing (phases: initializing/thinking/streaming/finalizing) → idle | interrupted
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { PendingUserQuestion } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';

describe('ProcessingStateManager', () => {
	let stateManager: ProcessingStateManager;
	let mockDaemonHub: DaemonHub;
	let mockDb: Database;
	let emitSpy: ReturnType<typeof mock>;
	let updateSessionSpy: ReturnType<typeof mock>;
	let getSessionSpy: ReturnType<typeof mock>;
	const testSessionId = generateUUID();

	beforeEach(() => {
		// Create mock DaemonHub
		emitSpy = mock(async () => {});
		mockDaemonHub = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		// Create mock Database
		updateSessionSpy = mock(() => {});
		getSessionSpy = mock(() => null);
		mockDb = {
			updateSession: updateSessionSpy,
			getSession: getSessionSpy,
		} as unknown as Database;

		stateManager = new ProcessingStateManager(testSessionId, mockDaemonHub, mockDb);
	});

	describe('initial state', () => {
		it('should start in idle state', () => {
			expect(stateManager.getState().status).toBe('idle');
		});

		it('should report isIdle as true initially', () => {
			expect(stateManager.isIdle()).toBe(true);
		});

		it('should report isProcessing as false initially', () => {
			expect(stateManager.isProcessing()).toBe(false);
		});
	});

	describe('state transitions', () => {
		it('should transition from idle to queued', async () => {
			const messageId = generateUUID();
			await stateManager.setQueued(messageId);

			const state = stateManager.getState();
			expect(state.status).toBe('queued');
			expect(state.messageId).toBe(messageId);
		});

		it('should transition from queued to processing', async () => {
			const messageId = generateUUID();
			await stateManager.setQueued(messageId);
			await stateManager.setProcessing(messageId);

			const state = stateManager.getState();
			expect(state.status).toBe('processing');
			expect(state.messageId).toBe(messageId);
			expect(state.phase).toBe('initializing');
		});

		it('should transition from processing to idle', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);
			await stateManager.setIdle();

			expect(stateManager.getState().status).toBe('idle');
			expect(stateManager.isIdle()).toBe(true);
		});

		it('should transition from processing to interrupted', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);
			await stateManager.setInterrupted();

			expect(stateManager.getState().status).toBe('interrupted');
		});
	});

	describe('streaming phases', () => {
		it('should set initial phase to initializing', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);

			const state = stateManager.getState();
			expect(state.status).toBe('processing');
			expect(state.phase).toBe('initializing');
		});

		it('should allow setting custom initial phase', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId, 'streaming');

			const state = stateManager.getState();
			expect(state.phase).toBe('streaming');
		});

		it('should update phase during processing', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);

			await stateManager.updatePhase('thinking');
			expect(stateManager.getState().phase).toBe('thinking');

			await stateManager.updatePhase('streaming');
			expect(stateManager.getState().phase).toBe('streaming');

			await stateManager.updatePhase('finalizing');
			expect(stateManager.getState().phase).toBe('finalizing');
		});

		it('should track streaming start time', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);

			const beforeStreaming = Date.now();
			await stateManager.updatePhase('streaming');
			const afterStreaming = Date.now();

			const state = stateManager.getState();
			expect(state.streamingStartedAt).toBeDefined();
			expect(state.streamingStartedAt).toBeGreaterThanOrEqual(beforeStreaming);
			expect(state.streamingStartedAt).toBeLessThanOrEqual(afterStreaming);
		});

		it('should not update phase when not processing', async () => {
			await stateManager.updatePhase('streaming');
			// Should stay idle
			expect(stateManager.getState().status).toBe('idle');
		});

		it('should reset phase tracking when transitioning to idle', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId, 'streaming');
			await stateManager.setIdle();

			// Next processing should start fresh
			await stateManager.setProcessing(messageId);
			expect(stateManager.getState().phase).toBe('initializing');
		});
	});

	describe('compacting state', () => {
		it('should track compacting state during processing', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);

			await stateManager.setCompacting(true);
			expect(stateManager.getIsCompacting()).toBe(true);
			expect(stateManager.getState().isCompacting).toBe(true);

			await stateManager.setCompacting(false);
			expect(stateManager.getIsCompacting()).toBe(false);
			expect(stateManager.getState().isCompacting).toBe(false);
		});

		it('should reset compacting on idle', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);
			await stateManager.setCompacting(true);
			await stateManager.setIdle();

			expect(stateManager.getIsCompacting()).toBe(false);
		});
	});

	describe('waiting for input', () => {
		it('should transition to waiting_for_input state', async () => {
			const pendingQuestion: PendingUserQuestion = {
				toolUseId: 'tool-123',
				questions: [
					{
						question: 'What is your preference?',
						header: 'Preference',
						options: [
							{ label: 'Option A', description: 'First option' },
							{ label: 'Option B', description: 'Second option' },
						],
						multiSelect: false,
					},
				],
				askedAt: Date.now(),
			};

			await stateManager.setWaitingForInput(pendingQuestion);

			expect(stateManager.getState().status).toBe('waiting_for_input');
			expect(stateManager.isWaitingForInput()).toBe(true);
		});

		it('should store pending question', async () => {
			const pendingQuestion: PendingUserQuestion = {
				toolUseId: 'tool-456',
				questions: [
					{
						question: 'Choose your path',
						header: 'Path',
						options: [
							{ label: 'Path 1', description: 'First path' },
							{ label: 'Path 2', description: 'Second path' },
						],
						multiSelect: false,
					},
				],
				askedAt: Date.now(),
			};

			await stateManager.setWaitingForInput(pendingQuestion);

			const retrieved = stateManager.getPendingQuestion();
			expect(retrieved).toEqual(pendingQuestion);
		});

		it('should return null for pending question when not waiting', () => {
			expect(stateManager.getPendingQuestion()).toBeNull();
		});

		it('should update question draft responses', async () => {
			const pendingQuestion: PendingUserQuestion = {
				toolUseId: 'tool-789',
				questions: [
					{
						question: 'Select options',
						header: 'Options',
						options: [
							{ label: 'A', description: 'A' },
							{ label: 'B', description: 'B' },
						],
						multiSelect: true,
					},
				],
				askedAt: Date.now(),
			};

			await stateManager.setWaitingForInput(pendingQuestion);

			const draftResponses = [{ questionIndex: 0, selectedLabels: ['A', 'B'] }];
			await stateManager.updateQuestionDraft(draftResponses);

			const retrieved = stateManager.getPendingQuestion();
			expect(retrieved?.draftResponses).toEqual(draftResponses);
		});

		it('should not update draft when not waiting for input', async () => {
			const draftResponses = [{ questionIndex: 0, selectedLabels: ['A'] }];
			await stateManager.updateQuestionDraft(draftResponses);

			// Should not throw, just log warning
			expect(stateManager.getPendingQuestion()).toBeNull();
		});
	});

	describe('database persistence', () => {
		it('should persist state to database on state changes', async () => {
			const messageId = generateUUID();
			await stateManager.setQueued(messageId);

			expect(updateSessionSpy).toHaveBeenCalledWith(testSessionId, {
				processingState: expect.any(String),
			});
		});

		it('should persist state on phase updates', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);
			updateSessionSpy.mockClear();

			await stateManager.updatePhase('streaming');

			expect(updateSessionSpy).toHaveBeenCalledWith(testSessionId, {
				processingState: expect.any(String),
			});
		});

		it('should restore state from database', () => {
			const savedState = {
				status: 'waiting_for_input' as const,
				pendingQuestion: {
					toolUseId: 'test-tool',
					questions: [],
					askedAt: Date.now(),
				},
			};
			getSessionSpy.mockReturnValue({
				processingState: JSON.stringify(savedState),
			});

			stateManager.restoreFromDatabase();

			expect(stateManager.getState().status).toBe('waiting_for_input');
		});

		it('should reset to idle when restoring processing state', () => {
			const savedState = {
				status: 'processing' as const,
				messageId: 'test',
				phase: 'streaming',
			};
			getSessionSpy.mockReturnValue({
				processingState: JSON.stringify(savedState),
			});

			stateManager.restoreFromDatabase();

			// Processing states should reset to idle after restart
			expect(stateManager.getState().status).toBe('idle');
		});

		it('should preserve waiting_for_input state on restore', () => {
			const pendingQuestion: PendingUserQuestion = {
				toolUseId: 'tool-restore',
				questions: [
					{
						question: 'Continue?',
						header: 'Continue',
						options: [
							{ label: 'Yes', description: 'Yes' },
							{ label: 'No', description: 'No' },
						],
						multiSelect: false,
					},
				],
				askedAt: Date.now(),
			};
			const savedState = {
				status: 'waiting_for_input' as const,
				pendingQuestion,
			};
			getSessionSpy.mockReturnValue({
				processingState: JSON.stringify(savedState),
			});

			stateManager.restoreFromDatabase();

			expect(stateManager.getState().status).toBe('waiting_for_input');
			expect(stateManager.getPendingQuestion()).toEqual(pendingQuestion);
		});

		it('should handle missing processing state', () => {
			getSessionSpy.mockReturnValue(null);
			stateManager.restoreFromDatabase();
			expect(stateManager.getState().status).toBe('idle');
		});

		it('should handle invalid JSON in processing state', () => {
			getSessionSpy.mockReturnValue({
				processingState: 'invalid json',
			});

			stateManager.restoreFromDatabase();
			expect(stateManager.getState().status).toBe('idle');
		});

		it('should restore idle state as-is', () => {
			const savedState = { status: 'idle' as const };
			getSessionSpy.mockReturnValue({
				processingState: JSON.stringify(savedState),
			});

			stateManager.restoreFromDatabase();
			expect(stateManager.getState().status).toBe('idle');
		});

		it('should restore interrupted state as-is', () => {
			const savedState = { status: 'interrupted' as const };
			getSessionSpy.mockReturnValue({
				processingState: JSON.stringify(savedState),
			});

			stateManager.restoreFromDatabase();
			expect(stateManager.getState().status).toBe('interrupted');
		});

		it('should reset queued state to idle on restore', () => {
			const savedState = { status: 'queued' as const, messageId: 'test-msg' };
			getSessionSpy.mockReturnValue({
				processingState: JSON.stringify(savedState),
			});

			stateManager.restoreFromDatabase();
			expect(stateManager.getState().status).toBe('idle');
		});

		it('should handle session with empty processingState string', () => {
			getSessionSpy.mockReturnValue({
				processingState: '',
			});

			// Empty string is falsy, should treat as no state
			stateManager.restoreFromDatabase();
			expect(stateManager.getState().status).toBe('idle');
		});
	});

	describe('event emission', () => {
		it('should emit session.updated on state changes', async () => {
			const messageId = generateUUID();
			await stateManager.setQueued(messageId);

			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: testSessionId,
				source: 'processing-state',
				processingState: expect.objectContaining({
					status: 'queued',
					messageId,
				}),
			});
		});

		it('should emit event on phase updates', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);
			emitSpy.mockClear();

			await stateManager.updatePhase('thinking');

			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: testSessionId,
				source: 'processing-state',
				processingState: expect.objectContaining({
					status: 'processing',
					phase: 'thinking',
				}),
			});
		});

		it('should emit event on compacting state change', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);
			emitSpy.mockClear();

			await stateManager.setCompacting(true);

			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: testSessionId,
				source: 'processing-state',
				processingState: expect.objectContaining({
					isCompacting: true,
				}),
			});
		});
	});

	describe('onIdle callback', () => {
		it('should execute callback when transitioning to idle', async () => {
			const callbackSpy = mock(async () => {});
			stateManager.setOnIdleCallback(callbackSpy);

			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);
			await stateManager.setIdle();

			expect(callbackSpy).toHaveBeenCalled();
		});

		it('should handle callback errors gracefully', async () => {
			const errorCallback = mock(async () => {
				throw new Error('Callback error');
			});
			stateManager.setOnIdleCallback(errorCallback);

			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);

			// Should not throw
			await expect(stateManager.setIdle()).resolves.toBeUndefined();
			expect(stateManager.getState().status).toBe('idle');
		});
	});

	describe('detectPhaseFromMessage', () => {
		it('should detect streaming phase from stream_event', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);

			await stateManager.detectPhaseFromMessage({
				type: 'stream_event',
			} as unknown);

			expect(stateManager.getState().phase).toBe('streaming');
		});

		it('should detect thinking phase from assistant message with tool use', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);

			const assistantMessage = {
				type: 'assistant',
				message: {
					content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
				},
			};

			await stateManager.detectPhaseFromMessage(assistantMessage as unknown);

			expect(stateManager.getState().phase).toBe('thinking');
		});

		it('should detect finalizing phase from result message', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);

			await stateManager.detectPhaseFromMessage({ type: 'result' } as unknown);

			expect(stateManager.getState().phase).toBe('finalizing');
		});

		it('should not detect phase when not processing', async () => {
			await stateManager.detectPhaseFromMessage({
				type: 'stream_event',
			} as unknown);
			expect(stateManager.getState().status).toBe('idle');
		});

		it('should detect thinking phase from assistant message with text only', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);

			const assistantMessage = {
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'Let me help you with that.' }],
				},
			};

			await stateManager.detectPhaseFromMessage(assistantMessage as unknown);

			expect(stateManager.getState().phase).toBe('thinking');
		});

		it('should not re-detect streaming phase if already streaming', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId, 'streaming');
			emitSpy.mockClear();

			await stateManager.detectPhaseFromMessage({
				type: 'stream_event',
			} as unknown);

			// Should not emit again since already streaming
			expect(emitSpy).not.toHaveBeenCalled();
		});

		it('should not re-detect finalizing phase if already finalizing', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);
			await stateManager.updatePhase('finalizing');
			emitSpy.mockClear();

			await stateManager.detectPhaseFromMessage({ type: 'result' } as unknown);

			// Should not emit again since already finalizing
			expect(emitSpy).not.toHaveBeenCalled();
		});

		it('should not transition to thinking from non-initializing phase', async () => {
			const messageId = generateUUID();
			await stateManager.setProcessing(messageId);
			await stateManager.updatePhase('streaming'); // Not initializing
			emitSpy.mockClear();

			const assistantMessage = {
				type: 'assistant',
				message: {
					content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
				},
			};

			await stateManager.detectPhaseFromMessage(assistantMessage as unknown);

			// Should stay in streaming, not transition to thinking
			expect(stateManager.getState().phase).toBe('streaming');
		});
	});
});
