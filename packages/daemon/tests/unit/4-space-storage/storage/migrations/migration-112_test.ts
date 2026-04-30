import { Database as BunDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { runMigration111, runMigration112 } from '../../../../../src/storage/schema';

function insertGitHubEvent(db: BunDatabase, id: string, dedupeKey: string): void {
	db.prepare(
		`INSERT INTO space_github_events (
			id, space_id, source, delivery_id, event_type, action, repo_owner, repo_name,
			pr_number, pr_url, actor, actor_type, body, summary, external_url, external_id,
			occurred_at, dedupe_key, raw_payload, state, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		'space-1',
		'webhook',
		`delivery-${id}`,
		'pull_request',
		'synchronize',
		'MyOrg',
		'MyRepo',
		7,
		'https://github.com/MyOrg/MyRepo/pull/7',
		'dev',
		'User',
		'',
		'PR update',
		'https://github.com/MyOrg/MyRepo/pull/7',
		'pull_request:77:synchronize:delivery-1',
		1,
		dedupeKey,
		'{}',
		'received',
		1,
		1
	);
}

describe('Migration 112', () => {
	test('normalizes existing Space GitHub dedupe keys to lowercase', () => {
		const db = new BunDatabase(':memory:');
		runMigration111(db);

		insertGitHubEvent(db, 'event-1', 'MyOrg/MyRepo:pull_request:77:synchronize:delivery-1');

		runMigration112(db);
		runMigration112(db);

		expect(db.prepare(`SELECT dedupe_key FROM space_github_events`).get()).toEqual({
			dedupe_key: 'myorg/myrepo:pull_request:77:synchronize:delivery-1',
		});
	});

	test('dedupes mixed-case rows when lowercase counterpart already exists', () => {
		const db = new BunDatabase(':memory:');
		runMigration111(db);
		insertGitHubEvent(db, 'event-old', 'MyOrg/MyRepo:pull_request:77:synchronize:delivery-1');
		insertGitHubEvent(db, 'event-new', 'myorg/myrepo:pull_request:77:synchronize:delivery-1');

		expect(() => runMigration112(db)).not.toThrow();

		expect(db.prepare(`SELECT COUNT(*) AS c FROM space_github_events`).get()).toEqual({ c: 1 });
		expect(db.prepare(`SELECT dedupe_key FROM space_github_events`).get()).toEqual({
			dedupe_key: 'myorg/myrepo:pull_request:77:synchronize:delivery-1',
		});
	});

	test('is safe when Space GitHub events table is absent', () => {
		const db = new BunDatabase(':memory:');
		expect(() => runMigration112(db)).not.toThrow();
	});
});
