/**
 * Room Context Version Repository
 *
 * Repository for room context versioning operations.
 * Tracks all changes to room background and instructions.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';

/**
 * Who made the context change
 */
export type ContextChangedBy = 'human' | 'agent';

/**
 * A versioned snapshot of room context
 */
export interface RoomContextVersion {
	/** Unique identifier */
	id: string;
	/** Room this version belongs to */
	roomId: string;
	/** Version number (sequential per room) */
	version: number;
	/** Background context text */
	background?: string;
	/** Instructions context text */
	instructions?: string;
	/** Who made the change */
	changedBy: ContextChangedBy;
	/** Optional reason for the change */
	changeReason?: string;
	/** When this version was created */
	createdAt: number;
}

/**
 * Parameters for creating a new context version
 */
export interface CreateContextVersionParams {
	roomId: string;
	background?: string;
	instructions?: string;
	changedBy: ContextChangedBy;
	changeReason?: string;
}

export class RoomContextVersionRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new context version for a room
	 * Automatically increments the version number based on existing versions
	 */
	createVersion(params: CreateContextVersionParams): RoomContextVersion {
		const id = generateUUID();
		const now = Date.now();

		// Get the next version number for this room
		const latestVersion = this.getLatestVersion(params.roomId);
		const nextVersion = latestVersion ? latestVersion.version + 1 : 1;

		const stmt = this.db.prepare(
			`INSERT INTO room_context_versions (id, room_id, version, background, instructions, changed_by, change_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.roomId,
			nextVersion,
			params.background ?? null,
			params.instructions ?? null,
			params.changedBy,
			params.changeReason ?? null,
			now
		);

		return this.getVersion(params.roomId, nextVersion)!;
	}

	/**
	 * Get all versions for a room, ordered by version descending (newest first)
	 */
	getVersions(roomId: string, limit = 50): RoomContextVersion[] {
		const stmt = this.db.prepare(
			`SELECT * FROM room_context_versions WHERE room_id = ? ORDER BY version DESC LIMIT ?`
		);
		const rows = stmt.all(roomId, limit) as Record<string, unknown>[];
		return rows.map((r) => this.rowToVersion(r));
	}

	/**
	 * Get a specific version for a room
	 */
	getVersion(roomId: string, version: number): RoomContextVersion | null {
		const stmt = this.db.prepare(
			`SELECT * FROM room_context_versions WHERE room_id = ? AND version = ?`
		);
		const row = stmt.get(roomId, version) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToVersion(row);
	}

	/**
	 * Get the latest version for a room
	 */
	getLatestVersion(roomId: string): RoomContextVersion | null {
		const stmt = this.db.prepare(
			`SELECT * FROM room_context_versions WHERE room_id = ? ORDER BY version DESC LIMIT 1`
		);
		const row = stmt.get(roomId) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToVersion(row);
	}

	/**
	 * Get the version count for a room
	 */
	getVersionCount(roomId: string): number {
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM room_context_versions WHERE room_id = ?`
		);
		const result = stmt.get(roomId) as { count: number };
		return result.count;
	}

	/**
	 * Delete all versions for a room (used when room is deleted)
	 */
	deleteVersionsForRoom(roomId: string): void {
		const stmt = this.db.prepare(`DELETE FROM room_context_versions WHERE room_id = ?`);
		stmt.run(roomId);
	}

	/**
	 * Convert a database row to a RoomContextVersion object
	 */
	private rowToVersion(row: Record<string, unknown>): RoomContextVersion {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			version: row.version as number,
			background: (row.background as string | null) ?? undefined,
			instructions: (row.instructions as string | null) ?? undefined,
			changedBy: row.changed_by as ContextChangedBy,
			changeReason: (row.change_reason as string | null) ?? undefined,
			createdAt: row.created_at as number,
		};
	}
}
