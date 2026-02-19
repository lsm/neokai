/**
 * Tests for QA RPC Handlers
 *
 * Tests the RPC handlers for Q&A round operations:
 * - qa.getActiveRound - Get the active Q&A round
 * - qa.getRoundHistory - Get Q&A round history for a room
 * - qa.answerQuestion - Answer a question in the round
 * - qa.completeRound - Complete the current round
 *
 * Mocks QARoundRepository to focus on RPC handler logic.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type RoomQARound, type QAQuestion } from '@neokai/shared';
import { setupQAHandlers } from '../../../src/lib/rpc-handlers/qa-handlers';
import type { Database } from '../../../src/storage/database';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock QARoundRepository methods
const mockQARoundRepository = {
	getActiveRound: mock((roomId: string): RoomQARound | null => {
		if (roomId === 'room-no-active') return null;
		return {
			id: 'round-123',
			roomId,
			trigger: 'room_created',
			status: 'in_progress',
			questions: [],
			startedAt: Date.now(),
		};
	}),
	listRounds: mock((roomId: string, limit?: number): RoomQARound[] => {
		return [
			{
				id: 'round-1',
				roomId,
				trigger: 'room_created',
				status: 'completed',
				questions: [],
				startedAt: Date.now() - 10000,
				completedAt: Date.now() - 5000,
			},
			{
				id: 'round-2',
				roomId,
				trigger: 'context_updated',
				status: 'completed',
				questions: [],
				startedAt: Date.now() - 3000,
				completedAt: Date.now() - 1000,
			},
		].slice(0, limit);
	}),
	answerQuestion: mock((roundId: string, questionId: string, answer: string): QAQuestion | null => {
		if (questionId === 'question-not-found') return null;
		return {
			id: questionId,
			question: 'Test question?',
			answer,
			askedAt: Date.now() - 1000,
			answeredAt: Date.now(),
		};
	}),
	completeRound: mock((roundId: string, summary?: string): RoomQARound | null => {
		return {
			id: roundId,
			roomId: 'room-123',
			trigger: 'room_created',
			status: 'completed',
			questions: [],
			startedAt: Date.now() - 5000,
			completedAt: Date.now(),
			summary,
		};
	}),
};

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

// Helper to create mock Database
function createMockDatabase(): Database {
	return {
		getDatabase: mock(() => ({})),
	} as unknown as Database;
}

// Mock the QARoundRepository constructor
mock.module('../../../src/storage/repositories/qa-round-repository', () => ({
	QARoundRepository: class {
		constructor() {}
		getActiveRound = mockQARoundRepository.getActiveRound;
		listRounds = mockQARoundRepository.listRounds;
		answerQuestion = mockQARoundRepository.answerQuestion;
		completeRound = mockQARoundRepository.completeRound;
	},
}));

describe('QA RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let mockDb: Database;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		mockDb = createMockDatabase();

		// Reset all mocks
		mockQARoundRepository.getActiveRound.mockClear();
		mockQARoundRepository.listRounds.mockClear();
		mockQARoundRepository.answerQuestion.mockClear();
		mockQARoundRepository.completeRound.mockClear();

		// Setup handlers with mocked dependencies
		setupQAHandlers(messageHubData.hub, mockDb);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('qa.getActiveRound', () => {
		it('should return active round', async () => {
			const handler = messageHubData.handlers.get('qa.getActiveRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { round: RoomQARound | null };

			expect(mockQARoundRepository.getActiveRound).toHaveBeenCalledWith('room-123');
			expect(result.round).toBeDefined();
			expect(result.round?.status).toBe('in_progress');
		});

		it('should return null when no active round', async () => {
			const handler = messageHubData.handlers.get('qa.getActiveRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-no-active',
			};

			const result = (await handler!(params, {})) as { round: RoomQARound | null };

			expect(result.round).toBeNull();
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.getActiveRound');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
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

			expect(mockQARoundRepository.listRounds).toHaveBeenCalledWith('room-123', undefined);
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

			expect(mockQARoundRepository.listRounds).toHaveBeenCalledWith('room-123', 5);
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.getRoundHistory');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('qa.answerQuestion', () => {
		it('should answer a question', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				questionId: 'question-123',
				answer: 'This is the answer',
			};

			const result = (await handler!(params, {})) as { question: QAQuestion | null };

			expect(mockQARoundRepository.getActiveRound).toHaveBeenCalledWith('room-123');
			expect(mockQARoundRepository.answerQuestion).toHaveBeenCalledWith(
				'round-123',
				'question-123',
				'This is the answer'
			);
			expect(result.question).toBeDefined();
			expect(result.question?.answer).toBe('This is the answer');
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				questionId: 'question-123',
				answer: 'Answer',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('should require questionId', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				answer: 'Answer',
			};

			await expect(handler!(params, {})).rejects.toThrow('Question ID is required');
		});

		it('should require answer', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				questionId: 'question-123',
			};

			await expect(handler!(params, {})).rejects.toThrow('Answer is required');
		});

		it('should throw error when no active round', async () => {
			const handler = messageHubData.handlers.get('qa.answerQuestion');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-no-active',
				questionId: 'question-123',
				answer: 'Answer',
			};

			await expect(handler!(params, {})).rejects.toThrow('No active Q&A round for this room');
		});
	});

	describe('qa.completeRound', () => {
		it('should complete the round', async () => {
			const handler = messageHubData.handlers.get('qa.completeRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { round: RoomQARound | null };

			expect(mockQARoundRepository.getActiveRound).toHaveBeenCalledWith('room-123');
			expect(mockQARoundRepository.completeRound).toHaveBeenCalledWith('round-123', undefined);
			expect(result.round?.status).toBe('completed');
		});

		it('should complete the round with summary', async () => {
			const handler = messageHubData.handlers.get('qa.completeRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				summary: 'User clarified requirements',
			};

			await handler!(params, {});

			expect(mockQARoundRepository.completeRound).toHaveBeenCalledWith(
				'round-123',
				'User clarified requirements'
			);
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('qa.completeRound');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('should throw error when no active round', async () => {
			const handler = messageHubData.handlers.get('qa.completeRound');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-no-active',
			};

			await expect(handler!(params, {})).rejects.toThrow('No active Q&A round for this room');
		});
	});

	describe('handler registration', () => {
		it('should register all handlers', () => {
			expect(messageHubData.handlers.has('qa.getActiveRound')).toBe(true);
			expect(messageHubData.handlers.has('qa.getRoundHistory')).toBe(true);
			expect(messageHubData.handlers.has('qa.answerQuestion')).toBe(true);
			expect(messageHubData.handlers.has('qa.completeRound')).toBe(true);
		});
	});
});
