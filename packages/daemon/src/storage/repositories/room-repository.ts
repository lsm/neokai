/**
 * Room Repository
 *
 * Repository for room CRUD operations.
 * Extracted from neo-db.ts for better organization.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { Room, CreateRoomParams, UpdateRoomParams } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export class NeoRoomRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new room
	 */
	createRoom(params: CreateRoomParams): Room {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO neo_rooms (id, name, description, default_workspace, default_model, session_ids, status, neo_context_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.name,
			params.description ?? null,
			params.defaultWorkspace ?? null,
			params.defaultModel ?? null,
			'[]',
			'active',
			null,
			now,
			now
		);

		return this.getRoom(id)!;
	}

	/**
	 * Get a room by ID
	 */
	getRoom(id: string): Room | null {
		const stmt = this.db.prepare(`SELECT * FROM neo_rooms WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToRoom(row);
	}

	/**
	 * List all rooms, optionally filtering by status
	 */
	listRooms(includeArchived = false): Room[] {
		let query = `SELECT * FROM neo_rooms`;
		if (!includeArchived) {
			query += ` WHERE status = 'active'`;
		}
		query += ` ORDER BY updated_at DESC`;

		const stmt = this.db.prepare(query);
		const rows = stmt.all() as Record<string, unknown>[];
		return rows.map((r) => this.rowToRoom(r));
	}

	/**
	 * Update a room with partial updates
	 */
	updateRoom(id: string, params: UpdateRoomParams): Room | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.name !== undefined) {
			fields.push('name = ?');
			values.push(params.name);
		}
		if (params.description !== undefined) {
			fields.push('description = ?');
			values.push(params.description ?? null);
		}
		if (params.defaultWorkspace !== undefined) {
			fields.push('default_workspace = ?');
			values.push(params.defaultWorkspace ?? null);
		}
		if (params.defaultModel !== undefined) {
			fields.push('default_model = ?');
			values.push(params.defaultModel ?? null);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(Date.now());
			values.push(id);
			const stmt = this.db.prepare(`UPDATE neo_rooms SET ${fields.join(', ')} WHERE id = ?`);
			stmt.run(...values);
		}

		return this.getRoom(id);
	}

	/**
	 * Archive a room
	 */
	archiveRoom(id: string): Room | null {
		const stmt = this.db.prepare(
			`UPDATE neo_rooms SET status = 'archived', updated_at = ? WHERE id = ?`
		);
		stmt.run(Date.now(), id);
		return this.getRoom(id);
	}

	/**
	 * Add a session to a room
	 */
	addSessionToRoom(roomId: string, sessionId: string): Room | null {
		const room = this.getRoom(roomId);
		if (!room) return null;

		const sessionIds = [...new Set([...room.sessionIds, sessionId])];
		const stmt = this.db.prepare(
			`UPDATE neo_rooms SET session_ids = ?, updated_at = ? WHERE id = ?`
		);
		stmt.run(JSON.stringify(sessionIds), Date.now(), roomId);
		return this.getRoom(roomId);
	}

	/**
	 * Remove a session from a room
	 */
	removeSessionFromRoom(roomId: string, sessionId: string): Room | null {
		const room = this.getRoom(roomId);
		if (!room) return null;

		const sessionIds = room.sessionIds.filter((id) => id !== sessionId);
		const stmt = this.db.prepare(
			`UPDATE neo_rooms SET session_ids = ?, updated_at = ? WHERE id = ?`
		);
		stmt.run(JSON.stringify(sessionIds), Date.now(), roomId);
		return this.getRoom(roomId);
	}

	/**
	 * Set the neo context ID for a room
	 */
	setRoomContextId(roomId: string, contextId: string): void {
		const stmt = this.db.prepare(`UPDATE neo_rooms SET neo_context_id = ? WHERE id = ?`);
		stmt.run(contextId, roomId);
	}

	/**
	 * Delete a room by ID
	 */
	deleteRoom(id: string): void {
		const stmt = this.db.prepare(`DELETE FROM neo_rooms WHERE id = ?`);
		stmt.run(id);
	}

	/**
	 * Convert a database row to a Room object
	 */
	private rowToRoom(row: Record<string, unknown>): Room {
		return {
			id: row.id as string,
			name: row.name as string,
			description: (row.description as string | null) ?? undefined,
			defaultWorkspace: (row.default_workspace as string | null) ?? undefined,
			defaultModel: (row.default_model as string | null) ?? undefined,
			sessionIds: JSON.parse(row.session_ids as string) as string[],
			status: row.status as 'active' | 'archived',
			neoContextId: (row.neo_context_id as string | null) ?? undefined,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}
}
