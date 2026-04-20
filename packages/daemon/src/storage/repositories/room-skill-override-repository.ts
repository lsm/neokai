/**
 * RoomSkillOverrideRepository
 *
 * Stores per-room overrides for which skills are enabled.
 * Each write calls reactiveDb.notifyChange('room_skill_overrides') so that
 * LiveQueryEngine can invalidate frontend subscriptions on every change.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { RoomSkillOverride } from '@neokai/shared';
import type { ReactiveDatabase } from '../reactive-database';

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface OverrideRow {
	skill_id: string;
	room_id: string;
	enabled: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class RoomSkillOverrideRepository {
	constructor(
		private db: BunDatabase,
		private reactiveDb: ReactiveDatabase
	) {}

	/**
	 * Get all overrides for a room.
	 */
	getOverrides(roomId: string): RoomSkillOverride[] {
		const rows = this.db
			.prepare(
				`SELECT skill_id, room_id, enabled
         FROM room_skill_overrides
         WHERE room_id = ?`
			)
			.all(roomId) as OverrideRow[];
		return rows.map((r) => ({
			skillId: r.skill_id,
			roomId: r.room_id,
			enabled: r.enabled === 1,
		}));
	}

	/**
	 * Upsert an override for a single skill in a room.
	 * Calling with enabled=true or enabled=false sets an explicit override.
	 * Use deleteOverride() to remove an override and revert to global.
	 */
	upsertOverride(roomId: string, skillId: string, enabled: boolean): void {
		this.db
			.prepare(
				`INSERT INTO room_skill_overrides (skill_id, room_id, enabled)
         VALUES (?, ?, ?)
         ON CONFLICT(skill_id, room_id) DO UPDATE SET enabled = excluded.enabled`
			)
			.run(skillId, roomId, enabled ? 1 : 0);
		this.reactiveDb.notifyChange('room_skill_overrides');
	}

	/**
	 * Remove a single override, reverting to global default.
	 */
	deleteOverride(roomId: string, skillId: string): void {
		this.db
			.prepare(`DELETE FROM room_skill_overrides WHERE room_id = ? AND skill_id = ?`)
			.run(roomId, skillId);
		this.reactiveDb.notifyChange('room_skill_overrides');
	}

	/**
	 * Remove all overrides for a room, reverting all skills to global defaults.
	 */
	deleteAllForRoom(roomId: string): void {
		this.db.prepare(`DELETE FROM room_skill_overrides WHERE room_id = ?`).run(roomId);
		this.reactiveDb.notifyChange('room_skill_overrides');
	}
}
