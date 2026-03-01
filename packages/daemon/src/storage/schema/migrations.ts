/**
 * Database Migrations
 *
 * Migrations 1–13 handle incremental schema changes to core tables.
 * runMigrationRoomCleanup consolidates former migrations 25–36 (room feature
 * experiments that never shipped to production) into a single drop-and-recreate
 * cleanup. CRITICAL: Preserve the order of migrations.
 */

import type { Database as BunDatabase } from 'bun:sqlite';

/**
 * Run all database migrations
 *
 * @param db - The database instance
 * @param createBackup - Function to call before running migrations (creates backup)
 */
export function runMigrations(db: BunDatabase, createBackup: () => void): void {
	// Create backup before running any migrations
	// This ensures we can recover if a migration causes data loss
	createBackup();

	// Migration 1: Add oauth_token_encrypted column if it doesn't exist
	runMigration1(db);

	// Migration 2: Remove messages and tool_calls tables (replaced by sdk_messages)
	runMigration2(db);

	// Migration 3: Add worktree columns to sessions table
	runMigration3(db);

	// Migration 4: Add git_branch column for non-worktree git sessions
	runMigration4(db);

	// Migration 5: Add sdk_session_id column for session resumption
	runMigration5(db);

	// Migration 6: Add available_commands column for slash commands persistence
	runMigration6(db);

	// Migration 7: Add processing_state column for agent state persistence
	runMigration7(db);

	// Migration 8: Add archived_at column for archive session feature
	runMigration8(db);

	// Migration 9: Update CHECK constraint to include 'archived' status
	runMigration9(db);

	// Migration 10: Add send_status column to sdk_messages for query mode support
	runMigration10(db);

	// Migration 11: Add sub-session columns for parent-child session relationships
	runMigration11(db);

	// Migration 12: Ensure global_settings has autoScroll: true for existing databases
	runMigration12(db);

	// Migration 13: Update CHECK constraint to include 'pending_worktree_choice' status
	runMigration13(db);

	// Room cleanup: drop all room experiment tables and fix sessions schema if outdated
	// (consolidates former migrations 25–36, which covered features never shipped to production)
	runMigrationRoomCleanup(db);

	// Migration 14: Drop events table and unused session columns (labels, sub_session_order)
	runMigration14(db);

	// Migration 15: Add 'failed' to send_status CHECK constraint in sdk_messages
	runMigration15(db);

	// Migration 16: Replace 'escalated' with 'review' in tasks, remove 'hibernated' from session_groups,
	// add config column to rooms table
	runMigration16(db);
}

/**
 * Migration 1: Add oauth_token_encrypted column if it doesn't exist
 */
function runMigration1(db: BunDatabase): void {
	// First check if auth_config table exists (fresh database)
	if (!tableExists(db, 'auth_config')) {
		return;
	}
	try {
		// Check if column exists by trying to query it
		db.prepare(`SELECT oauth_token_encrypted FROM auth_config LIMIT 1`).all();
	} catch {
		// Column doesn't exist, add it
		db.exec(`ALTER TABLE auth_config ADD COLUMN oauth_token_encrypted TEXT`);
	}
}

/**
 * Migration 2: Remove messages and tool_calls tables (replaced by sdk_messages)
 */
function runMigration2(db: BunDatabase): void {
	try {
		// Check if messages table exists
		db.prepare(`SELECT 1 FROM messages LIMIT 1`).all();
		// Table exists, drop it
		db.exec(`DROP TABLE IF EXISTS tool_calls`);
		db.exec(`DROP TABLE IF EXISTS messages`);
		db.exec(`DROP INDEX IF EXISTS idx_messages_session`);
		db.exec(`DROP INDEX IF EXISTS idx_tool_calls_message`);
	} catch {
		// Tables don't exist, migration already complete
	}
}

/**
 * Migration 3: Add worktree columns to sessions table
 */
