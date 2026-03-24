/**
 * Database Migrations
 *
 * Migrations 1–13 handle incremental schema changes to core tables.
 * runMigrationRoomCleanup consolidates former migrations 25–36 (room feature
 * experiments that never shipped to production) into a single drop-and-recreate
 * cleanup. Migration 29 is the single consolidated migration for all Space system
 * tables — do not add separate Space migrations after it. CRITICAL: Preserve the
 * order of migrations.
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

	// Migration 17: Fix goals table CHECK constraint and add goal_review_attempts column
	runMigration17(db);

	// Migration 18: Add 'cancelled' to tasks status CHECK constraint
	runMigration18(db);

	// Migration 19: Remove legacy mirrored session_group_messages table
	runMigration19(db);

	// Migration 20: Add archived_at column to tasks table
	runMigration20(db);

	// Migration 21: Backfill submittedForReview metadata for active awaiting_human groups
	runMigration21(db);

	// Migration 22: Drop legacy session_groups.state column and index
	runMigration22(db);

	// Migration 23: Add active_session column to tasks table
	runMigration23(db);

	// Migration 24: Rename 'failed' task status to 'needs_attention' for better semantic clarity
	runMigration24(db);

	// Migration 25: Add PR fields to tasks table
	runMigration25(db);

	// Migration 26: Add input_draft column to tasks table for server-side draft persistence
	runMigration26(db);

	// Migration 27: Add updated_at column to tasks table for sorting by most recently updated
	runMigration27(db);

	// Migration 28: Add mission metadata columns to goals table, create mission_metric_history
	// and mission_executions tables for Goal V2 / Mission System
	runMigration28(db);

	// Migration 29: Create all Space system tables (fully consolidated schema).
	// All space tables and columns — including role, provider, inject_workflow_context,
	// start_step_id, current_step_id, and space_workflow_transitions — are created here
	// in a single idempotent migration. (Note: M45 renames step→node columns/tables.)
	runMigration29(db);

	// Migration 30: Add layout column to space_workflows for visual editor node positions.
	runMigration30(db);

	// Migration 31: Add 'space_task_agent' to sessions type CHECK constraint.
	runMigration31(db);

	// Migration 32: Add task_agent_session_id column to space_tasks.
	runMigration32(db);

	// Migration 33: Add autonomy_level column to spaces table.
	runMigration33(db);

	// Migration 34: Add goal_id column to space_tasks for goal/mission association.
	runMigration34(db);

	// Migration 35: Add iteration tracking columns to space_workflow_runs.
	runMigration35(db);

	// Migration 36: Add max_iterations column to space_workflows.
	runMigration36(db);

	// Migration 37: Add goal_id column to space_workflow_runs for goal/mission association.
	runMigration37(db);

	// Migration 38: Add is_cyclic column to space_workflow_transitions.
	runMigration38(db);

	// Migration 39: Add 'archived' to status CHECK constraints on tasks and space_tasks.
	runMigration39(db);

	// Migration 40: Flexible session groups — add task_id + status to space_session_groups,
	// drop role CHECK constraint and add agent_id + status to space_session_group_members.
	runMigration40(db);

	// Migration 41: Historical no-op. Kept for migration-number continuity.
	runMigration41(db);

	// Migration 42: Clean up stale/zombie session groups and add partial unique index
	// on session_groups(ref_id) WHERE completed_at IS NULL to prevent future duplicates.
	runMigration42(db);

	// Migration 43: Drop legacy session_group_messages projection table.
	runMigration43(db);

	// Migration 44: Rename sdk_messages send_status values to deferred/enqueued/consumed.
	runMigration44(db);

	// Migration 45: Rename step-related columns and tables to node
	// - space_workflow_steps -> space_workflow_nodes
	// - start_step_id -> start_node_id in space_workflows
	// - from_step_id -> from_node_id, to_step_id -> to_node_id in space_workflow_transitions
	// - workflow_step_id -> workflow_node_id in space_tasks
	// - current_step_id -> current_node_id in space_workflow_runs
	// - current_step_id -> current_node_id in space_session_groups
	runMigration45(db);
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
		// Inspect CHECK constraint text instead of probe INSERT.
		// Probe inserts can fail due to FK constraints (tasks.room_id -> rooms.id)
		// even when the status CHECK is already migrated.
		const tableInfo = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
			.get() as { sql: string } | null;
		const needsTaskMigration =
			tableInfo !== null &&
			(tableInfo.sql.includes("'escalated'") || !tableInfo.sql.includes("'review'"));

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
						status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'failed', 'cancelled')),
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
					'id',
					'room_id',
					'title',
					'description',
					'status',
					'priority',
					'progress',
					'current_step',
					'result',
					'error',
					'depends_on',
					'created_at',
					'started_at',
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
 * Migration 17: Fix goals table CHECK constraint and add goal_review_attempts column
 *
 * The goals table was created with an old CHECK constraint:
 *   CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked'))
 * The correct constraint (matching GoalStatus type) is:
 *   CHECK(status IN ('active', 'needs_human', 'completed', 'archived'))
 *
 * Also adds the goal_review_attempts column defined in the RoomGoal interface
 * but missing from the original table schema.
 *
 * Status mapping: pending → active, in_progress → active, blocked → needs_human
 *
 * CRITICAL: Must disable foreign_keys during table recreation to prevent
 * CASCADE delete from wiping related data when we DROP TABLE goals.
 */
