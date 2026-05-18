import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import {
	AgentMemoryRepository,
	type AgentMemoryEmbedder,
} from '../../../src/storage/repositories/agent-memory-repository.ts';

let db: BunDatabase;
let repo: AgentMemoryRepository;

class KeywordEmbedder implements AgentMemoryEmbedder {
	model = 'test-keyword';
	dimensions = 3;

	embedQuery(text: string): Float32Array {
		return keywordVector(text);
	}

	embedPassage(text: string): Float32Array {
		return keywordVector(text);
	}
}

class TrackingEmbedder extends KeywordEmbedder {
	queryTexts: string[] = [];
	passageTexts: string[] = [];

	override embedQuery(text: string): Float32Array {
		this.queryTexts.push(text);
		return super.embedQuery(text);
	}

	override embedPassage(text: string): Float32Array {
		this.passageTexts.push(text);
		return super.embedPassage(text);
	}
}

class AsyncKeywordEmbedder implements AgentMemoryEmbedder {
	model = 'test-keyword';
	dimensions = 3;

	embedQuery(text: string): Promise<Float32Array> {
		return Promise.resolve(keywordVector(text));
	}

	embedPassage(text: string): Promise<Float32Array> {
		return Promise.resolve(keywordVector(text));
	}
}

class DeferredKeywordEmbedder implements AgentMemoryEmbedder {
	model = 'test-keyword';
	dimensions = 3;
	private resolvers: Array<(vector: Float32Array) => void> = [];

	embedQuery(text: string): Promise<Float32Array> {
		return new Promise((resolve) => {
			this.resolvers.push(() => resolve(keywordVector(text)));
		});
	}

	embedPassage(text: string): Promise<Float32Array> {
		return new Promise((resolve) => {
			this.resolvers.push(() => resolve(keywordVector(text)));
		});
	}

	resolveNext(): void {
		this.resolvers.shift()?.(new Float32Array());
	}
}

class FailingEmbedder implements AgentMemoryEmbedder {
	model = 'test-failing';
	dimensions = 3;

	embedQuery(): Promise<Float32Array> {
		return Promise.reject(new Error('embedding unavailable'));
	}

	embedPassage(): Promise<Float32Array> {
		return Promise.reject(new Error('embedding unavailable'));
	}
}

class QueryFailingEmbedder extends KeywordEmbedder {
	override embedQuery(): Promise<Float32Array> {
		return Promise.reject(new Error('query embedding unavailable'));
	}
}

class SyncThrowingEmbedder extends KeywordEmbedder {
	override embedPassage(): Float32Array {
		throw new Error('sync embedding unavailable');
	}
}

function keywordVector(text: string): Float32Array {
	const lower = text.toLowerCase();
	return new Float32Array([
		lower.includes('delete') || lower.includes('remove') || lower.includes('erase') ? 1 : 0,
		lower.includes('session') || lower.includes('conversation') || lower.includes('thread') ? 1 : 0,
		lower.includes('credential') || lower.includes('secret') || lower.includes('token') ? 1 : 0,
	]);
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function seedSpace(spaceId: string): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
	     allowed_models, session_ids, slug, status, created_at, updated_at)
	     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `/tmp/${spaceId}`, spaceId, spaceId, now, now);
}

