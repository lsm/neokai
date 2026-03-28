/**
 * NeoActivityLogger
 *
 * High-level logging service that wraps NeoActivityLogRepository.
 * Records every Neo tool invocation for auditing and undo support.
 *
 * Responsibilities:
 * - logAction()          — insert a completed activity log entry
 * - getRecentActivity()  — paginated list (newest-first)
 * - getLatestUndoable()  — most recent undoable entry
 * - pruneOldEntries()    — enforce 30-day retention and 10 000-row cap
 */

import { randomUUID } from 'crypto';
import type { NeoActivityLogEntry } from '../../storage/repositories/neo-activity-log-repository';
import type { NeoActivityLogRepository } from '../../storage/repositories/neo-activity-log-repository';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parameters for logging a completed tool invocation. */
export interface LogActionParams {
	/** Name of the Neo tool that was invoked. */
	toolName: string;
	/** Tool input arguments (will be JSON-serialised). */
	input: Record<string, unknown>;
	/** Raw tool output text (already-serialised JSON string from MCP result). */
	output?: string | null;
	/** Execution outcome. */
	status: 'success' | 'error' | 'cancelled';
	/** Error message when status is 'error'. */
	error?: string | null;
	/** Entity type targeted by the action (e.g. 'room', 'skill', 'task'). */
	targetType?: string | null;
	/** ID of the targeted entity. */
	targetId?: string | null;
	/**
	 * Whether the action can be reversed via `undo_last_action`.
	 * Only true for successful operations on the undoable-tool list.
	 */
	undoable?: boolean;
	/**
	 * Data required to undo the action (e.g. previous state for updates,
	 * created entity ID for creates). Serialised to JSON string for storage.
	 */
	undoData?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// NeoActivityLogger
// ---------------------------------------------------------------------------

export class NeoActivityLogger {
	constructor(private readonly repo: NeoActivityLogRepository) {
		// Prune on startup so stale entries are removed before the activity feed loads.
		this.pruneOldEntries();
	}

	// ── Core logging ──────────────────────────────────────────────────────────

	/**
	 * Record a completed tool invocation.
	 * Returns the inserted entry (including its generated ID and timestamp).
	 */
	logAction(params: LogActionParams): NeoActivityLogEntry {
		return this.repo.insert({
			id: randomUUID(),
			toolName: params.toolName,
			input: JSON.stringify(params.input),
			output: params.output ?? null,
			status: params.status,
			error: params.error ?? null,
			targetType: params.targetType ?? null,
			targetId: params.targetId ?? null,
			undoable: params.undoable ?? false,
			undoData: params.undoData != null ? JSON.stringify(params.undoData) : null,
		});
	}

	// ── Query helpers ─────────────────────────────────────────────────────────

	/**
	 * Return recent activity entries, newest-first.
	 *
	 * @param limit   Maximum rows to return (default 50).
	 * @param offset  Number of rows to skip for pagination (default 0).
	 */
	getRecentActivity(limit = 50, offset = 0): NeoActivityLogEntry[] {
		// The repository's list() uses cursor-based pagination.
		// For offset-based access we fetch limit+offset and slice — acceptable
		// because the activity feed only ever requests a small window.
		if (offset === 0) {
			return this.repo.list({ limit });
		}
		const rows = this.repo.list({ limit: limit + offset });
		return rows.slice(offset);
	}

	/**
	 * Return the most recent undoable log entry, or null if none exists.
	 */
	getLatestUndoable(): NeoActivityLogEntry | null {
		return this.repo.getLatestUndoable();
	}

	// ── Maintenance ───────────────────────────────────────────────────────────

	/**
	 * Delete entries that violate retention policy:
	 * 1. Entries older than 30 days.
	 * 2. Entries beyond the 10 000-row cap (oldest removed first).
	 *
	 * Called automatically on construction and should be called periodically
	 * (e.g. from NeoAgentManager health-check or provision cycle).
	 *
	 * @returns Total number of rows deleted.
	 */
	pruneOldEntries(): number {
		return this.repo.pruneOldEntries();
	}
}