function runMigration17(db: BunDatabase): void {
	if (!tableExists(db, 'goals')) {
		return;
	}

	// Check if migration is needed: try inserting a row with status='active'
	// If it fails, the old CHECK constraint is in place and we need to recreate the table.
	// Also check if goal_review_attempts column is already present.
	const testId = '__migration16_goals_test__';
	let needsConstraintFix = false;
	try {
		db.prepare(
			`INSERT INTO goals (id, room_id, title, description, status, priority, created_at, updated_at)
			 VALUES (?, 'test', 'test', '', 'active', 'normal', 0, 0)`
		).run(testId);
		db.prepare(`DELETE FROM goals WHERE id = ?`).run(testId);
	} catch {
		needsConstraintFix = true;
	}

	const needsColumn = !tableHasColumn(db, 'goals', 'goal_review_attempts');

	if (!needsConstraintFix && !needsColumn) {
		return; // Already up to date
	}

	db.exec('PRAGMA foreign_keys = OFF');
	try {
		if (needsConstraintFix) {
			// Map old status values to new ones before recreating the table
			db.exec(`PRAGMA ignore_check_constraints = 1`);
			db.exec(`UPDATE goals SET status = 'active' WHERE status IN ('pending', 'in_progress')`);
			db.exec(`UPDATE goals SET status = 'needs_human' WHERE status = 'blocked'`);
			db.exec(`PRAGMA ignore_check_constraints = 0`);
		}

		// Drop leftover temp table from a previous crashed migration attempt
		db.exec(`DROP TABLE IF EXISTS goals_new`);

		// Determine which optional columns exist so we can carry them over
		const hasGoalReviewAttempts = tableHasColumn(db, 'goals', 'goal_review_attempts');
		const hasPlanningAttempts = tableHasColumn(db, 'goals', 'planning_attempts');

		db.exec(`
			CREATE TABLE goals_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'needs_human', 'completed', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]',
				metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				planning_attempts INTEGER DEFAULT 0,
				goal_review_attempts INTEGER DEFAULT 0,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

		// Build column list — only include goal_review_attempts if it existed before
		const cols = [
			'id',
			'room_id',
			'title',
			'description',
			'status',
			'priority',
			'progress',
			'linked_task_ids',
			'metrics',
			'created_at',
			'updated_at',
			'completed_at',
		];
		if (hasPlanningAttempts) {
			cols.push('planning_attempts');
		}
		if (hasGoalReviewAttempts) {
			cols.push('goal_review_attempts');
		}
		const selectCols = cols.join(', ');
		db.exec(`INSERT INTO goals_new (${selectCols}) SELECT ${selectCols} FROM goals`);

		db.exec(`DROP TABLE goals`);
		db.exec(`ALTER TABLE goals_new RENAME TO goals`);

		db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_room ON goals(room_id)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 18: Add 'cancelled' to tasks status CHECK constraint
 *
 * Cancelled tasks are intentionally stopped by the user — semantically distinct from failed.
 * Uses the same table-rebuild pattern required by SQLite's lack of ALTER CONSTRAINT support.
 */
function runMigration18(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}

	// Test if migration is needed by inspecting the CHECK constraint in the schema text.
	// We use sqlite_master instead of a probe INSERT to avoid triggering a FK violation:
	// tasks.room_id references rooms(id), and inserting with a fake room_id would fail
	// when foreign_keys=ON (which the app enables at startup), spuriously triggering a
	// full table-rebuild on every startup even for already-migrated databases.
	const tableInfo = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
		.get() as { sql: string } | null;
	const needsMigration = tableInfo !== null && !tableInfo.sql.includes("'cancelled'");

	if (!needsMigration) return;

	db.exec('PRAGMA foreign_keys = OFF');
	try {
		db.exec(`DROP TABLE IF EXISTS tasks_new`);

		db.exec(`
			CREATE TABLE tasks_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'failed', 'cancelled')),
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

		const cols = [
			'id',
			'room_id',
			'title',
			'description',
			'status',
			'priority',
			'progress',
			'current_step',
			'result',
			'error',
			'depends_on',
			'created_at',
			'started_at',
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
function runMigration19(db: BunDatabase): void {
	db.exec(`DROP TABLE IF EXISTS session_group_messages`);
	db.exec(`DROP INDEX IF EXISTS idx_sgmsg_group`);
}

/**
 * Migration 20: Add archived_at column to tasks table
 *
 * archived_at is orthogonal to status - a task can be completed+archived, failed+archived, etc.
 * This supports the worktree cleanup strategy where:
 * - completed/cancelled tasks cleanup worktree immediately
 * - failed tasks keep worktree for debugging
 * - archived tasks cleanup worktree when user explicitly archives
 */
function runMigration20(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}

	// Check if archived_at column already exists
	if (tableHasColumn(db, 'tasks', 'archived_at')) {
		return;
	}

	db.exec(`ALTER TABLE tasks ADD COLUMN archived_at INTEGER`);
}

/**
 * Migration 21: Backfill submittedForReview metadata from legacy state column.
 *
 * For pre-existing databases, active groups may rely on `state='awaiting_human'`
 * without metadata.submittedForReview set. Runtime behavior now relies on metadata,
 * so this migration copies that semantic flag into metadata once.
 */
function runMigration21(db: BunDatabase): void {
	if (!tableExists(db, 'session_groups')) {
		return;
	}
	if (!tableHasColumn(db, 'session_groups', 'state')) {
		return;
	}

	const rows = db
		.prepare(
			`SELECT id, metadata
			 FROM session_groups
			 WHERE completed_at IS NULL AND state = 'awaiting_human'`
		)
		.all() as Array<{ id: string; metadata: string | null }>;

	const update = db.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`);
	for (const row of rows) {
		let meta: Record<string, unknown> = {};
		if (row.metadata) {
			try {
				meta = JSON.parse(row.metadata) as Record<string, unknown>;
			} catch {
				meta = {};
			}
		}
		if (meta.submittedForReview === true) {
			continue;
		}
		meta.submittedForReview = true;
		update.run(JSON.stringify(meta), row.id);
	}
}

/**
 * Migration 22: Drop legacy `session_groups.state` and its index.
 *
 * Routing semantics now rely on completed_at + metadata.submittedForReview.
 */
function runMigration22(db: BunDatabase): void {
	db.exec(`DROP INDEX IF EXISTS idx_session_groups_state`);

	if (!tableExists(db, 'session_groups')) {
		return;
	}
	if (!tableHasColumn(db, 'session_groups', 'state')) {
		return;
	}

	db.exec(`ALTER TABLE session_groups DROP COLUMN state`);
}

/**
 * Migration 23: Add active_session column to tasks table.
 * Tracks which agent session is currently generating output ('worker' | 'leader' | null).
 * Allows the UI to show a "working" indicator even when the task status is 'review'.
 */
function runMigration23(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}
	if (tableHasColumn(db, 'tasks', 'active_session')) {
		return;
	}
	db.exec(`ALTER TABLE tasks ADD COLUMN active_session TEXT`);
}

/**
 * Migration 24: Rename 'failed' task status to 'needs_attention'.
 *
 * Uses the table-rebuild pattern required by SQLite's lack of ALTER CONSTRAINT support.
 * Also updates any existing task rows with status='failed' to 'needs_attention'.
 */
function runMigration24(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}

	// Check if migration is needed by inspecting the CHECK constraint.
	const tableInfo = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
		.get() as { sql: string } | null;
	const needsMigration = tableInfo !== null && tableInfo.sql.includes("'failed'");

	if (!needsMigration) return;

	db.exec('PRAGMA foreign_keys = OFF');
	try {
		db.exec(`DROP TABLE IF EXISTS tasks_new`);

		db.exec(`
			CREATE TABLE tasks_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled')),
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
				archived_at INTEGER,
				active_session TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

		// Build column list dynamically for the INSERT SELECT (handles optional columns)
		const baseCols = [
			'id',
			'room_id',
			'title',
			'description',
			'priority',
			'progress',
			'current_step',
			'result',
			'error',
			'depends_on',
			'created_at',
			'started_at',
			'completed_at',
		];
		const optionalCols = [
			'task_type',
			'assigned_agent',
			'created_by_task_id',
			'archived_at',
			'active_session',
			'pr_url',
			'pr_number',
			'pr_created_at',
		];
		for (const col of optionalCols) {
			if (tableHasColumn(db, 'tasks', col)) baseCols.push(col);
		}

		// Rename 'failed' → 'needs_attention' during the copy using CASE expression
		const colsWithoutStatus = baseCols.join(', ');
		db.exec(`PRAGMA ignore_check_constraints = 1`);
		db.exec(`
			INSERT INTO tasks_new (status, ${colsWithoutStatus})
			SELECT
				CASE WHEN status = 'failed' THEN 'needs_attention' ELSE status END,
				${colsWithoutStatus}
			FROM tasks
		`);
		db.exec(`PRAGMA ignore_check_constraints = 0`);

		db.exec(`DROP TABLE tasks`);
		db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 25: Add PR fields to tasks table.
 *
 * Adds pr_url, pr_number, pr_created_at as first-class columns so PR data
 * is no longer stored as a hack in current_step.
 */
function runMigration25(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}
	if (!tableHasColumn(db, 'tasks', 'pr_url')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
	}
	if (!tableHasColumn(db, 'tasks', 'pr_number')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN pr_number INTEGER`);
	}
	if (!tableHasColumn(db, 'tasks', 'pr_created_at')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN pr_created_at INTEGER`);
	}
}

