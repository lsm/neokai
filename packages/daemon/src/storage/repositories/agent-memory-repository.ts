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

export interface AgentMemoryEmbedder {
	model: string;
	dimensions: number;
	embedQuery(text: string): Float32Array | number[] | Promise<Float32Array | number[]>;
	embedPassage(text: string): Float32Array | number[] | Promise<Float32Array | number[]>;
}

interface AgentMemoryRow {
	rowid: number;
	key: string;
	space_id: string;
	content: string;
	tags: string;
	created_by_session: string | null;
	created_at: number;
	updated_at: number;
	access_count: number;
	last_accessed_at: number | null;
	embedding_status: 'pending' | 'ready' | 'failed';
	embedding_model: string | null;
	embedding_updated_at: number | null;
	embedding_error: string | null;
}

interface AgentMemorySearchRow extends AgentMemoryRow {
	rank: number;
}

interface AgentMemoryVectorRow extends AgentMemoryRow {
	embedding: Buffer;
	dimensions: number;
	model: string;
}

interface RankedRow {
	row: AgentMemorySearchRow;
	rank: number;
}

const MEMORY_CONTENT_MAX_LENGTH = 10_000;
const MEMORY_TAG_MAX_LENGTH = 50;
const MEMORY_TAG_MAX_COUNT = 50;
const RRF_K = 60;
const VECTOR_CANDIDATE_LIMIT = 100;
const EMBEDDING_ERROR_MAX_LENGTH = 500;

