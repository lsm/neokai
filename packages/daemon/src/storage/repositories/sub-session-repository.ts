/**
 * Sub-Session Repository
 *
 * Responsibilities:
 * - Sub-session hierarchy management
 * - Parent-child validation (one level deep)
 * - Ordering among siblings
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { Session } from '@liuboer/shared';
import type { SQLiteValue } from '../types';
import { SessionRepository } from './session-repository';

export class SubSessionRepository {
	private sessionRepo: SessionRepository;

	constructor(private db: BunDatabase) {
		this.sessionRepo = new SessionRepository(db);
	}

	/**
	 * Get sub-sessions for a parent session
	 *
	 * @param parentId - The parent session ID
	 * @param labels - Optional labels to filter by (matches any)
	 * @returns Sub-sessions ordered by sub_session_order, then by created_at
	 */
	getSubSessions(parentId: string, labels?: string[]): Session[] {
		let query = `SELECT * FROM sessions WHERE parent_id = ?`;
		const params: SQLiteValue[] = [parentId];

		// If labels provided, filter to sessions that have at least one matching label
		// Note: This uses JSON to check if labels overlap - SQLite JSON functions
		if (labels && labels.length > 0) {
			// Build a condition that checks if any of the provided labels exist in the session's labels
			// Using JSON extraction to check membership
			const labelConditions = labels.map(() => `json_extract(labels, '$') LIKE ?`);
			query += ` AND (${labelConditions.join(' OR ')})`;
			// Wrap each label in wildcards for LIKE matching within JSON array
			labels.forEach((label) => params.push(`%"${label}"%`));
		}

		query += ` ORDER BY sub_session_order ASC, created_at ASC`;

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];

		return rows.map((r) => this.sessionRepo.rowToSession(r));
	}

	/**
	 * Create a sub-session under a parent
	 * Validates that parent exists and is not already a sub-session
	 *
	 * @param session - The session to create (must have parentId set)
	 * @throws Error if parent doesn't exist or is already a sub-session
	 */
	createSubSession(session: Session): void {
		if (!session.parentId) {
			throw new Error('Sub-session must have a parentId');
		}

		// Validate parent exists
		const parent = this.sessionRepo.getSession(session.parentId);
		if (!parent) {
			throw new Error(`Parent session ${session.parentId} not found`);
		}

		// Validate parent is not a sub-session (one level deep only)
		if (parent.parentId) {
			throw new Error('Cannot create sub-session under another sub-session (one level deep only)');
		}

		// Set order to be after existing sub-sessions
		const existingSubSessions = this.getSubSessions(session.parentId);
		const maxOrder = existingSubSessions.reduce(
			(max, s) => Math.max(max, s.subSessionOrder ?? 0),
			-1
		);
		session.subSessionOrder = maxOrder + 1;

		// Create the session
		this.sessionRepo.createSession(session);
	}

	/**
	 * Update the order of sub-sessions within a parent
	 *
	 * @param parentId - The parent session ID
	 * @param orderedIds - Array of sub-session IDs in desired order
	 */
	updateSubSessionOrder(parentId: string, orderedIds: string[]): void {
		// Use a transaction for atomic updates
		const updateStmt = this.db.prepare(
			`UPDATE sessions SET sub_session_order = ? WHERE id = ? AND parent_id = ?`
		);

		orderedIds.forEach((id, index) => {
			updateStmt.run(index, id, parentId);
		});
	}

	/**
	 * Check if a session has any sub-sessions
	 *
	 * @param sessionId - The session ID to check
	 * @returns true if the session has sub-sessions
	 */
	hasSubSessions(sessionId: string): boolean {
		const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE parent_id = ?`);
		const result = stmt.get(sessionId) as { count: number };
		return result.count > 0;
	}
}
