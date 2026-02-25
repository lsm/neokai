/**
 * TaskPairRepository - CRUD for task_pairs table
 *
 * Manages (Craft, Lead) session pairs with optimistic locking.
 * All update methods use version-based concurrency control.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';

export type PairState =
	| 'awaiting_craft'
	| 'awaiting_lead'
	| 'awaiting_human'
	| 'hibernated'
	| 'completed'
	| 'failed';

export interface TaskPair {
	id: string;
	taskId: string;
	craftSessionId: string;
	leadSessionId: string;
	pairState: PairState;
	feedbackIteration: number;
	leadContractViolations: number;
	lastProcessedLeadTurnId: string | null;
	lastForwardedMessageId: string | null;
	activeWorkStartedAt: number | null;
	activeWorkElapsed: number;
	hibernatedAt: number | null;
	version: number;
	tokensUsed: number;
	createdAt: number;
	completedAt: number | null;
}

export class TaskPairRepository {
	constructor(private db: BunDatabase) {}

	createPair(taskId: string, craftSessionId: string, leadSessionId: string): TaskPair {
		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO task_pairs (id, task_id, craft_session_id, lead_session_id, created_at)
			 VALUES (?, ?, ?, ?, ?)`
			)
			.run(id, taskId, craftSessionId, leadSessionId, now);

		return this.getPair(id)!;
	}

	getPair(pairId: string): TaskPair | null {
		const row = this.db.prepare(`SELECT * FROM task_pairs WHERE id = ?`).get(pairId) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return this.rowToPair(row);
	}

	getPairByTaskId(taskId: string): TaskPair | null {
		const row = this.db
			.prepare(`SELECT * FROM task_pairs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`)
			.get(taskId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.rowToPair(row);
	}

	getActivePairs(roomId: string): TaskPair[] {
		const rows = this.db
			.prepare(
				`SELECT tp.* FROM task_pairs tp
			 JOIN tasks t ON tp.task_id = t.id
			 WHERE t.room_id = ?
			 AND tp.pair_state NOT IN ('completed', 'failed')`
			)
			.all(roomId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToPair(r));
	}

	updatePairState(pairId: string, newState: PairState, expectedVersion: number): TaskPair | null {
		const result = this.db
			.prepare(
				`UPDATE task_pairs SET pair_state = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(newState, pairId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getPair(pairId);
	}

	incrementFeedbackIteration(pairId: string, expectedVersion: number): TaskPair | null {
		const result = this.db
			.prepare(
				`UPDATE task_pairs SET feedback_iteration = feedback_iteration + 1, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(pairId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getPair(pairId);
	}

	completePair(pairId: string, expectedVersion: number): TaskPair | null {
		const now = Date.now();
		const result = this.db
			.prepare(
				`UPDATE task_pairs SET pair_state = 'completed', completed_at = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(now, pairId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getPair(pairId);
	}

	failPair(pairId: string, expectedVersion: number): TaskPair | null {
		const now = Date.now();
		const result = this.db
			.prepare(
				`UPDATE task_pairs SET pair_state = 'failed', completed_at = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(now, pairId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getPair(pairId);
	}

	updateLeadContractViolations(
		pairId: string,
		violations: number,
		lastTurnId: string,
		expectedVersion: number
	): TaskPair | null {
		const result = this.db
			.prepare(
				`UPDATE task_pairs SET lead_contract_violations = ?, last_processed_lead_turn_id = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(violations, lastTurnId, pairId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getPair(pairId);
	}

	resetLeadContractViolations(pairId: string, expectedVersion: number): TaskPair | null {
		const result = this.db
			.prepare(
				`UPDATE task_pairs SET lead_contract_violations = 0, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(pairId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getPair(pairId);
	}

	updateLastForwardedMessageId(
		pairId: string,
		messageId: string,
		expectedVersion: number
	): TaskPair | null {
		const result = this.db
			.prepare(
				`UPDATE task_pairs SET last_forwarded_message_id = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(messageId, pairId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getPair(pairId);
	}

	private rowToPair(row: Record<string, unknown>): TaskPair {
		return {
			id: row.id as string,
			taskId: row.task_id as string,
			craftSessionId: row.craft_session_id as string,
			leadSessionId: row.lead_session_id as string,
			pairState: row.pair_state as PairState,
			feedbackIteration: row.feedback_iteration as number,
			leadContractViolations: row.lead_contract_violations as number,
			lastProcessedLeadTurnId: row.last_processed_lead_turn_id as string | null,
			lastForwardedMessageId: row.last_forwarded_message_id as string | null,
			activeWorkStartedAt: row.active_work_started_at as number | null,
			activeWorkElapsed: row.active_work_elapsed as number,
			hibernatedAt: row.hibernated_at as number | null,
			version: row.version as number,
			tokensUsed: row.tokens_used as number,
			createdAt: row.created_at as number,
			completedAt: row.completed_at as number | null,
		};
	}
}
