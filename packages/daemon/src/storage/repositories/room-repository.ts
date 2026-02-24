/**
 * Room Repository
 *
 * Repository for room CRUD operations.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { Room, CreateRoomParams, UpdateRoomParams, WorkspacePath } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export class RoomRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new room
	 */
	createRoom(params: CreateRoomParams): Room {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO rooms (id, name, background_context, allowed_paths, default_path, default_model, allowed_models, session_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.name,
			params.background ?? null,
			JSON.stringify(params.allowedPaths ?? []),
			params.defaultPath ?? null,
			params.defaultModel ?? null,
			JSON.stringify(params.allowedModels ?? []),
			'[]',
			'active',
			now,
			now
		);

		return this.getRoom(id)!;
	}

	/**
	 * Get a room by ID
	 */
	getRoom(id: string): Room | null {
		const stmt = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToRoom(row);
	}

	/**
	 * List all rooms, optionally filtering by status
	 */
	listRooms(includeArchived = false): Room[] {
		let query = `SELECT * FROM rooms`;
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
		if (params.allowedPaths !== undefined) {
			fields.push('allowed_paths = ?');
			values.push(JSON.stringify(params.allowedPaths));
		}
		if (params.defaultPath !== undefined) {
			fields.push('default_path = ?');
			values.push(params.defaultPath ?? null);
		}
		if (params.defaultModel !== undefined) {
			fields.push('default_model = ?');
			values.push(params.defaultModel ?? null);
		}
		if (params.allowedModels !== undefined) {
			fields.push('allowed_models = ?');
			values.push(JSON.stringify(params.allowedModels));
		}
		if (params.background !== undefined) {
			fields.push('background_context = ?');
			values.push(params.background ?? null);
		}
		if (params.instructions !== undefined) {
			fields.push('instructions = ?');
			values.push(params.instructions ?? null);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(Date.now());
			values.push(id);
			const stmt = this.db.prepare(`UPDATE rooms SET ${fields.join(', ')} WHERE id = ?`);
			stmt.run(...values);
		}

		return this.getRoom(id);
	}

	/**
	 * Archive a room
	 */
	archiveRoom(id: string): Room | null {
		const stmt = this.db.prepare(
			`UPDATE rooms SET status = 'archived', updated_at = ? WHERE id = ?`
		);
		stmt.run(Date.now(), id);
		return this.getRoom(id);
	}

	/**
	 * Add a session to a room
	 */
	addSessionToRoom(roomId: string, sessionId: string): Room | null {
		const tx = this.db.transaction(() => {
			const room = this.getRoom(roomId);
			if (!room) return null;

			// Idempotent - don't add if already present
			if (room.sessionIds.includes(sessionId)) {
				return room;
			}

			const sessionIds = [...room.sessionIds, sessionId];
			const stmt = this.db.prepare(`UPDATE rooms SET session_ids = ?, updated_at = ? WHERE id = ?`);
			stmt.run(JSON.stringify(sessionIds), Date.now(), roomId);
			return this.getRoom(roomId);
		});

		return tx() as Room | null;
	}

	/**
	 * Remove a session from a room
	 */
	removeSessionFromRoom(roomId: string, sessionId: string): Room | null {
		const tx = this.db.transaction(() => {
			const room = this.getRoom(roomId);
			if (!room) return null;

			// Idempotent - no-op if session not in room
			if (!room.sessionIds.includes(sessionId)) {
				return room;
			}

			const sessionIds = room.sessionIds.filter((id) => id !== sessionId);
			const stmt = this.db.prepare(`UPDATE rooms SET session_ids = ?, updated_at = ? WHERE id = ?`);
			stmt.run(JSON.stringify(sessionIds), Date.now(), roomId);
			return this.getRoom(roomId);
		});

		return tx() as Room | null;
	}

	/**
	 * Delete a room by ID
	 */
	deleteRoom(id: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM rooms WHERE id = ?`);
		const result = stmt.run(id);
		return result.changes > 0;
	}

	/**
	 * Add a path to the room's allowed paths
	 */
	addPath(id: string, path: string, description?: string): Room | null {
		const tx = this.db.transaction(() => {
			const room = this.getRoom(id);
			if (!room) return null;

			// Idempotent - don't add if already present
			if (room.allowedPaths.some((p) => p.path === path)) {
				return room;
			}

			const allowedPaths: WorkspacePath[] = [...room.allowedPaths, { path, description }];
			const stmt = this.db.prepare(
				`UPDATE rooms SET allowed_paths = ?, updated_at = ? WHERE id = ?`
			);
			stmt.run(JSON.stringify(allowedPaths), Date.now(), id);
			return this.getRoom(id);
		});

		return tx() as Room | null;
	}

	/**
	 * Remove a path from the room's allowed paths
	 */
	removePath(id: string, path: string): Room | null {
		const tx = this.db.transaction(() => {
			const room = this.getRoom(id);
			if (!room) return null;

			// Idempotent - no-op if path not in allowed paths
			if (!room.allowedPaths.some((p) => p.path === path)) {
				return room;
			}

			const allowedPaths = room.allowedPaths.filter((p) => p.path !== path);
			const stmt = this.db.prepare(
				`UPDATE rooms SET allowed_paths = ?, updated_at = ? WHERE id = ?`
			);
			stmt.run(JSON.stringify(allowedPaths), Date.now(), id);
			return this.getRoom(id);
		});

		return tx() as Room | null;
	}

	/**
	 * Convert a database row to a Room object
	 */
	private rowToRoom(row: Record<string, unknown>): Room {
		// Parse allowedPaths, handling backward compatibility with string[] format
		const rawPaths = JSON.parse((row.allowed_paths as string) ?? '[]');
		const allowedPaths = rawPaths.map((p: string | { path: string; description?: string }) =>
			typeof p === 'string' ? { path: p } : p
		);

		const rawModels = JSON.parse((row.allowed_models as string) ?? '[]') as string[];

		return {
			id: row.id as string,
			name: row.name as string,
			allowedPaths,
			defaultPath: (row.default_path as string | null) ?? undefined,
			defaultModel: (row.default_model as string | null) ?? undefined,
			allowedModels: rawModels.length > 0 ? rawModels : undefined,
			sessionIds: JSON.parse(row.session_ids as string) as string[],
			status: row.status as 'active' | 'archived',
			background: (row.background_context as string | null) ?? undefined,
			instructions: (row.instructions as string | null) ?? undefined,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}
}
