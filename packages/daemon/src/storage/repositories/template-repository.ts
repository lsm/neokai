/**
 * Template Repository
 *
 * CRUD operations for session/room templates.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	SessionTemplate,
	CreateTemplateParams,
	UpdateTemplateParams,
	TemplateScope,
	TemplateConfig,
	TemplateRoomConfig,
	SessionTemplateVariable,
} from '@neokai/shared';

export class TemplateRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new template
	 */
	createTemplate(params: CreateTemplateParams): SessionTemplate {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO session_templates (id, name, description, scope, config, room_config, variables, built_in, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.name,
			params.description ?? null,
			params.scope,
			JSON.stringify(params.config),
			params.roomConfig ? JSON.stringify(params.roomConfig) : null,
			params.variables ? JSON.stringify(params.variables) : null,
			0,
			now,
			now
		);

		return this.getTemplate(id)!;
	}

	/**
	 * Create a built-in template (idempotent — skips if ID exists)
	 */
	createBuiltIn(template: SessionTemplate): void {
		const existing = this.getTemplate(template.id);
		if (existing) return;

		const stmt = this.db.prepare(
			`INSERT INTO session_templates (id, name, description, scope, config, room_config, variables, built_in, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			template.id,
			template.name,
			template.description ?? null,
			template.scope,
			JSON.stringify(template.config),
			template.roomConfig ? JSON.stringify(template.roomConfig) : null,
			template.variables ? JSON.stringify(template.variables) : null,
			1,
			template.createdAt,
			template.updatedAt
		);
	}

	/**
	 * Get a template by ID
	 */
	getTemplate(id: string): SessionTemplate | null {
		const stmt = this.db.prepare(`SELECT * FROM session_templates WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.rowToTemplate(row);
	}

	/**
	 * List all templates, optionally filtered by scope
	 */
	listTemplates(scope?: TemplateScope): SessionTemplate[] {
		let query = `SELECT * FROM session_templates`;
		const params: string[] = [];
		if (scope) {
			query += ` WHERE scope = ?`;
			params.push(scope);
		}
		query += ` ORDER BY built_in DESC, name ASC`;

		const stmt = this.db.prepare(query);
		const rows = (scope ? stmt.all(scope) : stmt.all()) as Record<string, unknown>[];
		return rows.map((r) => this.rowToTemplate(r));
	}

	/**
	 * Update a template (only user-created templates can be updated)
	 */
	updateTemplate(id: string, params: UpdateTemplateParams): SessionTemplate | null {
		const existing = this.getTemplate(id);
		if (!existing || existing.builtIn) return null;

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
		if (params.config !== undefined) {
			fields.push('config = ?');
			values.push(JSON.stringify(params.config));
		}
		if (params.roomConfig !== undefined) {
			fields.push('room_config = ?');
			values.push(JSON.stringify(params.roomConfig));
		}
		if (params.variables !== undefined) {
			fields.push('variables = ?');
			values.push(JSON.stringify(params.variables));
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(Date.now());
			values.push(id);
			const stmt = this.db.prepare(
				`UPDATE session_templates SET ${fields.join(', ')} WHERE id = ?`
			);
			stmt.run(...values);
		}

		return this.getTemplate(id);
	}

	/**
	 * Delete a template (only user-created templates can be deleted)
	 */
	deleteTemplate(id: string): boolean {
		const existing = this.getTemplate(id);
		if (!existing || existing.builtIn) return false;

		const stmt = this.db.prepare(`DELETE FROM session_templates WHERE id = ?`);
		const result = stmt.run(id);
		return result.changes > 0;
	}

	/**
	 * Convert a database row to a SessionTemplate object
	 */
	private rowToTemplate(row: Record<string, unknown>): SessionTemplate {
		const rawConfig = row.config as string;
		const rawRoomConfig = row.room_config as string | null;
		const rawVariables = row.variables as string | null;

		return {
			id: row.id as string,
			name: row.name as string,
			description: (row.description as string | null) ?? undefined,
			scope: row.scope as TemplateScope,
			config: JSON.parse(rawConfig) as TemplateConfig,
			roomConfig: rawRoomConfig ? (JSON.parse(rawRoomConfig) as TemplateRoomConfig) : undefined,
			variables: rawVariables ? (JSON.parse(rawVariables) as SessionTemplateVariable[]) : undefined,
			builtIn: (row.built_in as number) === 1,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}
}