describe('AgentMemoryRepository', () => {
	beforeEach(() => {
		db = new BunDatabase(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		runMigrations(db, () => {});
		repo = new AgentMemoryRepository(db);
		seedSpace('space-a');
		seedSpace('space-b');
	});

	afterEach(() => {
		db.close();
	});

	test('writes and reads memory by space/key', async () => {
		const memory = repo.write({
			spaceId: 'space-a',
			key: 'conventions.test',
			content: 'Use Bun native tests for daemon code.',
			tags: ['testing', 'bun'],
			createdBySession: 'session-1',
		});

		expect(memory.key).toBe('conventions.test');
		expect(memory.spaceId).toBe('space-a');
		expect(memory.tags).toEqual(['testing', 'bun']);
		expect(await repo.list('space-a')).toHaveLength(1);

		const read = repo.read('space-a', 'conventions.test');
		expect(read?.content).toBe('Use Bun native tests for daemon code.');
		expect(read?.createdBySession).toBe('session-1');
	});

	test('search returns FTS-ranked results', async () => {
		repo.write({
			spaceId: 'space-a',
			key: 'alpha',
			content: 'React components use hooks.',
		});
		repo.write({
			spaceId: 'space-a',
			key: 'preact',
			content: 'Preact Signals are required for web state management.',
			tags: ['preact', 'signals'],
		});

		const results = await repo.search('space-a', 'preact signals', 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].memory.key).toBe('preact');
		expect(results[0].rank).toBeTypeOf('number');
	});

	test('search is scoped by space', async () => {
		repo.write({ spaceId: 'space-a', key: 'shared', content: 'Use tabs for formatting.' });
		repo.write({ spaceId: 'space-b', key: 'shared', content: 'Use spaces for formatting.' });

		const results = await repo.search('space-a', 'formatting', 10);
		expect(results.map((result) => result.memory.content)).toEqual(['Use tabs for formatting.']);
	});

	test('preserves tags with whitespace', () => {
		repo.write({
			spaceId: 'space-a',
			key: 'release.process',
			content: 'Release process notes.',
			tags: ['release notes', 'phase 1'],
		});

		expect(repo.read('space-a', 'release.process')?.tags).toEqual(['release notes', 'phase 1']);
	});

	test('rejects oversized memory content', () => {
		expect(() =>
			repo.write({
				spaceId: 'space-a',
				key: 'oversized',
				content: 'x'.repeat(10_001),
			})
		).toThrow('Memory content must be 10000 characters or fewer.');
	});

	test('rejects oversized memory tags', () => {
		expect(() =>
			repo.write({
				spaceId: 'space-a',
				key: 'oversized.tag',
				content: 'Tag length must be bounded for prompt safety.',
				tags: ['x'.repeat(51)],
			})
		).toThrow('Memory tags must be 50 characters or fewer.');
	});

	test('preserves existing tags when update omits tags', () => {
		repo.write({
			spaceId: 'space-a',
			key: 'conventions.api',
			content: 'Original content.',
			tags: ['api', 'http'],
		});

		const updated = repo.write({
			spaceId: 'space-a',
			key: 'conventions.api',
			content: 'Updated content without tag changes.',
		});

		expect(updated.content).toBe('Updated content without tag changes.');
		expect(updated.tags).toEqual(['api', 'http']);
	});

	test('clears tags when update explicitly passes empty array', () => {
		repo.write({
			spaceId: 'space-a',
			key: 'conventions.lint',
			content: 'Original.',
			tags: ['lint'],
		});

		const updated = repo.write({
			spaceId: 'space-a',
			key: 'conventions.lint',
			content: 'Original.',
			tags: [],
		});

		expect(updated.tags).toEqual([]);
	});

	test('keeps original creator session when later sessions update', () => {
		repo.write({
			spaceId: 'space-a',
			key: 'conventions.auth',
			content: 'Initial note.',
			createdBySession: 'session-original',
		});

		const updated = repo.write({
			spaceId: 'space-a',
			key: 'conventions.auth',
			content: 'Revised note.',
			createdBySession: 'session-later',
		});

		expect(updated.createdBySession).toBe('session-original');
	});

	test('search matches path identifiers', async () => {
		repo.write({
			spaceId: 'space-a',
			key: 'modules.entry',
			content: 'Entry point is src/lib/main.ts.',
		});

		const results = await repo.search('space-a', 'src/lib/main.ts', 5);
		expect(results.map((result) => result.memory.key)).toEqual(['modules.entry']);
	});

	test('filtered list honors limit and offset above search limit', async () => {
		for (let index = 0; index < 25; index++) {
			repo.write({
				spaceId: 'space-a',
				key: `memory.${index.toString().padStart(2, '0')}`,
				content: `Shared pagination topic ${index}`,
			});
		}

		const firstPage = await repo.list('space-a', { query: 'pagination topic', limit: 25 });
		const secondPage = await repo.list('space-a', {
			query: 'pagination topic',
			limit: 5,
			offset: 5,
		});

		expect(firstPage).toHaveLength(25);
		expect(secondPage).toHaveLength(5);
		expect(secondPage.map((memory) => memory.key)).toEqual(
			firstPage.slice(5, 10).map((memory) => memory.key)
		);
	});

	test('search orders by FTS rank before recency', async () => {
		repo.write({
			spaceId: 'space-a',
			key: 'focused',
			content: 'Preact preact preact signals signals signals.',
		});
		repo.write({
			spaceId: 'space-a',
			key: 'recent',
			content: 'Preact signals mixed with unrelated routing and styling notes.',
		});

		const results = await repo.search('space-a', 'preact signals', 1);
		expect(results.map((result) => result.memory.key)).toEqual(['focused']);
		expect(results[0].rank).not.toBe(1000);
	});

	test('search matches hyphenated identifiers', async () => {
		repo.write({
			spaceId: 'space-a',
			key: 'tooling.hooks',
			content: 'Run pre-commit before pushing.',
		});

		const results = await repo.search('space-a', 'pre-commit', 5);
		expect(results.map((result) => result.memory.key)).toEqual(['tooling.hooks']);
	});

	test('search matches memory keys', async () => {
		repo.write({
			spaceId: 'space-a',
			key: 'conventions.forms',
			content: 'Use zod schemas.',
		});

		const results = await repo.search('space-a', 'conventions.forms', 5);
		expect(results.map((result) => result.memory.key)).toEqual(['conventions.forms']);
	});

	test('access updates do not rewrite FTS rows', async () => {
		repo.write({
			spaceId: 'space-a',
			key: 'access.fts',
			content: 'Keep access telemetry cheap.',
		});
		const before = db
			.prepare(`SELECT count(*) AS count FROM space_agent_memory_fts_data`)
			.get() as {
			count: number;
		};

		repo.read('space-a', 'access.fts');
		await repo.search('space-a', 'telemetry', 5);

		const after = db.prepare(`SELECT count(*) AS count FROM space_agent_memory_fts_data`).get() as {
			count: number;
		};
		expect(after.count).toBe(before.count);
	});

	test('delete removes memory from FTS index', async () => {
		repo.write({ spaceId: 'space-a', key: 'obsolete', content: 'Old Flowbite convention.' });
		expect(await repo.search('space-a', 'Flowbite', 10)).toHaveLength(1);

		expect(repo.delete('space-a', 'obsolete')).toBe(true);
		expect(repo.read('space-a', 'obsolete')).toBeNull();
		expect(await repo.search('space-a', 'Flowbite', 10)).toHaveLength(0);
	});

	test('semantic paraphrase query finds memory with zero keyword overlap', async () => {
		repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());
		repo.write({
			spaceId: 'space-a',
			key: 'cleanup.sessions',
			content: 'Delete stale session records after retention expires.',
		});
		repo.write({
			spaceId: 'space-a',
			key: 'auth.tokens',
			content: 'Store credential material only in secure storage.',
		});

		const vectorCount = db.prepare(`SELECT count(*) AS count FROM memory_vectors`).get() as {
			count: number;
		};
		const fkCheck = db.prepare(`PRAGMA foreign_key_check(memory_vectors)`).all();
		const results = await repo.search('space-a', 'erase old conversation data', 5);

		expect(vectorCount.count).toBe(2);
		expect(fkCheck).toEqual([]);
		expect(results.map((result) => result.memory.key)).toContain('cleanup.sessions');
		expect(results[0].memory.key).toBe('cleanup.sessions');
	});

	test('pending entries still appear in FTS results while embedding is incomplete', async () => {
		repo.write({
			spaceId: 'space-a',
			key: 'pending.memory',
			content: 'Pending embedding still searchable through lexical fallback.',
		});

		const row = db
			.prepare(`SELECT embedding_status FROM space_agent_memory WHERE space_id = ? AND key = ?`)
			.get('space-a', 'pending.memory') as { embedding_status: string };
		expect(row.embedding_status).toBe('pending');
		const results = await repo.search('space-a', 'lexical fallback', 5);
		expect(results.map((result) => result.memory.key)).toEqual(['pending.memory']);
	});

	test('query embedding failures fall back to FTS results', async () => {
		repo = new AgentMemoryRepository(db, undefined, new QueryFailingEmbedder());
		repo.write({
			spaceId: 'space-a',
			key: 'fallback.memory',
			content: 'Lexical fallback survives query embedding failure.',
		});

		const results = await repo.search('space-a', 'lexical fallback', 5);

		expect(results.map((result) => result.memory.key)).toEqual(['fallback.memory']);
	});

	test('sync passage embedding failures do not abort writes', () => {
		repo = new AgentMemoryRepository(db, undefined, new SyncThrowingEmbedder());
		const memory = repo.write({
			spaceId: 'space-a',
			key: 'sync.failure',
			content: 'Synchronous embedding failures should keep lexical memory.',
		});

		expect(memory.key).toBe('sync.failure');
		const row = db
			.prepare(
				`SELECT embedding_status, embedding_error FROM space_agent_memory WHERE space_id = ? AND key = ?`
			)
			.get('space-a', 'sync.failure') as {
			embedding_status: string;
			embedding_error: string;
		};
		expect(row.embedding_status).toBe('failed');
		expect(row.embedding_error).toContain('sync embedding unavailable');
	});

	test('uses passage embeddings for memories and query embeddings for searches', async () => {
		const embedder = new TrackingEmbedder();
		repo = new AgentMemoryRepository(db, undefined, embedder);
		repo.write({
			spaceId: 'space-a',
			key: 'embedding.kind',
			content: 'Delete stale session records after retention expires.',
		});

		await repo.search('space-a', 'erase old conversation data', 5);

		expect(embedder.passageTexts).toEqual([
			'embedding.kind\nDelete stale session records after retention expires.',
		]);
		expect(embedder.queryTexts).toEqual(['erase old conversation data']);
	});

	test('backfills pending legacy memories', async () => {
		repo.write({
			spaceId: 'space-a',
			key: 'legacy.memory',
			content: 'Delete stale session records after retention expires.',
		});
		repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());

		repo.backfillPendingEmbeddings();

		const results = await repo.search('space-a', 'erase old conversation data', 5);
		expect(results.map((result) => result.memory.key)).toEqual(['legacy.memory']);
	});

	test('vector search preserves space isolation', async () => {
		repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());
		repo.write({
			spaceId: 'space-a',
			key: 'cleanup.local',
			content: 'Delete stale session records after retention expires.',
		});
		repo.write({
			spaceId: 'space-b',
			key: 'cleanup.other',
			content: 'Delete stale session records after retention expires.',
		});

		const results = await repo.search('space-a', 'erase old conversation data', 5);

		expect(results.map((result) => result.memory.key)).toEqual(['cleanup.local']);
	});

	test('semantic search awaits async query embeddings', async () => {
		repo = new AgentMemoryRepository(db, undefined, new AsyncKeywordEmbedder());
		repo.write({
			spaceId: 'space-a',
			key: 'cleanup.async',
			content: 'Delete stale session records after retention expires.',
		});
		await flushPromises();

		const results = await repo.search('space-a', 'erase old conversation data', 5);

		expect(results.map((result) => result.memory.key)).toEqual(['cleanup.async']);
	});

	test('stale async embeddings do not overwrite newer content', async () => {
		const embedder = new DeferredKeywordEmbedder();
		repo = new AgentMemoryRepository(db, undefined, embedder);
		db.transaction(() => {
			repo.write({
				spaceId: 'space-a',
				key: 'changing.memory',
				content: 'Delete stale session records after retention expires.',
			});
			repo.write({
				spaceId: 'space-a',
				key: 'changing.memory',
				content: 'Store credential material only in secure storage.',
			});
		})();

		embedder.resolveNext();
		await flushPromises();
		embedder.resolveNext();
		await flushPromises();
		embedder.resolveNext();

		const vectorRow = db
			.prepare(`SELECT embedding FROM memory_vectors WHERE memory_id = 1`)
			.get() as {
			embedding: Buffer;
		};
		expect(new Float32Array(vectorRow.embedding.buffer, vectorRow.embedding.byteOffset, 3)).toEqual(
			keywordVector('Store credential material only in secure storage.')
		);
		const row = db
			.prepare(`SELECT embedding_revision FROM space_agent_memory WHERE space_id = ? AND key = ?`)
			.get('space-a', 'changing.memory') as { embedding_revision: number };
		expect(row.embedding_revision).toBe(2);
	});

	test('embedding failures are persisted', async () => {
		repo = new AgentMemoryRepository(db, undefined, new FailingEmbedder());
		repo.write({
			spaceId: 'space-a',
			key: 'failing.memory',
			content: 'Embedding provider failure should be visible.',
		});
		await flushPromises();

		const row = db
			.prepare(
				`SELECT embedding_status, embedding_error FROM space_agent_memory WHERE space_id = ? AND key = ?`
			)
			.get('space-a', 'failing.memory') as {
			embedding_status: string;
			embedding_error: string;
		};
		expect(row.embedding_status).toBe('failed');
		expect(row.embedding_error).toContain('embedding unavailable');
	});

	test('semantic search skips vectors from different embedding models', async () => {
		repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());
		repo.write({
			spaceId: 'space-a',
			key: 'cleanup.model',
			content: 'Delete stale session records after retention expires.',
		});
		db.prepare(`UPDATE memory_vectors SET model = ? WHERE memory_id = 1`).run('old-model');

		const results = await repo.search('space-a', 'erase old conversation data', 5);

		expect(results).toHaveLength(0);
	});

	test('vector search ranks ready vectors beyond the first 100 rows', async () => {
		repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());
		for (let index = 0; index < 120; index++) {
			repo.write({
				spaceId: 'space-a',
				key: `memory.${index.toString().padStart(3, '0')}`,
				content:
					index === 119
						? 'Delete stale session records after retention expires.'
						: `Unrelated memory ${index}`,
			});
		}

		const results = await repo.search('space-a', 'erase old conversation data', 5);

		expect(results.map((result) => result.memory.key)).toContain('memory.119');
	});

	test('filtered list supports offsets beyond 100 matches', async () => {
		for (let index = 0; index < 130; index++) {
			repo.write({
				spaceId: 'space-a',
				key: `pagination.${index.toString().padStart(3, '0')}`,
				content: `Shared pagination topic ${index}`,
			});
		}

		const page = await repo.list('space-a', { query: 'pagination topic', limit: 10, offset: 110 });

		expect(page).toHaveLength(10);
	});
});
