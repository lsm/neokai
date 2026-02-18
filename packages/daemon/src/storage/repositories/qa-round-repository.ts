/**
 * Q&A Round Repository
 *
 * Repository for Q&A round CRUD operations.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { RoomQARound, QAQuestion, QARoundStatus } from '@neokai/shared';

export class QARoundRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new Q&A round
	 */
	createRound(roomId: string, trigger: RoomQARound['trigger']): RoomQARound {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO qa_rounds (id, room_id, trigger, status, questions, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
		);

		stmt.run(id, roomId, trigger, 'in_progress', '[]', now);

		return this.getRound(id)!;
	}

	/**
	 * Get a Q&A round by ID
	 */
	getRound(id: string): RoomQARound | null {
		const stmt = this.db.prepare(`SELECT * FROM qa_rounds WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToRound(row);
	}

	/**
	 * Get the active (in_progress) Q&A round for a room
	 */
	getActiveRound(roomId: string): RoomQARound | null {
		const stmt = this.db.prepare(
			`SELECT * FROM qa_rounds WHERE room_id = ? AND status = 'in_progress' LIMIT 1`
		);
		const row = stmt.get(roomId) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToRound(row);
	}

	/**
	 * List Q&A rounds for a room
	 */
	listRounds(roomId: string, limit?: number): RoomQARound[] {
		let query = `SELECT * FROM qa_rounds WHERE room_id = ? ORDER BY started_at DESC`;
		if (limit) {
			query += ` LIMIT ${limit}`;
		}

		const stmt = this.db.prepare(query);
		const rows = stmt.all(roomId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToRound(r));
	}

	/**
	 * Add a question to a round
	 */
	addQuestion(roundId: string, question: string): QAQuestion {
		const round = this.getRound(roundId);
		if (!round) {
			throw new Error(`Q&A round not found: ${roundId}`);
		}

		const questionId = generateUUID();
		const now = Date.now();
		const newQuestion: QAQuestion = {
			id: questionId,
			question,
			askedAt: now,
		};

		const questions = [...round.questions, newQuestion];
		const stmt = this.db.prepare(`UPDATE qa_rounds SET questions = ? WHERE id = ?`);
		stmt.run(JSON.stringify(questions), roundId);

		return newQuestion;
	}

	/**
	 * Answer a question in a round
	 */
	answerQuestion(roundId: string, questionId: string, answer: string): QAQuestion | null {
		const round = this.getRound(roundId);
		if (!round) {
			throw new Error(`Q&A round not found: ${roundId}`);
		}

		const questionIndex = round.questions.findIndex((q) => q.id === questionId);
		if (questionIndex === -1) {
			return null;
		}

		const now = Date.now();
		const questions = [...round.questions];
		questions[questionIndex] = {
			...questions[questionIndex],
			answer,
			answeredAt: now,
		};

		const stmt = this.db.prepare(`UPDATE qa_rounds SET questions = ? WHERE id = ?`);
		stmt.run(JSON.stringify(questions), roundId);

		return questions[questionIndex];
	}

	/**
	 * Update round status
	 */
	updateStatus(roundId: string, status: QARoundStatus, summary?: string): RoomQARound | null {
		const fields: string[] = ['status = ?'];
		const values: (string | number | null)[] = [status];

		if (status === 'completed' || status === 'cancelled') {
			fields.push('completed_at = ?');
			values.push(Date.now());
		}

		if (summary !== undefined) {
			fields.push('summary = ?');
			values.push(summary);
		}

		values.push(roundId);
		const stmt = this.db.prepare(`UPDATE qa_rounds SET ${fields.join(', ')} WHERE id = ?`);
		stmt.run(...values);

		return this.getRound(roundId);
	}

	/**
	 * Complete a round with a summary
	 */
	completeRound(roundId: string, summary?: string): RoomQARound | null {
		return this.updateStatus(roundId, 'completed', summary);
	}

	/**
	 * Cancel a round
	 */
	cancelRound(roundId: string): RoomQARound | null {
		return this.updateStatus(roundId, 'cancelled');
	}

	/**
	 * Delete all Q&A rounds for a room
	 */
	deleteRoundsForRoom(roomId: string): void {
		const stmt = this.db.prepare(`DELETE FROM qa_rounds WHERE room_id = ?`);
		stmt.run(roomId);
	}

	/**
	 * Check if a room has an active round
	 */
	hasActiveRound(roomId: string): boolean {
		return this.getActiveRound(roomId) !== null;
	}

	/**
	 * Get unanswered questions count for a round
	 */
	getUnansweredCount(roundId: string): number {
		const round = this.getRound(roundId);
		if (!round) return 0;
		return round.questions.filter((q) => !q.answer).length;
	}

	/**
	 * Convert a database row to a RoomQARound object
	 */
	private rowToRound(row: Record<string, unknown>): RoomQARound {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			trigger: row.trigger as RoomQARound['trigger'],
			status: row.status as QARoundStatus,
			questions: JSON.parse(row.questions as string) as QAQuestion[],
			startedAt: row.started_at as number,
			completedAt: (row.completed_at as number | null) ?? undefined,
			summary: (row.summary as string | null) ?? undefined,
		};
	}
}
