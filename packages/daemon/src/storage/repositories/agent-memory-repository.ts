import type { Database as BunDatabase } from 'bun:sqlite';
import type { ReactiveDatabase } from '../reactive-database';

export interface AgentMemoryEntry {
	key: string;
	spaceId: string;
	content: string;
	tags: string[];
	createdBySession: string | null;
	createdAt: number;
	updatedAt: number;
	accessCount: number;
	lastAccessedAt: number | null;
}

export interface AgentMemorySearchResult {
	memory: AgentMemoryEntry;
	rank: number;
}

interface AgentMemoryRow {
	key: string;
	space_id: string;
	content: string;
	tags: string;
	created_by_session: string | null;
	created_at: number;
	updated_at: number;
	access_count: number;
	last_accessed_at: number | null;
}

interface AgentMemorySearchRow extends AgentMemoryRow {
	rank: number;
}

export class AgentMemoryRepository {
	constructor(
		private db: BunDatabase,
		private reactiveDb?: ReactiveDatabase
	) {}

	write(params: {
		spaceId: string;
		key: string;
		content: string;
		tags?: string[];
		createdBySession?: string | null;
	}): AgentMemoryEntry {
		const key = normalizeKey(params.key);
		const content = normalizeContent(params.content);
		const tags = normalizeTags(params.tags ?? []);
		const now = Date.now();

		const row = this.db
			.prepare(
				`INSERT INTO space_agent_memory
					(key, space_id, content, tags, created_by_session, created_at, updated_at, access_count, last_accessed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
				 ON CONFLICT(space_id, key) DO UPDATE SET
					content = excluded.content,
					tags = excluded.tags,
					created_by_session = COALESCE(excluded.created_by_session, space_agent_memory.created_by_session),
					updated_at = excluded.updated_at
				 RETURNING *`
			)
			.get(
				key,
				params.spaceId,
				content,
				serializeTags(tags),
				params.createdBySession ?? null,
				now,
				now
			) as AgentMemoryRow;

		this.reactiveDb?.notifyChange('space_agent_memory');
		return rowToEntry(row);
	}

	read(
		spaceId: string,
		key: string,
		options?: { recordAccess?: boolean }
	): AgentMemoryEntry | null {
		const normalizedKey = normalizeKey(key);
		const row = this.db
			.prepare(`SELECT * FROM space_agent_memory WHERE space_id = ? AND key = ?`)
			.get(spaceId, normalizedKey) as AgentMemoryRow | undefined;
		if (!row) return null;
		if (options?.recordAccess !== false) this.recordAccess(spaceId, normalizedKey);
		return rowToEntry(row);
	}

	delete(spaceId: string, key: string): boolean {
		const normalizedKey = normalizeKey(key);
		const result = this.db
			.prepare(`DELETE FROM space_agent_memory WHERE space_id = ? AND key = ?`)
			.run(spaceId, normalizedKey);
		if (result.changes > 0) this.reactiveDb?.notifyChange('space_agent_memory');
		return result.changes > 0;
	}

	search(spaceId: string, query: string, limit = 10): AgentMemorySearchResult[] {
		return this.searchWithOptions(spaceId, query, { limit }).map((row) => ({
			memory: rowToEntry(row),
			rank: row.rank,
		}));
	}

	list(
		spaceId: string,
		options?: { query?: string; limit?: number; offset?: number }
	): AgentMemoryEntry[] {
		const limit = normalizeLimit(options?.limit ?? 50, 100);
		const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
		const query = options?.query?.trim();

		if (query) {
			return this.searchWithOptions(spaceId, query, { limit, offset, maxLimit: 100 }).map(
				rowToEntry
			);
		}

		const rows = this.db
			.prepare(
				`SELECT * FROM space_agent_memory
				 WHERE space_id = ?
				 ORDER BY updated_at DESC, key ASC
				 LIMIT ? OFFSET ?`
			)
			.all(spaceId, limit, offset) as AgentMemoryRow[];
		return rows.map(rowToEntry);
	}

	recordAccess(spaceId: string, key: string): void {
		this.db
			.prepare(
				`UPDATE space_agent_memory
				 SET access_count = access_count + 1, last_accessed_at = ?
				 WHERE space_id = ? AND key = ?`
			)
			.run(Date.now(), spaceId, normalizeKey(key));
		this.reactiveDb?.notifyChange('space_agent_memory');
	}

	private searchWithOptions(
		spaceId: string,
		query: string,
		options?: { limit?: number; offset?: number; maxLimit?: number }
	): AgentMemorySearchRow[] {
		const ftsQuery = buildFtsQuery(query);
		const limit = normalizeLimit(options?.limit ?? 10, options?.maxLimit ?? 20);
		const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
		if (!ftsQuery) return [];

		const rows = this.db
			.prepare(
				`SELECT m.*, bm25(space_agent_memory_fts) AS rank
				 FROM space_agent_memory_fts
				 JOIN space_agent_memory m ON m.rowid = space_agent_memory_fts.rowid
				 WHERE space_agent_memory_fts MATCH ? AND m.space_id = ?
				 ORDER BY rank ASC, m.updated_at DESC, m.key ASC
				 LIMIT ? OFFSET ?`
			)
			.all(ftsQuery, spaceId, limit, offset) as AgentMemorySearchRow[];

		if (rows.length > 0) {
			const now = Date.now();
			const bump = this.db.prepare(
				`UPDATE space_agent_memory
				 SET access_count = access_count + 1, last_accessed_at = ?
				 WHERE space_id = ? AND key = ?`
			);
			const updateAccess = this.db.transaction((items: AgentMemorySearchRow[]) => {
				for (const row of items) bump.run(now, row.space_id, row.key);
			});
			updateAccess(rows);
			this.reactiveDb?.notifyChange('space_agent_memory');
		}

		return rows;
	}
}

function rowToEntry(row: AgentMemoryRow): AgentMemoryEntry {
	return {
		key: row.key,
		spaceId: row.space_id,
		content: row.content,
		tags: parseTags(row.tags),
		createdBySession: row.created_by_session,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		accessCount: row.access_count,
		lastAccessedAt: row.last_accessed_at,
	};
}

function normalizeKey(key: string): string {
	const trimmed = key.trim();
	if (!trimmed) throw new Error('Memory key must be a non-empty string.');
	if (trimmed.length > 200) throw new Error('Memory key must be 200 characters or fewer.');
	return trimmed;
}

function normalizeContent(content: string): string {
	const trimmed = content.trim();
	if (!trimmed) throw new Error('Memory content must be a non-empty string.');
	return trimmed;
}

function normalizeTags(tags: string[]): string[] {
	return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 50);
}

function serializeTags(tags: string[]): string {
	return JSON.stringify(tags);
}

function parseTags(tags: string): string[] {
	if (!tags) return [];
	try {
		const parsed = JSON.parse(tags) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter((tag): tag is string => typeof tag === 'string');
		}
	} catch {
		// Pre-JSON rows used whitespace-delimited tags.
	}
	return tags.split(/\s+/).filter(Boolean);
}

function normalizeLimit(limit: number, max = 20): number {
	if (!Number.isFinite(limit)) return Math.min(10, max);
	return Math.min(Math.max(1, Math.trunc(limit)), max);
}

function buildFtsQuery(query: string): string | null {
	const terms = query
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.map((term) => term.replace(/[^\p{L}\p{N}_.-]/gu, ''))
		.filter((term) => term.length >= 3);
	if (terms.length === 0) return null;
	return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ');
}
