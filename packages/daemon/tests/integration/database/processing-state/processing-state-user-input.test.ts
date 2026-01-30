/**
 * ProcessingStateManager User Input Tests
 *
 * Tests for AskUserQuestion support:
 * - waiting_for_input state
 * - draft responses for AskUserQuestion
 * - waiting_for_input persistence
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { Database } from '../../../../src/storage/database';
import { generateUUID } from '@neokai/shared';
import {
	createMockDb,
	createTestDb,
	createTestDaemonHub,
	createTestSession,
	createSamplePendingQuestion,
	createMultiSelectPendingQuestion,
	createPersistablePendingQuestion,
} from './test-utils';

describe('ProcessingStateManager User Input', () => {
	describe('waiting_for_input state (AskUserQuestion)', () => {
		let stateManager: ProcessingStateManager;
		let mockEventBus: DaemonHub;
		let emitSpy: ReturnType<typeof mock>;
		const testSessionId = generateUUID();

		beforeEach(() => {
			emitSpy = mock(async () => {});
			mockEventBus = {
				emit: emitSpy,
			} as unknown as DaemonHub;

			const mockDb = createMockDb();
			stateManager = new ProcessingStateManager(testSessionId, mockEventBus, mockDb);
		});

		it('should transition to waiting_for_input state', async () => {
			const samplePendingQuestion = createSamplePendingQuestion();
			await stateManager.setWaitingForInput(samplePendingQuestion);

			const state = stateManager.getState();
			expect(state.status).toBe('waiting_for_input');
			expect(stateManager.isWaitingForInput()).toBe(true);
			expect(stateManager.isProcessing()).toBe(false);
			expect(stateManager.isIdle()).toBe(false);
		});

		it('should store pending question in state', async () => {
			const samplePendingQuestion = createSamplePendingQuestion();
			await stateManager.setWaitingForInput(samplePendingQuestion);

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
			// Initially idle
			expect(stateManager.getPendingQuestion()).toBeNull();

			// In processing state
			await stateManager.setProcessing('msg-123', 'thinking');
			expect(stateManager.getPendingQuestion()).toBeNull();
		});

		it('should transition from waiting_for_input back to idle', async () => {
			const samplePendingQuestion = createSamplePendingQuestion();
			await stateManager.setWaitingForInput(samplePendingQuestion);
			expect(stateManager.isWaitingForInput()).toBe(true);

			await stateManager.setIdle();

			expect(stateManager.isIdle()).toBe(true);
			expect(stateManager.isWaitingForInput()).toBe(false);
			expect(stateManager.getPendingQuestion()).toBeNull();
		});

		it('should transition from waiting_for_input to processing', async () => {
			const samplePendingQuestion = createSamplePendingQuestion();
			await stateManager.setWaitingForInput(samplePendingQuestion);

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
			mockEventBus = {
				emit: emitSpy,
			} as unknown as DaemonHub;

			const mockDb = createMockDb();
			stateManager = new ProcessingStateManager(testSessionId, mockEventBus, mockDb);
		});

		it('should update draft responses in waiting_for_input state', async () => {
			const samplePendingQuestion = createMultiSelectPendingQuestion();
			await stateManager.setWaitingForInput(samplePendingQuestion);

			const draftResponses = [{ questionIndex: 0, selectedLabels: ['TypeScript'] }];
			await stateManager.updateQuestionDraft(draftResponses);

			const pendingQuestion = stateManager.getPendingQuestion();
			expect(pendingQuestion?.draftResponses).toBeDefined();
			expect(pendingQuestion?.draftResponses).toHaveLength(1);
			expect(pendingQuestion?.draftResponses?.[0].selectedLabels).toContain('TypeScript');
		});

		it('should emit event when updating draft responses', async () => {
			const samplePendingQuestion = createMultiSelectPendingQuestion();
			await stateManager.setWaitingForInput(samplePendingQuestion);
			emitSpy.mockClear();

			const draftResponses = [
				{
					questionIndex: 0,
					selectedLabels: ['Testing'],
					customText: 'maybe ESLint too',
				},
			];
			await stateManager.updateQuestionDraft(draftResponses);

			expect(emitSpy).toHaveBeenCalledTimes(1);
			const [eventName, payload] = emitSpy.mock.calls[0];
			expect(eventName).toBe('session.updated');
			expect(payload.processingState.pendingQuestion.draftResponses).toEqual(draftResponses);
		});

		it('should not update draft when not in waiting_for_input state', async () => {
			// Should not throw, just log warning
			const draftResponses = [{ questionIndex: 0, selectedLabels: ['TypeScript'] }];
			await stateManager.updateQuestionDraft(draftResponses);

			// Still idle, no pending question
			expect(stateManager.isIdle()).toBe(true);
			expect(stateManager.getPendingQuestion()).toBeNull();
		});

		it('should update draft responses multiple times', async () => {
			const samplePendingQuestion = createMultiSelectPendingQuestion();
			await stateManager.setWaitingForInput(samplePendingQuestion);

			// First update
			await stateManager.updateQuestionDraft([
				{ questionIndex: 0, selectedLabels: ['TypeScript'] },
			]);

			// Second update - add more selections
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

			// Create a test session
			const session = createTestSession(sessionId);
			db.createSession(session);
		});

		it('should persist waiting_for_input state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const samplePendingQuestion = createPersistablePendingQuestion();

			await manager.setWaitingForInput(samplePendingQuestion);

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('waiting_for_input');
			expect(persistedState.pendingQuestion.toolUseId).toBe('tool-persist-789');
		});

		it('should persist draft responses to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const samplePendingQuestion = createPersistablePendingQuestion();

			await manager.setWaitingForInput({
				...samplePendingQuestion,
				draftResponses: undefined,
			});

			// Update draft
			const draftResponses = [{ questionIndex: 0, selectedLabels: ['B'] }];
			await manager.updateQuestionDraft(draftResponses);

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.pendingQuestion.draftResponses).toEqual(draftResponses);
		});

		it('should restore waiting_for_input state from database (preserves across restart)', async () => {
			const samplePendingQuestion = createPersistablePendingQuestion();

			// Set up persisted waiting_for_input state
			db.updateSession(sessionId, {
				processingState: JSON.stringify({
					status: 'waiting_for_input',
					pendingQuestion: samplePendingQuestion,
				}),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			// Should preserve waiting_for_input state (unlike processing/queued which reset)
			const state = manager.getState();
			expect(state.status).toBe('waiting_for_input');
			expect(manager.isWaitingForInput()).toBe(true);

			// Should preserve pending question with draft
			const pendingQuestion = manager.getPendingQuestion();
			expect(pendingQuestion?.toolUseId).toBe('tool-persist-789');
			expect(pendingQuestion?.draftResponses?.[0].selectedLabels).toContain('A');
		});
	});
});
