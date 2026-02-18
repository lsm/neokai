/**
 * QA Round Repository Tests
 *
 * Tests for Q&A round CRUD operations and status management.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { QARoundRepository } from '../../../src/storage/repositories/qa-round-repository';
import type { RoomQARound, QAQuestion, QARoundStatus } from '@neokai/shared';

describe('QARoundRepository', () => {
	let db: Database;
	let repository: QARoundRepository;
	const testRoomId = 'room-123';

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE qa_rounds (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				trigger TEXT NOT NULL CHECK(trigger IN ('room_created', 'context_updated', 'goal_created')),
				status TEXT NOT NULL DEFAULT 'in_progress'
					CHECK(status IN ('in_progress', 'completed', 'cancelled')),
				questions TEXT DEFAULT '[]',
				started_at INTEGER NOT NULL,
				completed_at INTEGER,
				summary TEXT
			);

			CREATE INDEX idx_qa_rounds_room ON qa_rounds(room_id);
			CREATE INDEX idx_qa_rounds_status ON qa_rounds(room_id, status);
		`);
		repository = new QARoundRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('createRound', () => {
		it('should create a round with trigger type room_created', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			expect(round.id).toBeDefined();
			expect(round.roomId).toBe(testRoomId);
			expect(round.trigger).toBe('room_created');
			expect(round.questions).toEqual([]);
		});

		it('should create a round with trigger type context_updated', () => {
			const round = repository.createRound(testRoomId, 'context_updated');

			expect(round.trigger).toBe('context_updated');
		});

		it('should create a round with trigger type goal_created', () => {
			const round = repository.createRound(testRoomId, 'goal_created');

			expect(round.trigger).toBe('goal_created');
		});

		it('should set status to in_progress', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			expect(round.status).toBe('in_progress');
		});

		it('should generate unique ID', () => {
			const round1 = repository.createRound(testRoomId, 'room_created');
			const round2 = repository.createRound(testRoomId, 'context_updated');

			expect(round1.id).not.toBe(round2.id);
		});

		it('should set startedAt timestamp', () => {
			const beforeTime = Date.now();
			const round = repository.createRound(testRoomId, 'room_created');

			expect(round.startedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should initialize questions as empty array', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			expect(round.questions).toEqual([]);
		});

		it('should not set completedAt initially', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			expect(round.completedAt).toBeUndefined();
		});

		it('should not set summary initially', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			expect(round.summary).toBeUndefined();
		});
	});

	describe('getRound', () => {
		it('should return round by ID', () => {
			const created = repository.createRound(testRoomId, 'room_created');
			const round = repository.getRound(created.id);

			expect(round).not.toBeNull();
			expect(round?.id).toBe(created.id);
			expect(round?.roomId).toBe(testRoomId);
		});

		it('should return null for non-existent ID', () => {
			const round = repository.getRound('non-existent-id');

			expect(round).toBeNull();
		});

		it('should return all round properties', () => {
			const created = repository.createRound(testRoomId, 'context_updated');
			const round = repository.getRound(created.id);

			expect(round).toEqual({
				id: created.id,
				roomId: testRoomId,
				trigger: 'context_updated',
				status: 'in_progress',
				questions: [],
				startedAt: expect.any(Number),
				completedAt: undefined,
				summary: undefined,
			});
		});
	});

	describe('getActiveRound', () => {
		it('should return active round for room', () => {
			repository.createRound(testRoomId, 'room_created');
			const activeRound = repository.getActiveRound(testRoomId);

			expect(activeRound).not.toBeNull();
			expect(activeRound?.status).toBe('in_progress');
		});

		it('should return null if no active round', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			repository.completeRound(round.id);

			const activeRound = repository.getActiveRound(testRoomId);

			expect(activeRound).toBeNull();
		});

		it('should return only in_progress rounds', () => {
			const round1 = repository.createRound(testRoomId, 'room_created');
			repository.completeRound(round1.id);
			const round2 = repository.createRound(testRoomId, 'context_updated');

			const activeRound = repository.getActiveRound(testRoomId);

			expect(activeRound?.id).toBe(round2.id);
		});

		it('should not return rounds from other rooms', () => {
			repository.createRound(testRoomId, 'room_created');
			repository.createRound('other-room', 'room_created');

			const activeRound = repository.getActiveRound(testRoomId);

			expect(activeRound?.roomId).toBe(testRoomId);
		});
	});

	describe('addQuestion', () => {
		it('should add question to round', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			const question = repository.addQuestion(round.id, 'What is the project structure?');

			expect(question.question).toBe('What is the project structure?');
			expect(question.answer).toBeUndefined();
			expect(question.answeredAt).toBeUndefined();
		});

		it('should generate question ID', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			const question = repository.addQuestion(round.id, 'Test question?');

			expect(question.id).toBeDefined();
			expect(typeof question.id).toBe('string');
		});

		it('should set askedAt timestamp', () => {
			const beforeTime = Date.now();
			const round = repository.createRound(testRoomId, 'room_created');
			const question = repository.addQuestion(round.id, 'Test question?');

			expect(question.askedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should append to existing questions', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			repository.addQuestion(round.id, 'Question 1?');
			repository.addQuestion(round.id, 'Question 2?');

			const updatedRound = repository.getRound(round.id);
			expect(updatedRound?.questions).toHaveLength(2);
		});

		it('should throw error for non-existent round', () => {
			expect(() => repository.addQuestion('non-existent', 'Question?')).toThrow(
				'Q&A round not found: non-existent'
			);
		});
	});

	describe('answerQuestion', () => {
		it('should record answer', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			const question = repository.addQuestion(round.id, 'What is the project?');

			const answered = repository.answerQuestion(round.id, question.id, 'It is a web app');

			expect(answered?.answer).toBe('It is a web app');
		});

		it('should set answeredAt timestamp', () => {
			const beforeTime = Date.now();
			const round = repository.createRound(testRoomId, 'room_created');
			const question = repository.addQuestion(round.id, 'Test?');

			const answered = repository.answerQuestion(round.id, question.id, 'Answer');

			expect(answered?.answeredAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should return null for non-existent question', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			const result = repository.answerQuestion(round.id, 'non-existent-question', 'Answer');

			expect(result).toBeNull();
		});

		it('should throw error for non-existent round', () => {
			expect(() => repository.answerQuestion('non-existent', 'q-1', 'Answer')).toThrow(
				'Q&A round not found: non-existent'
			);
		});

		it('should preserve other questions', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			const q1 = repository.addQuestion(round.id, 'Question 1?');
			const q2 = repository.addQuestion(round.id, 'Question 2?');

			repository.answerQuestion(round.id, q1.id, 'Answer 1');

			const updatedRound = repository.getRound(round.id);
			expect(updatedRound?.questions).toHaveLength(2);
			const answeredQ1 = updatedRound?.questions.find((q) => q.id === q1.id);
			const unansweredQ2 = updatedRound?.questions.find((q) => q.id === q2.id);
			expect(answeredQ1?.answer).toBe('Answer 1');
			expect(unansweredQ2?.answer).toBeUndefined();
		});
	});

	describe('completeRound', () => {
		it('should update status to completed', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			const completed = repository.completeRound(round.id);

			expect(completed?.status).toBe('completed');
		});

		it('should record summary', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			const completed = repository.completeRound(round.id, 'User clarified the project structure');

			expect(completed?.summary).toBe('User clarified the project structure');
		});

		it('should set completedAt timestamp', () => {
			const beforeTime = Date.now();
			const round = repository.createRound(testRoomId, 'room_created');

			const completed = repository.completeRound(round.id);

			expect(completed?.completedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should work without summary', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			const completed = repository.completeRound(round.id);

			expect(completed?.status).toBe('completed');
			expect(completed?.summary).toBeUndefined();
		});
	});

	describe('cancelRound', () => {
		it('should update status to cancelled', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			const cancelled = repository.cancelRound(round.id);

			expect(cancelled?.status).toBe('cancelled');
		});

		it('should set completedAt timestamp', () => {
			const beforeTime = Date.now();
			const round = repository.createRound(testRoomId, 'room_created');

			const cancelled = repository.cancelRound(round.id);

			expect(cancelled?.completedAt).toBeGreaterThanOrEqual(beforeTime);
		});
	});

	describe('updateStatus', () => {
		it('should update status to completed', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			const updated = repository.updateStatus(round.id, 'completed');

			expect(updated?.status).toBe('completed');
			expect(updated?.completedAt).toBeDefined();
		});

		it('should update status to cancelled', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			const updated = repository.updateStatus(round.id, 'cancelled');

			expect(updated?.status).toBe('cancelled');
			expect(updated?.completedAt).toBeDefined();
		});

		it('should not set completedAt for in_progress status', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			repository.completeRound(round.id);

			const updated = repository.updateStatus(round.id, 'in_progress');

			expect(updated?.status).toBe('in_progress');
			// completedAt should remain from previous completion
			expect(updated?.completedAt).toBeDefined();
		});

		it('should include summary when provided', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			const updated = repository.updateStatus(round.id, 'completed', 'Summary text');

			expect(updated?.summary).toBe('Summary text');
		});
	});

	describe('listRounds', () => {
		it('should list rounds for a room', () => {
			repository.createRound(testRoomId, 'room_created');
			repository.createRound(testRoomId, 'context_updated');
			repository.createRound('other-room', 'room_created');

			const rounds = repository.listRounds(testRoomId);

			expect(rounds).toHaveLength(2);
			expect(rounds.every((r) => r.roomId === testRoomId)).toBe(true);
		});

		it('should return rounds ordered by started_at DESC', async () => {
			repository.createRound(testRoomId, 'room_created');
			await new Promise((r) => setTimeout(r, 5));
			repository.createRound(testRoomId, 'context_updated');
			await new Promise((r) => setTimeout(r, 5));
			repository.createRound(testRoomId, 'goal_created');

			const rounds = repository.listRounds(testRoomId);

			expect(rounds[0].trigger).toBe('goal_created');
			expect(rounds[1].trigger).toBe('context_updated');
			expect(rounds[2].trigger).toBe('room_created');
		});

		it('should respect limit parameter', () => {
			repository.createRound(testRoomId, 'room_created');
			repository.createRound(testRoomId, 'context_updated');
			repository.createRound(testRoomId, 'goal_created');

			const rounds = repository.listRounds(testRoomId, 2);

			expect(rounds).toHaveLength(2);
		});

		it('should return empty array for room with no rounds', () => {
			const rounds = repository.listRounds('non-existent-room');

			expect(rounds).toEqual([]);
		});
	});

	describe('deleteRoundsForRoom', () => {
		it('should delete all rounds for a room', () => {
			repository.createRound(testRoomId, 'room_created');
			repository.createRound(testRoomId, 'context_updated');
			repository.createRound('other-room', 'room_created');

			repository.deleteRoundsForRoom(testRoomId);

			expect(repository.listRounds(testRoomId)).toEqual([]);
			expect(repository.listRounds('other-room')).toHaveLength(1);
		});

		it('should not throw for non-existent room', () => {
			expect(() => repository.deleteRoundsForRoom('non-existent')).not.toThrow();
		});
	});

	describe('hasActiveRound', () => {
		it('should return true when active round exists', () => {
			repository.createRound(testRoomId, 'room_created');

			expect(repository.hasActiveRound(testRoomId)).toBe(true);
		});

		it('should return false when no active round', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			repository.completeRound(round.id);

			expect(repository.hasActiveRound(testRoomId)).toBe(false);
		});

		it('should return false when round is cancelled', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			repository.cancelRound(round.id);

			expect(repository.hasActiveRound(testRoomId)).toBe(false);
		});
	});

	describe('getUnansweredCount', () => {
		it('should return count of unanswered questions', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			const q1 = repository.addQuestion(round.id, 'Question 1?');
			repository.addQuestion(round.id, 'Question 2?');
			repository.addQuestion(round.id, 'Question 3?');

			repository.answerQuestion(round.id, q1.id, 'Answer 1');

			expect(repository.getUnansweredCount(round.id)).toBe(2);
		});

		it('should return 0 when all questions answered', () => {
			const round = repository.createRound(testRoomId, 'room_created');
			const q1 = repository.addQuestion(round.id, 'Question 1?');
			const q2 = repository.addQuestion(round.id, 'Question 2?');

			repository.answerQuestion(round.id, q1.id, 'Answer 1');
			repository.answerQuestion(round.id, q2.id, 'Answer 2');

			expect(repository.getUnansweredCount(round.id)).toBe(0);
		});

		it('should return 0 for round with no questions', () => {
			const round = repository.createRound(testRoomId, 'room_created');

			expect(repository.getUnansweredCount(round.id)).toBe(0);
		});

		it('should return 0 for non-existent round', () => {
			expect(repository.getUnansweredCount('non-existent')).toBe(0);
		});
	});

	describe('round lifecycle', () => {
		it('should support full Q&A round lifecycle', async () => {
			// Create round
			const round = repository.createRound(testRoomId, 'room_created');
			expect(round.status).toBe('in_progress');
			expect(round.questions).toEqual([]);

			// Add questions
			const q1 = repository.addQuestion(round.id, 'What framework should we use?');
			const q2 = repository.addQuestion(round.id, 'What is the deadline?');

			let currentRound = repository.getRound(round.id);
			expect(currentRound?.questions).toHaveLength(2);
			expect(repository.getUnansweredCount(round.id)).toBe(2);

			// Answer questions
			await new Promise((r) => setTimeout(r, 5));
			repository.answerQuestion(round.id, q1.id, 'React with TypeScript');
			repository.answerQuestion(round.id, q2.id, 'End of next month');

			currentRound = repository.getRound(round.id);
			expect(repository.getUnansweredCount(round.id)).toBe(0);

			// Complete round
			await new Promise((r) => setTimeout(r, 5));
			const completed = repository.completeRound(round.id, 'Clarified tech stack and timeline');

			expect(completed?.status).toBe('completed');
			expect(completed?.completedAt).toBeDefined();
			expect(completed?.summary).toBe('Clarified tech stack and timeline');
			expect(repository.hasActiveRound(testRoomId)).toBe(false);
		});
	});
});
