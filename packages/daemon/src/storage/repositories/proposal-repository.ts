/**
 * Proposal Repository
 *
 * Repository for room agent proposal CRUD operations.
 * Proposals track agent-initiated changes requiring human approval.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	RoomProposal,
	ProposalType,
	ProposalStatus,
	ProposalFilter,
	CreateProposalParams,
} from '@neokai/shared';
import type { SQLiteValue } from '../types';

export class ProposalRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new proposal
	 */
	createProposal(params: CreateProposalParams): RoomProposal {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO proposals (id, room_id, session_id, type, title, description, proposed_changes, reasoning, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.roomId,
			params.sessionId,
			params.type,
			params.title,
			params.description,
			JSON.stringify(params.proposedChanges),
			params.reasoning,
			'pending',
			now
		);

		return this.getProposal(id)!;
	}

	/**
	 * Get a proposal by ID
	 */
	getProposal(proposalId: string): RoomProposal | null {
		const stmt = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`);
		const row = stmt.get(proposalId) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToProposal(row);
	}

	/**
	 * List proposals for a room, optionally filtered
	 */
	listProposals(roomId: string, filter?: ProposalFilter): RoomProposal[] {
		let query = `SELECT * FROM proposals WHERE room_id = ?`;
		const params: SQLiteValue[] = [roomId];

		if (filter?.status) {
			query += ` AND status = ?`;
			params.push(filter.status);
		}
		if (filter?.type) {
			query += ` AND type = ?`;
			params.push(filter.type);
		}
		if (filter?.sessionId) {
			query += ` AND session_id = ?`;
			params.push(filter.sessionId);
		}

		query += ` ORDER BY created_at DESC`;

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];
		return rows.map((r) => this.rowToProposal(r));
	}

	/**
	 * Approve a proposal
	 */
	approveProposal(proposalId: string, actedBy: string, response?: string): RoomProposal | null {
		const now = Date.now();
		const stmt = this.db.prepare(
			`UPDATE proposals SET status = ?, acted_at = ?, acted_by = ?, action_response = ? WHERE id = ? AND status = 'pending'`
		);
		const result = stmt.run('approved', now, actedBy, response ?? null, proposalId);

		if (result.changes === 0) return null;
		return this.getProposal(proposalId);
	}

	/**
	 * Reject a proposal
	 */
	rejectProposal(proposalId: string, actedBy: string, response: string): RoomProposal | null {
		const now = Date.now();
		const stmt = this.db.prepare(
			`UPDATE proposals SET status = ?, acted_at = ?, acted_by = ?, action_response = ? WHERE id = ? AND status = 'pending'`
		);
		const result = stmt.run('rejected', now, actedBy, response, proposalId);

		if (result.changes === 0) return null;
		return this.getProposal(proposalId);
	}

	/**
	 * Withdraw a proposal (agent cancels it)
	 */
	withdrawProposal(proposalId: string): RoomProposal | null {
		const stmt = this.db.prepare(
			`UPDATE proposals SET status = ? WHERE id = ? AND status = 'pending'`
		);
		const result = stmt.run('withdrawn', proposalId);

		if (result.changes === 0) return null;
		return this.getProposal(proposalId);
	}

	/**
	 * Mark a proposal as applied (after executing the changes)
	 */
	applyProposal(proposalId: string): RoomProposal | null {
		const stmt = this.db.prepare(
			`UPDATE proposals SET status = ? WHERE id = ? AND status = 'approved'`
		);
		const result = stmt.run('applied', proposalId);

		if (result.changes === 0) return null;
		return this.getProposal(proposalId);
	}

	/**
	 * Get all pending proposals for a room
	 */
	getPendingProposals(roomId: string): RoomProposal[] {
		return this.listProposals(roomId, { status: 'pending' });
	}

	/**
	 * Delete all proposals for a room (used when room is deleted)
	 */
	deleteProposalsForRoom(roomId: string): void {
		const stmt = this.db.prepare(`DELETE FROM proposals WHERE room_id = ?`);
		stmt.run(roomId);
	}

	/**
	 * Convert a database row to a RoomProposal object
	 */
	private rowToProposal(row: Record<string, unknown>): RoomProposal {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			sessionId: row.session_id as string,
			type: row.type as ProposalType,
			title: row.title as string,
			description: row.description as string,
			proposedChanges: JSON.parse(row.proposed_changes as string) as Record<string, unknown>,
			reasoning: row.reasoning as string,
			status: row.status as ProposalStatus,
			actedBy: (row.acted_by as string | null) ?? undefined,
			actionResponse: (row.action_response as string | null) ?? undefined,
			createdAt: row.created_at as number,
			actedAt: (row.acted_at as number | null) ?? undefined,
		};
	}
}
