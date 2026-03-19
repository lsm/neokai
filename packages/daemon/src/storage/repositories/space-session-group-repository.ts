/**
 * Space Session Group Repository
 *
 * Repository for SpaceSessionGroup and SpaceSessionGroupMember CRUD operations.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { SpaceSessionGroup, SpaceSessionGroupMember } from '@neokai/shared';

export interface CreateSessionGroupParams {
	spaceId: string;
	name: string;
	description?: string;
}

export interface UpdateSessionGroupParams {
	name?: string;
	description?: string;
}

export class SpaceSessionGroupRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new session group
	 */
	createGroup(params: CreateSessionGroupParams): SpaceSessionGroup {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO space_session_groups (id, space_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
		);

		stmt.run(id, params.spaceId, params.name, params.description ?? null, now, now);

		return this.getGroup(id)!;
	}

	/**
	 * Get a session group by ID, including its members
	 */
	getGroup(id: string): SpaceSessionGroup | null {
		const stmt = this.db.prepare(`SELECT * FROM space_session_groups WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;

		const members = this.getGroupMembers(id);
		return this.rowToGroup(row, members);
	}

	/**
	 * List all session groups for a space, including their members
	 */
	getGroupsBySpace(spaceId: string): SpaceSessionGroup[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_session_groups WHERE space_id = ? ORDER BY created_at ASC`
		);
		const rows = stmt.all(spaceId) as Record<string, unknown>[];

		return rows.map((row) => {
			const members = this.getGroupMembers(row.id as string);
			return this.rowToGroup(row, members);
		});
	}

	/**
	 * Get all session groups that contain a specific task's associated sessions.
	 * Returns groups matching by spaceId and name pattern (groups for a given task).
	 */
	getGroupsByTask(spaceId: string, taskId: string): SpaceSessionGroup[] {
		// Groups are associated to tasks by their name convention (e.g. "task:{taskId}")
		// or by querying members. We query groups that are named for a task.
		const stmt = this.db.prepare(
			`SELECT * FROM space_session_groups WHERE space_id = ? AND name = ? ORDER BY created_at ASC`
		);
		const rows = stmt.all(spaceId, `task:${taskId}`) as Record<string, unknown>[];

		return rows.map((row) => {
			const members = this.getGroupMembers(row.id as string);
			return this.rowToGroup(row, members);
		});
	}

	/**
	 * Update a session group
	 */
	updateGroup(id: string, params: UpdateSessionGroupParams): SpaceSessionGroup | null {
		const fields: string[] = [];
		const values: (string | number | null)[] = [];

		if (params.name !== undefined) {
			fields.push('name = ?');
			values.push(params.name);
		}
		if (params.description !== undefined) {
			fields.push('description = ?');
			values.push(params.description ?? null);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(Date.now());
			values.push(id);
			const stmt = this.db.prepare(
				`UPDATE space_session_groups SET ${fields.join(', ')} WHERE id = ?`
			);
			stmt.run(...values);
		}

		return this.getGroup(id);
	}

	/**
	 * Delete a session group (cascades to members)
	 */
	deleteGroup(id: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM space_session_groups WHERE id = ?`);
		const result = stmt.run(id);
		return result.changes > 0;
	}

	/**
	 * Add a session member to a group
	 * Idempotent — updates role/orderIndex if the session is already a member
	 */
	addMember(
		groupId: string,
		sessionId: string,
		role: 'worker' | 'leader',
		orderIndex = 0
	): SpaceSessionGroupMember {
		const existing = this.db
			.prepare(`SELECT * FROM space_session_group_members WHERE group_id = ? AND session_id = ?`)
			.get(groupId, sessionId) as Record<string, unknown> | undefined;

		if (existing) {
			this.db
				.prepare(
					`UPDATE space_session_group_members SET role = ?, order_index = ? WHERE group_id = ? AND session_id = ?`
				)
				.run(role, orderIndex, groupId, sessionId);
			return this.getMember(existing.id as string)!;
		}

		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO space_session_group_members (id, group_id, session_id, role, order_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(id, groupId, sessionId, role, orderIndex, now);

		// Touch group updated_at
		this.db
			.prepare(`UPDATE space_session_groups SET updated_at = ? WHERE id = ?`)
			.run(now, groupId);

		return this.getMember(id)!;
	}

	/**
	 * Remove a session from a group
	 */
	removeMember(groupId: string, sessionId: string): boolean {
		const result = this.db
			.prepare(`DELETE FROM space_session_group_members WHERE group_id = ? AND session_id = ?`)
			.run(groupId, sessionId);

		if (result.changes > 0) {
			this.db
				.prepare(`UPDATE space_session_groups SET updated_at = ? WHERE id = ?`)
				.run(Date.now(), groupId);
		}

		return result.changes > 0;
	}

	/**
	 * Get a single member record by ID
	 */
	getMember(id: string): SpaceSessionGroupMember | null {
		const row = this.db.prepare(`SELECT * FROM space_session_group_members WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;

		if (!row) return null;
		return this.rowToMember(row);
	}

	/**
	 * Get all members of a group, ordered by order_index
	 */
	private getGroupMembers(groupId: string): SpaceSessionGroupMember[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_session_group_members WHERE group_id = ? ORDER BY order_index ASC, created_at ASC`
			)
			.all(groupId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToMember(r));
	}

	/**
	 * Convert a database row to a SpaceSessionGroup object
	 */
	private rowToGroup(
		row: Record<string, unknown>,
		members: SpaceSessionGroupMember[]
	): SpaceSessionGroup {
		return {
			id: row.id as string,
			spaceId: row.space_id as string,
			name: row.name as string,
			description: (row.description as string | null) ?? undefined,
			members,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}

	/**
	 * Convert a database row to a SpaceSessionGroupMember object
	 */
	private rowToMember(row: Record<string, unknown>): SpaceSessionGroupMember {
		return {
			id: row.id as string,
			groupId: row.group_id as string,
			sessionId: row.session_id as string,
			role: row.role as 'worker' | 'leader',
			orderIndex: row.order_index as number,
			createdAt: row.created_at as number,
		};
	}
}
