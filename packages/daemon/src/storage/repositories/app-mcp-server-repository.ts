/**
 * AppMcpServerRepository
 *
 * CRUD operations for the application-level MCP server registry.
 * Each write method calls reactiveDb.notifyChange('app_mcp_servers') so that
 * LiveQueryEngine can invalidate frontend subscriptions on every registry change.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	AppMcpServer,
	AppMcpServerSourceType,
	CreateAppMcpServerRequest,
	UpdateAppMcpServerRequest,
} from '@neokai/shared';
import type { ReactiveDatabase } from '../reactive-database';
import type { SQLiteValue } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SOURCE_TYPES = new Set<AppMcpServerSourceType>(['stdio', 'sse', 'http']);

// ---------------------------------------------------------------------------
// Internal row type (mirrors SQLite columns)
// ---------------------------------------------------------------------------

interface AppMcpServerRow {
	id: string;
	name: string;
	description: string | null;
	source_type: string;
	command: string | null;
	args: string | null;
	env: string | null;
	url: string | null;
	headers: string | null;
	enabled: number;
	created_at: number | null;
	updated_at: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToServer(row: AppMcpServerRow): AppMcpServer {
	return {
		id: row.id,
		name: row.name,
		...(row.description !== null ? { description: row.description } : {}),
		sourceType: row.source_type as AppMcpServerSourceType,
		...(row.command !== null ? { command: row.command } : {}),
		...(row.args !== null ? { args: JSON.parse(row.args) as string[] } : {}),
		...(row.env !== null ? { env: JSON.parse(row.env) as Record<string, string> } : {}),
		...(row.url !== null ? { url: row.url } : {}),
		...(row.headers !== null ? { headers: JSON.parse(row.headers) as Record<string, string> } : {}),
		enabled: row.enabled === 1,
		...(row.created_at !== null ? { createdAt: row.created_at } : {}),
		...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
	};
}

function validateSourceType(sourceType: string): void {
	if (!VALID_SOURCE_TYPES.has(sourceType as AppMcpServerSourceType)) {
		throw new Error(
			`Invalid sourceType "${sourceType}". Must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}`
		);
	}
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class AppMcpServerRepository {
	constructor(
		private db: BunDatabase,
		private reactiveDb: ReactiveDatabase
	) {}

	/**
	 * Check whether a name is already taken in the registry.
	 * Pass `excludeId` when renaming an existing entry to avoid a false positive.
	 */
	isNameTaken(name: string, excludeId?: string): boolean {
		if (excludeId) {
			const row = this.db
				.prepare(`SELECT 1 FROM app_mcp_servers WHERE name = ? AND id != ?`)
				.get(name, excludeId);
			return row !== null;
		}
		const row = this.db.prepare(`SELECT 1 FROM app_mcp_servers WHERE name = ?`).get(name);
		return row !== null;
	}

	/**
	 * Create a new MCP server registry entry.
	 * Throws if the name is already taken or if sourceType is invalid.
	 */
	create(req: CreateAppMcpServerRequest): AppMcpServer {
		validateSourceType(req.sourceType);

		if (this.isNameTaken(req.name)) {
			throw new Error(`An MCP server named "${req.name}" already exists`);
		}

		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO app_mcp_servers
          (id, name, description, source_type, command, args, env, url, headers, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				req.name,
				req.description ?? null,
				req.sourceType,
				req.command ?? null,
				req.args !== undefined ? JSON.stringify(req.args) : null,
				req.env !== undefined ? JSON.stringify(req.env) : null,
				req.url ?? null,
				req.headers !== undefined ? JSON.stringify(req.headers) : null,
				(req.enabled ?? true) ? 1 : 0,
				now,
				now
			);

		this.reactiveDb.notifyChange('app_mcp_servers');
		return this.get(id)!;
	}

	/**
	 * Get a server entry by ID. Returns null if not found.
	 */
	get(id: string): AppMcpServer | null {
		const row = this.db.prepare(`SELECT * FROM app_mcp_servers WHERE id = ?`).get(id) as
			| AppMcpServerRow
			| undefined;
		return row ? rowToServer(row) : null;
	}

	/**
	 * Get a server entry by name. Returns null if not found.
	 */
	getByName(name: string): AppMcpServer | null {
		const row = this.db.prepare(`SELECT * FROM app_mcp_servers WHERE name = ?`).get(name) as
			| AppMcpServerRow
			| undefined;
		return row ? rowToServer(row) : null;
	}

	/**
	 * List all MCP server entries, ordered by created_at (NULLs last).
	 */
	list(): AppMcpServer[] {
		const rows = this.db
			.prepare(`SELECT * FROM app_mcp_servers ORDER BY created_at IS NULL, created_at ASC`)
			.all() as AppMcpServerRow[];
		return rows.map(rowToServer);
	}

	/**
	 * List only enabled MCP server entries, ordered by created_at (NULLs last).
	 */
	listEnabled(): AppMcpServer[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM app_mcp_servers WHERE enabled = 1 ORDER BY created_at IS NULL, created_at ASC`
			)
			.all() as AppMcpServerRow[];
		return rows.map(rowToServer);
	}

	/**
	 * Update an existing MCP server entry. Returns the updated entry or null if not found.
	 * Throws if the new name is already taken by another entry, or if sourceType is invalid.
	 */
	update(id: string, updates: Omit<UpdateAppMcpServerRequest, 'id'>): AppMcpServer | null {
		const existing = this.get(id);
		if (!existing) return null;

		if (updates.name !== undefined && this.isNameTaken(updates.name, id)) {
			throw new Error(`An MCP server named "${updates.name}" already exists`);
		}

		if (updates.sourceType !== undefined) {
			validateSourceType(updates.sourceType);
		}

		const now = Date.now();
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (updates.name !== undefined) {
			fields.push('name = ?');
			values.push(updates.name);
		}
		if ('description' in updates) {
			fields.push('description = ?');
			values.push(updates.description ?? null);
		}
		if (updates.sourceType !== undefined) {
			fields.push('source_type = ?');
			values.push(updates.sourceType);
		}
		if ('command' in updates) {
			fields.push('command = ?');
			values.push(updates.command ?? null);
		}
		if ('args' in updates) {
			fields.push('args = ?');
			values.push(updates.args !== undefined ? JSON.stringify(updates.args) : null);
		}
		if ('env' in updates) {
			fields.push('env = ?');
			values.push(updates.env !== undefined ? JSON.stringify(updates.env) : null);
		}
		if ('url' in updates) {
			fields.push('url = ?');
			values.push(updates.url ?? null);
		}
		if ('headers' in updates) {
			fields.push('headers = ?');
			values.push(updates.headers !== undefined ? JSON.stringify(updates.headers) : null);
		}
		if (updates.enabled !== undefined) {
			fields.push('enabled = ?');
			values.push(updates.enabled ? 1 : 0);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(now);
			values.push(id);
			this.db
				.prepare(`UPDATE app_mcp_servers SET ${fields.join(', ')} WHERE id = ?`)
				.run(...values);
			this.reactiveDb.notifyChange('app_mcp_servers');
		}

		return this.get(id);
	}

	/**
	 * Delete an MCP server entry. Returns true if a row was deleted.
	 */
	delete(id: string): boolean {
		const result = this.db.prepare(`DELETE FROM app_mcp_servers WHERE id = ?`).run(id);
		const deleted = result.changes > 0;
		if (deleted) {
			this.reactiveDb.notifyChange('app_mcp_servers');
		}
		return deleted;
	}
}
