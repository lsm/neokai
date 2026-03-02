/**
 * LiveQueryEngine Tests
 *
 * Unit tests for LiveQueryEngine: initial snapshots, insert/update/delete deltas,
 * multi-subscriber behaviour, handle disposal, engine disposal, and version tracking.
 *
 * These tests use a real BunDatabase in-memory and a lightweight mock ReactiveDatabase
 * built on EventEmitter so we have direct control over when change events fire.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Database as BunDatabase } from 'bun:sqlite';
import { LiveQueryEngine } from '../../../src/storage/live-query';
import type { QueryDiff } from '../../../src/storage/live-query';

// ---------------------------------------------------------------------------
// Mock ReactiveDatabase
// ---------------------------------------------------------------------------

interface MockReactiveDatabase {
	on(event: 'change', listener: (data: { tables: string[]; versions: Record<string, number> }) => void): void;
	off(event: string, listener: (...args: unknown[]) => void): void;
	getTableVersion(table: string): number;
	/** Test helper — fire a synthetic change event for the given tables. */
	fireChange(tables: string[]): void;
	/** Test helper — bump + fire change for a table. */
	bumpAndFire(table: string): void;
}

function createMockReactiveDatabase(): MockReactiveDatabase {
	const emitter = new EventEmitter();
	const versions: Record<string, number> = {};

	return {
		on(event: 'change', listener: (data: { tables: string[]; versions: Record<string, number> }) => void): void {
			emitter.on(event, listener);
		},
		off(event: string, listener: (...args: unknown[]) => void): void {
			emitter.off(event, listener);
		},
		getTableVersion(table: string): number {
			return versions[table] ?? 0;
		},
		fireChange(tables: string[]): void {
			const v: Record<string, number> = {};
			for (const t of tables) {
				v[t] = versions[t] ?? 0;
			}
			emitter.emit('change', { tables, versions: v });
		},
		bumpAndFire(table: string): void {
			versions[table] = (versions[table] ?? 0) + 1;
			this.fireChange([table]);
		},
	};
}

// ---------------------------------------------------------------------------
// Table setup helpers
// ---------------------------------------------------------------------------

function createTestDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec(`
		CREATE TABLE items (
			id   TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			val  INTEGER DEFAULT 0
		);
		CREATE TABLE other (
			id TEXT PRIMARY KEY,
			note TEXT
		);
	`);
	return db;
}

function insertItem(db: BunDatabase, id: string, name: string, val = 0): void {
	db.exec(`INSERT INTO items (id, name, val) VALUES ('${id}', '${name}', ${val})`);
}

function updateItem(db: BunDatabase, id: string, name: string, val: number): void {
	db.exec(`UPDATE items SET name = '${name}', val = ${val} WHERE id = '${id}'`);
}

