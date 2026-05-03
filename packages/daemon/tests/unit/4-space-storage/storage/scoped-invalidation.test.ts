/**
 * Scoped Invalidation Tests
 *
 * Tests for the scoped invalidation feature:
 *   - ReactiveDatabase carries scope in change events
 *   - LiveQueryEngine skips re-evaluation for scope-mismatched queries
 *   - Fallback to table-wide invalidation when scope is unknown
 *   - Transaction batching preserves scope
 *   - Instrumentation stats are accurate
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Database as BunDatabase } from 'bun:sqlite';
import { LiveQueryEngine, computeDiff, extractTables } from '../../../../src/storage/live-query';
import type { QueryDiff, ScopeExtractor } from '../../../../src/storage/live-query';
import type { TableChangeScope } from '../../../../src/storage/reactive-database';

// ---------------------------------------------------------------------------
// Mock ReactiveDatabase with scope support
// ---------------------------------------------------------------------------

interface MockReactiveDatabase {
	on(
		event: 'change',
		listener: (data: {
			tables: string[];
			versions: Record<string, number>;
			scope?: TableChangeScope;
		}) => void
	): void;
	off(event: string, listener: (...args: unknown[]) => void): void;
	getTableVersion(table: string): number;
	/** Test helper — fire a synthetic change event for the given tables. */
	fireChange(tables: string[], scope?: TableChangeScope): void;
	/** Test helper — bump + fire change for a table. */
	bumpAndFire(table: string, scope?: TableChangeScope): void;
}