export class AgentMemoryRepository {
	constructor(
		private db: BunDatabase,
		private reactiveDb?: ReactiveDatabase,
		private embedder?: AgentMemoryEmbedder
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
		const tagsProvided = params.tags !== undefined;
		const tags = normalizeTags(params.tags ?? []);
		const now = Date.now();

		// On conflict (existing row): preserve `tags` when caller did not supply them
		// and never overwrite `created_by_session` so provenance stays with the
		// original author.
		const row = this.db
			.prepare(
				`INSERT INTO space_agent_memory
					(key, space_id, content, tags, created_by_session, created_at, updated_at, access_count, last_accessed_at, embedding_status, embedding_model, embedding_updated_at, embedding_error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 'pending', NULL, NULL, NULL)
				 ON CONFLICT(space_id, key) DO UPDATE SET
					content = excluded.content,
					tags = CASE WHEN ? = 1 THEN excluded.tags ELSE space_agent_memory.tags END,
					updated_at = excluded.updated_at,
					embedding_status = 'pending',
					embedding_model = NULL,
					embedding_updated_at = NULL,
					embedding_error = NULL
				 RETURNING *`
			)
			.get(
				key,
				params.spaceId,
				content,
				serializeTags(tags),
				params.createdBySession ?? null,
				now,
				now,
				tagsProvided ? 1 : 0
			) as AgentMemoryRow;

		this.updateEmbedding(row);
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

	async search(spaceId: string, query: string, limit = 10): Promise<AgentMemorySearchResult[]> {
		return (await this.searchWithOptions(spaceId, query, { limit })).map((row) => ({
			memory: rowToEntry(row),
			rank: row.rank,
		}));
	}

	async list(
		spaceId: string,
		options?: { query?: string; limit?: number; offset?: number }
	): Promise<AgentMemoryEntry[]> {
		const limit = normalizeLimit(options?.limit ?? 50, 100);
		const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
		const query = options?.query?.trim();

		if (query) {
			return (await this.searchWithOptions(spaceId, query, { limit, offset, maxLimit: 100 })).map(
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

	private async searchWithOptions(
		spaceId: string,
		query: string,
		options?: { limit?: number; offset?: number; maxLimit?: number }
	): Promise<AgentMemorySearchRow[]> {
		const ftsQuery = buildFtsQuery(query);
		const limit = normalizeLimit(options?.limit ?? 10, options?.maxLimit ?? 20);
		const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
		const poolLimit = options?.offset
			? limit + offset
			: (options?.maxLimit ?? VECTOR_CANDIDATE_LIMIT);

		const ftsRows = ftsQuery ? this.searchFts(spaceId, ftsQuery, poolLimit, 0) : [];
		const vectorRows = await this.searchVector(spaceId, query, poolLimit);
		const rows = mergeRankedRows(ftsRows, vectorRows).slice(offset, offset + limit);

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

	private searchFts(
		spaceId: string,
		ftsQuery: string,
		limit: number,
		offset: number
	): AgentMemorySearchRow[] {
		return this.db
			.prepare(
				`SELECT m.*, bm25(space_agent_memory_fts) AS rank
				 FROM space_agent_memory_fts
				 JOIN space_agent_memory m ON m.rowid = space_agent_memory_fts.rowid
				 WHERE space_agent_memory_fts MATCH ? AND m.space_id = ?
				 ORDER BY rank ASC, m.updated_at DESC, m.key ASC
				 LIMIT ? OFFSET ?`
			)
			.all(ftsQuery, spaceId, limit, offset) as AgentMemorySearchRow[];
	}

	private async searchVector(spaceId: string, query: string, limit: number): Promise<RankedRow[]> {
		const queryVector = await this.embedText(query, 'query', { fallbackToNull: true });
		if (!queryVector || !this.embedder) return [];

		const rows = this.db
			.prepare(
				`SELECT m.*, v.embedding, v.dimensions, v.model
				 FROM memory_vectors v
				 JOIN space_agent_memory m ON m.rowid = v.memory_rowid
				 WHERE m.space_id = ?
					AND m.embedding_status = 'ready'
					AND v.model = ?
					AND v.dimensions = ?`
			)
			.all(spaceId, this.embedder.model, this.embedder.dimensions) as AgentMemoryVectorRow[];

		return rows
			.map((row) => {
				const similarity = cosineSimilarity(queryVector, blobToFloat32Array(row.embedding));
				return {
					row: { ...row, rank: 1 - similarity },
					rank: similarity,
				};
			})
			.filter((item) => Number.isFinite(item.rank))
			.sort(
				(a, b) =>
					b.rank - a.rank ||
					b.row.updated_at - a.row.updated_at ||
					a.row.key.localeCompare(b.row.key)
			)
			.slice(0, limit);
	}

	private updateEmbedding(row: AgentMemoryRow): void {
		const sourceUpdatedAt = row.updated_at;
		const embedding = this.embedText(memoryEmbeddingText(row), 'passage');
		if (!embedding) return;
		if (embedding instanceof Promise) {
			embedding
				.then((vector) => this.storeEmbedding(row.rowid, sourceUpdatedAt, vector))
				.catch((error: unknown) => this.markEmbeddingFailed(row.rowid, sourceUpdatedAt, error));
			return;
		}
		this.storeEmbedding(row.rowid, sourceUpdatedAt, embedding);
	}

	private storeEmbedding(rowid: number, sourceUpdatedAt: number, embedding: Float32Array): void {
		const now = Date.now();
		const store = this.db.transaction(() => {
			const current = this.db
				.prepare(`SELECT updated_at FROM space_agent_memory WHERE rowid = ?`)
				.get(rowid) as { updated_at: number } | undefined;
			if (!current || current.updated_at !== sourceUpdatedAt) return;

			this.db
				.prepare(
					`INSERT INTO memory_vectors (memory_rowid, embedding, dimensions, model, updated_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(memory_rowid) DO UPDATE SET
						embedding = excluded.embedding,
						dimensions = excluded.dimensions,
						model = excluded.model,
						updated_at = excluded.updated_at`
				)
				.run(
					rowid,
					float32ArrayToBlob(embedding),
					embedding.length,
					this.embedder?.model ?? 'unknown',
					now
				);
			this.db
				.prepare(
					`UPDATE space_agent_memory
					 SET embedding_status = 'ready', embedding_model = ?, embedding_updated_at = ?, embedding_error = NULL
					 WHERE rowid = ?`
				)
				.run(this.embedder?.model ?? 'unknown', now, rowid);
		});
		store();
	}

	private markEmbeddingFailed(rowid: number, sourceUpdatedAt: number, error: unknown): void {
		const now = Date.now();
		this.db
			.prepare(
				`UPDATE space_agent_memory
				 SET embedding_status = 'failed', embedding_model = ?, embedding_updated_at = ?, embedding_error = ?
				 WHERE rowid = ? AND updated_at = ?`
			)
			.run(
				this.embedder?.model ?? 'unknown',
				now,
				embeddingErrorMessage(error),
				rowid,
				sourceUpdatedAt
			);
	}

	private embedText(
		text: string,
		kind: 'query' | 'passage'
	): Float32Array | Promise<Float32Array> | null;
	private embedText(
		text: string,
		kind: 'query' | 'passage',
		options: { fallbackToNull: true }
	): Float32Array | Promise<Float32Array | null> | null;
	private embedText(
		text: string,
		kind: 'query' | 'passage',
		options?: { fallbackToNull?: boolean }
	): Float32Array | Promise<Float32Array | null> | null {
		if (!this.embedder) return null;
		try {
			const embedding =
				kind === 'query' ? this.embedder.embedQuery(text) : this.embedder.embedPassage(text);
			if (embedding instanceof Promise) {
				const normalized = embedding.then((value) => this.normalizeEmbedding(value));
				return options?.fallbackToNull ? normalized.catch(() => null) : normalized;
			}
			return this.normalizeEmbedding(embedding);
		} catch (error) {
			if (options?.fallbackToNull) return null;
			throw error;
		}
	}

	private normalizeEmbedding(embedding: Float32Array | number[]): Float32Array {
		const vector = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
		if (vector.length !== this.embedder?.dimensions)
			throw new Error('Embedding dimension mismatch.');
		return vector;
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

function mergeRankedRows(
	ftsRows: AgentMemorySearchRow[],
	vectorRows: RankedRow[]
): AgentMemorySearchRow[] {
	const merged = new Map<number, { row: AgentMemorySearchRow; score: number }>();

	ftsRows.forEach((row, index) => {
		merged.set(row.rowid, {
			row,
			score: 1 / (RRF_K + index + 1),
		});
	});

	vectorRows.forEach((item, index) => {
		const existing = merged.get(item.row.rowid);
		const score = 1 / (RRF_K + index + 1);
		if (existing) {
			existing.score += score;
		} else {
			merged.set(item.row.rowid, { row: item.row, score });
		}
	});

	return [...merged.values()]
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.row.updated_at - a.row.updated_at ||
				a.row.key.localeCompare(b.row.key)
		)
		.map((item) => ({ ...item.row, rank: item.score }));
}

function memoryEmbeddingText(row: AgentMemoryRow): string {
	return [row.key, row.content, ...parseTags(row.tags)].join('\n');
}

function float32ArrayToBlob(vector: Float32Array): Buffer {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function blobToFloat32Array(blob: Buffer): Float32Array {
	return new Float32Array(
		blob.buffer,
		blob.byteOffset,
		Math.floor(blob.byteLength / Float32Array.BYTES_PER_ELEMENT)
	);
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
	if (left.length !== right.length || left.length === 0) return Number.NEGATIVE_INFINITY;
	const length = left.length;

	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < length; index++) {
		const leftValue = left[index] ?? 0;
		const rightValue = right[index] ?? 0;
		dot += leftValue * rightValue;
		leftMagnitude += leftValue * leftValue;
		rightMagnitude += rightValue * rightValue;
	}
	if (leftMagnitude === 0 || rightMagnitude === 0) return Number.NEGATIVE_INFINITY;
	return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function embeddingErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, EMBEDDING_ERROR_MAX_LENGTH);
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
	if (trimmed.length > MEMORY_CONTENT_MAX_LENGTH) {
		throw new Error(`Memory content must be ${MEMORY_CONTENT_MAX_LENGTH} characters or fewer.`);
	}
	return trimmed;
}

function normalizeTags(tags: string[]): string[] {
	const normalized: string[] = [];
	for (const raw of tags) {
		const tag = raw.trim();
		if (!tag) continue;
		// Tags are rendered verbatim into agent prompts via `tags.join(', ')`, so a
		// single oversized tag would balloon the prompt past the memory-content cap.
		// Bound per-tag length here to keep the prompt-size budget enforceable.
		if (tag.length > MEMORY_TAG_MAX_LENGTH) {
			throw new Error(`Memory tags must be ${MEMORY_TAG_MAX_LENGTH} characters or fewer.`);
		}
		normalized.push(tag);
	}
	return [...new Set(normalized)].slice(0, MEMORY_TAG_MAX_COUNT);
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
		// Preserve hyphens, dots, slashes, and colons so paths, URLs, and
		// dashed identifiers (e.g. `src/lib/main.ts`, `pre-commit`) remain
		// intact for trigram matching.
		.map((term) => term.replace(/[^\p{L}\p{N}_./:-]/gu, ''))
		// Trigram FTS cannot match terms shorter than three chars.
		.filter((term) => term.length >= 3);
	if (terms.length === 0) return null;
	return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ');
}
