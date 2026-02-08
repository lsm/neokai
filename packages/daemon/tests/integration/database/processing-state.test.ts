/**
 * ProcessingStateManager Tests
 *
 * Consolidated tests for the processing state machine:
 * - Core state transitions and DaemonHub integration
 * - Database persistence and restoration
 * - Phase tracking and auto-detection from messages
 * - AskUserQuestion (waiting_for_input) support
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import { generateUUID } from '@neokai/shared';
import {
	createMockDb,
	createTestDb,
	createTestDaemonHub,
	createTestSession,
	createSamplePendingQuestion,
	createMultiSelectPendingQuestion,
	createPersistablePendingQuestion,
} from './processing-state/test-utils';

// =============================================================================
// Core State Machine
// =============================================================================

describe('ProcessingStateManager Core', () => {
	let stateManager: ProcessingStateManager;
	let mockEventBus: DaemonHub;
	let emitSpy: ReturnType<typeof mock>;
	const testSessionId = generateUUID();

	beforeEach(() => {
		emitSpy = mock(async () => {});
		mockEventBus = { emit: emitSpy } as unknown as DaemonHub;
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

			expect(emitSpy).toHaveBeenCalledTimes(1);
			const [eventName, payload] = emitSpy.mock.calls[0];
			expect(eventName).toBe('session.updated');
			expect(payload.sessionId).toBe(testSessionId);
			expect(payload.source).toBe('processing-state');
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

			expect(stateManager.getState().phase).toBe('streaming');
			expect(stateManager.getState().streamingStartedAt).toBeDefined();

			await stateManager.setIdle();

			const state = stateManager.getState();
			expect(state.phase).toBeUndefined();
			expect(state.streamingStartedAt).toBeUndefined();
		});

		it('should reset phase tracking when interrupted', async () => {
			await stateManager.setProcessing('msg-123', 'thinking');

			await stateManager.setInterrupted();

			await stateManager.setProcessing('msg-456', 'initializing');
			expect(stateManager.getState().phase).toBe('initializing');
		});
	});
});

// =============================================================================
// Phase Tracking
// =============================================================================

describe('ProcessingStateManager Phases', () => {
	let stateManager: ProcessingStateManager;
	let mockEventBus: DaemonHub;
	let emitSpy: ReturnType<typeof mock>;
	const testSessionId = generateUUID();

	beforeEach(() => {
		emitSpy = mock(async () => {});
		mockEventBus = { emit: emitSpy } as unknown as DaemonHub;
		const mockDb = createMockDb();
		stateManager = new ProcessingStateManager(testSessionId, mockEventBus, mockDb);
	});

	describe('phase tracking', () => {
		beforeEach(async () => {
			await stateManager.setProcessing('msg-123', 'initializing');
		});

		it('should update phase during processing', async () => {
			await stateManager.updatePhase('thinking');
			expect(stateManager.getState().phase).toBe('thinking');
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
			await stateManager.updatePhase('streaming');

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
			await stateManager.detectPhaseFromMessage({ type: 'stream_event', event: {} });
			expect(stateManager.getState().phase).toBe('streaming');
		});

		it('should detect thinking phase from assistant message with tool use', async () => {
			await stateManager.detectPhaseFromMessage({
				type: 'assistant',
				message: {
					content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }],
				},
			});
			expect(stateManager.getState().phase).toBe('thinking');
		});

		it('should detect finalizing phase from result message', async () => {
			await stateManager.detectPhaseFromMessage({ type: 'result', subtype: 'success' });
			expect(stateManager.getState().phase).toBe('finalizing');
		});

		it('should not detect phase when not processing', async () => {
			await stateManager.setIdle();
			await stateManager.detectPhaseFromMessage({ type: 'stream_event', event: {} });

			expect(stateManager.getState().status).toBe('idle');
			expect(stateManager.getState().phase).toBeUndefined();
		});
	});
});

// =============================================================================
// Database Persistence
// =============================================================================

describe('ProcessingStateManager Persistence', () => {
	describe('state persistence', () => {
		let db: Database;
		let eventBus: DaemonHub;
		const sessionId = 'test-session-persist';

		beforeEach(async () => {
			db = await createTestDb();
			eventBus = await createTestDaemonHub('test-hub-persist');
			db.createSession(createTestSession(sessionId));
		});

		it('should persist idle state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			await manager.setIdle();

			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('idle');
		});

		it('should persist queued state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			await manager.setQueued('msg-123');

			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('queued');
			expect(persistedState.messageId).toBe('msg-123');
		});

		it('should persist processing state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			await manager.setProcessing('msg-456', 'thinking');

			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('processing');
			expect(persistedState.messageId).toBe('msg-456');
			expect(persistedState.phase).toBe('thinking');
		});

		it('should persist interrupted state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			await manager.setInterrupted();

			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('interrupted');
		});

		it('should persist phase updates to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			await manager.setProcessing('msg-789', 'initializing');
			await manager.updatePhase('streaming');

			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('processing');
			expect(persistedState.phase).toBe('streaming');
			expect(persistedState.streamingStartedAt).toBeDefined();
		});

		it('should persist state changes through full lifecycle', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const messageId = 'msg-lifecycle';

			await manager.setIdle();
			expect(JSON.parse(db.getSession(sessionId)!.processingState as string).status).toBe('idle');

			await manager.setQueued(messageId);
			expect(JSON.parse(db.getSession(sessionId)!.processingState as string).status).toBe('queued');

			await manager.setProcessing(messageId, 'initializing');
			let persistedState = JSON.parse(db.getSession(sessionId)!.processingState as string);
			expect(persistedState.status).toBe('processing');
			expect(persistedState.phase).toBe('initializing');

			await manager.updatePhase('streaming');
			persistedState = JSON.parse(db.getSession(sessionId)!.processingState as string);
			expect(persistedState.phase).toBe('streaming');

			await manager.setIdle();
			expect(JSON.parse(db.getSession(sessionId)!.processingState as string).status).toBe('idle');
		});
	});

	describe('state restoration', () => {
		let db: Database;
		let eventBus: DaemonHub;
		const sessionId = 'test-session-restore';

		beforeEach(async () => {
			db = await createTestDb();
			eventBus = await createTestDaemonHub('test-hub-restore');
			db.createSession(createTestSession(sessionId));
		});

		it('should restore idle state from database', async () => {
			db.updateSession(sessionId, {
				processingState: JSON.stringify({ status: 'idle' }),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			expect(manager.getState().status).toBe('idle');
		});

		it('should reset processing state to idle after restart (safety logic)', async () => {
			db.updateSession(sessionId, {
				processingState: JSON.stringify({
					status: 'processing',
					messageId: 'msg-old',
					phase: 'streaming',
				}),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			expect(manager.getState().status).toBe('idle');
		});

		it('should reset queued state to idle after restart (safety logic)', async () => {
			db.updateSession(sessionId, {
				processingState: JSON.stringify({
					status: 'queued',
					messageId: 'msg-old',
				}),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			expect(manager.getState().status).toBe('idle');
		});

		it('should restore interrupted state from database', async () => {
			db.updateSession(sessionId, {
				processingState: JSON.stringify({ status: 'interrupted' }),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			expect(manager.getState().status).toBe('interrupted');
		});

		it('should handle missing persisted state gracefully', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			expect(manager.getState().status).toBe('idle');
		});

		it('should handle invalid JSON in persisted state gracefully', async () => {
			db.updateSession(sessionId, { processingState: 'invalid-json-{' });

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			expect(manager.getState().status).toBe('idle');
		});
	});
});

// =============================================================================
// User Input (AskUserQuestion)
// =============================================================================

describe('ProcessingStateManager User Input', () => {
	describe('waiting_for_input state (AskUserQuestion)', () => {
		let stateManager: ProcessingStateManager;
		let mockEventBus: DaemonHub;
		let emitSpy: ReturnType<typeof mock>;
		const testSessionId = generateUUID();

		beforeEach(() => {
			emitSpy = mock(async () => {});
			mockEventBus = { emit: emitSpy } as unknown as DaemonHub;
			const mockDb = createMockDb();
			stateManager = new ProcessingStateManager(testSessionId, mockEventBus, mockDb);
		});

		it('should transition to waiting_for_input state', async () => {
			await stateManager.setWaitingForInput(createSamplePendingQuestion());

			const state = stateManager.getState();
			expect(state.status).toBe('waiting_for_input');
			expect(stateManager.isWaitingForInput()).toBe(true);
			expect(stateManager.isProcessing()).toBe(false);
			expect(stateManager.isIdle()).toBe(false);
		});

		it('should store pending question in state', async () => {
			await stateManager.setWaitingForInput(createSamplePendingQuestion());

			const pendingQuestion = stateManager.getPendingQuestion();
			expect(pendingQuestion).not.toBeNull();
			expect(pendingQuestion?.toolUseId).toBe('tool-ask-123');
			expect(pendingQuestion?.questions).toHaveLength(1);
			expect(pendingQuestion?.questions[0].header).toBe('Database Choice');
		});

		it('should emit event when entering waiting_for_input state', async () => {
			const samplePendingQuestion = createSamplePendingQuestion();
			emitSpy.mockClear();

			await stateManager.setWaitingForInput(samplePendingQuestion);

			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: testSessionId,
				source: 'processing-state',
				processingState: {
					status: 'waiting_for_input',
					pendingQuestion: samplePendingQuestion,
				},
			});
		});

		it('should return null for getPendingQuestion when not waiting', async () => {
			expect(stateManager.getPendingQuestion()).toBeNull();

			await stateManager.setProcessing('msg-123', 'thinking');
			expect(stateManager.getPendingQuestion()).toBeNull();
		});

		it('should transition from waiting_for_input back to idle', async () => {
			await stateManager.setWaitingForInput(createSamplePendingQuestion());
			await stateManager.setIdle();

			expect(stateManager.isIdle()).toBe(true);
			expect(stateManager.isWaitingForInput()).toBe(false);
			expect(stateManager.getPendingQuestion()).toBeNull();
		});

		it('should transition from waiting_for_input to processing', async () => {
			await stateManager.setWaitingForInput(createSamplePendingQuestion());
			await stateManager.setProcessing('msg-response', 'initializing');

			expect(stateManager.isProcessing()).toBe(true);
			expect(stateManager.isWaitingForInput()).toBe(false);
			expect(stateManager.getPendingQuestion()).toBeNull();
		});
	});

	describe('draft responses for AskUserQuestion', () => {
		let stateManager: ProcessingStateManager;
		let mockEventBus: DaemonHub;
		let emitSpy: ReturnType<typeof mock>;
		const testSessionId = generateUUID();

		beforeEach(() => {
			emitSpy = mock(async () => {});
			mockEventBus = { emit: emitSpy } as unknown as DaemonHub;
			const mockDb = createMockDb();
			stateManager = new ProcessingStateManager(testSessionId, mockEventBus, mockDb);
		});

		it('should update draft responses in waiting_for_input state', async () => {
			await stateManager.setWaitingForInput(createMultiSelectPendingQuestion());

			await stateManager.updateQuestionDraft([
				{ questionIndex: 0, selectedLabels: ['TypeScript'] },
			]);

			const pendingQuestion = stateManager.getPendingQuestion();
			expect(pendingQuestion?.draftResponses).toHaveLength(1);
			expect(pendingQuestion?.draftResponses?.[0].selectedLabels).toContain('TypeScript');
		});

		it('should emit event when updating draft responses', async () => {
			await stateManager.setWaitingForInput(createMultiSelectPendingQuestion());
			emitSpy.mockClear();

			const draftResponses = [
				{ questionIndex: 0, selectedLabels: ['Testing'], customText: 'maybe ESLint too' },
			];
			await stateManager.updateQuestionDraft(draftResponses);

			expect(emitSpy).toHaveBeenCalledTimes(1);
			const [eventName, payload] = emitSpy.mock.calls[0];
			expect(eventName).toBe('session.updated');
			expect(payload.processingState.pendingQuestion.draftResponses).toEqual(draftResponses);
		});

		it('should not update draft when not in waiting_for_input state', async () => {
			await stateManager.updateQuestionDraft([
				{ questionIndex: 0, selectedLabels: ['TypeScript'] },
			]);

			expect(stateManager.isIdle()).toBe(true);
			expect(stateManager.getPendingQuestion()).toBeNull();
		});

		it('should update draft responses multiple times', async () => {
			await stateManager.setWaitingForInput(createMultiSelectPendingQuestion());

			await stateManager.updateQuestionDraft([
				{ questionIndex: 0, selectedLabels: ['TypeScript'] },
			]);
			await stateManager.updateQuestionDraft([
				{ questionIndex: 0, selectedLabels: ['TypeScript', 'Testing'] },
			]);

			const pendingQuestion = stateManager.getPendingQuestion();
			expect(pendingQuestion?.draftResponses?.[0].selectedLabels).toContain('TypeScript');
			expect(pendingQuestion?.draftResponses?.[0].selectedLabels).toContain('Testing');
		});
	});

	describe('waiting_for_input persistence', () => {
		let db: Database;
		let eventBus: DaemonHub;
		const sessionId = 'test-session-waiting';

		beforeEach(async () => {
			db = await createTestDb();
			eventBus = await createTestDaemonHub('test-hub-waiting');
			db.createSession(createTestSession(sessionId));
		});

		it('should persist waiting_for_input state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			await manager.setWaitingForInput(createPersistablePendingQuestion());

			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('waiting_for_input');
			expect(persistedState.pendingQuestion.toolUseId).toBe('tool-persist-789');
		});

		it('should persist draft responses to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			await manager.setWaitingForInput({
				...createPersistablePendingQuestion(),
				draftResponses: undefined,
			});

			const draftResponses = [{ questionIndex: 0, selectedLabels: ['B'] }];
			await manager.updateQuestionDraft(draftResponses);

			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.pendingQuestion.draftResponses).toEqual(draftResponses);
		});

		it('should restore waiting_for_input state from database (preserves across restart)', async () => {
			const samplePendingQuestion = createPersistablePendingQuestion();

			db.updateSession(sessionId, {
				processingState: JSON.stringify({
					status: 'waiting_for_input',
					pendingQuestion: samplePendingQuestion,
				}),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			const state = manager.getState();
			expect(state.status).toBe('waiting_for_input');
			expect(manager.isWaitingForInput()).toBe(true);

			const pendingQuestion = manager.getPendingQuestion();
			expect(pendingQuestion?.toolUseId).toBe('tool-persist-789');
			expect(pendingQuestion?.draftResponses?.[0].selectedLabels).toContain('A');
		});
	});
});
