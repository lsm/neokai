/**
 * NeoActivityLogRepository
 *
 * CRUD operations for the neo_activity_log table.
 * Records every tool invocation made by the Neo global agent for auditing and undo support.
 */

import type { Database as BunDatabase } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NeoActivityLogEntry {
	id: string;
	toolName: string;
	input: string | null;
	output: string | null;
	status: 'success' | 'error' | 'cancelled';
	error: string | null;
	targetType: string | null;
	targetId: string | null;
	undoable: boolean;
	undoData: string | null;
	createdAt: string;
}

export interface InsertNeoActivityParams {
	id: string;
	toolName: string;
	input?: string | null;
	output?: string | null;
	status?: 'success' | 'error' | 'cancelled';
	error?: string | null;
	targetType?: string | null;
	targetId?: string | null;
	undoable?: boolean;
	undoData?: string | null;
}

export interface UpdateNeoActivityParams {
	output?: string | null;
	status?: 'success' | 'error' | 'cancelled';
	error?: string | null;
	targetType?: string | null;
	targetId?: string | null;
	undoable?: boolean;
	undoData?: string | null;
}

export interface ListNeoActivityParams {
	/** Number of entries to return (default: 50) */
	limit?: number;
	/**
	 * Cursor for pagination: return entries strictly older than this (created_at, id) pair.
	 * Both fields must be provided together for collision-safe pagination.
	 */
	before?: { createdAt: string; id: string };
}

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface ActivityRow {
	id: string;
	tool_name: string;
	input: string | null;
	output: string | null;
	status: string;
	error: string | null;
	target_type: string | null;
	target_id: string | null;
	undoable: number;
	undo_data: string | null;
	created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToEntry(row: ActivityRow): NeoActivityLogEntry {
	return {
		id: row.id,
		toolName: row.tool_name,
		input: row.input,
		output: row.output,
		status: row.status as NeoActivityLogEntry['status'],
		error: row.error,
		targetType: row.target_type,
		targetId: row.target_id,
		undoable: row.undoable === 1,
		undoData: row.undo_data,
		createdAt: row.created_at,
	};
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class NeoActivityLogRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Insert a new activity log entry.
	 */
	insert(params: InsertNeoActivityParams): NeoActivityLogEntry {
		const now = new Date().toISOString();
		const status = params.status ?? 'success';
		this.db
			.prepare(
				`INSERT INTO neo_activity_log
         (id, tool_name, input, output, status, error, target_type, target_id, undoable, undo_data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				params.id,
				params.toolName,
				params.input ?? null,
				params.output ?? null,
				status,
				params.error ?? null,
				params.targetType ?? null,
				params.targetId ?? null,
				params.undoable ? 1 : 0,
				params.undoData ?? null,
				now
			);
		const row = this.db
			.prepare(`SELECT * FROM neo_activity_log WHERE id = ?`)
			.get(params.id) as ActivityRow;
		return rowToEntry(row);
	}

	/**
	 * List activity log entries, newest first, with optional cursor-based pagination.
	 * The cursor is a compound (createdAt, id) pair to avoid dropping entries when
	 * multiple records share the same millisecond timestamp.
	 */
	list(params: ListNeoActivityParams = {}): NeoActivityLogEntry[] {
		const limit = params.limit ?? 50;
		if (params.before) {
			// Compound cursor: entries where created_at is strictly earlier, OR created_at
			// is equal but id sorts before the cursor id (lexicographic, UUIDs are random
			// so this is just a stable tiebreaker, not meaningful ordering).
			const rows = this.db
				.prepare(
					`SELECT * FROM neo_activity_log
           WHERE created_at < ? OR (created_at = ? AND id < ?)
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
				)
				.all(
					params.before.createdAt,
					params.before.createdAt,
					params.before.id,
					limit
				) as ActivityRow[];
			return rows.map(rowToEntry);
		}
		const rows = this.db
			.prepare(
				`SELECT * FROM neo_activity_log
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
			)
			.all(limit) as ActivityRow[];
		return rows.map(rowToEntry);
	}

	/**
	 * Get a single entry by ID. Returns null if not found.
	 */
	getById(id: string): NeoActivityLogEntry | null {
		const row = this.db.prepare(`SELECT * FROM neo_activity_log WHERE id = ?`).get(id) as
			| ActivityRow
			| undefined;
		return row ? rowToEntry(row) : null;
	}

	/**
	 * Get the most recent undoable entry. Returns null if none exists.
	 */
	getLatestUndoable(): NeoActivityLogEntry | null {
		const row = this.db
			.prepare(
				`SELECT * FROM neo_activity_log
         WHERE undoable = 1
         ORDER BY created_at DESC
         LIMIT 1`
			)
			.get() as ActivityRow | undefined;
		return row ? rowToEntry(row) : null;
	}

	/**
	 * Update an existing log entry by ID. Only the provided fields are changed.
	 * Returns the updated entry, or null if the entry does not exist.
	 */
	update(id: string, params: UpdateNeoActivityParams): NeoActivityLogEntry | null {
		const setClauses: string[] = [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const values: any[] = [];

		if (params.output !== undefined) {
			setClauses.push('output = ?');
			values.push(params.output);
		}
		if (params.status !== undefined) {
			setClauses.push('status = ?');
			values.push(params.status);
		}
		if (params.error !== undefined) {
			setClauses.push('error = ?');
			values.push(params.error);
		}
		if (params.targetType !== undefined) {
			setClauses.push('target_type = ?');
			values.push(params.targetType);
		}
		if (params.targetId !== undefined) {
			setClauses.push('target_id = ?');
			values.push(params.targetId);
		}
		if (params.undoable !== undefined) {
			setClauses.push('undoable = ?');
			values.push(params.undoable ? 1 : 0);
		}
		if (params.undoData !== undefined) {
			setClauses.push('undo_data = ?');
			values.push(params.undoData);
		}

		if (setClauses.length === 0) return this.getById(id);

		values.push(id);
		this.db
			.prepare(`UPDATE neo_activity_log SET ${setClauses.join(', ')} WHERE id = ?`)
			.run(...values);
		return this.getById(id);
	}

	/**
	 * Prune old entries to keep the table within retention limits:
	 * 1. Delete entries older than 30 days.
	 * 2. Trim to at most 10,000 rows (keeping the newest).
	 *
	 * Returns the total number of rows deleted.
	 */
	pruneOldEntries(): number {
		const byAge = this.db
			.prepare(
				`DELETE FROM neo_activity_log
         WHERE created_at < datetime('now', '-30 days')`
			)
			.run();

		const byCount = this.db
			.prepare(
				`DELETE FROM neo_activity_log
         WHERE id NOT IN (
           SELECT id FROM neo_activity_log
           ORDER BY created_at DESC, id DESC
           LIMIT 10000
         )`
			)
			.run();

		return Number(byAge.changes) + Number(byCount.changes);
	}
}