/**
 * Migration 26: Add input_draft column to tasks table for server-side draft persistence
 */
function runMigration26(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}
	if (tableHasColumn(db, 'tasks', 'input_draft')) {
		return;
	}
	db.exec(`ALTER TABLE tasks ADD COLUMN input_draft TEXT`);
}

function runMigration27(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}
	if (!tableHasColumn(db, 'tasks', 'updated_at')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN updated_at INTEGER`);
		// Backfill updated_at with the best available timestamp for existing rows
		db.exec(
			`UPDATE tasks SET updated_at = COALESCE(completed_at, started_at, created_at) WHERE updated_at IS NULL`
		);
	}
	// Add composite index for listTasks() query: WHERE room_id = ? ORDER BY updated_at DESC
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`);
}

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

/**
 * Migration 28: Add mission metadata columns to goals table and create
 * mission_metric_history and mission_executions tables.
 *
 * New columns on goals:
 * - mission_type, autonomy_level (with CHECK constraints)
 * - schedule (JSON), schedule_paused, next_run_at
 * - structured_metrics (JSON)
 * - max_consecutive_failures, max_planning_attempts, consecutive_failures
 *
 * New tables:
 * - mission_metric_history: metric data points per goal
 * - mission_executions: execution runs per goal (with partial unique index
 *   on (goal_id) WHERE status = 'running' for at-most-one-running invariant)
 *
 * Backfills existing goals: mission_type = 'one_shot', autonomy_level = 'supervised'
 */
