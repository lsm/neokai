/**
 * Question RPC Handlers Tests
 *
 * Tests for question.respond, question.saveDraft, and question.cancel handlers.
 * These handlers are used when the Claude Agent SDK asks the user questions.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { MessageHub, EventBus } from '@liuboer/shared';
import type { QuestionDraftResponse } from '@liuboer/shared';
import { setupQuestionHandlers } from '../../../../src/lib/rpc-handlers/question-handlers';

// Mock AgentSession with question handling methods
function createMockAgentSession() {
	return {
		handleQuestionResponse: mock(async () => {}),
		updateQuestionDraft: mock(async () => {}),
		handleQuestionCancel: mock(async () => {}),
	};
}

// Mock SessionManager
function createMockSessionManager(agentSession: ReturnType<typeof createMockAgentSession> | null) {
	return {
		getSessionAsync: mock(async () => agentSession),
	};
}

describe('Question RPC Handlers', () => {
	let messageHub: MessageHub;
	let eventBus: EventBus;
	let mockAgentSession: ReturnType<typeof createMockAgentSession>;

	beforeEach(() => {
		messageHub = new MessageHub({ defaultSessionId: 'global' });
		eventBus = new EventBus({ debug: false });
		mockAgentSession = createMockAgentSession();
	});

	describe('handler registration', () => {
		test('should register all three question handlers', async () => {
			const sessionManager = createMockSessionManager(mockAgentSession);
			setupQuestionHandlers(messageHub, sessionManager as unknown as never, eventBus);

			const handlers = (messageHub as unknown as { rpcHandlers: Map<string, unknown> }).rpcHandlers;

			expect(handlers.has('question.respond')).toBe(true);
			expect(handlers.has('question.saveDraft')).toBe(true);
			expect(handlers.has('question.cancel')).toBe(true);
		});
	});

	describe('question.respond handler (direct)', () => {
		test('should call handleQuestionResponse on agent session', async () => {
			const sessionManager = createMockSessionManager(mockAgentSession);
			setupQuestionHandlers(messageHub, sessionManager as unknown as never, eventBus);

			// Get the handler directly
			const handlers = (
				messageHub as unknown as { rpcHandlers: Map<string, (data: unknown) => Promise<unknown>> }
			).rpcHandlers;
			const respondHandler = handlers.get('question.respond')!;

			const responses: QuestionDraftResponse[] = [
				{ questionIndex: 0, selectedLabels: ['Option A'] },
			];

			const result = await respondHandler({
				sessionId: 'test-session',
				toolUseId: 'tool-123',
				responses,
			});

			expect(result).toEqual({ success: true });
			expect(sessionManager.getSessionAsync).toHaveBeenCalledWith('test-session');
			expect(mockAgentSession.handleQuestionResponse).toHaveBeenCalledWith('tool-123', responses);
		});

		test('should throw error if session not found', async () => {
			const sessionManager = createMockSessionManager(null);
			setupQuestionHandlers(messageHub, sessionManager as unknown as never, eventBus);

			const handlers = (
				messageHub as unknown as { rpcHandlers: Map<string, (data: unknown) => Promise<unknown>> }
			).rpcHandlers;
			const respondHandler = handlers.get('question.respond')!;

			await expect(
				respondHandler({
					sessionId: 'nonexistent-session',
					toolUseId: 'tool-123',
					responses: [],
				})
			).rejects.toThrow('Session not found: nonexistent-session');
		});

		test('should handle multiple responses for multi-question', async () => {
			const sessionManager = createMockSessionManager(mockAgentSession);
			setupQuestionHandlers(messageHub, sessionManager as unknown as never, eventBus);

			const handlers = (
				messageHub as unknown as { rpcHandlers: Map<string, (data: unknown) => Promise<unknown>> }
			).rpcHandlers;
			const respondHandler = handlers.get('question.respond')!;

			const responses: QuestionDraftResponse[] = [
				{ questionIndex: 0, selectedLabels: ['PostgreSQL'] },
				{ questionIndex: 1, selectedLabels: ['TypeScript', 'Testing'], customText: 'also ESLint' },
			];

			await respondHandler({
				sessionId: 'test-session',
				toolUseId: 'tool-multi',
				responses,
			});

			expect(mockAgentSession.handleQuestionResponse).toHaveBeenCalledWith('tool-multi', responses);
		});
	});

	describe('question.saveDraft handler (direct)', () => {
		test('should call updateQuestionDraft on agent session', async () => {
			const sessionManager = createMockSessionManager(mockAgentSession);
			setupQuestionHandlers(messageHub, sessionManager as unknown as never, eventBus);

			const handlers = (
				messageHub as unknown as { rpcHandlers: Map<string, (data: unknown) => Promise<unknown>> }
			).rpcHandlers;
			const saveDraftHandler = handlers.get('question.saveDraft')!;

			const draftResponses: QuestionDraftResponse[] = [
				{ questionIndex: 0, selectedLabels: ['Draft Option'] },
			];

			const result = await saveDraftHandler({
				sessionId: 'test-session',
				draftResponses,
			});

			expect(result).toEqual({ success: true });
			expect(mockAgentSession.updateQuestionDraft).toHaveBeenCalledWith(draftResponses);
		});

		test('should throw error if session not found', async () => {
			const sessionManager = createMockSessionManager(null);
			setupQuestionHandlers(messageHub, sessionManager as unknown as never, eventBus);

			const handlers = (
				messageHub as unknown as { rpcHandlers: Map<string, (data: unknown) => Promise<unknown>> }
			).rpcHandlers;
			const saveDraftHandler = handlers.get('question.saveDraft')!;

			await expect(
				saveDraftHandler({
					sessionId: 'nonexistent-session',
					draftResponses: [],
				})
			).rejects.toThrow('Session not found: nonexistent-session');
		});

		test('should handle draft with custom text', async () => {
			const sessionManager = createMockSessionManager(mockAgentSession);
			setupQuestionHandlers(messageHub, sessionManager as unknown as never, eventBus);

			const handlers = (
				messageHub as unknown as { rpcHandlers: Map<string, (data: unknown) => Promise<unknown>> }
			).rpcHandlers;
			const saveDraftHandler = handlers.get('question.saveDraft')!;

			const draftResponses: QuestionDraftResponse[] = [
				{ questionIndex: 0, selectedLabels: [], customText: 'My custom response' },
			];

			await saveDraftHandler({
				sessionId: 'test-session',
				draftResponses,
			});

			expect(mockAgentSession.updateQuestionDraft).toHaveBeenCalledWith(draftResponses);
		});
	});

	describe('question.cancel handler (direct)', () => {
		test('should call handleQuestionCancel on agent session', async () => {
			const sessionManager = createMockSessionManager(mockAgentSession);
			setupQuestionHandlers(messageHub, sessionManager as unknown as never, eventBus);

			const handlers = (
				messageHub as unknown as { rpcHandlers: Map<string, (data: unknown) => Promise<unknown>> }
			).rpcHandlers;
			const cancelHandler = handlers.get('question.cancel')!;

			const result = await cancelHandler({
				sessionId: 'test-session',
				toolUseId: 'tool-cancel-123',
			});

			expect(result).toEqual({ success: true });
			expect(mockAgentSession.handleQuestionCancel).toHaveBeenCalledWith('tool-cancel-123');
		});

		test('should throw error if session not found', async () => {
			const sessionManager = createMockSessionManager(null);
			setupQuestionHandlers(messageHub, sessionManager as unknown as never, eventBus);

			const handlers = (
				messageHub as unknown as { rpcHandlers: Map<string, (data: unknown) => Promise<unknown>> }
			).rpcHandlers;
			const cancelHandler = handlers.get('question.cancel')!;

			await expect(
				cancelHandler({
					sessionId: 'nonexistent-session',
					toolUseId: 'tool-123',
				})
			).rejects.toThrow('Session not found: nonexistent-session');
		});
	});
});
