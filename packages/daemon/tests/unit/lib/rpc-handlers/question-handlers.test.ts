/**
 * Question Handlers Tests
 *
 * Tests for question RPC handlers (AskUserQuestion tool responses).
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupQuestionHandlers } from '../../../../src/lib/rpc-handlers/question-handlers';
import type { MessageHub, QuestionDraftResponse } from '@liuboer/shared';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';

describe('Question Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let mockDaemonHub: DaemonHub;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;
	let mockAgentSession: {
		handleQuestionResponse: ReturnType<typeof mock>;
		updateQuestionDraft: ReturnType<typeof mock>;
		handleQuestionCancel: ReturnType<typeof mock>;
	};

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
		} as unknown as MessageHub;

		// Mock DaemonHub
		mockDaemonHub = {} as DaemonHub;

		// Mock AgentSession
		mockAgentSession = {
			handleQuestionResponse: mock(async () => {}),
			updateQuestionDraft: mock(async () => {}),
			handleQuestionCancel: mock(async () => {}),
		};

		// Mock SessionManager
		mockSessionManager = {
			getSessionAsync: mock(async () => mockAgentSession),
		} as unknown as SessionManager;

		// Setup handlers
		setupQuestionHandlers(mockMessageHub, mockSessionManager, mockDaemonHub);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register all question handlers', () => {
			expect(handlers.has('question.respond')).toBe(true);
			expect(handlers.has('question.saveDraft')).toBe(true);
			expect(handlers.has('question.cancel')).toBe(true);
		});
	});

	describe('question.respond', () => {
		const mockResponses: QuestionDraftResponse[] = [
			{ questionIndex: 0, selectedOptions: ['Option A'] },
		];

		it('should handle question response successfully', async () => {
			const result = await callHandler('question.respond', {
				sessionId: 'test-session-id',
				toolUseId: 'tool-123',
				responses: mockResponses,
			});

			expect(result).toEqual({ success: true });
			expect(mockSessionManager.getSessionAsync).toHaveBeenCalledWith('test-session-id');
			expect(mockAgentSession.handleQuestionResponse).toHaveBeenCalledWith(
				'tool-123',
				mockResponses
			);
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('question.respond', {
					sessionId: 'nonexistent',
					toolUseId: 'tool-123',
					responses: mockResponses,
				})
			).rejects.toThrow('Session not found: nonexistent');
		});
	});

	describe('question.saveDraft', () => {
		const mockDraftResponses: QuestionDraftResponse[] = [
			{ questionIndex: 0, selectedOptions: ['Draft Option'] },
		];

		it('should save draft responses successfully', async () => {
			const result = await callHandler('question.saveDraft', {
				sessionId: 'test-session-id',
				draftResponses: mockDraftResponses,
			});

			expect(result).toEqual({ success: true });
			expect(mockSessionManager.getSessionAsync).toHaveBeenCalledWith('test-session-id');
			expect(mockAgentSession.updateQuestionDraft).toHaveBeenCalledWith(mockDraftResponses);
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('question.saveDraft', {
					sessionId: 'nonexistent',
					draftResponses: mockDraftResponses,
				})
			).rejects.toThrow('Session not found: nonexistent');
		});
	});

	describe('question.cancel', () => {
		it('should cancel question successfully', async () => {
			const result = await callHandler('question.cancel', {
				sessionId: 'test-session-id',
				toolUseId: 'tool-456',
			});

			expect(result).toEqual({ success: true });
			expect(mockSessionManager.getSessionAsync).toHaveBeenCalledWith('test-session-id');
			expect(mockAgentSession.handleQuestionCancel).toHaveBeenCalledWith('tool-456');
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('question.cancel', {
					sessionId: 'nonexistent',
					toolUseId: 'tool-456',
				})
			).rejects.toThrow('Session not found: nonexistent');
		});
	});
});