function runMigration28(db: BunDatabase): void {
	// --- Add columns to goals table ---
	if (tableExists(db, 'goals')) {
		if (!tableHasColumn(db, 'goals', 'mission_type')) {
			db.exec(
				`ALTER TABLE goals ADD COLUMN mission_type TEXT NOT NULL DEFAULT 'one_shot'` +
					` CHECK(mission_type IN ('one_shot', 'measurable', 'recurring'))`
			);
			// Backfill existing rows (ALTER TABLE DEFAULT already handles it, but be explicit)
			db.exec(`UPDATE goals SET mission_type = 'one_shot' WHERE mission_type IS NULL`);
		}
		if (!tableHasColumn(db, 'goals', 'autonomy_level')) {
			db.exec(
				`ALTER TABLE goals ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'supervised'` +
					` CHECK(autonomy_level IN ('supervised', 'semi_autonomous'))`
			);
			db.exec(`UPDATE goals SET autonomy_level = 'supervised' WHERE autonomy_level IS NULL`);
		}
		if (!tableHasColumn(db, 'goals', 'schedule')) {
			db.exec(`ALTER TABLE goals ADD COLUMN schedule TEXT`);
		}
		if (!tableHasColumn(db, 'goals', 'schedule_paused')) {
			db.exec(`ALTER TABLE goals ADD COLUMN schedule_paused INTEGER NOT NULL DEFAULT 0`);
		}
		if (!tableHasColumn(db, 'goals', 'next_run_at')) {
			db.exec(`ALTER TABLE goals ADD COLUMN next_run_at INTEGER`);
		}
		if (!tableHasColumn(db, 'goals', 'structured_metrics')) {
			db.exec(`ALTER TABLE goals ADD COLUMN structured_metrics TEXT`);
		}
		if (!tableHasColumn(db, 'goals', 'max_consecutive_failures')) {
			db.exec(`ALTER TABLE goals ADD COLUMN max_consecutive_failures INTEGER NOT NULL DEFAULT 3`);
		}
		if (!tableHasColumn(db, 'goals', 'max_planning_attempts')) {
			db.exec(`ALTER TABLE goals ADD COLUMN max_planning_attempts INTEGER NOT NULL DEFAULT 0`);
		} else {
			// Reset old default sentinel 5 → 0. Zero means "use room config" (no per-goal override).
			// The prior migration used 5 as the column default, but that was never a meaningful
			// user-set value; it caused all goals to appear as if they had an explicit override.
			db.exec(`UPDATE goals SET max_planning_attempts = 0 WHERE max_planning_attempts = 5`);
		}
		if (!tableHasColumn(db, 'goals', 'consecutive_failures')) {
			db.exec(`ALTER TABLE goals ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`);
		}
		if (!tableHasColumn(db, 'goals', 'replan_count')) {
			db.exec(`ALTER TABLE goals ADD COLUMN replan_count INTEGER NOT NULL DEFAULT 0`);
		}
		// Composite index for efficient scheduler queries
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_goals_mission_scheduler` +
				` ON goals(mission_type, schedule_paused, next_run_at)`
		);
	}

	// --- Create mission_metric_history table ---
	db.exec(`
		CREATE TABLE IF NOT EXISTS mission_metric_history (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			metric_name TEXT NOT NULL,
			value REAL NOT NULL,
			recorded_at INTEGER NOT NULL,
			FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_mission_metric_history_lookup` +
			` ON mission_metric_history(goal_id, metric_name, recorded_at)`
	);

	// --- Create mission_executions table ---
	db.exec(`
		CREATE TABLE IF NOT EXISTS mission_executions (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			execution_number INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			status TEXT NOT NULL DEFAULT 'running',
			result_summary TEXT,
			task_ids TEXT NOT NULL DEFAULT '[]',
			planning_attempts INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
			UNIQUE(goal_id, execution_number)
		)
	`);
	// Partial unique index: at most one running execution per goal
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running` +
			` ON mission_executions(goal_id) WHERE status = 'running'`
	);
}

/**
 * Migration 29: Create all Space system tables (fully consolidated schema)
 *
 * Creates the following tables in FK-safe order:
 * - spaces: workspace-first multi-agent container
 * - space_agents: custom agents per space (role/provider/inject_workflow_context included, no CHECK on role)
 * - space_workflows: workflow definitions per space (includes start_step_id)
 * - space_workflow_steps: ordered steps within a workflow
 * - space_workflow_transitions: directed edges between steps (graph navigation)
 * - space_workflow_runs: active/historical workflow executions (includes current_step_id)
 * - space_tasks: tasks with built-in custom_agent_id, workflow_run_id, workflow_step_id
 * - space_session_groups: named groups of related sessions (includes workflow_run_id, current_step_id, task_id)
 * - space_session_group_members: membership records with freeform role, agent_id, and status
 *
 * All tables are created with IF NOT EXISTS so the migration is idempotent.
 * CASCADE deletes propagate from spaces → all child tables.
 */
function runMigration29(db: BunDatabase): void {
	// -------------------------------------------------------------------------
	// spaces
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS spaces (
			id TEXT PRIMARY KEY,
			workspace_path TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			background_context TEXT NOT NULL DEFAULT '',
			instructions TEXT NOT NULL DEFAULT '',
			default_model TEXT,
			allowed_models TEXT NOT NULL DEFAULT '[]',
			session_ids TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'archived')),
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status)`);
	// Note: workspace_path has a UNIQUE constraint which SQLite implements as an implicit
	// unique index — no explicit CREATE INDEX needed.

	// -------------------------------------------------------------------------
	// space_agents
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			tools TEXT NOT NULL DEFAULT '[]',
			system_prompt TEXT NOT NULL DEFAULT '',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			role TEXT NOT NULL,
			provider TEXT,
			inject_workflow_context INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_agents_space_id ON space_agents(space_id)`);

	// -------------------------------------------------------------------------
	// space_workflows
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			start_step_id TEXT,
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_workflows_space_id ON space_workflows(space_id)`);

	// -------------------------------------------------------------------------
	// space_workflow_steps
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_steps (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			agent_id TEXT,
			order_index INTEGER NOT NULL,
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_steps_workflow_id ON space_workflow_steps(workflow_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_steps_order ON space_workflow_steps(workflow_id, order_index)`
	);

	// -------------------------------------------------------------------------
	// space_workflow_transitions (directed edges between steps)
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_transitions (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			from_step_id TEXT NOT NULL,
			to_step_id TEXT NOT NULL,
			condition TEXT,
			order_index INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
			FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
			FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_workflow_id ON space_workflow_transitions(workflow_id)`
	);
	if (tableHasColumn(db, 'space_workflow_transitions', 'from_step_id')) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_from_step ON space_workflow_transitions(workflow_id, from_step_id)`
		);
	}

	// -------------------------------------------------------------------------
	// space_workflow_runs  (must be before space_tasks — FK dependency)
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_runs (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			workflow_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			current_step_index INTEGER NOT NULL DEFAULT 0,
			current_step_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_status ON space_workflow_runs(status)`
	);

	// -------------------------------------------------------------------------
	// space_tasks
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			task_type TEXT
				CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
			assigned_agent TEXT
				CHECK(assigned_agent IN ('coder', 'general')),
			custom_agent_id TEXT,
			workflow_run_id TEXT,
			workflow_step_id TEXT,
			created_by_task_id TEXT,
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT NOT NULL DEFAULT '[]',
			input_draft TEXT,
			active_session TEXT
				CHECK(active_session IN ('worker', 'leader')),
			task_agent_session_id TEXT,
			pr_url TEXT,
			pr_number INTEGER,
			pr_created_at INTEGER,
			archived_at INTEGER,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
			FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
	);
	if (tableHasColumn(db, 'space_tasks', 'workflow_step_id')) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_step_id ON space_tasks(workflow_step_id)`
		);
	}
	// Note: idx_space_tasks_task_agent_session_id is created by migration 32,
	// which first adds the column via ALTER TABLE for existing databases.
	// Note: goal_id column is added by migration 34 (ALTER TABLE for existing DBs).

	// -------------------------------------------------------------------------
	// space_session_groups
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_session_groups (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT,
			workflow_run_id TEXT,
			current_step_id TEXT,
			task_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_session_groups_space_id ON space_session_groups(space_id)`
	);

	// -------------------------------------------------------------------------
	// space_session_group_members
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_session_group_members (
			id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL,
			agent_id TEXT,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'completed', 'failed')),
			order_index INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (group_id) REFERENCES space_session_groups(id) ON DELETE CASCADE,
			UNIQUE(group_id, session_id)
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_group_id ON space_session_group_members(group_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_session_id ON space_session_group_members(session_id)`
	);

	// -------------------------------------------------------------------------
	// Idempotent column upgrades for existing databases
	//
	// The CREATE TABLE statements above include the final column set, so fresh
	// databases need nothing more. For databases that were created by an earlier
	// version of this migration (before all columns were consolidated), we add
	// any missing columns here.
	// -------------------------------------------------------------------------

	// space_agents: role (added in former migration 30)
	try {
		db.prepare(`SELECT role FROM space_agents LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_agents ADD COLUMN role TEXT NOT NULL DEFAULT 'coder'`);
	}

	// space_agents: provider (added in former migration 30)
	try {
		db.prepare(`SELECT provider FROM space_agents LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_agents ADD COLUMN provider TEXT`);
	}

	// space_agents: inject_workflow_context (added in former migration 33)
	try {
		db.prepare(`SELECT inject_workflow_context FROM space_agents LIMIT 1`).all();
	} catch {
		db.exec(
			`ALTER TABLE space_agents ADD COLUMN inject_workflow_context INTEGER NOT NULL DEFAULT 0`
		);
	}

	// space_workflows: start_step_id (added in former migration 32)
	try {
		db.prepare(`SELECT start_step_id FROM space_workflows LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN start_step_id TEXT`);
	}

	// space_workflow_runs: current_step_id (added in former migration 32)
	try {
		db.prepare(`SELECT current_step_id FROM space_workflow_runs LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflow_runs ADD COLUMN current_step_id TEXT`);
	}

	// space_workflow_transitions table (added in former migration 32) — CREATE TABLE
	// is already above with IF NOT EXISTS, so this is handled automatically.

	// Former migration 31 removed a CHECK constraint on space_agents.role that was
	// introduced by the old migration 30. On databases where that ALTER TABLE ran,
	// the constraint may still be present. Rebuild the table to remove it.
	const agentSchema = db
		.prepare<{ sql: string }, []>(
			`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_agents'`
		)
		.get();
	if (agentSchema?.sql.includes('CHECK(role IN')) {
		db.transaction(() => {
			db.exec(`
				CREATE TABLE space_agents_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					model TEXT,
					tools TEXT NOT NULL DEFAULT '[]',
					system_prompt TEXT NOT NULL DEFAULT '',
					config TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					role TEXT NOT NULL DEFAULT 'coder',
					provider TEXT,
					inject_workflow_context INTEGER NOT NULL DEFAULT 0,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				)
			`);

			// Copy all columns that existed before, filling inject_workflow_context with
			// the default for rows that pre-date that column.
			db.exec(`
				INSERT INTO space_agents_new
					(id, space_id, name, description, model, tools, system_prompt, config,
					 created_at, updated_at, role, provider, inject_workflow_context)
				SELECT
					id, space_id, name, description, model, tools, system_prompt, config,
					created_at, updated_at, role, provider,
					COALESCE(inject_workflow_context, 0)
				FROM space_agents
			`);

			db.exec(`DROP TABLE space_agents`);
			db.exec(`ALTER TABLE space_agents_new RENAME TO space_agents`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_agents_space_id ON space_agents(space_id)`);
		})();
	}

	// -------------------------------------------------------------------------
	// Add 'spaces_global' to sessions type CHECK constraint
	// -------------------------------------------------------------------------
	// SQLite doesn't support ALTER CHECK, so we recreate the table.
	if (tableExists(db, 'sessions')) {
		try {
			const testId = '__migration_test_spaces_global_type__';
			db.prepare(
				`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(
				testId,
				'Test',
				'/tmp',
				new Date().toISOString(),
				new Date().toISOString(),
				'active',
				'{}',
				'{}',
				0,
				'spaces_global'
			);
			db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
		} catch {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
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
						type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global')),
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
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}
}

/**
 * Migration 30: Add `layout` column to `space_workflows` for visual editor node positions.
 *
 * Stores node positions as JSON (`Record<stepId, {x, y}>`). Nullable — existing
 * workflows without layout data return NULL from the DB (mapped to undefined in code).
 */
function runMigration30(db: BunDatabase): void {
	try {
		db.prepare(`SELECT layout FROM space_workflows LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN layout TEXT`);
	}
}

/**
 * Migration 31: Add 'space_task_agent' to sessions type CHECK constraint.
 *
 * SQLite doesn't support ALTER CHECK, so we use the probe-insert + table-recreate
 * pattern: attempt to insert a row with type='space_task_agent'; if the constraint
 * rejects it, recreate the sessions table with the expanded CHECK list.
 */
function runMigration31(db: BunDatabase): void {
	if (!tableExists(db, 'sessions')) return;

	try {
		const testId = '__migration_test_space_task_agent_type__';
		db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			testId,
			'Test',
			'/tmp',
			new Date().toISOString(),
			new Date().toISOString(),
			'active',
			'{}',
			'{}',
			0,
			'space_task_agent'
		);
		db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
	} catch {
		db.exec('PRAGMA foreign_keys = OFF');
		try {
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
					type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent')),
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
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}

/**
 * Migration 32: Add `task_agent_session_id` column to `space_tasks`.
 *
 * Stores the ID of the Task Agent session associated with this task. Nullable —
 * tasks without a Task Agent return NULL (mapped to undefined in code).
 */
function runMigration32(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;
	try {
		db.prepare(`SELECT task_agent_session_id FROM space_tasks LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN task_agent_session_id TEXT`);
	}
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
	);
}

/**
 * Migration 33: Add `autonomy_level` column to `spaces`.
 *
 * Controls how much the Space Agent can act autonomously:
 * - 'supervised' (default): notifies human of all judgment calls, waits for approval.
 * - 'semi_autonomous': retries/reassigns tasks autonomously; escalates after one failed retry.
 *
 * Default is 'supervised' so all existing spaces remain supervised after migration.
 */
function runMigration33(db: BunDatabase): void {
	if (!tableExists(db, 'spaces')) return;
	try {
		db.prepare(`SELECT autonomy_level FROM spaces LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE spaces ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'supervised'`);
	}
}

/**
 * Migration 34: Add goal_id column to space_tasks.
 *
 * Links space tasks to goals/missions for cross-workflow-run querying.
 * Nullable — existing tasks will have goal_id as NULL.
 */
function runMigration34(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;
	try {
		db.prepare(`SELECT goal_id FROM space_tasks LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN goal_id TEXT`);
	}
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
}

/**
 * Migration 35: Add iteration tracking columns to `space_workflow_runs`.
 *
 * - `iteration_count`: how many times the run has looped back (default 0).
 * - `max_iterations`: safety cap before escalating to needs_attention (default 5).
 */
function runMigration35(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflow_runs')) return;
	try {
		db.prepare(`SELECT iteration_count FROM space_workflow_runs LIMIT 1`).all();
	} catch {
		db.exec(
			`ALTER TABLE space_workflow_runs ADD COLUMN iteration_count INTEGER NOT NULL DEFAULT 0`
		);
	}
	try {
		db.prepare(`SELECT max_iterations FROM space_workflow_runs LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflow_runs ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 5`);
	}
}

/**
 * Migration 36: Add `max_iterations` column to `space_workflows`.
 *
 * Template-level default for the maximum number of cyclic iterations.
 * Nullable — workflows without cyclic transitions don't need a cap.
 */
function runMigration36(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) return;
	try {
		db.prepare(`SELECT max_iterations FROM space_workflows LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN max_iterations INTEGER`);
	}
}

/**
 * Migration 37: Add goal_id column to space_workflow_runs for goal/mission association.
 */
function runMigration37(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflow_runs')) return;
	try {
		db.prepare(`SELECT goal_id FROM space_workflow_runs LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflow_runs ADD COLUMN goal_id TEXT`);
	}
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_goal_id ON space_workflow_runs(goal_id)`
	);
}

/**
 * Migration 38: Add `is_cyclic` column to `space_workflow_transitions`.
 *
 * When a transition is marked as cyclic, following it increments `iterationCount`
 * on the workflow run. This enables explicit cycle detection for iterative workflows
 * without relying on heuristics that would misfire on DAG merge paths.
 *
 * Nullable INTEGER (SQLite boolean): 0 = not cyclic, 1 = cyclic, NULL = not cyclic.
 */
function runMigration38(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflow_transitions')) return;
	try {
		db.prepare(`SELECT is_cyclic FROM space_workflow_transitions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflow_transitions ADD COLUMN is_cyclic INTEGER`);
	}
}

/**
 * Migration 39: Add 'archived' to the status CHECK constraint on `tasks` and `space_tasks`.
 *
 * Uses the SQLite table-rebuild pattern (same as migration 18) because SQLite does not
 * support ALTER TABLE … ALTER CONSTRAINT.
 *
 * After the rebuild, backfills any rows where `archived_at IS NOT NULL` to
 * `status = 'archived'` so the status column becomes the canonical source of truth.
 */
function runMigration39(db: BunDatabase): void {
	// --- tasks table ---
	if (tableExists(db, 'tasks')) {
		const tableInfo = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
			.get() as { sql: string } | null;
		const needsMigration = tableInfo !== null && !tableInfo.sql.includes("'archived'");

		if (needsMigration) {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				db.exec(`DROP TABLE IF EXISTS tasks_new`);
				db.exec(`
					CREATE TABLE tasks_new (
						id TEXT PRIMARY KEY,
						room_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL,
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT DEFAULT '[]',
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						task_type TEXT DEFAULT 'coding'
							CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review')),
						assigned_agent TEXT DEFAULT 'coder',
						created_by_task_id TEXT,
						archived_at INTEGER,
						active_session TEXT,
						pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,
						input_draft TEXT,
						updated_at INTEGER,
						FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
					)
				`);

				const cols = [
					'id',
					'room_id',
					'title',
					'description',
					'status',
					'priority',
					'progress',
					'current_step',
					'result',
					'error',
					'depends_on',
					'created_at',
					'started_at',
					'completed_at',
				];
				const optionalCols = [
					'task_type',
					'assigned_agent',
					'created_by_task_id',
					'archived_at',
					'active_session',
					'pr_url',
					'pr_number',
					'pr_created_at',
					'input_draft',
					'updated_at',
				];
				for (const col of optionalCols) {
					if (tableHasColumn(db, 'tasks', col)) cols.push(col);
				}
				const selectCols = cols.join(', ');
				db.exec(`INSERT INTO tasks_new (${selectCols}) SELECT ${selectCols} FROM tasks`);
				db.exec(`DROP TABLE tasks`);
				db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`
				);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}

		// Backfill: set status = 'archived' for rows with archived_at IS NOT NULL
		db.exec(
			`UPDATE tasks SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'`
		);
	}

	// --- space_tasks table ---
	if (tableExists(db, 'space_tasks')) {
		const tableInfo = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
			.get() as { sql: string } | null;
		const needsMigration = tableInfo !== null && !tableInfo.sql.includes("'archived'");

		if (needsMigration) {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				db.exec(`DROP TABLE IF EXISTS space_tasks_new`);
				db.exec(`
					CREATE TABLE space_tasks_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						task_type TEXT
							CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
						assigned_agent TEXT
							CHECK(assigned_agent IN ('coder', 'general')),
						custom_agent_id TEXT,
						workflow_run_id TEXT,
						workflow_step_id TEXT,
						created_by_task_id TEXT,
						goal_id TEXT,
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						input_draft TEXT,
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
						FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
					)
				`);

				const cols = ['id', 'space_id', 'title', 'description', 'status', 'priority'];
				const optionalCols = [
					'task_type',
					'assigned_agent',
					'custom_agent_id',
					'workflow_run_id',
					'workflow_step_id',
					'created_by_task_id',
					'goal_id',
					'progress',
					'current_step',
					'result',
					'error',
					'depends_on',
					'input_draft',
					'active_session',
					'task_agent_session_id',
					'pr_url',
					'pr_number',
					'pr_created_at',
					'archived_at',
					'created_at',
					'started_at',
					'completed_at',
					'updated_at',
				];
				for (const col of optionalCols) {
					if (tableHasColumn(db, 'space_tasks', col)) cols.push(col);
				}
				const selectCols = cols.join(', ');
				db.exec(
					`INSERT INTO space_tasks_new (${selectCols}) SELECT ${selectCols} FROM space_tasks`
				);
				db.exec(`DROP TABLE space_tasks`);
				db.exec(`ALTER TABLE space_tasks_new RENAME TO space_tasks`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
				);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
				);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_step_id ON space_tasks(workflow_step_id)`
				);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
				);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}

		// Backfill: set status = 'archived' for rows with archived_at IS NOT NULL
		db.exec(
			`UPDATE space_tasks SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'`
		);
	}
}

