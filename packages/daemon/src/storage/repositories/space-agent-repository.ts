/**
 * Space Agent Repository
 *
 * CRUD operations for space_agents table.
 *
 * Column mapping:
 *   SpaceAgent.tools        ↔  tools column (JSON string array; '[]' or null → undefined)
 *   SpaceAgent.toolConfig   ↔  config column (JSON)
 *   SpaceAgent.systemPrompt ↔  system_prompt column
 *   SpaceAgent.role         ↔  role column (BuiltinAgentRole: 'planner'|'coder'|'general'|'reviewer')
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { SpaceAgent, CreateSpaceAgentParams, UpdateSpaceAgentParams } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export class SpaceAgentRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new space agent
	 */
	create(params: CreateSpaceAgentParams): SpaceAgent {
		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO space_agents
					(id, space_id, name, description, model, provider, tools, system_prompt, role, config, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.spaceId,
				params.name,
				params.description ?? '', // NOT NULL DEFAULT '' in Mig29 — never pass null
				params.model ?? null,
				params.provider ?? null,
				params.tools && params.tools.length > 0 ? JSON.stringify(params.tools) : '[]',
				params.systemPrompt ?? '', // NOT NULL DEFAULT '' in Mig29 — never pass null
				params.role,
				params.toolConfig ? JSON.stringify(params.toolConfig) : null,
				now,
				now
			);

		return this.getById(id)!;
	}

	/**
	 * Get a single agent by ID
	 */
	getById(id: string): SpaceAgent | null {
		const row = this.db.prepare(`SELECT * FROM space_agents WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;

		return row ? this.rowToAgent(row) : null;
	}

	/**
	 * Get all agents for a space
	 */
	getBySpaceId(spaceId: string): SpaceAgent[] {
		const rows = this.db
			.prepare(`SELECT * FROM space_agents WHERE space_id = ? ORDER BY created_at ASC`)
			.all(spaceId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToAgent(r));
	}

	/**
	 * Batch lookup agents by IDs. Returns only found agents (no error on missing).
	 */
	getAgentsByIds(ids: string[]): SpaceAgent[] {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => '?').join(', ');
		const rows = this.db
			.prepare(`SELECT * FROM space_agents WHERE id IN (${placeholders})`)
			.all(...(ids as SQLiteValue[])) as Record<string, unknown>[];
		return rows.map((r) => this.rowToAgent(r));
	}

	/**
	 * Check if a name is already taken within a space.
	 * Case-insensitive. Pass excludeId to ignore the agent being updated.
	 */
	isNameTaken(spaceId: string, name: string, excludeId?: string): boolean {
		if (excludeId) {
			const row = this.db
				.prepare(
					`SELECT 1 FROM space_agents WHERE space_id = ? AND LOWER(name) = LOWER(?) AND id != ? LIMIT 1`
				)
				.get(spaceId, name, excludeId);
			return row !== null && row !== undefined;
		}
		const row = this.db
			.prepare(`SELECT 1 FROM space_agents WHERE space_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`)
			.get(spaceId, name);
		return row !== null && row !== undefined;
	}

	/**
	 * Update an agent with partial updates. Returns the updated agent or null if not found.
	 */
	update(id: string, params: UpdateSpaceAgentParams): SpaceAgent | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.name !== undefined) {
			fields.push('name = ?');
			values.push(params.name);
		}
		if (params.description !== undefined) {
			fields.push('description = ?');
			values.push(params.description ?? ''); // NOT NULL — null means clear → ''
		}
		if (params.model !== undefined) {
			fields.push('model = ?');
			values.push(params.model ?? null);
		}
		if (params.provider !== undefined) {
			fields.push('provider = ?');
			values.push(params.provider ?? null);
		}
		if (params.systemPrompt !== undefined) {
			fields.push('system_prompt = ?');
			values.push(params.systemPrompt ?? ''); // NOT NULL — null means clear → ''
		}
		if (params.role !== undefined) {
			fields.push('role = ?');
			values.push(params.role);
		}
		if (params.tools !== undefined) {
			fields.push('tools = ?');
			values.push(params.tools && params.tools.length > 0 ? JSON.stringify(params.tools) : '[]');
		}
		if (params.toolConfig !== undefined) {
			fields.push('config = ?');
			values.push(params.toolConfig ? JSON.stringify(params.toolConfig) : null);
		}

		if (fields.length === 0) return this.getById(id);

		fields.push('updated_at = ?');
		values.push(Date.now());
		values.push(id);

		this.db.prepare(`UPDATE space_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
		return this.getById(id);
	}

	/**
	 * Delete an agent by ID
	 */
	delete(id: string): void {
		this.db.prepare(`DELETE FROM space_agents WHERE id = ?`).run(id);
	}

	/**
	 * Check whether an agent is referenced by any workflow steps.
	 * Returns the names of workflows that reference this agent.
	 * Empty array means safe to delete.
	 */
	isAgentReferenced(agentId: string): { referenced: boolean; workflowNames: string[] } {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT sw.name
				FROM space_workflow_steps sws
				JOIN space_workflows sw ON sw.id = sws.workflow_id
				WHERE sws.agent_id = ?`
			)
			.all(agentId) as Array<{ name: string }>;

		const workflowNames = rows.map((r) => r.name);
		return { referenced: workflowNames.length > 0, workflowNames };
	}

	private rowToAgent(row: Record<string, unknown>): SpaceAgent {
		// Parse tools: '[]' or null → undefined; non-empty JSON array → string[]
		let tools: string[] | undefined;
		if (row.tools) {
			const parsed = JSON.parse(row.tools as string) as string[];
			tools = parsed.length > 0 ? parsed : undefined;
		}

		return {
			id: row.id as string,
			spaceId: row.space_id as string,
			name: row.name as string,
			description: (row.description as string) || undefined, // '' or null → undefined
			model: (row.model as string | null) ?? undefined,
			provider: (row.provider as string | null) ?? undefined,
			systemPrompt: (row.system_prompt as string) || undefined, // '' or null → undefined
			role: (row.role as SpaceAgent['role'] | null) ?? 'coder',
			tools,
			toolConfig: row.config
				? (JSON.parse(row.config as string) as Record<string, unknown>)
				: undefined,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}
}
