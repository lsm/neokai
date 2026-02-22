/**
 * Room Agent State Repository
 *
 * Repository for room agent lifecycle state management.
 * Tracks the state of the room agent (idle, planning, executing, etc.)
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { RoomSelfState, RoomSelfLifecycleState } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export interface CreateRoomSelfStateParams {
	roomId: string;
	lifecycleState?: RoomSelfLifecycleState;
}

export interface UpdateRoomSelfStateParams {
	lifecycleState?: RoomSelfLifecycleState;
	currentGoalId?: string | null;
	currentTaskId?: string | null;
	activeSessionPairIds?: string[];
	lastActivityAt?: number;
	errorCount?: number;
	lastError?: string | null;
	pendingActions?: string[];
}

export class RoomSelfStateRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create initial state for a room agent
	 */
	createState(params: CreateRoomSelfStateParams): RoomSelfState {
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO room_agent_states (room_id, lifecycle_state, active_session_pair_ids, last_activity_at, error_count, pending_actions)
       VALUES (?, ?, ?, ?, ?, ?)`
		);

		stmt.run(params.roomId, params.lifecycleState ?? 'idle', '[]', now, 0, '[]');

		return this.getState(params.roomId)!;
	}

	/**
	 * Get state for a room agent
	 */
	getState(roomId: string): RoomSelfState | null {
		const stmt = this.db.prepare(`SELECT * FROM room_agent_states WHERE room_id = ?`);
		const row = stmt.get(roomId) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToState(row);
	}

	/**
	 * Get or create state for a room agent
	 */
	getOrCreateState(roomId: string): RoomSelfState {
		const existing = this.getState(roomId);
		if (existing) return existing;
		return this.createState({ roomId });
	}

	/**
	 * Update state for a room agent
	 */
	updateState(roomId: string, params: UpdateRoomSelfStateParams): RoomSelfState | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.lifecycleState !== undefined) {
			fields.push('lifecycle_state = ?');
			values.push(params.lifecycleState);
		}
		if (params.currentGoalId !== undefined) {
			fields.push('current_goal_id = ?');
			values.push(params.currentGoalId);
		}
		if (params.currentTaskId !== undefined) {
			fields.push('current_task_id = ?');
			values.push(params.currentTaskId);
		}
		if (params.activeSessionPairIds !== undefined) {
			fields.push('active_session_pair_ids = ?');
			values.push(JSON.stringify(params.activeSessionPairIds));
		}
		if (params.lastActivityAt !== undefined) {
			fields.push('last_activity_at = ?');
			values.push(params.lastActivityAt);
		}
		if (params.errorCount !== undefined) {
			fields.push('error_count = ?');
			values.push(params.errorCount);
		}
		if (params.lastError !== undefined) {
			fields.push('last_error = ?');
			values.push(params.lastError);
		}
		if (params.pendingActions !== undefined) {
			fields.push('pending_actions = ?');
			values.push(JSON.stringify(params.pendingActions));
		}

		if (fields.length === 0) {
			return this.getState(roomId);
		}

		values.push(roomId);

		const stmt = this.db.prepare(
			`UPDATE room_agent_states SET ${fields.join(', ')} WHERE room_id = ?`
		);
		stmt.run(...values);

		return this.getState(roomId);
	}

	/**
	 * Transition to a new lifecycle state
	 */
	transitionTo(roomId: string, newState: RoomSelfLifecycleState): RoomSelfState | null {
		return this.updateState(roomId, {
			lifecycleState: newState,
			lastActivityAt: Date.now(),
		});
	}

	/**
	 * Record an error
	 */
	recordError(roomId: string, error: string): RoomSelfState | null {
		const current = this.getState(roomId);
		if (!current) return null;

		return this.updateState(roomId, {
			errorCount: current.errorCount + 1,
			lastError: error,
			lastActivityAt: Date.now(),
		});
	}

	/**
	 * Clear error state
	 */
	clearError(roomId: string): RoomSelfState | null {
		return this.updateState(roomId, {
			errorCount: 0,
			lastError: null,
		});
	}

	/**
	 * Add a session pair to active pairs
	 */
	addActiveSessionPair(roomId: string, pairId: string): RoomSelfState | null {
		const current = this.getState(roomId);
		if (!current) return null;

		const activePairs = [...new Set([...current.activeSessionPairIds, pairId])];
		return this.updateState(roomId, {
			activeSessionPairIds: activePairs,
			lastActivityAt: Date.now(),
		});
	}

	/**
	 * Remove a session pair from active pairs
	 */
	removeActiveSessionPair(roomId: string, pairId: string): RoomSelfState | null {
		const current = this.getState(roomId);
		if (!current) return null;

		const activePairs = current.activeSessionPairIds.filter((id) => id !== pairId);
		return this.updateState(roomId, {
			activeSessionPairIds: activePairs,
			lastActivityAt: Date.now(),
		});
	}

	/**
	 * Add a pending action
	 */
	addPendingAction(roomId: string, action: string): RoomSelfState | null {
		const current = this.getState(roomId);
		if (!current) return null;

		const actions = [...current.pendingActions, action];
		return this.updateState(roomId, { pendingActions: actions });
	}

	/**
	 * Remove a pending action
	 */
	removePendingAction(roomId: string, action: string): RoomSelfState | null {
		const current = this.getState(roomId);
		if (!current) return null;

		const actions = current.pendingActions.filter((a) => a !== action);
		return this.updateState(roomId, { pendingActions: actions });
	}

	/**
	 * Clear all pending actions
	 */
	clearPendingActions(roomId: string): RoomSelfState | null {
		return this.updateState(roomId, { pendingActions: [] });
	}

	/**
	 * Delete state for a room agent
	 */
	deleteState(roomId: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM room_agent_states WHERE room_id = ?`);
		const result = stmt.run(roomId);
		return result.changes > 0;
	}

	/**
	 * Get all room agent states (for monitoring)
	 */
	getAllStates(): RoomSelfState[] {
		const stmt = this.db.prepare(`SELECT * FROM room_agent_states ORDER BY last_activity_at DESC`);
		const rows = stmt.all() as Record<string, unknown>[];
		return rows.map((r) => this.rowToState(r));
	}

	/**
	 * Get agents in a specific state
	 */
	getStatesByLifecycle(lifecycleState: RoomSelfLifecycleState): RoomSelfState[] {
		const stmt = this.db.prepare(
			`SELECT * FROM room_agent_states WHERE lifecycle_state = ? ORDER BY last_activity_at DESC`
		);
		const rows = stmt.all(lifecycleState) as Record<string, unknown>[];
		return rows.map((r) => this.rowToState(r));
	}

	/**
	 * Convert a database row to a RoomSelfState object
	 */
	private rowToState(row: Record<string, unknown>): RoomSelfState {
		return {
			roomId: row.room_id as string,
			lifecycleState: row.lifecycle_state as RoomSelfLifecycleState,
			currentGoalId: row.current_goal_id as string | undefined,
			currentTaskId: row.current_task_id as string | undefined,
			activeSessionPairIds: JSON.parse(row.active_session_pair_ids as string) as string[],
			lastActivityAt: row.last_activity_at as number,
			errorCount: row.error_count as number,
			lastError: row.last_error as string | undefined,
			pendingActions: JSON.parse(row.pending_actions as string) as string[],
		};
	}
}