/**
 * Migration 40: Flexible session groups.
 *
 * space_session_groups:
 *   - Add `task_id TEXT` (nullable) — links group to SpaceTask
 *   - Add `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed'))`
 *   - Add index on space_session_groups(task_id)
 *
 * space_session_group_members:
 *   - Drop the CHECK constraint on `role` so it accepts any freeform string
 *   - Add `agent_id TEXT` (nullable) — references SpaceAgent config
 *   - Add `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed'))`
 *
 * SQLite cannot drop CHECK constraints via ALTER TABLE, so space_session_group_members
 * uses the recreate-table pattern (same as migrations 18 and 39).
 * ALTER TABLE ADD COLUMN is used for the two new space_session_groups columns because
 * no constraint change is needed there.
 */
function runMigration40(db: BunDatabase): void {
	// -------------------------------------------------------------------------
	// space_session_groups — add task_id and status via ALTER TABLE (idempotent)
	// -------------------------------------------------------------------------
	if (tableExists(db, 'space_session_groups')) {
		if (!tableHasColumn(db, 'space_session_groups', 'task_id')) {
			db.exec(`ALTER TABLE space_session_groups ADD COLUMN task_id TEXT`);
		}
		if (!tableHasColumn(db, 'space_session_groups', 'status')) {
			db.exec(
				`ALTER TABLE space_session_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed'))`
			);
		}
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_session_groups_task_id ON space_session_groups(task_id)`
		);
	}

	// -------------------------------------------------------------------------
	// space_session_group_members — recreate table to drop role CHECK constraint
	// and add agent_id + status columns.
	//
	// Idempotency guard: if agent_id already exists the migration has already run.
	// -------------------------------------------------------------------------
	if (
		tableExists(db, 'space_session_group_members') &&
		!tableHasColumn(db, 'space_session_group_members', 'agent_id')
	) {
		db.exec('PRAGMA foreign_keys = OFF');
		try {
			db.exec(`DROP TABLE IF EXISTS space_session_group_members_new`);
			db.exec(`
				CREATE TABLE space_session_group_members_new (
					id TEXT PRIMARY KEY,
					group_id TEXT NOT NULL,
					session_id TEXT NOT NULL,
					role TEXT NOT NULL,
					agent_id TEXT,
					status TEXT NOT NULL DEFAULT 'active'
						CHECK(status IN ('active', 'completed', 'failed')),
					order_index INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					FOREIGN KEY (group_id) REFERENCES space_session_groups(id) ON DELETE CASCADE,
					UNIQUE(group_id, session_id)
				)
			`);

			// Copy existing columns; agent_id and status get their defaults
			const cols = ['id', 'group_id', 'session_id', 'role', 'order_index', 'created_at'];
			const selectCols = cols.join(', ');
			db.exec(
				`INSERT INTO space_session_group_members_new (${selectCols}) SELECT ${selectCols} FROM space_session_group_members`
			);
			db.exec(`DROP TABLE space_session_group_members`);
			db.exec(`ALTER TABLE space_session_group_members_new RENAME TO space_session_group_members`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_group_id ON space_session_group_members(group_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_session_id ON space_session_group_members(session_id)`
			);
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}