function runMigration3(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT is_worktree FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN is_worktree INTEGER DEFAULT 0`);
		db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
		db.exec(`ALTER TABLE sessions ADD COLUMN main_repo_path TEXT`);
		db.exec(`ALTER TABLE sessions ADD COLUMN worktree_branch TEXT`);
	}
}

/**
 * Migration 4: Add git_branch column for non-worktree git sessions
 */
function runMigration4(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT git_branch FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN git_branch TEXT`);
	}
}

/**
 * Migration 5: Add sdk_session_id column for session resumption
 */
function runMigration5(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT sdk_session_id FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT`);
	}
}

/**
 * Migration 6: Add available_commands column for slash commands persistence
 */
function runMigration6(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT available_commands FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN available_commands TEXT`);
	}
}

/**
 * Migration 7: Add processing_state column for agent state persistence
 */
function runMigration7(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT processing_state FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN processing_state TEXT`);
	}
}

/**
 * Migration 8: Add archived_at column for archive session feature
 */
function runMigration8(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT archived_at FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN archived_at TEXT`);
	}
}

/**
 * Migration 9: Update CHECK constraint to include 'archived' status
 *
 * SQLite doesn't support ALTER COLUMN, so we need to recreate the table.
 *
 * CRITICAL: Must disable foreign_keys during table recreation!
 * With foreign_keys=ON, DROP TABLE cascades to child tables (sdk_messages),
 * which would delete all messages. This was a data-loss bug.
 */
function runMigration9(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		// Check if the CHECK constraint already includes 'archived'
		// We do this by trying to insert a test row with status='archived'
		const testId = '__migration_test_archived_status__';
		db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, available_commands, processing_state, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			testId,
			'Test',
			'/tmp',
			new Date().toISOString(),
			new Date().toISOString(),
			'archived',
			'{}',
			'{}',
			0,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null
		);
		// If we got here, the constraint already includes 'archived', clean up and skip migration
		db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
	} catch {
		// INSERT failed, which means CHECK constraint doesn't include 'archived'
		// Need to recreate the table with updated constraint

		// CRITICAL: Disable foreign keys during table recreation to prevent
		// CASCADE delete from wiping sdk_messages when we DROP TABLE sessions
		db.exec('PRAGMA foreign_keys = OFF');

		try {
			// SQLite table recreation pattern for modifying constraints
			db.exec(`
				-- Create new table with updated CHECK constraint
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_active_at TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived')),
					config TEXT NOT NULL,
					metadata TEXT NOT NULL,
					is_worktree INTEGER DEFAULT 0,
					worktree_path TEXT,
					main_repo_path TEXT,
					worktree_branch TEXT,
					git_branch TEXT,
					sdk_session_id TEXT,
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT
				);

				-- Copy all data from old table to new table
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					   is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch,
					   sdk_session_id, available_commands, processing_state, archived_at
				FROM sessions;

				-- Drop old table (safe now that foreign_keys is OFF)
				DROP TABLE sessions;

				-- Rename new table to original name
				ALTER TABLE sessions_new RENAME TO sessions;
			`);
		} finally {
			// Re-enable foreign keys
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}

/**
 * Migration 10: Add send_status column to sdk_messages for query mode support
 *
 * send_status tracks whether a message has been saved, queued, or sent to SDK
 */
function runMigration10(db: BunDatabase): void {
	// Skip if sdk_messages table doesn't exist (fresh database)
	if (!tableExists(db, 'sdk_messages')) {
		return;
	}
	try {
		db.prepare(`SELECT send_status FROM sdk_messages LIMIT 1`).all();
	} catch {
		db.exec(
			`ALTER TABLE sdk_messages ADD COLUMN send_status TEXT DEFAULT 'sent' CHECK(send_status IN ('saved', 'queued', 'sent'))`
		);
		// Add index for efficient status queries
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
		);
	}
}

/**
 * Migration 11: Add sub-session columns for parent-child session relationships
 *
 * - parent_id: References parent session (null for root sessions)
 * - labels: JSON array of strings for categorization
 * - sub_session_order: Integer for ordering siblings in UI
 */
