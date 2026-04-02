import { describe, expect, test } from 'bun:test';
import { validateSql } from '../../../src/lib/db-query/sql-validator';

// ============ Valid SELECT queries ============

describe('validateSql — valid SELECT queries', () => {
	test('simple SELECT', () => {
		const result = validateSql('SELECT * FROM tasks');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('SELECT with explicit columns', () => {
		const result = validateSql('SELECT id, name, status FROM tasks');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('SELECT with WHERE clause', () => {
		const result = validateSql('SELECT * FROM tasks WHERE status = ?', ['active']);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('SELECT with JOIN', () => {
		const result = validateSql(
			'SELECT t.id, s.name FROM tasks t JOIN sessions s ON t.session_id = s.id'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks', 'sessions']);
	});

	test('SELECT with LEFT JOIN', () => {
		const result = validateSql(
			'SELECT * FROM tasks LEFT JOIN sessions ON tasks.session_id = sessions.id'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks', 'sessions']);
	});

	test('SELECT with multiple JOINs', () => {
		const result = validateSql(
			'SELECT * FROM tasks t INNER JOIN sessions s ON t.session_id = s.id LEFT JOIN rooms r ON s.room_id = r.id'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks', 'sessions', 'rooms']);
	});

	test('SELECT * FROM with no WHERE', () => {
		const result = validateSql('SELECT * FROM tasks');
		expect(result.valid).toBe(true);
	});

	test('SELECT 1 (no table ref)', () => {
		const result = validateSql('SELECT 1');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual([]);
	});

	test('mixed case', () => {
		const result = validateSql('select * FROM Tasks');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('UPPERCASE SELECT', () => {
		const result = validateSql('SELECT * FROM TASKS');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('leading whitespace', () => {
		const result = validateSql('   SELECT * FROM tasks');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('tabs and newlines', () => {
		const result = validateSql('\t\n  SELECT *\n  FROM tasks\n');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('unicode table name', () => {
		const result = validateSql('SELECT * FROM задачи');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['задачи']);
	});

	test('unicode column names', () => {
		const result = validateSql('SELECT имя, статус FROM tasks');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('very long SQL string', () => {
		const columns = Array.from({ length: 500 }, (_, i) => `col${i}`).join(', ');
		const sql = `SELECT ${columns} FROM tasks WHERE id = ?`;
		const result = validateSql(sql);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});
});

// ============ Rejected non-SELECT statements ============

describe('validateSql — rejected statements', () => {
	const rejectedStatements = [
		'INSERT INTO tasks VALUES (1)',
		'UPDATE tasks SET status = ?',
		'DELETE FROM tasks WHERE id = ?',
		'DROP TABLE tasks',
		'ALTER TABLE tasks ADD COLUMN foo TEXT',
		'CREATE TABLE foo (id INTEGER)',
		'REPLACE INTO tasks VALUES (1)',
		'ATTACH DATABASE ? AS other',
		'PRAGMA journal_mode=WAL',
	];

	for (const sql of rejectedStatements) {
		test(`rejects: ${sql.split(' ')[0]}`, () => {
			const result = validateSql(sql);
			expect(result.valid).toBe(false);
			expect(result.error).toBe('Only SELECT statements are allowed');
			expect(result.tableRefs).toEqual([]);
		});
	}

	test('rejects empty string', () => {
		const result = validateSql('');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Empty SQL statement');
	});

	test('rejects whitespace-only string', () => {
		const result = validateSql('   \t\n  ');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Empty SQL statement');
	});

	test('rejects comments-only string', () => {
		const result = validateSql('-- just a comment');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Empty SQL statement');
	});

	test('rejects block-comment-only string', () => {
		const result = validateSql('/* just a comment */');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Empty SQL statement');
	});
});

// ============ Semicolons ============

describe('validateSql — semicolons rejected', () => {
	test('rejects semicolon at end', () => {
		const result = validateSql('SELECT * FROM tasks;');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Semicolons are not allowed (single statement only)');
	});

	test('rejects semicolon in middle', () => {
		const result = validateSql('SELECT * FROM tasks; DROP TABLE tasks');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Semicolons are not allowed (single statement only)');
	});
});

// ============ NULL bytes ============

describe('validateSql — NULL byte rejection', () => {
	test('rejects NULL byte in SELECT', () => {
		const result = validateSql('SELECT * FROM tasks\0; DROP TABLE tasks');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('NULL byte in SQL is not allowed');
	});

	test('rejects NULL byte at start', () => {
		const result = validateSql('\0SELECT * FROM tasks');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('NULL byte in SQL is not allowed');
	});
});

// ============ Comments ============

describe('validateSql — comment stripping', () => {
	test('strips line comments', () => {
		const result = validateSql('SELECT * -- comment\nFROM tasks');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('strips block comments', () => {
		const result = validateSql('SELECT/* comment */ * FROM tasks');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('strips multi-line block comments', () => {
		const result = validateSql('SELECT * /*\n multi-line\n comment\n */FROM tasks');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('strips comments before rejection check', () => {
		// A comment disguising a non-SELECT keyword
		const result = validateSql('-- INSERT INTO\nSELECT * FROM tasks');
		expect(result.valid).toBe(true);
	});
});

// ============ CTEs ============

describe('validateSql — CTE handling', () => {
	test('simple CTE — CTE name excluded from tableRefs', () => {
		const result = validateSql(
			'WITH counts AS (SELECT room_id, COUNT(*) AS n FROM sessions GROUP BY room_id) SELECT * FROM counts'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['sessions']);
		expect(result.tableRefs).not.toContain('counts');
	});

	test('CTE with JOIN — both CTE name excluded, real table included', () => {
		const result = validateSql(
			'WITH active AS (SELECT * FROM sessions WHERE status = ?) SELECT a.*, r.name FROM active a JOIN rooms r ON a.room_id = r.id'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['sessions', 'rooms']);
		expect(result.tableRefs).not.toContain('active');
	});

	test('multiple CTEs', () => {
		const result = validateSql(
			'WITH s AS (SELECT * FROM sessions), r AS (SELECT * FROM rooms) SELECT * FROM s JOIN r ON s.room_id = r.id'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['sessions', 'rooms']);
		expect(result.tableRefs).not.toContain('s');
		expect(result.tableRefs).not.toContain('r');
	});

	test('nested CTE references other CTE — only real tables extracted', () => {
		const result = validateSql(
			'WITH s AS (SELECT * FROM sessions), filtered AS (SELECT * FROM s WHERE status = ?) SELECT * FROM filtered'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['sessions']);
		expect(result.tableRefs).not.toContain('s');
		expect(result.tableRefs).not.toContain('filtered');
	});

	test('CTE with mixed case', () => {
		const result = validateSql('with MyCte As (select * from tasks) Select * from MyCte');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
		expect(result.tableRefs).not.toContain('mycte');
	});

	test('CTE with string literals containing parens', () => {
		const result = validateSql(
			`WITH parsed AS (SELECT substr(data, 1, instr(data, ')')) AS val FROM logs) SELECT * FROM parsed`
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['logs']);
		expect(result.tableRefs).not.toContain('parsed');
	});

	test('non-SELECT after WITH is rejected', () => {
		const result = validateSql('WITH x AS (SELECT 1) INSERT INTO tasks VALUES (1)');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Only SELECT statements are allowed');
	});
});

// ============ Subqueries ============

describe('validateSql — subqueries', () => {
	test('subquery in WHERE — table refs extracted', () => {
		const result = validateSql(
			'SELECT * FROM tasks WHERE session_id IN (SELECT id FROM sessions WHERE status = ?)'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks', 'sessions']);
	});

	test('subquery in FROM — table refs extracted', () => {
		const result = validateSql('SELECT sub.* FROM (SELECT * FROM tasks WHERE status = ?) AS sub');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('nested subqueries — all table refs extracted', () => {
		const result = validateSql(
			`SELECT * FROM rooms WHERE id IN (SELECT room_id FROM sessions WHERE id IN (SELECT session_id FROM tasks WHERE status = ?))`
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['rooms', 'sessions', 'tasks']);
	});
});

// ============ Edge cases ============

describe('validateSql — edge cases', () => {
	test('duplicate table refs — deduplicated', () => {
		const result = validateSql('SELECT * FROM tasks t1 JOIN tasks t2 ON t1.id = t2.parent_id');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('table alias does not appear in tableRefs', () => {
		const result = validateSql('SELECT t.* FROM tasks t');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('CROSS JOIN', () => {
		const result = validateSql('SELECT * FROM tasks CROSS JOIN sessions');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks', 'sessions']);
	});

	test('NATURAL JOIN', () => {
		const result = validateSql('SELECT * FROM tasks NATURAL JOIN sessions');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks', 'sessions']);
	});

	test('subquery alias excluded from tableRefs', () => {
		const result = validateSql(
			'SELECT sub.id FROM (SELECT * FROM tasks) AS sub JOIN sessions ON sub.session_id = sessions.id'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks', 'sessions']);
	});

	test('ORDER BY, LIMIT, OFFSET preserved', () => {
		const result = validateSql('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 10 OFFSET 20');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks']);
	});

	test('GROUP BY with HAVING', () => {
		const result = validateSql(
			'SELECT room_id, COUNT(*) AS n FROM sessions GROUP BY room_id HAVING n > 5'
		);
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['sessions']);
	});

	test('UNION queries', () => {
		const result = validateSql('SELECT * FROM tasks UNION SELECT * FROM archived_tasks');
		expect(result.valid).toBe(true);
		expect(result.tableRefs).toEqual(['tasks', 'archived_tasks']);
	});
});
