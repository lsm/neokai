import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { runMigration128 } from '../../../../../src/storage/schema/index.ts';

let db: Database;

beforeEach(() => {
	db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			workspace_path TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
});

describe('Migration 128: external event extension config tables', () => {
	test('creates global source config table with expected columns', () => {
		runMigration128(db);

		const columns = columnNames('external_event_source_configs');
		expect(columns).toEqual([
			'source',
			'globally_enabled',
			'capabilities_json',
			'secrets_ref',
			'settings_json',
			'created_at',
			'updated_at',
		]);
	});

	test('creates per-space source config table with cascading space foreign key', () => {
		runMigration128(db);

		const columns = columnNames('space_external_event_source_configs');
		expect(columns).toEqual([
			'space_id',
			'source',
			'enabled',
			'settings_json',
			'created_at',
			'updated_at',
		]);

		const fks = db
			.prepare(`PRAGMA foreign_key_list('space_external_event_source_configs')`)
			.all() as Array<{
			from: string;
			table: string;
			to: string;
			on_delete: string;
		}>;
		expect(fks).toContainEqual(
			expect.objectContaining({
				from: 'space_id',
				table: 'spaces',
				to: 'id',
				on_delete: 'CASCADE',
			})
		);
	});

	test('is idempotent', () => {
		runMigration128(db);
		expect(() => runMigration128(db)).not.toThrow();
	});
});

function columnNames(table: string): string[] {
	const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
	return rows.map((row) => row.name);
}