function createMockReactiveDatabase(): MockReactiveDatabase {
	const emitter = new EventEmitter();
	const versions: Record<string, number> = {};

	return {
		on(
			event: 'change',
			listener: (data: {
				tables: string[];
				versions: Record<string, number>;
				scope?: TableChangeScope;
			}) => void
		): void {
			emitter.on(event, listener);
		},
		off(event: string, listener: (...args: unknown[]) => void): void {
			emitter.off(event, listener);
		},
		getTableVersion(table: string): number {
			return versions[table] ?? 0;
		},
		fireChange(tables: string[], scope?: TableChangeScope): void {
			const v: Record<string, number> = {};
			for (const t of tables) {
				v[t] = versions[t] ?? 0;
			}
			emitter.emit('change', { tables, versions: v, scope });
		},
		bumpAndFire(table: string, scope?: TableChangeScope): void {
			versions[table] = (versions[table] ?? 0) + 1;
			this.fireChange([table], scope);
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
			val  INTEGER DEFAULT 0,
			owner TEXT
		);
	`);
	return db;
}

function insertItem(db: BunDatabase, id: string, name: string, val = 0, owner = 'default'): void {
	db.exec(
		`INSERT INTO items (id, name, val, owner) VALUES ('${id}', '${name}', ${val}, '${owner}')`
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scoped Invalidation', () => {
	let db: BunDatabase;
	let mockReactive: MockReactiveDatabase;
	let engine: LiveQueryEngine;

	const SQL_ALL = 'SELECT id, name, val FROM items ORDER BY id';
	const SQL_BY_OWNER = 'SELECT id, name, val FROM items WHERE owner = ? ORDER BY id';

	// Scope extractor that extracts `owner` from params[0]
	const ownerScopeExtractor: ScopeExtractor = (params) => ({ sessionId: params[0] as string });

	beforeEach(() => {
		db = createTestDb();
		mockReactive = createMockReactiveDatabase();
		engine = new LiveQueryEngine(db, mockReactive as any);
	});

	afterEach(() => {
		engine.dispose();
		db.close();
	});

	// -------------------------------------------------------------------------
	// Scope filtering — core behaviour
	// -------------------------------------------------------------------------

	describe('scope filtering', () => {
		test('scoped query is NOT re-evaluated when scope does not match', async () => {
			// Subscribe to items for owner=A
			const diffsA: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffsA.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});

			// Subscribe to items for owner=B
			const diffsB: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL_BY_OWNER, ['B'], (diff) => diffsB.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});

			expect(diffsA.length).toBe(1); // snapshot
			expect(diffsB.length).toBe(1); // snapshot

			// Insert item for owner A, fire event scoped to session A
			insertItem(db, 'item-a', 'ItemA', 1, 'A');
			mockReactive.bumpAndFire('items', { sessionId: 'A' });

			await Promise.resolve();

			// Query A should be re-evaluated (scope matches)
			expect(diffsA.length).toBe(2);
			expect(diffsA[1].type).toBe('delta');

			// Query B should NOT be re-evaluated (scope mismatch)
			expect(diffsB.length).toBe(1); // still only snapshot
		});

		test('scoped query IS re-evaluated when scope matches', async () => {
			insertItem(db, 'existing', 'Existing', 1, 'A');

			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffs.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});

			expect(diffs.length).toBe(1);
			expect(diffs[0].rows.length).toBe(1);

			// Insert another item for owner A
			insertItem(db, 'new-a', 'NewA', 2, 'A');
			mockReactive.bumpAndFire('items', { sessionId: 'A' });

			await Promise.resolve();

			expect(diffs.length).toBe(2);
			expect(diffs[1].type).toBe('delta');
			expect(diffs[1].added?.length).toBe(1);
			expect(diffs[1].added?.[0].id).toBe('new-a');
		});

		test('unscoped query (no scopeExtractor) IS always re-evaluated', async () => {
			const diffsAll: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL_ALL, [], (diff) => diffsAll.push(diff)); // no scopeExtractor

			insertItem(db, 'x', 'X', 1, 'A');
			mockReactive.bumpAndFire('items', { sessionId: 'A' });

			await Promise.resolve();

			// Unscoped query is always re-evaluated regardless of event scope
			expect(diffsAll.length).toBe(2);
			expect(diffsAll[1].type).toBe('delta');
		});

		test('scoped event without scopeExtractor falls back to table-wide', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffs.push(diff)); // no scopeExtractor

			// Event scoped to A, query also watches A — should re-evaluate even without scopeExtractor
			insertItem(db, 'item-a', 'ItemA', 1, 'A');
			mockReactive.bumpAndFire('items', { sessionId: 'A' });

			await Promise.resolve();

			// No scopeExtractor → always re-evaluate → data changed for A → delta emitted
			expect(diffs.length).toBe(2);
			expect(diffs[1].type).toBe('delta');
			expect(diffs[1].added?.length).toBe(1);
		});

		test('scoped query with unscoped event (no scope) IS re-evaluated', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffs.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});

			// Fire unscoped event (no scope info)
			insertItem(db, 'item-a', 'ItemA', 1, 'A');
			mockReactive.bumpAndFire('items'); // no scope

			await Promise.resolve();

			// No scope → cannot filter → re-evaluate
			expect(diffs.length).toBe(2);
		});
	});

	// -------------------------------------------------------------------------
	// Multiple concurrent sessions
	// -------------------------------------------------------------------------

	describe('multiple concurrent sessions', () => {
		test('three sessions: write to one only re-evaluates that session', async () => {
			// Subscribe for 3 different "sessions"
			const diffsA: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const diffsB: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const diffsC: QueryDiff<{ id: string; name: string; val: number }>[] = [];

			engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffsA.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});
			engine.subscribe(SQL_BY_OWNER, ['B'], (diff) => diffsB.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});
			engine.subscribe(SQL_BY_OWNER, ['C'], (diff) => diffsC.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});

			// Write to session B
			insertItem(db, 'b1', 'B1', 1, 'B');
			mockReactive.bumpAndFire('items', { sessionId: 'B' });
			await Promise.resolve();

			// Only B's query is re-evaluated
			expect(diffsA.length).toBe(1); // snapshot only
			expect(diffsB.length).toBe(2); // snapshot + delta
			expect(diffsC.length).toBe(1); // snapshot only
		});

		test('rapid writes to different sessions are independently scoped', async () => {
			const diffsA: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const diffsB: QueryDiff<{ id: string; name: string; val: number }>[] = [];

			engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffsA.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});
			engine.subscribe(SQL_BY_OWNER, ['B'], (diff) => diffsB.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});

			// Rapid writes to A and B
			insertItem(db, 'a1', 'A1', 1, 'A');
			mockReactive.bumpAndFire('items', { sessionId: 'A' });

			insertItem(db, 'b1', 'B1', 1, 'B');
			mockReactive.bumpAndFire('items', { sessionId: 'B' });

			await Promise.resolve();

			// A should have 2 callbacks: snapshot + delta (from its write)
			expect(diffsA.length).toBe(2);
			// B should have 2 callbacks: snapshot + delta (from its write)
			expect(diffsB.length).toBe(2);
		});
	});

	// -------------------------------------------------------------------------
	// ScopeExtractor undefined / edge cases
	// -------------------------------------------------------------------------

	describe('scopeExtractor edge cases', () => {
		test('scopeExtractor returning undefined always re-evaluates', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffs.push(diff), {
				scopeExtractor: () => undefined, // always returns undefined
			});

			// Insert matching data so the delta is actually emitted (not hash-deduped)
			insertItem(db, 'x', 'X', 1, 'A');
			mockReactive.bumpAndFire('items', { sessionId: 'B' });

			await Promise.resolve();

			// Undefined scope from extractor → cannot filter → re-evaluate → data changed → delta
			expect(diffs.length).toBe(2);
			expect(diffs[1].type).toBe('delta');
		});

		test('scopeExtractor returning empty object always re-evaluates', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffs.push(diff), {
				scopeExtractor: () => ({}), // empty scope
			});

			// Insert matching data so the delta is actually emitted (not hash-deduped)
			insertItem(db, 'x', 'X', 1, 'A');
			mockReactive.bumpAndFire('items', { sessionId: 'B' });

			await Promise.resolve();

			// Empty scope from extractor → no sessionId to compare → re-evaluate → data changed → delta
			expect(diffs.length).toBe(2);
			expect(diffs[1].type).toBe('delta');
		});

		test('event with empty scope always re-evaluates scoped queries', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffs.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});

			insertItem(db, 'x', 'X', 1, 'A');
			mockReactive.bumpAndFire('items', {}); // empty scope

			await Promise.resolve();

			// Empty event scope → cannot filter → re-evaluate
			expect(diffs.length).toBe(2);
		});
	});

	// -------------------------------------------------------------------------
	// Instrumentation stats
	// -------------------------------------------------------------------------

	describe('invalidation stats', () => {
		test('stats show skipped queries when scope mismatches', async () => {
			engine.subscribe(SQL_BY_OWNER, ['A'], () => {}, {
				scopeExtractor: ownerScopeExtractor,
			});
			engine.subscribe(SQL_BY_OWNER, ['B'], () => {}, {
				scopeExtractor: ownerScopeExtractor,
			});
			// Unscoped query
			engine.subscribe(SQL_ALL, [], () => {});

			// Fire scoped event for session A
			mockReactive.bumpAndFire('items', { sessionId: 'A' });

			const stats = engine.getLastInvalidationStats();
			expect(stats.table).toBe('items');
			expect(stats.scope).toEqual({ sessionId: 'A' });
			expect(stats.candidates).toBe(3); // 3 queries total
			expect(stats.skipped).toBe(1); // B's scoped query was skipped
			expect(stats.reevaluated).toBe(2); // A's scoped + unscoped

			await Promise.resolve(); // flush pending evaluations
		});

		test('stats show all re-evaluated when no scope info', () => {
			engine.subscribe(SQL_BY_OWNER, ['A'], () => {}, {
				scopeExtractor: ownerScopeExtractor,
			});
			engine.subscribe(SQL_BY_OWNER, ['B'], () => {}, {
				scopeExtractor: ownerScopeExtractor,
			});

			// Fire unscoped event
			mockReactive.bumpAndFire('items');

			const stats = engine.getLastInvalidationStats();
			expect(stats.skipped).toBe(0);
			expect(stats.reevaluated).toBe(2);
		});
	});

	// -------------------------------------------------------------------------
	// Disposal behaviour with scope
	// -------------------------------------------------------------------------

	describe('disposal with scoped queries', () => {
		test('disposed scoped handle no longer receives deltas', async () => {
			const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
			const handle = engine.subscribe(SQL_BY_OWNER, ['A'], (diff) => diffs.push(diff), {
				scopeExtractor: ownerScopeExtractor,
			});

			handle.dispose();

			insertItem(db, 'x', 'X', 1, 'A');
			mockReactive.bumpAndFire('items', { sessionId: 'A' });

			await Promise.resolve();

			expect(diffs.length).toBe(1); // only snapshot
		});
	});
});
