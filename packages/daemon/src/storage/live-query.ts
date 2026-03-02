/**
 * LiveQueryEngine
 *
 * Registers SQL queries with parameters and callbacks. When a table change event
 * fires from ReactiveDatabase, it re-evaluates all queries that depend on that
 * table, computes diffs, and invokes callbacks only when results actually changed.
 */

import { Database as BunDatabase } from 'bun:sqlite';
import type { ReactiveDatabase } from './reactive-database';

// ============================================================================
// Public API types
// ============================================================================

export interface LiveQueryHandle<T> {
	/** Get current cached result */
	get(): T[];
	/** Stop receiving updates */
	dispose(): void;
}

export interface QueryDiff<T = Record<string, unknown>> {
	type: 'snapshot' | 'delta';
	rows: T[];
	added?: T[];
	removed?: T[];
	updated?: T[];
	version: number;
}

// ============================================================================
// Internal types
// ============================================================================

interface Subscriber<T extends Record<string, unknown>> {
	onChange: (diff: QueryDiff<T>) => void;
	disposed: boolean;
}

interface QueryEntry<T extends Record<string, unknown>> {
	sql: string;
	params: ReadonlyArray<unknown>;
	tables: string[];
	cachedRows: T[];
	cachedHash: number;
	subscribers: Set<Subscriber<T>>;
	/** True when a microtask re-evaluation is already queued */
	pendingEval: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract table names referenced in FROM and JOIN clauses.
 *
 * Handles:
 * - Simple `FROM table` and all JOIN variants: LEFT JOIN, RIGHT JOIN,
 *   INNER JOIN, CROSS JOIN, FULL JOIN, LEFT OUTER JOIN, RIGHT OUTER JOIN
 * - Comma-separated tables in the FROM clause: `FROM a, b`
 * - Table aliases — `FROM items AS i` or `FROM items i` — returns base name
 * - Case-insensitive keywords; names are normalised to lowercase
 * - Subqueries: the pattern skips `FROM (` so the `(` is not treated as a
 *   table name; inner tables are still matched when the regex reaches them
 *
 * Known limitations (acceptable for the queries this engine handles):
 * - CTE aliases defined with `WITH alias AS (…)` may be captured as table
 *   names when they appear after a FROM/JOIN keyword.
 * - Quoted identifiers (`"my table"`, `` `col` ``) are not supported.
 *
 * @internal Exported for unit testing only.
 */
export function extractTables(sql: string): string[] {
	const tables = new Set<string>();

	// Match all JOIN variants followed by a bare identifier (not a `(`).
	// This covers: JOIN, INNER JOIN, LEFT JOIN, RIGHT JOIN, CROSS JOIN,
	// FULL JOIN, LEFT OUTER JOIN, RIGHT OUTER JOIN, etc.
	const joinPattern =
		/\b(?:(?:LEFT|RIGHT|INNER|CROSS|FULL)(?:\s+OUTER)?\s+)?JOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
	let match: RegExpExecArray | null;
	while ((match = joinPattern.exec(sql)) !== null) {
		tables.add(match[1].toLowerCase());
	}

	// Match FROM clauses and walk the comma-separated table list that follows.
	// The pattern captures the raw list; we then split on commas and pick the
	// first identifier from each item (ignoring AS alias and positional alias).
	// We use a negative lookahead `(?!\s*\()` to skip `FROM (subquery)` openers.
	const fromPattern =
		/\bFROM\s+(?!\s*\()([a-zA-Z_][a-zA-Z0-9_\s,]*?)(?=\s+(?:WHERE|JOIN|ON|GROUP|ORDER|HAVING|LIMIT|UNION)\b|\s*(?:$|\)))/gi;
	while ((match = fromPattern.exec(sql)) !== null) {
		for (const part of match[1].split(',')) {
			const name = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
			if (name) {
				tables.add(name[1].toLowerCase());
			}
		}
	}

	return Array.from(tables);
}

/** Hash rows using Bun.hash for fast change detection. */
function hashRows(rows: Record<string, unknown>[]): number {
	const hash = Bun.hash(JSON.stringify(rows));
	return typeof hash === 'bigint' ? Number(hash) : hash;
}

/**
 * Compute a row-level diff between old and new result sets.
 * Uses `id` field when available; falls back to positional comparison.
 *
 * @internal Exported for testing only.
 */
export function computeDiff<T extends Record<string, unknown>>(
	oldRows: T[],
	newRows: T[]
): { added: T[]; removed: T[]; updated: T[] } {
	const hasId =
		(newRows.length > 0 && 'id' in newRows[0]) || (oldRows.length > 0 && 'id' in oldRows[0]);

	if (!hasId) {
		// Positional diff: compare by full JSON
		const oldSet = new Set(oldRows.map((r) => JSON.stringify(r)));
		const newSet = new Set(newRows.map((r) => JSON.stringify(r)));
		const added: T[] = newRows.filter((r) => !oldSet.has(JSON.stringify(r)));
		const removed: T[] = oldRows.filter((r) => !newSet.has(JSON.stringify(r)));
		return { added, removed, updated: [] };
	}

	const oldById = new Map<unknown, T>();
	for (const row of oldRows) {
		oldById.set(row['id'], row);
	}
	const newById = new Map<unknown, T>();
	for (const row of newRows) {
		newById.set(row['id'], row);
	}

	const added: T[] = [];
	const removed: T[] = [];
	const updated: T[] = [];

	for (const [id, newRow] of newById) {
		const oldRow = oldById.get(id);
		if (oldRow === undefined) {
			added.push(newRow);
		} else if (JSON.stringify(oldRow) !== JSON.stringify(newRow)) {
			updated.push(newRow);
		}
	}
	for (const [id, oldRow] of oldById) {
		if (!newById.has(id)) {
			removed.push(oldRow);
		}
	}

	return { added, removed, updated };
}

// ============================================================================
// LiveQueryEngine
// ============================================================================

export class LiveQueryEngine {
	/** Map from cache key (`sql + JSON.stringify(params)`) to QueryEntry */
	private queries = new Map<string, QueryEntry<Record<string, unknown>>>();
	/** Map from table name to set of cache keys that depend on it */
	private tableIndex = new Map<string, Set<string>>();
	private changeListener: (data: { tables: string[]; versions: Record<string, number> }) => void;
	private disposed = false;

