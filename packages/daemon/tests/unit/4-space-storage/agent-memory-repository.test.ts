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

	test('delete removes memory from FTS index', () => {
		repo.write({ spaceId: 'space-a', key: 'obsolete', content: 'Old Flowbite convention.' });
		expect(repo.search('space-a', 'Flowbite', 10)).toHaveLength(1);

		expect(repo.delete('space-a', 'obsolete')).toBe(true);
		expect(repo.read('space-a', 'obsolete')).toBeNull();
		expect(repo.search('space-a', 'Flowbite', 10)).toHaveLength(0);
	});
});
