/**
 * db-query MCP Server — scoped read-only SQL access for agent sessions.
 *
 * Provides three tools: db_query, db_list_tables, db_describe_table.
 * Each instance owns a single read-only SQLite connection created at init
 * and closed via the returned close() method.
 *
 * Scope enforcement is layered:
 *   1. SQL validation rejects non-SELECT statements (fast feedback)
 *   2. Table-ref validation rejects queries referencing out-of-scope tables
 *   3. Subquery wrapping injects WHERE clauses for room/space scopes
 *   4. Connection-level read-only mode (readonly: true + PRAGMA query_only = ON)
 *   5. Row limit cap (default 200, max 1000)
 *   6. Column blacklist removes sensitive columns from results
 */

import { Database } from 'bun:sqlite';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { type DbScopeType, type ScopeTableConfig, getScopeConfig } from './scope-config.ts';
import { validateSql } from './sql-validator.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DbQueryToolsConfig {
	dbPath: string;
	scopeType: DbScopeType;
	scopeValue: string;
}

interface ToolResult {
	[key: string]: unknown;
	content: Array<{ type: 'text'; text: string }>;
}

interface DbQueryMcpServer {
	type: 'sdk';
	name: string;
	version?: string;
	tools?: unknown[];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	instance: any;
	close(): void;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

// ============ SQL Parsing Helpers ============

/**
 * Find the position of a top-level SQL keyword, respecting parentheses
 * depth and single-quoted string literals.
 */
function findTopLevelKeyword(sql: string, keyword: string): number {
	const upper = sql.toUpperCase();
	const kwLen = keyword.length;
	let depth = 0;
	let inString = false;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];

		if (inString) {
			if (ch === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
				i++; // skip escaped quote
				continue;
			}
			if (ch === "'") {
				inString = false;
			}
			continue;
		}

		if (ch === "'") {
			inString = true;
			continue;
		}
		if (ch === '(') {
			depth++;
			continue;
		}
		if (ch === ')') {
			depth--;
			continue;
		}

		if (depth === 0 && upper.slice(i, i + kwLen) === keyword) {
			const beforeOk = i === 0 || /\s/.test(sql[i - 1]);
			const afterChar = i + kwLen < sql.length ? sql[i + kwLen] : ' ';
			const afterOk = i + kwLen >= sql.length || /\s/.test(afterChar) || afterChar === '(';
			if (beforeOk && afterOk) return i;
		}
	}

	return -1;
}

/**
 * Rewrite ALL SELECT column lists to `*` so that all columns
 * (including scope columns needed by the outer filter) are available.
 * This handles both the main SELECT and SELECTs inside CTE bodies,
 * subqueries, and nested parentheses. Preserves DISTINCT when present.
 *
 * Strategy: collect all (selectPos, fromPos) pairs in a single forward pass
 * (at any depth, respecting string literals), then replace from right to
 * left to preserve string positions. The outer loop walks left-to-right, so
 * pairs are in ascending order by selectStart — this invariant is required
 * for the right-to-left replacement to be correct.
 */
