import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { AgentMemoryRepository } from '../../../src/storage/repositories/agent-memory-repository.ts';

let db: BunDatabase;
let repo: AgentMemoryRepository;

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

	test('writes and reads memory by space/key', () => {
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
		expect(repo.list('space-a')).toHaveLength(1);

		const read = repo.read('space-a', 'conventions.test');
		expect(read?.content).toBe('Use Bun native tests for daemon code.');
		expect(read?.createdBySession).toBe('session-1');
	});

	test('search returns FTS-ranked results', () => {
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

		const results = repo.search('space-a', 'preact signals', 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].memory.key).toBe('preact');
		expect(results[0].rank).toBeTypeOf('number');
	});

	test('search is scoped by space', () => {
		repo.write({ spaceId: 'space-a', key: 'shared', content: 'Use tabs for formatting.' });
		repo.write({ spaceId: 'space-b', key: 'shared', content: 'Use spaces for formatting.' });

		const results = repo.search('space-a', 'formatting', 10);
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

	test('search matches path identifiers', () => {
		repo.write({
			spaceId: 'space-a',
			key: 'modules.entry',
			content: 'Entry point is src/lib/main.ts.',
		});

		const results = repo.search('space-a', 'src/lib/main.ts', 5);
		expect(results.map((result) => result.memory.key)).toEqual(['modules.entry']);
	});

	test('filtered list honors limit and offset above search limit', () => {
		for (let index = 0; index < 25; index++) {
			repo.write({
				spaceId: 'space-a',
				key: `memory.${index.toString().padStart(2, '0')}`,
				content: `Shared pagination topic ${index}`,
			});
		}

		const firstPage = repo.list('space-a', { query: 'pagination topic', limit: 25 });
		const secondPage = repo.list('space-a', { query: 'pagination topic', limit: 5, offset: 5 });

		expect(firstPage).toHaveLength(25);
		expect(secondPage).toHaveLength(5);
		expect(secondPage.map((memory) => memory.key)).toEqual(
			firstPage.slice(5, 10).map((memory) => memory.key)
		);
	});

	test('search orders by FTS rank before recency', () => {
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

		const results = repo.search('space-a', 'preact signals', 1);
		expect(results.map((result) => result.memory.key)).toEqual(['focused']);
		expect(results[0].rank).not.toBe(1000);
	});

	test('search matches hyphenated identifiers', () => {
		repo.write({
			spaceId: 'space-a',
			key: 'tooling.hooks',
			content: 'Run pre-commit before pushing.',
		});

		const results = repo.search('space-a', 'pre-commit', 5);
		expect(results.map((result) => result.memory.key)).toEqual(['tooling.hooks']);
	});

	test('search matches memory keys', () => {
		repo.write({
			spaceId: 'space-a',
			key: 'conventions.forms',
			content: 'Use zod schemas.',
		});

		const results = repo.search('space-a', 'conventions.forms', 5);
		expect(results.map((result) => result.memory.key)).toEqual(['conventions.forms']);
	});

	test('access updates do not rewrite FTS rows', () => {
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
		repo.search('space-a', 'telemetry', 5);

		const after = db.prepare(`SELECT count(*) AS count FROM space_agent_memory_fts_data`).get() as {
			count: number;
		};
		expect(after.count).toBe(before.count);
	});

	test('delete removes memory from FTS index', () => {
		repo.write({ spaceId: 'space-a', key: 'obsolete', content: 'Old Flowbite convention.' });
		expect(repo.search('space-a', 'Flowbite', 10)).toHaveLength(1);

		expect(repo.delete('space-a', 'obsolete')).toBe(true);
		expect(repo.read('space-a', 'obsolete')).toBeNull();
		expect(repo.search('space-a', 'Flowbite', 10)).toHaveLength(0);
	});
});