function deleteItem(db: BunDatabase, id: string): void {
	db.exec(`DELETE FROM items WHERE id = '${id}'`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveQueryEngine', () => {
	let db: BunDatabase;
	let mockReactive: MockReactiveDatabase;
	let engine: LiveQueryEngine;

	const SQL = 'SELECT id, name, val FROM items ORDER BY id';

	beforeEach(() => {
		db = createTestDb();
		mockReactive = createMockReactiveDatabase();
		engine = new LiveQueryEngine(db, mockReactive as Parameters<typeof LiveQueryEngine['prototype']['subscribe']>[2] extends never ? never : any);
	});

	afterEach(() => {
		engine.dispose();
		db.close();
	});

	// -------------------------------------------------------------------------
	// Initial snapshot
	// -------------------------------------------------------------------------

	describe('subscribe — initial snapshot', () => {
		test('delivers snapshot immediately on subscribe with empty table', () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			expect(diffs.length).toBe(1);
			expect(diffs[0].type).toBe('snapshot');
			expect(diffs[0].rows).toEqual([]);
		});

		test('snapshot contains existing rows when table already has data', () => {
			insertItem(db, 'a', 'Alpha', 1);
			insertItem(db, 'b', 'Beta', 2);

			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			expect(diffs[0].type).toBe('snapshot');
			expect(diffs[0].rows.length).toBe(2);
			expect(diffs[0].rows[0].id).toBe('a');
			expect(diffs[0].rows[1].id).toBe('b');
		});

		test('snapshot version is 0 when table version is 0', () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			expect(diffs[0].version).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// INSERT delta
	// -------------------------------------------------------------------------

	describe('INSERT triggers delta', () => {
		test('delta has type=delta after insert', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			insertItem(db, 'c', 'Charlie', 3);
			mockReactive.bumpAndFire('items');

			await Promise.resolve(); // flush microtask

			expect(diffs.length).toBe(2);
			expect(diffs[1].type).toBe('delta');
		});

		test('delta added contains the new row', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			insertItem(db, 'd', 'Delta', 4);
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			const delta = diffs[1];
			expect(delta.added?.length).toBe(1);
			expect(delta.added?.[0].id).toBe('d');
			expect(delta.added?.[0].name).toBe('Delta');
			expect(delta.added?.[0].val).toBe(4);
		});

		test('delta rows contains all current rows after insert', async () => {
			insertItem(db, 'e', 'Echo', 5);
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			insertItem(db, 'f', 'Foxtrot', 6);
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			expect(diffs[1].rows.length).toBe(2);
		});

		test('handle.get() returns updated rows after insert delta', async () => {
			const handle = engine.subscribe(SQL, [], () => {});

			insertItem(db, 'g', 'Golf', 7);
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			expect(handle.get().length).toBe(1);
			expect(handle.get()[0].id).toBe('g');
		});
	});

	// -------------------------------------------------------------------------
	// UPDATE delta
	// -------------------------------------------------------------------------

	describe('UPDATE triggers delta', () => {
		test('delta updated contains the modified row', async () => {
			insertItem(db, 'h', 'Hotel', 8);
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			updateItem(db, 'h', 'Hotel-Updated', 99);
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			const delta = diffs[1];
			expect(delta.type).toBe('delta');
			expect(delta.updated?.length).toBe(1);
			expect(delta.updated?.[0].name).toBe('Hotel-Updated');
			expect(delta.updated?.[0].val).toBe(99);
		});

		test('delta added and removed are empty on pure update', async () => {
			insertItem(db, 'i', 'India', 9);
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			updateItem(db, 'i', 'India-New', 10);
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			const delta = diffs[1];
			expect(delta.added).toEqual([]);
			expect(delta.removed).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// DELETE delta
	// -------------------------------------------------------------------------

	describe('DELETE triggers delta', () => {
		test('delta removed contains the deleted row', async () => {
			insertItem(db, 'j', 'Juliet', 10);
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			deleteItem(db, 'j');
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			const delta = diffs[1];
			expect(delta.type).toBe('delta');
			expect(delta.removed?.length).toBe(1);
			expect(delta.removed?.[0].id).toBe('j');
		});

		test('delta rows is empty after deleting the only row', async () => {
			insertItem(db, 'k', 'Kilo', 11);
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			deleteItem(db, 'k');
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			expect(diffs[1].rows).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// No callback when result unchanged
	// -------------------------------------------------------------------------

	describe('no callback on unrelated table change', () => {
		test('writing to an unrelated table does NOT trigger a delta', async () => {
			insertItem(db, 'l', 'Lima', 12);
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			// Write to `other` table — query watches `items` only
			db.exec(`INSERT INTO other (id, note) VALUES ('x', 'unrelated')`);
			mockReactive.bumpAndFire('other');

			await Promise.resolve();

			// Only the initial snapshot, no delta
			expect(diffs.length).toBe(1);
		});

		test('change event for items table but no data change does NOT trigger a delta', async () => {
			insertItem(db, 'm', 'Mike', 13);
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			// Fire change event without actually modifying the data
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			// Hash-based dedup: result is identical, so no delta
			expect(diffs.length).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Multiple subscribers
	// -------------------------------------------------------------------------

	describe('multiple subscribers', () => {
		test('two subscribers to same query both receive initial snapshot', () => {
			const diffs1: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const diffs2: QueryDiff<{ id: string; name: string; val: number }>[] = [];

			engine.subscribe(SQL, [], (diff) => diffs1.push(diff));
			engine.subscribe(SQL, [], (diff) => diffs2.push(diff));

			expect(diffs1.length).toBe(1);
			expect(diffs2.length).toBe(1);
			expect(diffs1[0].type).toBe('snapshot');
			expect(diffs2[0].type).toBe('snapshot');
		});

		test('both subscribers receive delta after insert', async () => {
			const diffs1: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const diffs2: QueryDiff<{ id: string; name: string; val: number }>[] = [];

			engine.subscribe(SQL, [], (diff) => diffs1.push(diff));
			engine.subscribe(SQL, [], (diff) => diffs2.push(diff));

			insertItem(db, 'n', 'November', 14);
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			expect(diffs1.length).toBe(2);
			expect(diffs2.length).toBe(2);
			expect(diffs1[1].type).toBe('delta');
			expect(diffs2[1].type).toBe('delta');
		});

		test('different queries with overlapping tables each get their own callbacks', async () => {
			const sqlAll = 'SELECT id, name, val FROM items ORDER BY id';
			const sqlFiltered = 'SELECT id, name, val FROM items WHERE val > 50 ORDER BY id';

			const allDiffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const filteredDiffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];

			engine.subscribe(sqlAll, [], (diff) => allDiffs.push(diff));
			engine.subscribe(sqlFiltered, [], (diff) => filteredDiffs.push(diff));

			// Insert low-val row — matches all but not filtered
			insertItem(db, 'o', 'Oscar', 5);
			mockReactive.bumpAndFire('items');
			await Promise.resolve();

			expect(allDiffs.length).toBe(2); // snapshot + delta
			expect(filteredDiffs.length).toBe(1); // only snapshot; no data change for that query
		});
	});

	// -------------------------------------------------------------------------
	// Handle disposal
	// -------------------------------------------------------------------------

	describe('handle.dispose()', () => {
		test('disposed handle no longer receives deltas', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const handle = engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			handle.dispose();

			insertItem(db, 'p', 'Papa', 16);
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			// Only initial snapshot; no delta after dispose
			expect(diffs.length).toBe(1);
		});

		test('disposing one handle does not affect another subscriber', async () => {
			const diffs1: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const diffs2: QueryDiff<{ id: string; name: string; val: number }>[] = [];

			const handle1 = engine.subscribe(SQL, [], (diff) => diffs1.push(diff));
			engine.subscribe(SQL, [], (diff) => diffs2.push(diff));

			handle1.dispose();

			insertItem(db, 'q', 'Quebec', 17);
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			expect(diffs1.length).toBe(1); // only snapshot
			expect(diffs2.length).toBe(2); // snapshot + delta
		});
	});

	// -------------------------------------------------------------------------
	// Engine disposal
	// -------------------------------------------------------------------------

	describe('LiveQueryEngine.dispose()', () => {
		test('disposed engine does not deliver further deltas', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			engine.dispose();

			insertItem(db, 'r', 'Romeo', 18);
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			expect(diffs.length).toBe(1); // only initial snapshot
		});

		test('engine.dispose() stops listening even if change events continue to fire', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			engine.dispose();

			// Fire multiple change events after dispose
			mockReactive.bumpAndFire('items');
			mockReactive.bumpAndFire('items');
			mockReactive.bumpAndFire('items');

			await Promise.resolve();

			expect(diffs.length).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Version in diffs
	// -------------------------------------------------------------------------

	describe('version in diffs', () => {
		test('delta version reflects ReactiveDatabase table version at evaluation time', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			insertItem(db, 's', 'Sierra', 19);
			mockReactive.bumpAndFire('items'); // bumps to 1

			await Promise.resolve();

			expect(diffs[1].version).toBe(1);
		});

		test('version increases with successive writes', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL, [], (diff) => diffs.push(diff));

			insertItem(db, 't', 'Tango', 20);
			mockReactive.bumpAndFire('items'); // v=1
			await Promise.resolve();

			insertItem(db, 'u', 'Uniform', 21);
			mockReactive.bumpAndFire('items'); // v=2
			await Promise.resolve();

			expect(diffs[1].version).toBe(1);
			expect(diffs[2].version).toBe(2);
		});
	});

	// -------------------------------------------------------------------------
	// Parameterised queries
	// -------------------------------------------------------------------------

	describe('parameterised queries', () => {
		test('query with parameter only reacts to matching rows', async () => {
			const sqlParam = 'SELECT id, name, val FROM items WHERE val > ? ORDER BY id';

			insertItem(db, 'v', 'Victor', 5);
			insertItem(db, 'w', 'Whiskey', 50);

			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(sqlParam, [10], (diff) => diffs.push(diff));

			// Only 'w' with val=50 matches val > 10
			expect(diffs[0].rows.length).toBe(1);
			expect(diffs[0].rows[0].id).toBe('w');
		});

		test('two subscriptions to same SQL with different params are independent', async () => {
			const sqlParam = 'SELECT id, name, val FROM items WHERE val > ? ORDER BY id';
			insertItem(db, 'x', 'Xray', 100);

			const difsLow: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const difsHigh: QueryDiff<{ id: string; name: string; val: number }>[] = [];

			engine.subscribe(sqlParam, [10], (diff) => difsLow.push(diff));
			engine.subscribe(sqlParam, [200], (diff) => difsHigh.push(diff));

			// Low threshold: x (100) matches
			expect(difsLow[0].rows.length).toBe(1);
			// High threshold: x (100) does not match 200
			expect(difsHigh[0].rows.length).toBe(0);
		});
	});
});