function rewriteSelectToStar(sql: string): string {
	// Collect all SELECT→FROM pairs at any depth (except inside string literals).
	// Each pair records selectStart (position of S in SELECT), fromStart
	// (position of F in FROM), and whether DISTINCT follows SELECT.
	const pairs: Array<{
		selectStart: number;
		fromStart: number;
		hasDistinct: boolean;
	}> = [];
	const upper = sql.toUpperCase();
	let depth = 0;
	let inString = false;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];

		if (inString) {
			if (ch === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
				i++;
				continue;
			}
			if (ch === "'") {
				inString = false;
			}
			continue;
		}

		if (ch === "'") {
			inString = true;
			continue;
		}
		if (ch === '(') {
			depth++;
			continue;
		}
		if (ch === ')') {
			depth--;
			continue;
		}

		// Check for SELECT keyword at any depth (CTE bodies, subqueries, etc.)
		if (
			upper.slice(i, i + 6) === 'SELECT' &&
			(i === 0 || /\s/.test(sql[i - 1]) || sql[i - 1] === '(')
		) {
			const afterChar = i + 6 < sql.length ? sql[i + 6] : ' ';
			if (/\s/.test(afterChar) || afterChar === '(') {
				const selectEnd = i + 6;
				const targetDepth = depth;

				// Check for DISTINCT keyword immediately after SELECT
				const afterSelect = sql.slice(selectEnd).trimStart();
				const hasDistinct = /^DISTINCT\b/i.test(afterSelect);

				// Find matching FROM at the same depth as this SELECT
				let fDepth = depth;
				let fInString = false;
				let fromStart = -1;
				for (let j = selectEnd; j < sql.length; j++) {
					const c = sql[j];
					if (fInString) {
						if (c === "'" && j + 1 < sql.length && sql[j + 1] === "'") {
							j++;
							continue;
						}
						if (c === "'") fInString = false;
						continue;
					}
					if (c === "'") {
						fInString = true;
						continue;
					}
					if (c === '(') fDepth++;
					if (c === ')') fDepth--;
					if (fDepth !== targetDepth) continue;
					if (
						upper.slice(j, j + 4) === 'FROM' &&
						(j === 0 || /\s/.test(sql[j - 1])) &&
						(j + 4 >= sql.length || /\s/.test(sql[j + 4]))
					) {
						fromStart = j;
						break;
					}
				}
				if (fromStart !== -1) {
					pairs.push({ selectStart: i, fromStart, hasDistinct });
				}
			}
		}
	}

	if (pairs.length === 0) return sql;

	// Replace from right to left to preserve positions. Pairs are in ascending
	// order by selectStart (outer loop walks left-to-right), so processing
	// right-to-left ensures earlier positions remain valid after each replacement.
	let result = sql;
	for (let p = pairs.length - 1; p >= 0; p--) {
		const { selectStart, fromStart, hasDistinct } = pairs[p];
		const replacement = hasDistinct ? 'SELECT DISTINCT * ' : 'SELECT * ';
		result = `${result.slice(0, selectStart)}${replacement}${result.slice(fromStart)}`;
	}

	return result;
}

/**
 * Strip the user's LIMIT clause from the end of a SQL statement.
 * Returns the SQL without LIMIT and the user-specified limit value (if any).
 */
function stripLimit(sql: string): { sql: string; userLimit?: number } {
	const limitPos = findTopLevelKeyword(sql, 'LIMIT');
	if (limitPos === -1) return { sql };

	const afterLimit = sql.slice(limitPos + 5).trim();
	const match = afterLimit.match(/^(\d+)/);
	const userLimit = match ? Number.parseInt(match[1], 10) : undefined;

	return { sql: sql.slice(0, limitPos).trimEnd(), userLimit };
}

// ============ Scope Filter Builder ============

/**
 * Build a parameterized WHERE clause for a scoped table, using the `_dbq.` prefix
 * for column references that belong to the outer wrapper table.
 */
function buildPrefixedScopeFilter(
	config: ScopeTableConfig,
	scopeValue: string
): { whereClause: string; params: unknown[] } {
	// No scope column or join — no filter needed (global tables)
	if (!config.scopeColumn && !config.scopeJoin) {
		return { whereClause: '', params: [] };
	}

	// Direct scope filter
	if (config.scopeColumn) {
		return {
			whereClause: `_dbq.${config.scopeColumn} = ?`,
			params: [scopeValue],
		};
	}

	// Indirect scope filter via join table
	if (config.scopeJoin) {
		const join = config.scopeJoin;
		return {
			whereClause: `_dbq.${join.localColumn} IN (SELECT ${join.joinPkColumn} FROM ${join.joinTable} WHERE ${join.scopeColumn} = ?)`,
			params: [scopeValue],
		};
	}

	return { whereClause: '', params: [] };
}

