/**
 * SQL validation layer for the db-query MCP server.
 *
 * Provides fast, helpful error messages for obviously invalid queries before
 * they reach SQLite. This is NOT a security boundary — write prevention is
 * handled by the read-only connection. The goal is to fail fast with clear
 * messages for common mistakes.
 */

/** Result of SQL validation, including extracted table references. */
export interface SqlValidationResult {
	/** Whether the statement passed all checks. */
	valid: boolean;
	/** Human-readable error message when validation fails. */
	error?: string;
	/** Table names referenced in FROM / JOIN clauses (CTE names excluded). */
	tableRefs: string[];
}

// ============ Internal helpers ============

/**
 * Strip line comments (--) and block comments (/* *​/) from SQL.
 * Does NOT handle nested block comments (SQL doesn't support them).
 */
function stripComments(sql: string): string {
	let result = sql;

	// Block comments first (so we don't match inside them with line-comment regex)
	result = result.replace(/\/\*[\s\S]*?\*\//g, ' ');

	// Line comments
	result = result.replace(/--[^\n]*/g, ' ');

	return result;
}

/**
 * Collapse runs of whitespace into single spaces and trim.
 */
function normalizeWhitespace(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Extract CTE names from a WITH ... AS (...) preamble.
 * Returns an object with cteNames (a set of CTE names)
 * and remaining (the SQL after the WITH block).
 *
 * Handles both single and multiple CTEs:
 *   WITH x AS (...), y AS (...) SELECT ...
 */
function extractCtes(sql: string): { cteNames: Set<string>; remaining: string } {
	const trimmed = sql.trimStart();

	// Must start with WITH (case-insensitive)
	if (!/^[Ww][Ii][Tt][Hh]\b/.test(trimmed)) {
		return { cteNames: new Set(), remaining: sql };
	}

	const cteNames = new Set<string>();
	let pos = 4; // skip "WITH"
	const len = trimmed.length;

	// Skip whitespace after WITH
	while (pos < len && /\s/.test(trimmed[pos])) pos++;

	while (pos < len) {
		// Extract CTE name (identifier)
		const nameStart = pos;
		while (pos < len && /[\p{L}\p{N}_]/u.test(trimmed[pos])) pos++;
		if (pos === nameStart) break; // no name found
		const cteName = trimmed.slice(nameStart, pos).toLowerCase();
		cteNames.add(cteName);

		// Skip whitespace
		while (pos < len && /\s/.test(trimmed[pos])) pos++;

		// Expect "AS" keyword
		if (
			pos + 1 < len &&
			trimmed[pos].toLowerCase() === 'a' &&
			trimmed[pos + 1].toLowerCase() === 's'
		) {
			pos += 2;
		} else {
			break;
		}

		// Skip whitespace
		while (pos < len && /\s/.test(trimmed[pos])) pos++;

		// Skip parenthesised CTE body — track nesting depth
		if (pos < len && trimmed[pos] === '(') {
			let depth = 1;
			pos++;
			while (pos < len && depth > 0) {
				if (trimmed[pos] === '(') depth++;
				else if (trimmed[pos] === ')') depth--;
				// Skip string literals so parens inside strings aren't counted
				else if (trimmed[pos] === "'") {
					pos++;
					while (pos < len && trimmed[pos] !== "'") {
						if (trimmed[pos] === "'") pos++; // escaped quote
						pos++;
					}
				}
				pos++;
			}
		}

		// Skip whitespace
		while (pos < len && /\s/.test(trimmed[pos])) pos++;

		// Check for trailing comma (more CTEs) or end of WITH block
		if (pos < len && trimmed[pos] === ',') {
			pos++;
			// Skip whitespace after comma
			while (pos < len && /\s/.test(trimmed[pos])) pos++;
		} else {
			break;
		}
	}

	return { cteNames, remaining: trimmed.slice(pos) };
}

/**
 * Extract table name candidates from FROM and JOIN clauses.
 * Matches FROM <name> and JOIN <name> (any JOIN variant).
 * Skips names that appear in the exclude set (e.g., CTE names).
 */
function extractTableRefs(sql: string, exclude: Set<string>): string[] {
	const refs: string[] = [];

	// FROM clause — match FROM <identifier> (not followed by '(' which would be a function)
	const identRe = '[\\p{L}\\p{N}_]+';
	const fromRe = new RegExp(`\\b[Ff][Rr][Oo][Mm]\\s+(${identRe})`, 'gu');
	let m: RegExpExecArray | null;
	while ((m = fromRe.exec(sql)) !== null) {
		const name = m[1].toLowerCase();
		if (!exclude.has(name) && !refs.includes(name)) {
			refs.push(name);
		}
	}

	// JOIN clause — LEFT/RIGHT/INNER/OUTER/CROSS/NATURAL JOIN <identifier>
	const joinRe = new RegExp(
		`\\b(?:LEFT|RIGHT|INNER|OUTER|CROSS|NATURAL)?\\s*[Jj][Oo][Ii][Nn]\\s+(${identRe})`,
		'gu'
	);
	while ((m = joinRe.exec(sql)) !== null) {
		const name = m[1].toLowerCase();
		if (!exclude.has(name) && !refs.includes(name)) {
			refs.push(name);
		}
	}

	return refs;
}

// ============ Public API ============

/**
 * Validate a SQL statement for use with the db-query MCP server.
 *
 * Checks:
 * 1. Rejects NULL bytes
 * 2. Rejects semicolons (multi-statement injection)
 * 3. Strips comments and normalizes whitespace
 * 4. Requires the statement to start with SELECT (or WITH followed by SELECT)
 * 5. Extracts table references from FROM / JOIN clauses (excluding CTE names)
 *
 * @param sql - The raw SQL string to validate.
 * @returns Validation result with valid flag, optional error, and extracted tableRefs.
 */
export function validateSql(sql: string): SqlValidationResult {
	// Reject NULL bytes
	if (sql.includes('\0')) {
		return { valid: false, error: 'NULL byte in SQL is not allowed', tableRefs: [] };
	}

	// Reject semicolons (multi-statement injection)
	if (sql.includes(';')) {
		return {
			valid: false,
			error: 'Semicolons are not allowed (single statement only)',
			tableRefs: [],
		};
	}

	// Strip comments and normalize
	const cleaned = normalizeWhitespace(stripComments(sql));

	if (!cleaned) {
		return { valid: false, error: 'Empty SQL statement', tableRefs: [] };
	}

	// Handle CTEs — extract CTE names and get the remaining query
	const { cteNames, remaining } = extractCtes(cleaned);

	// The remaining (or full cleaned) statement must start with SELECT
	const checkSql = remaining.trimStart();
	if (!/^[Ss][Ee][Ll][Ee][Cc][Tt]\b/.test(checkSql)) {
		return {
			valid: false,
			error: 'Only SELECT statements are allowed',
			tableRefs: [],
		};
	}

	// Extract table refs from both the CTE bodies and the main query,
	// excluding CTE names themselves.
	const allRefs = extractTableRefs(cleaned, cteNames);

	return { valid: true, tableRefs: allRefs };
}