	constructor(
		private db: BunDatabase,
		private reactiveDb: ReactiveDatabase
	) {
		this.changeListener = (data) => {
			for (const table of data.tables) {
				this.onTableChange(table);
			}
		};
		this.reactiveDb.on('change', this.changeListener);
	}

	/**
	 * Register a live query. Executes immediately and delivers current results
	 * to the callback as a 'snapshot'. Subsequent changes trigger 'delta' callbacks.
	 */
	subscribe<T extends Record<string, unknown>>(
		sql: string,
		params: ReadonlyArray<unknown>,
		onChange: (diff: QueryDiff<T>) => void
	): LiveQueryHandle<T> {
		const cacheKey = sql + '\0' + JSON.stringify(params);

		let entry = this.queries.get(cacheKey) as QueryEntry<T> | undefined;

		if (!entry) {
			const rows = this.runQuery<T>(sql, params);
			const hash = hashRows(rows);
			const tables = extractTables(sql);

			entry = {
				sql,
				params,
				tables,
				cachedRows: rows,
				cachedHash: hash,
				subscribers: new Set(),
				pendingEval: false,
			} as unknown as QueryEntry<T>;

			this.queries.set(cacheKey, entry as unknown as QueryEntry<Record<string, unknown>>);

			for (const table of tables) {
				let keys = this.tableIndex.get(table);
				if (!keys) {
					keys = new Set();
					this.tableIndex.set(table, keys);
				}
				keys.add(cacheKey);
			}
		}

		const subscriber: Subscriber<T> = { onChange, disposed: false };
		(entry as QueryEntry<T>).subscribers.add(subscriber);

		// Deliver initial snapshot
		const version = this.computeVersion((entry as QueryEntry<T>).tables);
		onChange({
			type: 'snapshot',
			rows: (entry as QueryEntry<T>).cachedRows.slice(),
			version,
		});

		return {
			get: () => (entry as QueryEntry<T>).cachedRows.slice(),
			dispose: () => {
				subscriber.disposed = true;
				(entry as QueryEntry<T>).subscribers.delete(subscriber);
				// Clean up entry if no subscribers remain
				if ((entry as QueryEntry<T>).subscribers.size === 0) {
					this.queries.delete(cacheKey);
					for (const table of (entry as QueryEntry<T>).tables) {
						const keys = this.tableIndex.get(table);
						if (keys) {
							keys.delete(cacheKey);
							if (keys.size === 0) {
								this.tableIndex.delete(table);
							}
						}
					}
				}
			},
		};
	}

	/** Dispose all subscriptions and stop listening to ReactiveDatabase. */
	dispose(): void {
		this.disposed = true;
		this.reactiveDb.off('change', this.changeListener as (...args: unknown[]) => void);
		this.queries.clear();
		this.tableIndex.clear();
	}

	// ============================================================================
	// Private
	// ============================================================================

	private onTableChange(table: string): void {
		if (this.disposed) return;

		const keys = this.tableIndex.get(table.toLowerCase());
		if (!keys || keys.size === 0) return;

		for (const cacheKey of keys) {
			const entry = this.queries.get(cacheKey);
			if (!entry || entry.pendingEval) continue;

			entry.pendingEval = true;
			queueMicrotask(() => this.evaluateQuery(cacheKey));
		}
	}

	private evaluateQuery(cacheKey: string): void {
		if (this.disposed) return;

		const entry = this.queries.get(cacheKey);
		if (!entry) return;

		entry.pendingEval = false;

		const newRows = this.runQuery(entry.sql, entry.params);
		const newHash = hashRows(newRows);

		if (newHash === entry.cachedHash) return;

		const oldRows = entry.cachedRows;
		const diff = computeDiff(oldRows, newRows);
		const version = this.computeVersion(entry.tables);

		entry.cachedRows = newRows;
		entry.cachedHash = newHash;

		const queryDiff: QueryDiff<Record<string, unknown>> = {
			type: 'delta',
			rows: newRows,
			added: diff.added,
			removed: diff.removed,
			updated: diff.updated,
			version,
		};

		for (const subscriber of entry.subscribers) {
			if (!subscriber.disposed) {
				subscriber.onChange(queryDiff);
			}
		}
	}

	private runQuery<T extends Record<string, unknown>>(
		sql: string,
		params: ReadonlyArray<unknown>
	): T[] {
		const stmt = this.db.prepare(sql);
		const paramsArray = Array.from(params) as Parameters<typeof stmt.all>;
		return stmt.all(...paramsArray) as T[];
	}

	private computeVersion(tables: string[]): number {
		let max = 0;
		for (const table of tables) {
			const v = this.reactiveDb.getTableVersion(table);
			if (v > max) max = v;
		}
		return max;
	}
}