/**
 * Rewrite a validated SELECT query with scope filter injection via subquery wrapping.
 *
 * Strategy:
 *   - Global scope (no filters): append LIMIT cap to the original SQL.
 *   - Room/Space scope: wrap the user's query as a subquery aliased `_dbq`,
 *     then apply combined scope filters in the outer WHERE clause.
 *     The inner query's SELECT is rewritten to `*` so scope columns are available.
 */
function rewriteScopedQuery(
	sql: string,
	userParams: unknown[],
	scopeType: DbScopeType,
	scopeValue: string,
	tableConfigs: Map<string, ScopeTableConfig>,
	userLimit?: number
): { sql: string; params: unknown[]; cappedLimit: number } {
	const cappedLimit = Math.min(userLimit ?? DEFAULT_LIMIT, MAX_LIMIT);

	// Build scope filters for all referenced tables, deduplicating identical
	// clauses to avoid ambiguous column references when multiple tables share
	// the same scope column (e.g. tasks JOIN goals both have room_id).
	const scopeFilterSet = new Map<string, unknown[]>();
	for (const config of tableConfigs.values()) {
		const filter = buildPrefixedScopeFilter(config, scopeValue);
		if (filter.whereClause && !scopeFilterSet.has(filter.whereClause)) {
			scopeFilterSet.set(filter.whereClause, filter.params);
		}
	}

	// No scope filters needed (global scope, all tables unscoped, or no table refs
	// e.g. SELECT 1). Table-less queries are safe to pass through — they don't
	// access any scoped data.
	if (scopeFilterSet.size === 0) {
		const { sql: strippedSql, userLimit: existingLimit } = stripLimit(sql);
		// Use the stricter of the arg-level limit and the SQL-embedded limit
		const effectiveLimit = Math.min(cappedLimit, Math.min(existingLimit ?? MAX_LIMIT, MAX_LIMIT));
		return {
			sql: `${strippedSql} LIMIT ${effectiveLimit}`,
			params: userParams,
			cappedLimit: effectiveLimit,
		};
	}

	// Scope-aware wrapping
	const combinedWhere = [...scopeFilterSet.keys()].join(' AND ');
	const scopeParams = [...scopeFilterSet.values()].flat();

	// Strip user's LIMIT
	const { sql: strippedSql } = stripLimit(sql);

	// Rewrite all SELECTs (including CTE bodies) to * for the inner query
	// so scope columns are available. The outer SELECT also uses * because
	// qualified column names (table.column) and aliases become invalid in
	// the subquery wrapper context — only _dbq is a valid table reference.
	const innerSql = rewriteSelectToStar(strippedSql);

	const wrappedSql = `SELECT * FROM (${innerSql}) AS _dbq WHERE ${combinedWhere} LIMIT ${cappedLimit}`;

	return { sql: wrappedSql, params: [...userParams, ...scopeParams], cappedLimit };
}

/**
 * Remove blacklisted columns from query result rows.
 * Collects blacklists from all referenced tables and removes those keys.
 */
function removeBlacklistedColumns(
	rows: Record<string, unknown>[],
	tableConfigs: Map<string, ScopeTableConfig>
): Record<string, unknown>[] {
	// Collect all blacklisted column names across referenced tables
	const blacklisted = new Set<string>();
	for (const config of tableConfigs.values()) {
		for (const col of config.blacklistedColumns) {
			blacklisted.add(col);
		}
	}

	if (blacklisted.size === 0) return rows;

	return rows.map((row) => {
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(row)) {
			if (!blacklisted.has(key)) {
				filtered[key] = value;
			}
		}
		return filtered;
	});
}

// ============ JSON helper ============

function jsonResult(data: Record<string, unknown>): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

// ============ Tool Handlers ============

/**
 * Create plain handler functions for the three db-query tools.
 * These can be tested directly without the SDK MCP server wrapper.
 */
