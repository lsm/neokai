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
	workflowRunId?: string;
	currentStepId?: string;
	taskId?: string;
	/** Initial lifecycle status (default: 'active') */
	status?: 'active' | 'completed' | 'failed';
}

export interface UpdateSessionGroupParams {
	name?: string;
	description?: string;
	workflowRunId?: string | null;
	currentStepId?: string | null;
	taskId?: string | null;
	status?: 'active' | 'completed' | 'failed';
}

export interface AddMemberParams {
	/** Freeform role string matching SpaceAgent.role (e.g. 'coder', 'reviewer', 'security-auditor') */
	role: string;
	/** Display order within the group (default: 0) */
	orderIndex?: number;
	/** ID of the SpaceAgent config this session uses (nullable for system agents) */
	agentId?: string;
	/** Initial lifecycle state (default: 'active') */
	status?: 'active' | 'completed' | 'failed';
}

export interface UpdateMemberParams {
	role?: string;
	orderIndex?: number;
	agentId?: string | null;
	status?: 'active' | 'completed' | 'failed';
}

export class SpaceSessionGroupRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new session group
	 */
	createGroup(params: CreateSessionGroupParams): SpaceSessionGroup {
		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO space_session_groups (id, space_id, name, description, workflow_run_id, current_step_id, task_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.spaceId,
				params.name,
				params.description ?? null,
				params.workflowRunId ?? null,
				params.currentStepId ?? null,
				params.taskId ?? null,
				params.status ?? 'active',
				now,
				now
			);

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
	 * Get all session groups associated with a specific task.
	 * Queries by the `task_id` column set at group creation time.
	 */
	getGroupsByTask(spaceId: string, taskId: string): SpaceSessionGroup[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_session_groups WHERE space_id = ? AND task_id = ? ORDER BY created_at ASC`
		);
		const rows = stmt.all(spaceId, taskId) as Record<string, unknown>[];

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
		if (params.workflowRunId !== undefined) {
			fields.push('workflow_run_id = ?');
			values.push(params.workflowRunId ?? null);
		}
		if (params.currentStepId !== undefined) {
			fields.push('current_step_id = ?');
			values.push(params.currentStepId ?? null);
		}
		if (params.taskId !== undefined) {
			fields.push('task_id = ?');
			values.push(params.taskId ?? null);
		}
		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);
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
	 * Add a session member to a group.
	 * Idempotent — if the session is already a member, updates all provided fields.
	 * The member write and group timestamp touch are performed atomically.
	 */
	addMember(groupId: string, sessionId: string, params: AddMemberParams): SpaceSessionGroupMember {
		const { role, orderIndex = 0, agentId, status = 'active' } = params;

		const existing = this.db
			.prepare(`SELECT * FROM space_session_group_members WHERE group_id = ? AND session_id = ?`)
			.get(groupId, sessionId) as Record<string, unknown> | undefined;

		if (existing) {
			const now = Date.now();
			this.db.transaction(() => {
				this.db
					.prepare(
						`UPDATE space_session_group_members SET role = ?, order_index = ?, agent_id = ?, status = ? WHERE group_id = ? AND session_id = ?`
					)
					.run(role, orderIndex, agentId ?? null, status, groupId, sessionId);
				this.db
					.prepare(`UPDATE space_session_groups SET updated_at = ? WHERE id = ?`)
					.run(now, groupId);
			})();
			return this.getMember(existing.id as string)!;
		}

		const id = generateUUID();
		const now = Date.now();

		this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO space_session_group_members (id, group_id, session_id, role, agent_id, status, order_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(id, groupId, sessionId, role, agentId ?? null, status, orderIndex, now);
			this.db
				.prepare(`UPDATE space_session_groups SET updated_at = ? WHERE id = ?`)
				.run(now, groupId);
		})();

		return this.getMember(id)!;
	}

	/**
	 * Update fields on an existing group member (e.g. transition status after session completes).
	 * Returns null if the member record does not exist.
	 * The member write and group timestamp touch are performed atomically.
	 */
	updateMember(
		groupId: string,
		sessionId: string,
		params: UpdateMemberParams
	): SpaceSessionGroupMember | null {
		const fields: string[] = [];
		const values: (string | number | null)[] = [];

		if (params.role !== undefined) {
			fields.push('role = ?');
			values.push(params.role);
		}
		if (params.orderIndex !== undefined) {
			fields.push('order_index = ?');
			values.push(params.orderIndex);
		}
		if (params.agentId !== undefined) {
			fields.push('agent_id = ?');
			values.push(params.agentId ?? null);
		}
		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);
		}

		if (fields.length === 0) {
			// Nothing to update — return current state
			const row = this.db
				.prepare(`SELECT * FROM space_session_group_members WHERE group_id = ? AND session_id = ?`)
				.get(groupId, sessionId) as Record<string, unknown> | undefined;
			return row ? this.rowToMember(row) : null;
		}

		values.push(groupId, sessionId);
		let updated: Record<string, unknown> | undefined;

		this.db.transaction(() => {
			const result = this.db
				.prepare(
					`UPDATE space_session_group_members SET ${fields.join(', ')} WHERE group_id = ? AND session_id = ?`
				)
				.run(...values);

			if (result.changes === 0) return;

			this.db
				.prepare(`UPDATE space_session_groups SET updated_at = ? WHERE id = ?`)
				.run(Date.now(), groupId);

			updated = this.db
				.prepare(`SELECT * FROM space_session_group_members WHERE group_id = ? AND session_id = ?`)
				.get(groupId, sessionId) as Record<string, unknown> | undefined;
		})();

		return updated ? this.rowToMember(updated) : null;
	}

	/**
	 * Update status on an existing member by member ID.
	 * Returns null if the member record does not exist.
	 * The member update and group timestamp touch are performed atomically.
	 */
	updateMemberStatus(
		memberId: string,
		status: 'active' | 'completed' | 'failed'
	): SpaceSessionGroupMember | null {
		const row = this.db
			.prepare(`SELECT * FROM space_session_group_members WHERE id = ?`)
			.get(memberId) as Record<string, unknown> | undefined;

		if (!row) return null;

		this.db.transaction(() => {
			this.db
				.prepare(`UPDATE space_session_group_members SET status = ? WHERE id = ?`)
				.run(status, memberId);
			this.db
				.prepare(`UPDATE space_session_groups SET updated_at = ? WHERE id = ?`)
				.run(Date.now(), row.group_id as string);
		})();

		return this.getMember(memberId);
	}

	/**
	 * Remove a session from a group.
	 * The delete and group timestamp touch are performed atomically.
	 */
	removeMember(groupId: string, sessionId: string): boolean {
		let changed = false;

		this.db.transaction(() => {
			const result = this.db
				.prepare(`DELETE FROM space_session_group_members WHERE group_id = ? AND session_id = ?`)
				.run(groupId, sessionId);

			if (result.changes > 0) {
				changed = true;
				this.db
					.prepare(`UPDATE space_session_groups SET updated_at = ? WHERE id = ?`)
					.run(Date.now(), groupId);
			}
		})();

		return changed;
	}

	/**
	 * Return the current number of members in a group using a COUNT query.
	 * Used to assign the next orderIndex without fetching all member rows.
	 */
	getMemberCount(groupId: string): number {
		const row = this.db
			.prepare(`SELECT COUNT(*) as cnt FROM space_session_group_members WHERE group_id = ?`)
			.get(groupId) as { cnt: number } | undefined;
		return row?.cnt ?? 0;
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
			workflowRunId: (row.workflow_run_id as string | null) ?? undefined,
			currentStepId: (row.current_step_id as string | null) ?? undefined,
			taskId: (row.task_id as string | null) ?? undefined,
			status: ((row.status as string | null) ?? 'active') as 'active' | 'completed' | 'failed',
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
			role: row.role as string,
			agentId: (row.agent_id as string | null) ?? undefined,
			status: ((row.status as string | null) ?? 'active') as 'active' | 'completed' | 'failed',
			orderIndex: row.order_index as number,
			createdAt: row.created_at as number,
		};
	}
}
