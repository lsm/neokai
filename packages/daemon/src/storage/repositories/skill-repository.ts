/**
 * SkillRepository
 *
 * CRUD operations for the application-level Skills registry.
 * Each write method calls reactiveDb.notifyChange('skills') so that
 * LiveQueryEngine can invalidate frontend subscriptions on every registry change.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	AppSkill,
	AppSkillConfig,
	SkillSourceType,
	SkillValidationStatus,
} from '@neokai/shared';
import type { ReactiveDatabase } from '../reactive-database';

// ---------------------------------------------------------------------------
// Internal row type (mirrors SQLite columns)
// ---------------------------------------------------------------------------

interface SkillRow {
	id: string;
	name: string;
	display_name: string;
	description: string;
	source_type: string;
	config: string;
	enabled: number;
	built_in: number;
	validation_status: string;
	created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSkill(row: SkillRow): AppSkill {
	return {
		id: row.id,
		name: row.name,
		displayName: row.display_name,
		description: row.description,
		sourceType: row.source_type as SkillSourceType,
		config: JSON.parse(row.config) as AppSkillConfig,
		enabled: row.enabled === 1,
		builtIn: row.built_in === 1,
		validationStatus: row.validation_status as SkillValidationStatus,
		createdAt: row.created_at,
	};
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SkillRepository {
	constructor(
		private db: BunDatabase,
		private reactiveDb: ReactiveDatabase
	) {}

	/**
	 * Ensure the skills table exists. Called during DB initialization.
	 * Idempotent via CREATE TABLE IF NOT EXISTS.
	 */
	ensureTable(): void {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        source_type TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        built_in INTEGER NOT NULL DEFAULT 0,
        validation_status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `);
	}

	/**
	 * List all skills, ordered by created_at ascending.
	 */
	findAll(): AppSkill[] {
		const rows = this.db
			.prepare(`SELECT * FROM skills ORDER BY created_at ASC`)
			.all() as SkillRow[];
		return rows.map(rowToSkill);
	}

	/**
	 * Get a skill by ID. Returns null if not found.
	 */
	get(id: string): AppSkill | null {
		const row = this.db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as
			| SkillRow
			| undefined;
		return row ? rowToSkill(row) : null;
	}

	/**
	 * List only enabled skills, ordered by created_at ascending.
	 */
	findEnabled(): AppSkill[] {
		const rows = this.db
			.prepare(`SELECT * FROM skills WHERE enabled = 1 ORDER BY created_at ASC`)
			.all() as SkillRow[];
		return rows.map(rowToSkill);
	}

	/**
	 * Insert a new skill record.
	 */
	insert(skill: AppSkill): void {
		this.db
			.prepare(
				`INSERT INTO skills
         (id, name, display_name, description, source_type, config, enabled, built_in, validation_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				skill.id,
				skill.name,
				skill.displayName,
				skill.description,
				skill.sourceType,
				JSON.stringify(skill.config),
				skill.enabled ? 1 : 0,
				skill.builtIn ? 1 : 0,
				skill.validationStatus,
				skill.createdAt
			);
		this.reactiveDb.notifyChange('skills');
	}

	/**
	 * Update mutable fields on an existing skill.
	 */
	update(id: string, fields: Partial<AppSkill>): void {
		const setClauses: string[] = [];
		const values: (string | number | null)[] = [];

		if (fields.displayName !== undefined) {
			setClauses.push('display_name = ?');
			values.push(fields.displayName);
		}
		if (fields.description !== undefined) {
			setClauses.push('description = ?');
			values.push(fields.description);
		}
		if (fields.enabled !== undefined) {
			setClauses.push('enabled = ?');
			values.push(fields.enabled ? 1 : 0);
		}
		if (fields.config !== undefined) {
			setClauses.push('config = ?');
			values.push(JSON.stringify(fields.config));
		}
		if (fields.validationStatus !== undefined) {
			setClauses.push('validation_status = ?');
			values.push(fields.validationStatus);
		}

		if (setClauses.length === 0) return;

		values.push(id);
		this.db.prepare(`UPDATE skills SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
		this.reactiveDb.notifyChange('skills');
	}

	/**
	 * Toggle the enabled flag for a skill. Targeted single-column UPDATE.
	 */
	setEnabled(id: string, enabled: boolean): void {
		this.db.prepare(`UPDATE skills SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
		this.reactiveDb.notifyChange('skills');
	}

	/**
	 * Set the validation_status for a skill. Used by the async validation job.
	 */
	setValidationStatus(id: string, status: SkillValidationStatus): void {
		this.db.prepare(`UPDATE skills SET validation_status = ? WHERE id = ?`).run(status, id);
		this.reactiveDb.notifyChange('skills');
	}

	/**
	 * Delete a skill by ID. Returns true if a row was deleted.
	 */
	delete(id: string): boolean {
		const result = this.db.prepare(`DELETE FROM skills WHERE id = ?`).run(id);
		const deleted = result.changes > 0;
		if (deleted) {
			this.reactiveDb.notifyChange('skills');
		}
		return deleted;
	}
}