export function createDbQueryToolHandlers(config: DbQueryToolsConfig, db: Database) {
	const { scopeType, scopeValue } = config;
	const scopeConfigs = getScopeConfig(scopeType);

	// Build lookup map for table configs
	const configMap = new Map<string, ScopeTableConfig>();
	for (const tc of scopeConfigs) {
		configMap.set(tc.tableName, tc);
	}

	return {
		async db_query(args: { sql: string; params?: unknown[]; limit?: number }): Promise<ToolResult> {
			const { sql, params = [], limit } = args;

			// Step 1: Validate SQL — reject if not a valid SELECT
			const validation = validateSql(sql);
			if (!validation.valid) {
				return errorResult(validation.error ?? 'Invalid SQL');
			}

			// Step 2: Check all tableRefs are within the current scope
			for (const tableRef of validation.tableRefs) {
				if (!configMap.has(tableRef)) {
					return errorResult(`Table "${tableRef}" is not accessible in ${scopeType} scope`);
				}
			}

			// Step 3: Build per-table scope filter configs
			const tableConfigs = new Map<string, ScopeTableConfig>();
			for (const tableRef of validation.tableRefs) {
				const tc = configMap.get(tableRef);
				if (tc) tableConfigs.set(tableRef, tc);
			}

			// Step 4-6: Rewrite query with scope filter wrapping and LIMIT cap
			const {
				sql: wrappedSql,
				params: allParams,
				cappedLimit,
			} = rewriteScopedQuery(sql, params, scopeType, scopeValue, tableConfigs, limit);

			// Step 7: Execute the rewritten query
			try {
				const stmt = db.query(wrappedSql);
				const rows = stmt.all(...(allParams as [])) as Record<string, unknown>[];

				// Step 8: Apply column blacklist
				const filteredRows = removeBlacklistedColumns(rows, tableConfigs);

				// Step 9: Return result — truncated is true when the result set
				// hit the applied LIMIT cap, meaning more rows may exist
				const truncated = rows.length >= cappedLimit;

				return jsonResult({
					rows: filteredRows,
					rowCount: filteredRows.length,
					truncated,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return errorResult(`Query execution error: ${message}`);
			}
		},

		async db_list_tables(): Promise<ToolResult> {
			const lines: string[] = ['| Table | Description |', '|-------|-------------|'];
			for (const tc of scopeConfigs) {
				const blacklistNote =
					tc.blacklistedColumns.length > 0
						? ` (${tc.blacklistedColumns.length} column(s) hidden)`
						: '';
				lines.push(`| ${tc.tableName} | ${tc.description}${blacklistNote} |`);
			}
			return jsonResult({
				tables: scopeConfigs.map((tc) => tc.tableName),
				description: lines.join('\n'),
			});
		},

		async db_describe_table(args: { table_name: string }): Promise<ToolResult> {
			const { table_name } = args;

			// Verify table is in current scope
			if (!configMap.has(table_name)) {
				return errorResult(`Table "${table_name}" is not accessible in ${scopeType} scope`);
			}

			const tableConfig = configMap.get(table_name)!;
			const blacklisted = new Set(tableConfig.blacklistedColumns);

			// Execute PRAGMA table_info — server-side, not user SQL.
			// PRAGMA does not support parameterized bindings, so the table name
			// is interpolated directly. The table_name has already been validated
			// against the scope config's accessible table names (alphanumeric + underscore).
			const columns = db.query(`PRAGMA table_info("${table_name}")`).all() as Array<{
				cid: number;
				name: string;
				type: string;
				notnull: number;
				dflt_value: unknown;
				pk: number;
			}>;

			// Filter out blacklisted columns
			const visibleColumns = columns.filter((col) => !blacklisted.has(col.name));

			// Execute PRAGMA foreign_key_list
			const fks = db.query(`PRAGMA foreign_key_list("${table_name}")`).all() as Array<{
				id: number;
				seq: number;
				table: string;
				from: string;
				to: string;
			}>;

			// Format output
			const parts: string[] = [];
			parts.push(`## ${table_name}`);
			parts.push('');
			parts.push(tableConfig.description);
			parts.push('');

			if (visibleColumns.length > 0) {
				parts.push('### Columns');
				parts.push('');
				parts.push('| Name | Type | Not Null | Default | PK |');
				parts.push('|------|------|----------|---------|----|');
				for (const col of visibleColumns) {
					const notNull = col.notnull ? 'YES' : 'no';
					const defaultVal = col.dflt_value !== null ? String(col.dflt_value) : '';
					const pk = col.pk ? `#${col.pk}` : '';
					parts.push(`| ${col.name} | ${col.type} | ${notNull} | ${defaultVal} | ${pk} |`);
				}
			} else {
				parts.push('*All columns are hidden by the column blacklist.*');
			}

			if (blacklisted.size > 0) {
				parts.push('');
				parts.push(`**${blacklisted.size} column(s) hidden:** ${[...blacklisted].join(', ')}`);
			}

			if (fks.length > 0) {
				parts.push('');
				parts.push('### Foreign Keys');
				parts.push('');
				parts.push('| Column | References |');
				parts.push('|--------|-----------|');
				for (const fk of fks) {
					parts.push(`| ${fk.from} | ${fk.table}.${fk.to} |`);
				}
			}

			return jsonResult({ description: parts.join('\n') });
		},
	};
}

// ============ MCP Server Factory ============

/**
 * Create the db-query MCP server with a dedicated read-only connection.
 *
 * The server owns a single SQLite connection that is closed when the
 * returned close() method is called. This is typically called during
 * session teardown.
 *
 * // TODO: Add query timeout — AbortController-based cancellation or a
 * // worker thread with sqlite3_interrupt() could handle pathological queries.
 * // For now, PRAGMA busy_timeout = 5000 handles lock contention only.
 *
 * // TODO: Wire into agent sessions — createDbQueryMcpServer is not yet integrated
 * // into query-options-builder.ts or agent-session.ts. This is intentional
 * // (follow-up task) but should be connected before the db-query server is usable.
 */
export function createDbQueryMcpServer(config: DbQueryToolsConfig): DbQueryMcpServer {
	// Create a dedicated read-only connection
	const db = new Database(config.dbPath, { readonly: true });
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec('PRAGMA query_only = ON');

	const handlers = createDbQueryToolHandlers(config, db);

	const scopeDescription =
		config.scopeType === 'global'
			? 'global scope (full read access to all visible tables, no row filtering)'
			: `${config.scopeType} scope (auto-filters to ${config.scopeType}_id = current entity)`;

	const tools = [
		tool(
			'db_query',
			`Execute a scoped SELECT query against the NeoKai database. ` +
				`Operating in ${scopeDescription}. ` +
				`Only SELECT statements are allowed — INSERT/UPDATE/DELETE are rejected. ` +
				`Results are limited to ${MAX_LIMIT} rows (default ${DEFAULT_LIMIT}). ` +
				`Sensitive columns are automatically removed from results. ` +
				`Use db_list_tables to see available tables and db_describe_table for column details.`,
			{
				sql: z.string().describe('SELECT SQL statement to execute'),
				params: z
					.array(z.unknown())
					.optional()
					.describe('Parameterized query parameters (positional ? placeholders)'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_LIMIT)
					.optional()
					.describe(`Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
			},
			(args) => handlers.db_query(args)
		),
		tool(
			'db_list_tables',
			`List all tables visible in the current ${config.scopeType} scope with descriptions. ` +
				`Use this to discover what data you can query with db_query.`,
			{},
			() => handlers.db_list_tables()
		),
		tool(
			'db_describe_table',
			`Show column definitions, types, and foreign keys for a specific table. ` +
				`Sensitive columns are excluded from the output.`,
			{
				table_name: z.string().describe('Name of the table to describe'),
			},
			(args) => handlers.db_describe_table(args)
		),
	];

	const server = createSdkMcpServer({ name: 'db-query', version: '1.0.0', tools });

	return {
		...server,
		close() {
			db.close();
		},
	};
}

export type { DbQueryMcpServer };
