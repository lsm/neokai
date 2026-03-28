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

export interface ListNeoActivityParams {
	/** Number of entries to return (default: 50) */
	limit?: number;
	/** Cursor for pagination: return entries older than this created_at value */
	before?: string;
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
	 */
	list(params: ListNeoActivityParams = {}): NeoActivityLogEntry[] {
		const limit = params.limit ?? 50;
		if (params.before) {
			const rows = this.db
				.prepare(
					`SELECT * FROM neo_activity_log
           WHERE created_at < ?
           ORDER BY created_at DESC
           LIMIT ?`
				)
				.all(params.before, limit) as ActivityRow[];
			return rows.map(rowToEntry);
		}
		const rows = this.db
			.prepare(
				`SELECT * FROM neo_activity_log
         ORDER BY created_at DESC
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
}