function runMigration11(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT parent_id FROM sessions LIMIT 1`).all();
	} catch {
		// Note: SQLite doesn't support adding FK constraints via ALTER TABLE,
		// but the application layer will enforce the constraint
		db.exec(`ALTER TABLE sessions ADD COLUMN parent_id TEXT`);
		db.exec(`ALTER TABLE sessions ADD COLUMN labels TEXT`);
		db.exec(`ALTER TABLE sessions ADD COLUMN sub_session_order INTEGER DEFAULT 0`);
		// Add index for efficient parent lookups
		db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)`);
	}
}

/**
 * Migration 12: Ensure global_settings has autoScroll: true for existing databases
 *
 * Existing databases may have global_settings without the autoScroll field.
 * This migration ensures all existing settings have autoScroll: true as default.
 */
export function runMigration12(db: BunDatabase): void {
	// Skip if global_settings table doesn't exist (fresh database)
	if (!tableExists(db, 'global_settings')) {
		return;
	}
	try {
		const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
			| { settings: string }
			| undefined;

		if (!row) {
			db.exec(`
        INSERT INTO global_settings (id, settings, updated_at)
        VALUES (1, '{"autoScroll":true}', datetime('now'))
      `);
			return;
		}

		const settings = JSON.parse(row.settings) as Record<string, unknown>;

		// Only update if autoScroll is not already set
		if (settings.autoScroll === undefined) {
			settings.autoScroll = true;
			db.exec(`
        UPDATE global_settings
        SET settings = '${JSON.stringify(settings).replace(/'/g, "''")}',
            updated_at = datetime('now')
        WHERE id = 1
      `);
		}
	} catch {
		// Log but don't throw - migration errors shouldn't crash the app
	}
}

/**
 * Migration 13: Update CHECK constraint to include 'pending_worktree_choice' status
 *
 * SQLite doesn't support ALTER COLUMN, so we need to recreate the table.
 *
 * CRITICAL: Must disable foreign_keys during table recreation!
 * With foreign_keys=ON, DROP TABLE cascades to child tables (sdk_messages),
 * which would delete all messages. This was a data-loss bug.
 */
