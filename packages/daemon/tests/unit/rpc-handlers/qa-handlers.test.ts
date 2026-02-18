/**
 * Tests for QA RPC Handlers
 *
 * Tests the RPC handlers for Q&A round operations:
 * - qa.startRound - Start a new Q&A round
 * - qa.answerQuestion - Answer a question in the round
 * - qa.getActiveRound - Get the active Q&A round
 * - qa.completeRound - Complete the current round
 * - qa.cancelRound - Cancel the current round
 * - qa.getRoundHistory - Get Q&A round history for a room
 * - qa.askQuestion - Agent asks a question
 *
 * Mocks QARoundManager to focus on RPC handler logic.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type RoomQARound, type QAQuestion } from '@neokai/shared';
import { setupQAHandlers } from '../../../src/lib/rpc-handlers/qa-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock QARoundManager methods
const mockQAManager = {
	startRound: mock(
		async (trigger: 'room_created' | 'context_updated' | 'goal_created'): Promise<RoomQARound> => ({
			id: 'round-123',
			roomId: 'room-123',
			trigger,
			status: 'in_progress',
			questions: [],
			startedAt: Date.now(),
		})
	),
	askQuestion: mock(
		async (question: string): Promise<QAQuestion> => ({
			id: 'question-123',
			question,
			askedAt: Date.now(),
		})
	),
	answerQuestion: mock(
		async (questionId: string, answer: string): Promise<QAQuestion> => ({
			id: questionId,
			question: 'Test question?',
			answer,
			askedAt: Date.now() - 1000,
			answeredAt: Date.now(),
		})
	),
	completeRound: mock(
		async (summary?: string): Promise<RoomQARound> => ({
			id: 'round-123',
			roomId: 'room-123',
			trigger: 'room_created',
			status: 'completed',
			questions: [],
			startedAt: Date.now() - 5000,
			completedAt: Date.now(),
			summary,
		})
	),
	cancelRound: mock(
		async (): Promise<RoomQARound | null> => ({
			id: 'round-123',
			roomId: 'room-123',
			trigger: 'room_created',
			status: 'cancelled',
			questions: [],
			startedAt: Date.now() - 5000,
			completedAt: Date.now(),
		})
	),
	getActiveRound: mock((): RoomQARound | null => ({
		id: 'round-123',
		roomId: 'room-123',
		trigger: 'room_created',
		status: 'in_progress',
		questions: [],
		startedAt: Date.now(),
	})),
	getRoundHistory: mock((limit?: number): RoomQARound[] => [
		{
			id: 'round-1',
			roomId: 'room-123',
			trigger: 'room_created',
			status: 'completed',
			questions: [],
			startedAt: Date.now() - 10000,
			completedAt: Date.now() - 5000,
		},
		{
			id: 'round-2',
			roomId: 'room-123',
			trigger: 'context_updated',
			status: 'completed',
			questions: [],
			startedAt: Date.now() - 3000,
			completedAt: Date.now() - 1000,
		},
	]),
};

// Type for QARoundManager-like interface
type QAManagerLike = typeof mockQAManager;

const createMockQAManager = (): QAManagerLike => mockQAManager as unknown as QAManagerLike;

// Helper to create a minimal mock MessageHub that captures handlers
function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

// Helper to create mock DaemonHub
function createMockDaemonHub(): {
	daemonHub: DaemonHub;
	emit: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emit: emitMock };
}

describe('QA RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	const qaManagers: Map<string, QAManagerLike> = new Map();

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();
		qaManagers.clear();

		// Reset all mocks
		mockQAManager.startRound.mockClear();
		mockQAManager.askQuestion.mockClear();
		mockQAManager.answerQuestion.mockClear();
		mockQAManager.completeRound.mockClear();
		mockQAManager.cancelRound.mockClear();
		mockQAManager.getActiveRound.mockClear();
		mockQAManager.getRoundHistory.mockClear();

		// Setup handlers with mocked dependencies
		setupQAHandlers(
			messageHubData.hub,
			daemonHubData.daemonHub,
			(roomId: string) => qaManagers.get(roomId) || null
		);

		// Register default mock manager for room-123
		qaManagers.set('room-123', createMockQAManager());
	});

	afterEach(() => {
		mock.restore();
	});

	describe('qa.startRound', () => {
		it('should start a new round', async () => {
			const handler = messageHubData.handlers.get('qa.startRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				trigger: 'room_created' as const,
			};

			const result = (await handler!(params, {})) as { round: RoomQARound };

			expect(mockQAManager.startRound).toHaveBeenCalledWith('room_created');
			expect(result.round).toBeDefined();
			expect(result.round.status).toBe('in_progress');
		});

		it('should start round with context_updated trigger', async () => {
			const handler = messageHubData.handlers.get('qa.startRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				trigger: 'context_updated' as const,
			};

			await handler!(params, {});

			expect(mockQAManager.startRound).toHaveBeenCalledWith('context_updated');
		});

		it('should start round with goal_created trigger', async () => {
			const handler = messageHubData.handlers.get('qa.startRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				trigger: 'goal_created' as const,
			};

			await handler!(params, {});

			expect(mockQAManager.startRound).toHaveBeenCalledWith('goal_created');
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.startRound');
			expect(handler).toBeDefined();

			const params = {
				trigger: 'room_created' as const,
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('should require trigger', async () => {
			const handler = messageHubData.handlers.get('qa.startRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			await expect(handler!(params, {})).rejects.toThrow('Trigger is required');
		});

		it('should throw error when Q&A manager not available', async () => {
			const handler = messageHubData.handlers.get('qa.startRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'non-existent-room',
				trigger: 'room_created' as const,
			};

			await expect(handler!(params, {})).rejects.toThrow(
				'Q&A round manager not available for this room'
			);
		});
	});

	describe('qa.answerQuestion', () => {
		it('should answer a question', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roundId: 'round-123',
				questionId: 'question-123',
				answer: 'This is the answer',
			};

			const result = (await handler!(params, {})) as { question: QAQuestion };

			expect(mockQAManager.answerQuestion).toHaveBeenCalledWith(
				'question-123',
				'This is the answer'
			);
			expect(result.question).toBeDefined();
			expect(result.question.answer).toBe('This is the answer');
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roundId: 'round-123',
				questionId: 'question-123',
				answer: 'Answer',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('should require roundId', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				questionId: 'question-123',
				answer: 'Answer',
			};

			await expect(handler!(params, {})).rejects.toThrow('Round ID is required');
		});

		it('should require questionId', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roundId: 'round-123',
				answer: 'Answer',
			};

			await expect(handler!(params, {})).rejects.toThrow('Question ID is required');
		});

		it('should require answer', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				roundId: 'round-123',
				questionId: 'question-123',
			};

			await expect(handler!(params, {})).rejects.toThrow('Answer is required');
		});

		it('should throw error when Q&A manager not available', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'non-existent-room',
				roundId: 'round-123',
				questionId: 'question-123',
				answer: 'Answer',
			};

			await expect(handler!(params, {})).rejects.toThrow(
				'Q&A round manager not available for this room'
			);
		});
	});

	describe('qa.getActiveRound', () => {
		it('should return active round', async () => {
			const handler = messageHubData.handlers.get('qa.getActiveRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { round: RoomQARound | null };

			expect(mockQAManager.getActiveRound).toHaveBeenCalled();
			expect(result.round).toBeDefined();
			expect(result.round?.status).toBe('in_progress');
		});

		it('should return null when no active round', async () => {
			const handler = messageHubData.handlers.get('qa.getActiveRound');
			expect(handler).toBeDefined();

			mockQAManager.getActiveRound.mockReturnValueOnce(null);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { round: RoomQARound | null };

			expect(result.round).toBeNull();
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.getActiveRound');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('should throw error when Q&A manager not available', async () => {
			const handler = messageHubData.handlers.get('qa.getActiveRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'non-existent-room',
			};

			await expect(handler!(params, {})).rejects.toThrow(
				'Q&A round manager not available for this room'
			);
		});
	});

	describe('qa.completeRound', () => {
		it('should complete the round', async () => {
			const handler = messageHubData.handlers.get('qa.completeRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { round: RoomQARound };

			expect(mockQAManager.completeRound).toHaveBeenCalledWith(undefined);
			expect(result.round.status).toBe('completed');
		});

		it('should complete the round with summary', async () => {
			const handler = messageHubData.handlers.get('qa.completeRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				summary: 'User clarified requirements',
			};

			await handler!(params, {});

			expect(mockQAManager.completeRound).toHaveBeenCalledWith('User clarified requirements');
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.completeRound');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('should throw error when Q&A manager not available', async () => {
			const handler = messageHubData.handlers.get('qa.completeRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'non-existent-room',
			};

			await expect(handler!(params, {})).rejects.toThrow(
				'Q&A round manager not available for this room'
			);
		});
	});

	describe('qa.cancelRound', () => {
		it('should cancel the round', async () => {
			const handler = messageHubData.handlers.get('qa.cancelRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { round: RoomQARound | null };

			expect(mockQAManager.cancelRound).toHaveBeenCalled();
			expect(result.round?.status).toBe('cancelled');
		});

		it('should return null when no active round to cancel', async () => {
			const handler = messageHubData.handlers.get('qa.cancelRound');
			expect(handler).toBeDefined();

			mockQAManager.cancelRound.mockResolvedValueOnce(null);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { round: RoomQARound | null };

			expect(result.round).toBeNull();
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.cancelRound');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('should throw error when Q&A manager not available', async () => {
			const handler = messageHubData.handlers.get('qa.cancelRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'non-existent-room',
			};

			await expect(handler!(params, {})).rejects.toThrow(
				'Q&A round manager not available for this room'
			);
		});
	});

	describe('qa.getRoundHistory', () => {
		it('should return round history', async () => {
			const handler = messageHubData.handlers.get('qa.getRoundHistory');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { rounds: RoomQARound[] };

			expect(mockQAManager.getRoundHistory).toHaveBeenCalledWith(undefined);
			expect(result.rounds).toHaveLength(2);
		});

		it('should pass limit parameter', async () => {
			const handler = messageHubData.handlers.get('qa.getRoundHistory');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				limit: 5,
			};

			await handler!(params, {});

			expect(mockQAManager.getRoundHistory).toHaveBeenCalledWith(5);
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.getRoundHistory');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('should throw error when Q&A manager not available', async () => {
			const handler = messageHubData.handlers.get('qa.getRoundHistory');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'non-existent-room',
			};

			await expect(handler!(params, {})).rejects.toThrow(
				'Q&A round manager not available for this room'
			);
		});
	});

	describe('qa.askQuestion', () => {
		it('should ask a question', async () => {
			const handler = messageHubData.handlers.get('qa.askQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				question: 'What framework should we use?',
			};

			const result = (await handler!(params, {})) as { question: QAQuestion };

			expect(mockQAManager.askQuestion).toHaveBeenCalledWith('What framework should we use?');
			expect(result.question).toBeDefined();
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.askQuestion');
			expect(handler).toBeDefined();

			const params = {
				question: 'Test question?',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('should require question', async () => {
			const handler = messageHubData.handlers.get('qa.askQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			await expect(handler!(params, {})).rejects.toThrow('Question is required');
		});

		it('should throw error when Q&A manager not available', async () => {
			const handler = messageHubData.handlers.get('qa.askQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'non-existent-room',
				question: 'Test?',
			};

			await expect(handler!(params, {})).rejects.toThrow(
				'Q&A round manager not available for this room'
			);
		});
	});

	describe('handler registration', () => {
		it('should register all handlers', () => {
			expect(messageHubData.handlers.has('qa.startRound')).toBe(true);
			expect(messageHubData.handlers.has('qa.answerQuestion')).toBe(true);
			expect(messageHubData.handlers.has('qa.getActiveRound')).toBe(true);
			expect(messageHubData.handlers.has('qa.completeRound')).toBe(true);
			expect(messageHubData.handlers.has('qa.cancelRound')).toBe(true);
			expect(messageHubData.handlers.has('qa.getRoundHistory')).toBe(true);
			expect(messageHubData.handlers.has('qa.askQuestion')).toBe(true);
		});
	});
});