/**
 * Migration 41: Historical no-op.
 *
 * Kept for migration-number continuity. The former session_group_messages
 * projection table path was removed; canonical timeline data now comes from
 * sdk_messages + task_group_events.
 */
function runMigration41(_db: BunDatabase): void {
	// No-op.
}

/**
 * Migration 42: Clean up stale/zombie session groups and enforce uniqueness.
 *
 * Step 1: Mark active groups as completed when their task is in a terminal state
 *         (completed, cancelled, archived, needs_attention). These are zombie groups
 *         that were never cleaned up when the task finished.
 *
 * Step 2: For tasks that still have multiple active groups after step 1, keep the
 *         one with the highest rowid (the true insert order tiebreaker), and mark all
 *         others as completed. Uses rowid instead of created_at to avoid failures when
 *         two groups share an identical millisecond timestamp.
 *
 * Step 3: Add a partial unique index on session_groups(ref_id) WHERE completed_at IS NULL,
 *         scoped to task/task_pair group types, to enforce DB-level uniqueness.
 */
function runMigration42(db: BunDatabase): void {
	if (!tableExists(db, 'session_groups') || !tableExists(db, 'tasks')) {
		return;
	}

	const now = Date.now();

	// Step 1: Complete groups whose tasks are already in a terminal state.
	// Includes 'needs_attention' (the renamed 'failed' status from migration 24).
	db.prepare(
		`UPDATE session_groups
		 SET completed_at = ?, version = version + 1
		 WHERE completed_at IS NULL
		   AND group_type IN ('task', 'task_pair')
		   AND ref_id IN (
		     SELECT id FROM tasks
		     WHERE status IN ('completed', 'cancelled', 'archived', 'needs_attention')
		   )`
	).run(now);

	// Step 2: For tasks with multiple active groups, keep the one with the highest rowid
	// (true insert order, no timestamp tie risk) and complete all others.
	const duplicateTasks = db
		.prepare(
			`SELECT ref_id, MAX(rowid) AS max_rowid
			 FROM session_groups
			 WHERE completed_at IS NULL AND group_type IN ('task', 'task_pair')
			 GROUP BY ref_id
			 HAVING COUNT(*) > 1`
		)
		.all() as { ref_id: string; max_rowid: number }[];

	for (const { ref_id, max_rowid } of duplicateTasks) {
		db.prepare(
			`UPDATE session_groups
			 SET completed_at = ?, version = version + 1
			 WHERE ref_id = ? AND completed_at IS NULL AND rowid < ?`
		).run(now, ref_id, max_rowid);
	}

	// Step 3: Add partial unique index — only one active task/task_pair group per ref_id.
	// Scoped to task/task_pair so future group types with different semantics can share
	// ref_id values without violating this constraint.
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_session_groups_active_ref
		 ON session_groups(ref_id) WHERE completed_at IS NULL AND (group_type = 'task' OR group_type = 'task_pair')`
	);
}

/**
 * Migration 43: Drop legacy session_group_messages projection table.
 *
 * The canonical group timeline now comes from sdk_messages + task_group_events.
 * Keeping this mirror table risks drift and confusion after daemon restarts.
 */
function runMigration43(db: BunDatabase): void {
	db.exec(`DROP INDEX IF EXISTS idx_sgm_group`);
	db.exec(`DROP TABLE IF EXISTS session_group_messages`);
}

/**
 * Migration 44: Rename sdk_messages.send_status values.
 *
 * Old values: saved, queued, sent, failed
 * New values: deferred, enqueued, consumed, failed
 */
function runMigration44(db: BunDatabase): void {
	if (!tableExists(db, 'sdk_messages')) {
		return;
	}

	const tableInfo = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sdk_messages'`)
		.get() as { sql: string } | null;

	if (!tableInfo) {
		return;
	}

	// Already migrated
	if (tableInfo.sql.includes("'deferred'") && tableInfo.sql.includes("'consumed'")) {
		return;
	}

	db.exec(`PRAGMA foreign_keys = OFF`);
	try {
		db.exec(`PRAGMA ignore_check_constraints = 1`);
		db.exec(`
			UPDATE sdk_messages
			SET send_status = CASE
				WHEN send_status = 'saved' THEN 'deferred'
				WHEN send_status = 'queued' THEN 'enqueued'
				WHEN send_status = 'sent' THEN 'consumed'
				WHEN send_status IS NULL THEN 'consumed'
				ELSE send_status
			END
		`);
		db.exec(`PRAGMA ignore_check_constraints = 0`);

		db.exec(`
			CREATE TABLE sdk_messages_new (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'consumed', 'failed')),
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
 * Migration 45: Rename step-related columns and tables to node
 *
 * Renames:
 * - space_workflow_steps -> space_workflow_nodes
 * - space_workflows.start_step_id -> start_node_id
 * - space_workflow_transitions.from_step_id -> from_node_id
 * - space_workflow_transitions.to_step_id -> to_node_id
 * - space_tasks.workflow_step_id -> workflow_node_id
 * - space_workflow_runs.current_step_id -> current_node_id
 * - space_session_groups.current_step_id -> current_node_id
 *
 * Uses create-copy-drop-rename pattern for SQLite compatibility.
 */
function runMigration45(db: BunDatabase): void {
	// Skip if space_workflow_steps was already renamed to space_workflow_nodes,
	// or if the spaces feature was never enabled on this DB.
	// Also skip if space_workflow_nodes already exists (migration was already applied).
	if (!tableExists(db, 'space_workflow_steps') || tableExists(db, 'space_workflow_nodes')) {
		return;
	}

	// Issue PRAGMA before BEGIN so it takes effect (SQLite ignores PRAGMA inside a transaction)
	db.exec(`PRAGMA foreign_keys = OFF`);
	db.exec(`BEGIN`);
	try {
		// -------------------------------------------------------------------------
		// 1. Rename space_workflow_steps -> space_workflow_nodes
		// -------------------------------------------------------------------------
		db.exec(`DROP TABLE IF EXISTS space_workflow_nodes_new`);
		db.exec(`
				CREATE TABLE space_workflow_nodes_new (
					id TEXT PRIMARY KEY,
					workflow_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					agent_id TEXT,
					order_index INTEGER NOT NULL,
					config TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
				)
			`);
		db.exec(`
				INSERT INTO space_workflow_nodes_new
				SELECT id, workflow_id, name, description, agent_id, order_index, config, created_at, updated_at
				FROM space_workflow_steps
			`);
		db.exec(`DROP TABLE space_workflow_steps`);
		db.exec(`ALTER TABLE space_workflow_nodes_new RENAME TO space_workflow_nodes`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_workflow_nodes_workflow_id ON space_workflow_nodes(workflow_id)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_workflow_nodes_order ON space_workflow_nodes(workflow_id, order_index)`
		);

		// -------------------------------------------------------------------------
		// 2. Rename space_workflows.start_step_id -> start_node_id
		// Also preserve columns added by M30 (layout) and M36 (max_iterations)
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_workflows', 'start_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_workflows_new`);
			db.exec(`
					CREATE TABLE space_workflows_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						name TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						start_node_id TEXT,
						config TEXT,
						layout TEXT,
						max_iterations INTEGER,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);
			db.exec(`
					INSERT INTO space_workflows_new
					SELECT id, space_id, name, description, start_step_id, config, layout, max_iterations, created_at, updated_at
					FROM space_workflows
				`);
			db.exec(`DROP TABLE space_workflows`);
			db.exec(`ALTER TABLE space_workflows_new RENAME TO space_workflows`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflows_space_id ON space_workflows(space_id)`
			);
		}

		// -------------------------------------------------------------------------
		// 3. Rename space_workflow_transitions.from_step_id -> from_node_id
		//                          and space_workflow_transitions.to_step_id -> to_node_id
		// Also preserve is_cyclic column added by M38
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_workflow_transitions', 'from_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_workflow_transitions_new`);
			db.exec(`
					CREATE TABLE space_workflow_transitions_new (
						id TEXT PRIMARY KEY,
						workflow_id TEXT NOT NULL,
						from_node_id TEXT NOT NULL,
						to_node_id TEXT NOT NULL,
						condition TEXT,
						order_index INTEGER NOT NULL DEFAULT 0,
						is_cyclic INTEGER,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
						FOREIGN KEY (from_node_id) REFERENCES space_workflow_nodes(id) ON DELETE CASCADE,
						FOREIGN KEY (to_node_id) REFERENCES space_workflow_nodes(id) ON DELETE CASCADE
					)
				`);
			db.exec(`
					INSERT INTO space_workflow_transitions_new
					SELECT id, workflow_id, from_step_id, to_step_id, condition, order_index, is_cyclic, created_at, updated_at
					FROM space_workflow_transitions
				`);
			db.exec(`DROP TABLE space_workflow_transitions`);
			db.exec(`ALTER TABLE space_workflow_transitions_new RENAME TO space_workflow_transitions`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_workflow_id ON space_workflow_transitions(workflow_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_from_node ON space_workflow_transitions(workflow_id, from_node_id)`
			);
		}

		// -------------------------------------------------------------------------
		// 4. Rename space_workflow_runs.current_step_id -> current_node_id
		// Also preserve columns added by M35 (iteration_count, max_iterations) and M37 (goal_id)
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_workflow_runs', 'current_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_workflow_runs_new`);
			db.exec(`
					CREATE TABLE space_workflow_runs_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						workflow_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						current_step_index INTEGER NOT NULL DEFAULT 0,
						current_node_id TEXT,
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
						config TEXT,
						iteration_count INTEGER NOT NULL DEFAULT 0,
						max_iterations INTEGER NOT NULL DEFAULT 5,
						goal_id TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						completed_at INTEGER,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
					)
				`);
			db.exec(`
					INSERT INTO space_workflow_runs_new
					SELECT id, space_id, workflow_id, title, description, current_step_index, current_step_id, status, config, iteration_count, max_iterations, goal_id, created_at, updated_at, completed_at
					FROM space_workflow_runs
				`);
			db.exec(`DROP TABLE space_workflow_runs`);
			db.exec(`ALTER TABLE space_workflow_runs_new RENAME TO space_workflow_runs`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_status ON space_workflow_runs(status)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_goal_id ON space_workflow_runs(goal_id)`
			);
		}

		// -------------------------------------------------------------------------
		// 5. Rename space_tasks.workflow_step_id -> workflow_node_id
		// Also preserves goal_id column added by M34
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_tasks', 'workflow_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_tasks_new`);
			db.exec(`
					CREATE TABLE space_tasks_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						task_type TEXT
							CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
						assigned_agent TEXT
							CHECK(assigned_agent IN ('coder', 'general')),
						custom_agent_id TEXT,
						workflow_run_id TEXT,
						workflow_node_id TEXT,
						created_by_task_id TEXT,
						goal_id TEXT,
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						input_draft TEXT,
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
						FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
					)
				`);
			db.exec(`
					INSERT INTO space_tasks_new
					SELECT id, space_id, title, description, status, priority, task_type, assigned_agent,
								 custom_agent_id, workflow_run_id, workflow_step_id, created_by_task_id, goal_id,
								 progress, current_step, result, error, depends_on, input_draft, active_session,
								 task_agent_session_id, pr_url, pr_number, pr_created_at, archived_at,
								 created_at, started_at, completed_at, updated_at
					FROM space_tasks
				`);
			db.exec(`DROP TABLE space_tasks`);
			db.exec(`ALTER TABLE space_tasks_new RENAME TO space_tasks`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`
			);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
			);
		}

		// -------------------------------------------------------------------------
		// 6. Rename space_session_groups.current_step_id -> current_node_id
		// Also preserves status column added by M40
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_session_groups', 'current_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_session_groups_new`);
			db.exec(`
					CREATE TABLE space_session_groups_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						name TEXT NOT NULL,
						description TEXT,
						workflow_run_id TEXT,
						current_node_id TEXT,
						task_id TEXT,
						status TEXT NOT NULL DEFAULT 'active'
							CHECK(status IN ('active', 'completed', 'failed')),
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);
			db.exec(`
					INSERT INTO space_session_groups_new
					SELECT id, space_id, name, description, workflow_run_id, current_step_id, task_id, status, created_at, updated_at
					FROM space_session_groups
				`);
			db.exec(`DROP TABLE space_session_groups`);
			db.exec(`ALTER TABLE space_session_groups_new RENAME TO space_session_groups`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_session_groups_space_id ON space_session_groups(space_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_session_groups_task_id ON space_session_groups(task_id)`
			);
		}

		db.exec(`COMMIT`);
	} catch (e) {
		db.exec(`ROLLBACK`);
		throw e;
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}