function runMigration13(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		// Check if the CHECK constraint already includes 'pending_worktree_choice'
		// We do this by trying to insert a test row with status='pending_worktree_choice'
		const testId = '__migration_test_pending_worktree_choice_status__';
		db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, available_commands, processing_state, archived_at, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			testId,
			'Test',
			'/tmp',
			new Date().toISOString(),
			new Date().toISOString(),
			'pending_worktree_choice',
			'{}',
			'{}',
			0,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null
		);
		// If we got here, the constraint already includes 'pending_worktree_choice', clean up and skip migration
		db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
	} catch {
		// INSERT failed, which means CHECK constraint doesn't include 'pending_worktree_choice'
		// Need to recreate the table with updated constraint
		// Recreate table with updated CHECK constraint to include 'pending_worktree_choice'

		// CRITICAL: Disable foreign keys during table recreation to prevent
		// CASCADE delete from wiping sdk_messages when we DROP TABLE sessions
		db.exec('PRAGMA foreign_keys = OFF');

		try {
			// Determine which optional columns exist before rebuild (they may or may not be present
			// depending on which migrations ran before this one)
			const hasLabels = tableHasColumn(db, 'sessions', 'labels');
			const hasSubOrder = tableHasColumn(db, 'sessions', 'sub_session_order');

			// SQLite table recreation pattern for modifying constraints
			db.exec(`
				-- Create new table with updated CHECK constraint
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_active_at TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
					config TEXT NOT NULL,
					metadata TEXT NOT NULL,
					is_worktree INTEGER DEFAULT 0,
					worktree_path TEXT,
					main_repo_path TEXT,
					worktree_branch TEXT,
					git_branch TEXT,
					sdk_session_id TEXT,
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT,
					parent_id TEXT
				);

				-- Copy all data from old table to new table
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					   is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch,
					   sdk_session_id, available_commands, processing_state, archived_at, parent_id
				FROM sessions;

				-- Drop old table (safe now that foreign_keys is OFF)
				DROP TABLE sessions;

				-- Rename new table to original name
				ALTER TABLE sessions_new RENAME TO sessions;
			`);

			// Re-add labels and sub_session_order if they existed in the old table
			// (Migration 14 will drop them, but we preserve them here so M14 can do it cleanly)
			if (hasLabels) {
				db.exec(`ALTER TABLE sessions ADD COLUMN labels TEXT`);
			}
			if (hasSubOrder) {
				db.exec(`ALTER TABLE sessions ADD COLUMN sub_session_order INTEGER DEFAULT 0`);
			}
		} finally {
			// Re-enable foreign keys
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}

/**
 * Migration 14: Drop events table and unused session columns
 *
 * - events table was never used (EventBus handles events in-memory)
 * - labels and sub_session_order columns were added in Migration 11 but never used
 *
 * ALTER TABLE DROP COLUMN requires SQLite 3.35+; Bun ships SQLite 3.46+.
 */
function runMigration14(db: BunDatabase): void {
	db.exec(`DROP TABLE IF EXISTS events`);
	db.exec(`DROP INDEX IF EXISTS idx_events_session`);

	if (!tableExists(db, 'sessions')) return;
	if (tableHasColumn(db, 'sessions', 'labels')) {
		db.exec(`ALTER TABLE sessions DROP COLUMN labels`);
	}
	if (tableHasColumn(db, 'sessions', 'sub_session_order')) {
		db.exec(`ALTER TABLE sessions DROP COLUMN sub_session_order`);
	}
}

/**
 * Migration 15: Add 'failed' to send_status CHECK constraint in sdk_messages
 *
 * Orphaned messages are now marked 'failed' instead of 'saved', so they appear
 * in the UI as undelivered rather than being silently re-dispatched on startup.
 *
 * Requires rebuilding the table because SQLite does not support modifying
 * existing CHECK constraints via ALTER TABLE.
 */
function runMigration15(db: BunDatabase): void {
	if (!tableExists(db, 'sdk_messages')) {
		return;
	}
	// Check if the constraint already includes 'failed' by inspecting the schema SQL
	const tableInfo = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sdk_messages'`)
		.get() as { sql: string } | null;
	if (tableInfo?.sql?.includes("'failed'")) {
		return; // Already migrated
	}

	db.exec(`PRAGMA foreign_keys = OFF`);
	try {
		db.exec(`
			CREATE TABLE sdk_messages_new (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'sent' CHECK(send_status IN ('saved', 'queued', 'sent', 'failed')),
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			)
		`);
		db.exec(`INSERT INTO sdk_messages_new SELECT * FROM sdk_messages`);
		db.exec(`DROP TABLE sdk_messages`);
		db.exec(`ALTER TABLE sdk_messages_new RENAME TO sdk_messages`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_id ON sdk_messages(session_id)`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
		);
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Migration 16: Replace 'escalated' with 'review' in tasks CHECK constraint,
 * remove 'hibernated' from session_groups CHECK constraint,
 * add config column to rooms table.
 *
 * - Tasks: 'escalated' → 'review' (existing escalated rows mapped to 'failed')
 * - Session groups: remove 'hibernated' (existing hibernated rows mapped to 'failed')
 * - Rooms: add config TEXT column for agent sub-agents and other room config
 */
function runMigration16(db: BunDatabase): void {
	// --- Tasks table: replace 'escalated' with 'review' ---
	if (tableExists(db, 'tasks')) {
		// Test if migration is needed by trying to insert a 'review' status
		const testId = '__migration15_task_test__';
		let needsTaskMigration = false;
		try {
			db.prepare(
				`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
				 VALUES (?, 'test', 'test', 'test', 'review', 'normal', '[]', 0)`
			).run(testId);
			db.prepare(`DELETE FROM tasks WHERE id = ?`).run(testId);
		} catch {
			needsTaskMigration = true;
		}

		if (needsTaskMigration) {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				// Map any existing 'escalated' tasks to 'failed'
				db.exec(`PRAGMA ignore_check_constraints = 1`);
				db.exec(`UPDATE tasks SET status = 'failed' WHERE status = 'escalated'`);
				db.exec(`PRAGMA ignore_check_constraints = 0`);

				// Drop leftover temp table from a previous crashed migration attempt
				db.exec(`DROP TABLE IF EXISTS tasks_new`);

				db.exec(`
					CREATE TABLE tasks_new (
						id TEXT PRIMARY KEY,
						room_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL,
						status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'failed')),
						priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT DEFAULT '[]',
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						task_type TEXT DEFAULT 'coding' CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review')),
						assigned_agent TEXT DEFAULT 'coder',
						created_by_task_id TEXT,
						FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
					)
				`);
				// Build column list dynamically — old schemas may not have all columns
				const cols = [
					'id', 'room_id', 'title', 'description', 'status', 'priority', 'progress',
					'current_step', 'result', 'error', 'depends_on', 'created_at', 'started_at',
					'completed_at',
				];
				const optionalCols = ['task_type', 'assigned_agent', 'created_by_task_id'];
				for (const col of optionalCols) {
					if (tableHasColumn(db, 'tasks', col)) cols.push(col);
				}
				const selectCols = cols.join(', ');
				db.exec(`INSERT INTO tasks_new (${selectCols}) SELECT ${selectCols} FROM tasks`);
				db.exec(`DROP TABLE tasks`);
				db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}

	// --- Session groups table: remove 'hibernated' ---
	if (tableExists(db, 'session_groups')) {
		const testId = '__migration15_sg_test__';
		let needsGroupMigration = false;
		try {
			// Try inserting 'hibernated' — if it succeeds, the constraint still allows it
			db.prepare(
				`INSERT INTO session_groups (id, group_type, ref_id, state, version, metadata, created_at)
				 VALUES (?, 'task', 'test', 'hibernated', 0, '{}', 0)`
			).run(testId);
			db.prepare(`DELETE FROM session_groups WHERE id = ?`).run(testId);
			needsGroupMigration = true; // 'hibernated' is still allowed, need to remove it
		} catch {
			// 'hibernated' already not allowed — migration done
		}

		if (needsGroupMigration) {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				// Map any existing 'hibernated' groups to 'failed'
				db.exec(`UPDATE session_groups SET state = 'failed' WHERE state = 'hibernated'`);

				// Drop leftover temp table from a previous crashed migration attempt
				db.exec(`DROP TABLE IF EXISTS session_groups_new`);

				db.exec(`
					CREATE TABLE session_groups_new (
						id TEXT PRIMARY KEY,
						group_type TEXT NOT NULL DEFAULT 'task',
						ref_id TEXT NOT NULL,
						state TEXT NOT NULL DEFAULT 'awaiting_worker'
							CHECK(state IN ('awaiting_worker', 'awaiting_leader', 'awaiting_human', 'completed', 'failed')),
						version INTEGER NOT NULL DEFAULT 0,
						metadata TEXT NOT NULL DEFAULT '{}',
						created_at INTEGER NOT NULL,
						completed_at INTEGER
					)
				`);
				db.exec(`
					INSERT INTO session_groups_new
					SELECT id, group_type, ref_id, state, version, metadata, created_at, completed_at
					FROM session_groups
				`);
				db.exec(`DROP TABLE session_groups`);
				db.exec(`ALTER TABLE session_groups_new RENAME TO session_groups`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_ref ON session_groups(ref_id)`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_state ON session_groups(state)`);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}

	// --- Rooms table: add config column ---
	if (tableExists(db, 'rooms') && !tableHasColumn(db, 'rooms', 'config')) {
		db.exec(`ALTER TABLE rooms ADD COLUMN config TEXT`);
	}
}

/**
 * Helper function to check if a table exists in the database
 */
function tableExists(db: BunDatabase, tableName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(tableName);
	return !!result;
}

/**
 * Helper to check whether a table has a specific column
 */
function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
		.get(columnName);
	return !!result;
}

/**
 * Room cleanup migration (consolidates former migrations 25–36)
 *
 * Room features were never shipped to production, so all room-related tables are
 * dropped unconditionally — createTables() recreates them with the correct schema.
 *
 * For the sessions table (which contains real user data):
 * - Adds type/session_context columns if missing
 * - Rebuilds the table if the type CHECK constraint is outdated, mapping any
 *   dev-only type values to their production equivalents before the rebuild.
 */
function runMigrationRoomCleanup(db: BunDatabase): void {
	db.exec(`PRAGMA foreign_keys = OFF`);
	try {
		// Drop all old experiment and orchestration tables
		db.exec(`DROP TABLE IF EXISTS neo_context_messages`);
		db.exec(`DROP TABLE IF EXISTS neo_contexts`);
		db.exec(`DROP TABLE IF EXISTS neo_tasks`);
		db.exec(`DROP TABLE IF EXISTS neo_memories`);
		db.exec(`DROP TABLE IF EXISTS neo_rooms`);
		db.exec(`DROP TABLE IF EXISTS room_agent_states`);
		db.exec(`DROP TABLE IF EXISTS worker_sessions`);
		db.exec(`DROP TABLE IF EXISTS worker_sessions_orphaned`);
		db.exec(`DROP TABLE IF EXISTS recurring_jobs`);
		db.exec(`DROP TABLE IF EXISTS room_context_versions`);
		db.exec(`DROP TABLE IF EXISTS context_messages`);
		db.exec(`DROP TABLE IF EXISTS contexts`);
		db.exec(`DROP TABLE IF EXISTS memories`);
		db.exec(`DROP TABLE IF EXISTS session_pairs`);
		db.exec(`DROP TABLE IF EXISTS task_pairs`);
		db.exec(`DROP TABLE IF EXISTS rendered_prompts`);
		db.exec(`DROP TABLE IF EXISTS prompt_templates`);

		// Room runtime tables (rooms, tasks, goals, session_groups, etc.) are now
		// production tables with real data — do NOT drop them here.
		// createTables() uses CREATE TABLE IF NOT EXISTS, so they will be created
		// on first run and preserved on subsequent runs.

		if (!tableExists(db, 'sessions')) return;

		// Ensure sessions has the new columns
		if (!tableHasColumn(db, 'sessions', 'type')) {
			db.exec(`ALTER TABLE sessions ADD COLUMN type TEXT DEFAULT 'worker'`);
		}
		if (!tableHasColumn(db, 'sessions', 'session_context')) {
			db.exec(`ALTER TABLE sessions ADD COLUMN session_context TEXT`);
		}

		// Test whether the type CHECK constraint already includes the final set of types
		const testId = '__migration_room_cleanup_test__';
		try {
			db.exec(
				`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type)
				 VALUES ('${testId}', 'test', '/', datetime('now'), datetime('now'), 'active', '{}', '{}', 'planner')`
			);
			db.exec(`DELETE FROM sessions WHERE id = '${testId}'`);
			return; // Constraint is already correct — nothing more to do
		} catch {
			// Constraint is outdated — rebuild sessions below
		}

		// Remap dev-only type values before the rebuild
		db.exec(`PRAGMA ignore_check_constraints = 1`);
		db.exec(`UPDATE sessions SET type = 'coder' WHERE type IN ('craft', 'room_self')`);
		db.exec(`UPDATE sessions SET type = 'leader' WHERE type IN ('lead', 'manager')`);
		db.exec(`PRAGMA ignore_check_constraints = 0`);
		// Delete any remaining room-only session types (dev data, not present in production)
		db.exec(
			`DELETE FROM sessions WHERE type NOT IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby')`
		);

		db.exec(`
			CREATE TABLE sessions_new (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
				config TEXT NOT NULL,
				metadata TEXT NOT NULL,
				is_worktree INTEGER DEFAULT 0,
				worktree_path TEXT,
				main_repo_path TEXT,
				worktree_branch TEXT,
				git_branch TEXT,
				sdk_session_id TEXT,
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				parent_id TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby')),
				session_context TEXT
			)
		`);
		db.exec(`
			INSERT INTO sessions_new
			SELECT id, title, workspace_path, created_at, last_active_at,
				status, config, metadata, is_worktree, worktree_path, main_repo_path,
				worktree_branch, git_branch, sdk_session_id, available_commands,
				processing_state, archived_at, parent_id, type, session_context
			FROM sessions
		`);
		db.exec(`DROP TABLE sessions`);
		db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}
