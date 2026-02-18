/**
 * QARoundManager Tests
 *
 * Tests for Q&A round management with:
 * - Initialization
 * - Starting rounds
 * - Asking and answering questions
 * - Completing and cancelling rounds
 * - Event emissions
 * - Configuration
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { QARoundManager, type QARoundManagerContext } from '../../../src/lib/room/qa-round-manager';
import { RoomManager } from '../../../src/lib/room/room-manager';
import type { RoomQARound, QAQuestion, Room } from '@neokai/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { MessageHub } from '@neokai/shared';

describe('QARoundManager', () => {
	let db: Database;
	let roomManager: RoomManager;
	let roomId: string;
	let mockDaemonHub: { emit: ReturnType<typeof mock> };
	let mockMessageHub: MessageHub;
	let qaManager: QARoundManager;

	beforeEach(() => {
		db = new Database(':memory:');
		createTables(db);

		// Create qa_rounds table (not included in createTables, added via migration)
		db.exec(`
			CREATE TABLE IF NOT EXISTS qa_rounds (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				trigger TEXT NOT NULL CHECK(trigger IN ('room_created', 'context_updated', 'goal_created')),
				status TEXT NOT NULL DEFAULT 'in_progress'
					CHECK(status IN ('in_progress', 'completed', 'cancelled')),
				questions TEXT DEFAULT '[]',
				started_at INTEGER NOT NULL,
				completed_at INTEGER,
				summary TEXT,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_qa_rounds_room ON qa_rounds(room_id);
			CREATE INDEX IF NOT EXISTS idx_qa_rounds_status ON qa_rounds(room_id, status);
		`);

		roomManager = new RoomManager(db);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: ['/workspace/test'],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;

		// Create mocks
		mockDaemonHub = {
			emit: mock(async () => {}),
		};

		mockMessageHub = {
			onRequest: mock(() => () => {}),
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

		// Create manager with default config
		qaManager = createQAManager(room);
	});

	function createQAManager(room: Room, config?: Partial<QARoundManagerContext>): QARoundManager {
		const ctx: QARoundManagerContext = {
			room,
			db: db as any,
			daemonHub: mockDaemonHub as unknown as DaemonHub,
			messageHub: mockMessageHub,
			...config,
		};
		return new QARoundManager(ctx);
	}

	afterEach(() => {
		db.close();
	});

	describe('initialization', () => {
		it('should create manager with valid room', () => {
			expect(qaManager).toBeDefined();
		});

		it('should load existing active round on init', () => {
			// Create a round first
			const room = roomManager.createRoom({ name: 'Room 2' });
			const manager1 = createQAManager(room);
			manager1.startRound('room_created');

			// Create new manager - should load existing round
			const manager2 = createQAManager(room);
			expect(manager2.hasActiveRound()).toBe(true);
		});

		it('should not have active round initially if none exists', () => {
			expect(qaManager.hasActiveRound()).toBe(false);
		});
	});

	describe('startRound', () => {
		it('should start round for room_created trigger', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);

			const round = await manager.startRound('room_created');

			expect(round).toBeDefined();
			expect(round.roomId).toBe(roomId);
			expect(round.trigger).toBe('room_created');
			expect(round.status).toBe('in_progress');
		});

		it('should start round for context_updated trigger', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);

			const round = await manager.startRound('context_updated');

			expect(round.trigger).toBe('context_updated');
		});

		it('should start round for goal_created trigger', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);

			const round = await manager.startRound('goal_created');

			expect(round.trigger).toBe('goal_created');
		});

		it('should not start if round already active', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);

			const round1 = await manager.startRound('room_created');
			const round2 = await manager.startRound('context_updated');

			expect(round2.id).toBe(round1.id);
			expect(round2.trigger).toBe('room_created'); // Should keep original trigger
		});

		it('should emit qa.roundStarted event', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);

			await manager.startRound('room_created');

			expect(mockDaemonHub.emit).toHaveBeenCalledWith(
				'qa.roundStarted',
				expect.objectContaining({
					sessionId: `room:${roomId}`,
					roomId,
					trigger: 'room_created',
				})
			);
		});

		it('should set hasActiveRound to true', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);

			await manager.startRound('room_created');

			expect(manager.hasActiveRound()).toBe(true);
		});
	});

	describe('askQuestion', () => {
		it('should add question to active round', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			const question = await manager.askQuestion('What is the project about?');

			expect(question.question).toBe('What is the project about?');
			expect(question.answer).toBeUndefined();
		});

		it('should emit qa.questionAsked event', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			await manager.askQuestion('Test question?');

			expect(mockDaemonHub.emit).toHaveBeenCalledWith(
				'qa.questionAsked',
				expect.objectContaining({
					sessionId: `room:${roomId}`,
					roomId,
					question: 'Test question?',
				})
			);
		});

		it('should throw error if no active round', async () => {
			await expect(qaManager.askQuestion('Test?')).rejects.toThrow('No active Q&A round');
		});

		it('should throw error when max questions reached', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room, {
				// Use custom config via partial
			} as any);

			// Create manager with low max questions
			const ctx: QARoundManagerContext = {
				room,
				db: db as any,
				daemonHub: mockDaemonHub as unknown as DaemonHub,
				messageHub: mockMessageHub,
			};
			const limitedManager = new QARoundManager(ctx, { maxQuestionsPerRound: 2 });
			await limitedManager.startRound('room_created');

			await limitedManager.askQuestion('Question 1?');
			await limitedManager.askQuestion('Question 2?');

			await expect(limitedManager.askQuestion('Question 3?')).rejects.toThrow(
				'Maximum questions per round (2) reached'
			);
		});

		it('should generate unique question IDs', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			const q1 = await manager.askQuestion('Question 1?');
			const q2 = await manager.askQuestion('Question 2?');

			expect(q1.id).not.toBe(q2.id);
		});
	});

	describe('answerQuestion', () => {
		it('should record answer', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			const question = await manager.askQuestion('What framework?');

			const answered = await manager.answerQuestion(question.id, 'React');

			expect(answered.answer).toBe('React');
			expect(answered.answeredAt).toBeDefined();
		});

		it('should emit qa.questionAnswered event', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			const question = await manager.askQuestion('Test?');

			await manager.answerQuestion(question.id, 'Answer');

			expect(mockDaemonHub.emit).toHaveBeenCalledWith(
				'qa.questionAnswered',
				expect.objectContaining({
					sessionId: `room:${roomId}`,
					roomId,
					questionId: question.id,
					answer: 'Answer',
				})
			);
		});

		it('should throw error if no active round', async () => {
			await expect(qaManager.answerQuestion('q-1', 'Answer')).rejects.toThrow(
				'No active Q&A round'
			);
		});

		it('should throw error for non-existent question', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			await expect(manager.answerQuestion('non-existent', 'Answer')).rejects.toThrow(
				'Question not found: non-existent'
			);
		});
	});

	describe('completeRound', () => {
		it('should complete the round', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			const completed = await manager.completeRound();

			expect(completed.status).toBe('completed');
			expect(completed.completedAt).toBeDefined();
		});

		it('should complete the round with summary', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			const completed = await manager.completeRound('User provided clarifications');

			expect(completed.summary).toBe('User provided clarifications');
		});

		it('should emit qa.roundCompleted event', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			await manager.askQuestion('Question?');

			await manager.completeRound('Summary');

			expect(mockDaemonHub.emit).toHaveBeenCalledWith(
				'qa.roundCompleted',
				expect.objectContaining({
					sessionId: `room:${roomId}`,
					roomId,
					summary: 'Summary',
					questionsCount: 1,
				})
			);
		});

		it('should emit event with correct answered count', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			const q1 = await manager.askQuestion('Q1?');
			await manager.askQuestion('Q2?');
			await manager.answerQuestion(q1.id, 'A1');

			await manager.completeRound();

			expect(mockDaemonHub.emit).toHaveBeenCalledWith(
				'qa.roundCompleted',
				expect.objectContaining({
					questionsCount: 2,
					answeredCount: 1,
				})
			);
		});

		it('should throw error if no active round', async () => {
			await expect(qaManager.completeRound()).rejects.toThrow('No active Q&A round');
		});

		it('should clear active round after completion', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			await manager.completeRound();

			expect(manager.hasActiveRound()).toBe(false);
		});
	});

	describe('cancelRound', () => {
		it('should cancel the round', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			const cancelled = await manager.cancelRound();

			expect(cancelled?.status).toBe('cancelled');
		});

		it('should emit qa.roundCancelled event', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			await manager.cancelRound();

			expect(mockDaemonHub.emit).toHaveBeenCalledWith(
				'qa.roundCancelled',
				expect.objectContaining({
					sessionId: `room:${roomId}`,
					roomId,
				})
			);
		});

		it('should return null if no active round', async () => {
			const result = await qaManager.cancelRound();

			expect(result).toBeNull();
		});

		it('should clear active round after cancellation', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			await manager.cancelRound();

			expect(manager.hasActiveRound()).toBe(false);
		});
	});

	describe('getActiveRound', () => {
		it('should return active round', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			const started = await manager.startRound('room_created');

			const active = manager.getActiveRound();

			expect(active?.id).toBe(started.id);
		});

		it('should return null if no active round', () => {
			expect(qaManager.getActiveRound()).toBeNull();
		});
	});

	describe('hasActiveRound', () => {
		it('should return true when round is active', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			expect(manager.hasActiveRound()).toBe(true);
		});

		it('should return false when no active round', () => {
			expect(qaManager.hasActiveRound()).toBe(false);
		});
	});

	describe('getUnansweredQuestions', () => {
		it('should return unanswered questions', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			const q1 = await manager.askQuestion('Q1?');
			await manager.askQuestion('Q2?');
			await manager.answerQuestion(q1.id, 'A1');

			const unanswered = manager.getUnansweredQuestions();

			expect(unanswered).toHaveLength(1);
			expect(unanswered[0].question).toBe('Q2?');
		});

		it('should return empty array if no active round', () => {
			expect(qaManager.getUnansweredQuestions()).toEqual([]);
		});

		it('should return empty array if all answered', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			const q1 = await manager.askQuestion('Q1?');
			await manager.answerQuestion(q1.id, 'A1');

			expect(manager.getUnansweredQuestions()).toEqual([]);
		});
	});

	describe('getNextUnansweredQuestion', () => {
		it('should return first unanswered question', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			await manager.askQuestion('Q1?');
			await manager.askQuestion('Q2?');

			const next = manager.getNextUnansweredQuestion();

			expect(next?.question).toBe('Q1?');
		});

		it('should return null if no unanswered questions', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			const q1 = await manager.askQuestion('Q1?');
			await manager.answerQuestion(q1.id, 'A1');

			expect(manager.getNextUnansweredQuestion()).toBeNull();
		});

		it('should return null if no active round', () => {
			expect(qaManager.getNextUnansweredQuestion()).toBeNull();
		});
	});

	describe('allQuestionsAnswered', () => {
		it('should return true when all answered', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			const q1 = await manager.askQuestion('Q1?');
			await manager.answerQuestion(q1.id, 'A1');

			expect(manager.allQuestionsAnswered()).toBe(true);
		});

		it('should return false when unanswered questions exist', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			await manager.askQuestion('Q1?');

			expect(manager.allQuestionsAnswered()).toBe(false);
		});

		it('should return true if no active round', () => {
			expect(qaManager.allQuestionsAnswered()).toBe(true);
		});
	});

	describe('getRoundHistory', () => {
		it('should return round history for room', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			await manager.completeRound();
			await manager.startRound('context_updated');
			await manager.completeRound();

			const history = manager.getRoundHistory();

			expect(history).toHaveLength(2);
		});

		it('should respect limit parameter', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');
			await manager.completeRound();
			await manager.startRound('context_updated');
			await manager.completeRound();
			await manager.startRound('goal_created');
			await manager.completeRound();

			const history = manager.getRoundHistory(2);

			expect(history).toHaveLength(2);
		});

		it('should return empty array if no rounds', () => {
			expect(qaManager.getRoundHistory()).toEqual([]);
		});
	});

	describe('configuration', () => {
		it('should use default maxQuestionsPerRound', async () => {
			const room = roomManager.getRoom(roomId)!;
			const ctx: QARoundManagerContext = {
				room,
				db: db as any,
				daemonHub: mockDaemonHub as unknown as DaemonHub,
				messageHub: mockMessageHub,
			};
			const manager = new QARoundManager(ctx);
			await manager.startRound('room_created');

			// Default is 5
			await manager.askQuestion('Q1?');
			await manager.askQuestion('Q2?');
			await manager.askQuestion('Q3?');
			await manager.askQuestion('Q4?');
			await manager.askQuestion('Q5?');

			await expect(manager.askQuestion('Q6?')).rejects.toThrow(
				'Maximum questions per round (5) reached'
			);
		});

		it('should respect custom maxQuestionsPerRound', async () => {
			const room = roomManager.getRoom(roomId)!;
			const ctx: QARoundManagerContext = {
				room,
				db: db as any,
				daemonHub: mockDaemonHub as unknown as DaemonHub,
				messageHub: mockMessageHub,
			};
			const manager = new QARoundManager(ctx, { maxQuestionsPerRound: 3 });
			await manager.startRound('room_created');

			await manager.askQuestion('Q1?');
			await manager.askQuestion('Q2?');
			await manager.askQuestion('Q3?');

			await expect(manager.askQuestion('Q4?')).rejects.toThrow(
				'Maximum questions per round (3) reached'
			);
		});

		it('should have autoTriggerOnRoomCreate enabled by default', () => {
			expect(qaManager.shouldAutoTriggerOnRoomCreate()).toBe(true);
		});

		it('should have autoTriggerOnContextUpdate enabled by default', () => {
			expect(qaManager.shouldAutoTriggerOnContextUpdate()).toBe(true);
		});

		it('should respect disabled autoTriggerOnRoomCreate', () => {
			const room = roomManager.getRoom(roomId)!;
			const ctx: QARoundManagerContext = {
				room,
				db: db as any,
				daemonHub: mockDaemonHub as unknown as DaemonHub,
				messageHub: mockMessageHub,
			};
			const manager = new QARoundManager(ctx, { autoTriggerOnRoomCreate: false });

			expect(manager.shouldAutoTriggerOnRoomCreate()).toBe(false);
		});

		it('should respect disabled autoTriggerOnContextUpdate', () => {
			const room = roomManager.getRoom(roomId)!;
			const ctx: QARoundManagerContext = {
				room,
				db: db as any,
				daemonHub: mockDaemonHub as unknown as DaemonHub,
				messageHub: mockMessageHub,
			};
			const manager = new QARoundManager(ctx, { autoTriggerOnContextUpdate: false });

			expect(manager.shouldAutoTriggerOnContextUpdate()).toBe(false);
		});
	});

	describe('refreshActiveRound', () => {
		it('should refresh active round from database', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager1 = createQAManager(room);
			await manager1.startRound('room_created');

			// Create another manager and add a question
			const manager2 = createQAManager(room);
			await manager2.askQuestion('Question?');

			// Refresh first manager
			manager1.refreshActiveRound();

			const activeRound = manager1.getActiveRound();
			expect(activeRound?.questions).toHaveLength(1);
		});

		it('should return null if no active round', () => {
			expect(qaManager.refreshActiveRound()).toBeNull();
		});
	});

	describe('multiple rooms', () => {
		it('should isolate rounds between rooms', async () => {
			const room1 = roomManager.createRoom({ name: 'Room 1' });
			const room2 = roomManager.createRoom({ name: 'Room 2' });

			const manager1 = createQAManager(room1);
			const manager2 = createQAManager(room2);

			await manager1.startRound('room_created');
			await manager1.askQuestion('Room 1 question?');

			await manager2.startRound('room_created');
			await manager2.askQuestion('Room 2 question?');

			expect(manager1.getActiveRound()?.questions[0].question).toBe('Room 1 question?');
			expect(manager2.getActiveRound()?.questions[0].question).toBe('Room 2 question?');
		});
	});

	describe('edge cases', () => {
		it('should handle empty question', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			const question = await manager.askQuestion('');

			expect(question.question).toBe('');
		});

		it('should handle very long question', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			const longQuestion = 'x'.repeat(10000);
			const question = await manager.askQuestion(longQuestion);

			expect(question.question).toBe(longQuestion);
		});

		it('should handle special characters in question', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			const question = await manager.askQuestion('Question with "quotes" and \'apostrophes\'?');

			expect(question.question).toBe('Question with "quotes" and \'apostrophes\'?');
		});

		it('should handle unicode in question and answer', async () => {
			const room = roomManager.getRoom(roomId)!;
			const manager = createQAManager(room);
			await manager.startRound('room_created');

			const question = await manager.askQuestion('你好世界?');
			const answered = await manager.answerQuestion(question.id, ' مرحبا ');

			expect(answered.question).toBe('你好世界?');
			expect(answered.answer).toBe(' مرحبا ');
		});
	});
});
