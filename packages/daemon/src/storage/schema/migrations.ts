/**
 * Database Migrations
 *
 * All 33 migrations for schema changes.
 * CRITICAL: Preserve the order of migrations.
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

	// Migration 25: Add type and session_context columns to sessions table
	// (merged with former migration 27 — intermediate CHECK constraint widening
	// is redundant since migration 32 rebuilds sessions with the final constraint)
	runMigration25(db);

	// Migration 32: v0.19 cleanup - drop old room orchestration tables
	runMigration32(db);

	// Migration 33: Room Runtime schema - session groups, task_messages, room_audit_log tables
	runMigration33(db);

	// Migration 34: Transition from task_pairs to session_groups
	runMigration34(db);

	// Migration 35: Added 'task_conversation' type (now unused — kept for idempotency on existing DBs)
	runMigration35(db);

	// Migration 36: Multi-agent architecture — rename craft/lead to worker/leader, add assigned_agent
	runMigration36(db);
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
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, available_commands, processing_state, archived_at, parent_id, labels, sub_session_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
			null,
			null,
			0
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
					parent_id TEXT,
					labels TEXT,
					sub_session_order INTEGER DEFAULT 0
				);

				-- Copy all data from old table to new table
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					   is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch,
					   sdk_session_id, available_commands, processing_state, archived_at,
					   parent_id, labels, sub_session_order
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
 * Helper to check whether a table has all required columns
 */
function tableHasColumns(db: BunDatabase, tableName: string, columnNames: string[]): boolean {
	return columnNames.every((columnName) => tableHasColumn(db, tableName, columnName));
}

/**
 * Migration 25: Add type and session_context columns to sessions table
 *
 * Merged with former migration 27. The intermediate CHECK constraint widening
 * (room → room_chat, adding manager/room_self) is skipped because migration 32
 * rebuilds the sessions table with the final constraint anyway.
 */
function runMigration25(db: BunDatabase): void {
	if (!tableExists(db, 'sessions')) {
		return;
	}

	if (!tableHasColumn(db, 'sessions', 'type')) {
		db.exec(`ALTER TABLE sessions ADD COLUMN type TEXT DEFAULT 'worker'`);
	}

	if (!tableHasColumn(db, 'sessions', 'session_context')) {
		db.exec(`ALTER TABLE sessions ADD COLUMN session_context TEXT`);
	}

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sessions_room
		ON sessions(json_extract(session_context, '$.roomId'))
		WHERE type = 'room_chat'
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sessions_lobby
		ON sessions(json_extract(session_context, '$.lobbyId'))
		WHERE type = 'lobby'
	`);
}

/**
 * Migration 32: v0.19 cleanup - drop old room orchestration tables
 *
 * Removes tables belonging to the AI-based RoomNeo/RoomSelf orchestration
 * that was replaced by the deterministic Runtime scheduler in v0.19.
 *
 * Drops:
 * - room_agent_states, worker_sessions, recurring_jobs
 * - room_context_versions, contexts, context_messages, memories
 *
 * Also migrates stale status values in tasks, goals, and sessions.
 */
function runMigration32(db: BunDatabase): void {
	// Drop old neo_* tables in case migration 14 was never run
	db.exec(`DROP TABLE IF EXISTS neo_context_messages`);
	db.exec(`DROP TABLE IF EXISTS neo_contexts`);
	db.exec(`DROP TABLE IF EXISTS neo_tasks`);
	db.exec(`DROP TABLE IF EXISTS neo_memories`);
	db.exec(`DROP TABLE IF EXISTS neo_rooms`);

	// Drop old orchestration tables (IF EXISTS so idempotent)
	db.exec(`DROP TABLE IF EXISTS room_agent_states`);
	db.exec(`DROP TABLE IF EXISTS worker_sessions`);
	db.exec(`DROP TABLE IF EXISTS worker_sessions_orphaned`);
	db.exec(`DROP TABLE IF EXISTS recurring_jobs`);
	db.exec(`DROP TABLE IF EXISTS room_context_versions`);
	db.exec(`DROP TABLE IF EXISTS context_messages`);
	db.exec(`DROP TABLE IF EXISTS contexts`);
	db.exec(`DROP TABLE IF EXISTS memories`);

	// Drop stale session_pairs if it somehow survived Migration 29
	db.exec(`DROP TABLE IF EXISTS session_pairs`);

	// Preserve room/task data when the rooms schema is already compatible.
	// Only reset room-domain tables if we detect an incompatible legacy rooms table.
	const shouldResetRoomDomainTables =
		tableExists(db, 'rooms') &&
		!tableHasColumns(db, 'rooms', [
			'id',
			'name',
			'background_context',
			'instructions',
			'allowed_paths',
			'default_path',
			'default_model',
			'allowed_models',
			'session_ids',
			'status',
			'created_at',
			'updated_at',
			'context_version',
		]);

	// Temporarily disable FK enforcement for all table rebuilds in this migration.
	// Two reasons:
	// 1. rooms is only created by createTables() which runs after all migrations,
	//    so FK validation against rooms(id) would fail on a fresh database.
	// 2. DROP TABLE sessions with FK ON cascades into events/sdk_messages rows
	//    (both tables have FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE),
	//    silently wiping all chat history on upgrade.
	// FK is restored in the finally block below.
	db.exec(`PRAGMA foreign_keys = OFF`);
	try {
		if (shouldResetRoomDomainTables) {
			// Legacy/incompatible room schema detected - reset room-domain tables.
			db.exec(`DROP TABLE IF EXISTS task_messages`);
			db.exec(`DROP TABLE IF EXISTS task_pairs`);
			db.exec(`DROP TABLE IF EXISTS session_group_messages`);
			db.exec(`DROP TABLE IF EXISTS session_group_members`);
			db.exec(`DROP TABLE IF EXISTS session_groups`);
			db.exec(`DROP TABLE IF EXISTS room_audit_log`);
			db.exec(`DROP TABLE IF EXISTS rendered_prompts`);
			db.exec(`DROP TABLE IF EXISTS prompt_templates`);
			db.exec(`DROP TABLE IF EXISTS inbox_items`);
			db.exec(`DROP TABLE IF EXISTS room_github_mappings`);
			db.exec(`DROP TABLE IF EXISTS goals`);
			db.exec(`DROP TABLE IF EXISTS tasks`);
			db.exec(`DROP TABLE IF EXISTS rooms`);
		} else {
			// Compatible schema: keep room-domain data, remove obsolete prompt tables only.
			db.exec(`DROP TABLE IF EXISTS rendered_prompts`);
			db.exec(`DROP TABLE IF EXISTS prompt_templates`);
		}

		// Rebuild sessions table: update type CHECK constraint
		// (drop 'room_self' and 'manager', add 'craft' and 'lead')
		if (tableExists(db, 'sessions')) {
			// Migrate old type values first (disable CHECK so new values are accepted)
			db.exec(`PRAGMA ignore_check_constraints = 1`);
			db.exec(`UPDATE sessions SET type = 'craft' WHERE type = 'room_self'`);
			db.exec(`UPDATE sessions SET type = 'lead' WHERE type = 'manager'`);
			db.exec(`PRAGMA ignore_check_constraints = 0`);
			// Remove any rows with unmappable types
			db.exec(
				`DELETE FROM sessions WHERE type NOT IN ('worker', 'room_chat', 'craft', 'lead', 'lobby')`
			);

			// Rebuild with new CHECK constraint
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
				labels TEXT,
				sub_session_order INTEGER DEFAULT 0,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'craft', 'lead', 'lobby')),
				session_context TEXT
			)
		`);
			db.exec(`
			INSERT INTO sessions_new
			SELECT id, title, workspace_path, created_at, last_active_at,
				status, config, metadata, is_worktree, worktree_path, main_repo_path,
				worktree_branch, git_branch, sdk_session_id, available_commands,
				processing_state, archived_at, parent_id, labels,
				COALESCE(sub_session_order, 0), type, session_context
			FROM sessions
		`);
			db.exec(`DROP TABLE sessions`);
			db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
		}
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Migration 33: Room Runtime schema
 *
 * Creates tables for the (Craft, Lead) agent group architecture:
 * - session_groups: Generic multi-agent collaboration groups (replaces task_pairs)
 * - session_group_members: Craft/Lead session membership
 * - session_group_messages: Unified message timeline for a group
 * - task_messages: Message queue for inter-agent delivery (stub for MVP)
 * - room_audit_log: Observability for Runtime tick/state changes
 *
 * Also adds columns to existing tables:
 * - tasks: task_type, version, created_by_task_id
 * - goals: planning_attempts, goal_review_attempts
 * - rooms: config
 */
function runMigration33(db: BunDatabase): void {
	// --- New tables ---

	if (!tableExists(db, 'session_groups')) {
		db.exec(`
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task_pair',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_craft'
					CHECK(state IN ('awaiting_craft', 'awaiting_lead', 'awaiting_human', 'hibernated', 'completed', 'failed')),
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);

			CREATE INDEX idx_session_groups_ref ON session_groups(ref_id);
			CREATE INDEX idx_session_groups_state ON session_groups(state);
		`);
	}

	if (!tableExists(db, 'session_group_members')) {
		db.exec(`
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, role)
			);

			CREATE INDEX idx_sgm_session ON session_group_members(session_id);
		`);
	}

	if (!tableExists(db, 'session_group_messages')) {
		db.exec(`
			CREATE TABLE session_group_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT,
				role TEXT NOT NULL,
				message_type TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE INDEX idx_sgmsg_group ON session_group_messages(group_id, id);
		`);
	}

	if (!tableExists(db, 'task_messages')) {
		db.exec(`
			CREATE TABLE task_messages (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES tasks(id),
				group_id TEXT NOT NULL REFERENCES session_groups(id),
				from_role TEXT NOT NULL CHECK(from_role IN ('craft', 'lead', 'human')),
				to_role TEXT NOT NULL CHECK(to_role IN ('craft', 'lead')),
				to_session_id TEXT NOT NULL,
				message_type TEXT NOT NULL DEFAULT 'normal'
					CHECK(message_type IN ('normal', 'interrupt', 'escalation_context')),
				payload TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'delivered', 'dead_letter')),
				created_at INTEGER NOT NULL,
				delivered_at INTEGER
			);

			CREATE INDEX idx_task_messages_group ON task_messages(group_id, status);
			CREATE INDEX idx_task_messages_task ON task_messages(task_id);
		`);
	}

	if (!tableExists(db, 'room_audit_log')) {
		db.exec(`
			CREATE TABLE room_audit_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				room_id TEXT NOT NULL,
				event_type TEXT NOT NULL,
				detail TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE INDEX idx_room_audit_log_room ON room_audit_log(room_id, created_at);
		`);
	}

	// --- Column additions to existing tables ---

	if (tableExists(db, 'tasks')) {
		if (!tableHasColumn(db, 'tasks', 'task_type')) {
			db.exec(
				`ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'coding' CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review'))`
			);
		}
		if (!tableHasColumn(db, 'tasks', 'version')) {
			db.exec(`ALTER TABLE tasks ADD COLUMN version INTEGER DEFAULT 0`);
		}
		if (!tableHasColumn(db, 'tasks', 'created_by_task_id')) {
			db.exec(`ALTER TABLE tasks ADD COLUMN created_by_task_id TEXT`);
		}
	}

	if (tableExists(db, 'goals')) {
		if (!tableHasColumn(db, 'goals', 'planning_attempts')) {
			db.exec(`ALTER TABLE goals ADD COLUMN planning_attempts INTEGER DEFAULT 0`);
		}
		if (!tableHasColumn(db, 'goals', 'goal_review_attempts')) {
			db.exec(`ALTER TABLE goals ADD COLUMN goal_review_attempts INTEGER DEFAULT 0`);
		}
	}

	if (tableExists(db, 'rooms')) {
		if (!tableHasColumn(db, 'rooms', 'config')) {
			db.exec(`ALTER TABLE rooms ADD COLUMN config TEXT`);
		}
	}
}

/**
 * Migration 34: Transition from task_pairs to session_groups
 *
 * Drops the old task_pairs table (and task_messages with pair_id FK) and
 * creates session_groups, session_group_members, session_group_messages,
 * and a new task_messages with group_id FK. No data migration is needed
 * since task_pairs data is ephemeral runtime state.
 */
function runMigration34(db: BunDatabase): void {
	// Drop old task_pairs if it exists (databases that ran the old migration 33)
	if (tableExists(db, 'task_pairs')) {
		db.exec(`PRAGMA foreign_keys = OFF`);
		try {
			db.exec(`DROP TABLE IF EXISTS task_messages`);
			db.exec(`DROP TABLE IF EXISTS task_pairs`);
		} finally {
			db.exec(`PRAGMA foreign_keys = ON`);
		}
	}

	// Ensure session_groups tables exist (idempotent — runMigration33 may have already created them)
	if (!tableExists(db, 'session_groups')) {
		db.exec(`
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task_pair',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_craft'
					CHECK(state IN ('awaiting_craft', 'awaiting_lead', 'awaiting_human', 'hibernated', 'completed', 'failed')),
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);

			CREATE INDEX idx_session_groups_ref ON session_groups(ref_id);
			CREATE INDEX idx_session_groups_state ON session_groups(state);
		`);
	}

	if (!tableExists(db, 'session_group_members')) {
		db.exec(`
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, role)
			);

			CREATE INDEX idx_sgm_session ON session_group_members(session_id);
		`);
	}

	if (!tableExists(db, 'session_group_messages')) {
		db.exec(`
			CREATE TABLE session_group_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT,
				role TEXT NOT NULL,
				message_type TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE INDEX idx_sgmsg_group ON session_group_messages(group_id, id);
		`);
	}

	if (!tableExists(db, 'task_messages')) {
		db.exec(`
			CREATE TABLE task_messages (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES tasks(id),
				group_id TEXT NOT NULL REFERENCES session_groups(id),
				from_role TEXT NOT NULL CHECK(from_role IN ('craft', 'lead', 'human')),
				to_role TEXT NOT NULL CHECK(to_role IN ('craft', 'lead')),
				to_session_id TEXT NOT NULL,
				message_type TEXT NOT NULL DEFAULT 'normal'
					CHECK(message_type IN ('normal', 'interrupt', 'escalation_context')),
				payload TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'delivered', 'dead_letter')),
				created_at INTEGER NOT NULL,
				delivered_at INTEGER
			);

			CREATE INDEX idx_task_messages_group ON task_messages(group_id, status);
			CREATE INDEX idx_task_messages_task ON task_messages(task_id);
		`);
	}
}

/**
 * Migration 35: Add 'task_conversation' type to sessions table
 *
 * NOTE: The 'task_conversation' type is no longer used — session groups now
 * store messages directly in session_group_messages. This migration is kept
 * for idempotency on databases that already ran it. New databases get the
 * correct schema from createTables() which omits 'task_conversation'.
 */
function runMigration35(db: BunDatabase): void {
	if (!tableExists(db, 'sessions')) return;

	// Skip if already has task_conversation type (idempotent)
	try {
		db.exec(`PRAGMA ignore_check_constraints = 1`);
		db.exec(`UPDATE sessions SET type = type WHERE type = 'task_conversation'`);
		db.exec(`PRAGMA ignore_check_constraints = 0`);

		// Try inserting and immediately deleting a sentinel row to test the constraint
		// If it throws, we need to rebuild
		const testId = '__migration35_test__';
		try {
			db.exec(
				`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type)
				 VALUES ('${testId}', 'test', '/', datetime('now'), datetime('now'), 'active', '{}', '{}', 'task_conversation')`
			);
			db.exec(`DELETE FROM sessions WHERE id = '${testId}'`);
			// CHECK already allows 'task_conversation' — no rebuild needed
			return;
		} catch {
			// Fall through to rebuild
		}
	} catch {
		// Ignore
	}

	db.exec(`PRAGMA foreign_keys = OFF`);
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
				labels TEXT,
				sub_session_order INTEGER DEFAULT 0,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'craft', 'lead', 'lobby', 'task_conversation')),
				session_context TEXT
			)
		`);
		db.exec(`
			INSERT INTO sessions_new
			SELECT id, title, workspace_path, created_at, last_active_at,
				status, config, metadata, is_worktree, worktree_path, main_repo_path,
				worktree_branch, git_branch, sdk_session_id, available_commands,
				processing_state, archived_at, parent_id, labels,
				COALESCE(sub_session_order, 0), type, session_context
			FROM sessions
		`);
		db.exec(`DROP TABLE sessions`);
		db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Migration 36: Multi-agent architecture
 *
 * - Add assigned_agent column to tasks table
 * - Rename session_groups states: awaiting_craft → awaiting_worker, awaiting_lead → awaiting_leader
 * - Rename session_group_members roles: craft → worker, lead → leader
 * - Update task_messages role CHECK constraints
 * - Update sessions type CHECK to include planner, coder, leader, general
 */
function runMigration36(db: BunDatabase): void {
	// 1. Add assigned_agent to tasks (idempotent)
	if (tableExists(db, 'tasks')) {
		try {
			db.exec(`ALTER TABLE tasks ADD COLUMN assigned_agent TEXT DEFAULT 'coder'`);
		} catch {
			// Column already exists
		}
	}

	// 2. Rebuild session_groups with updated state CHECK
	if (tableExists(db, 'session_groups')) {
		// Check if migration already applied
		try {
			const testRow = db
				.prepare(`SELECT state FROM session_groups WHERE state = 'awaiting_worker' LIMIT 1`)
				.get();
			// If we find 'awaiting_worker' rows, or no rows with old states, check if already migrated
			const oldRows = db
				.prepare(
					`SELECT COUNT(*) as c FROM session_groups WHERE state IN ('awaiting_craft', 'awaiting_lead')`
				)
				.get() as { c: number };
			if (oldRows.c === 0 && testRow !== undefined) {
				// Already migrated, skip session_groups rebuild
			} else {
				rebuildSessionGroups(db);
			}
		} catch {
			rebuildSessionGroups(db);
		}
	}

	// 3. Update session_group_members roles
	if (tableExists(db, 'session_group_members')) {
		db.exec(`UPDATE session_group_members SET role = 'worker' WHERE role = 'craft'`);
		db.exec(`UPDATE session_group_members SET role = 'leader' WHERE role = 'lead'`);
	}

	// 4. Rebuild task_messages with updated CHECK constraints
	if (tableExists(db, 'task_messages')) {
		db.exec(`PRAGMA foreign_keys = OFF`);
		try {
			db.exec(`
				CREATE TABLE task_messages_new (
					id TEXT PRIMARY KEY,
					task_id TEXT NOT NULL REFERENCES tasks(id),
					group_id TEXT NOT NULL REFERENCES session_groups(id),
					from_role TEXT NOT NULL CHECK(from_role IN ('worker', 'leader', 'human')),
					to_role TEXT NOT NULL CHECK(to_role IN ('worker', 'leader')),
					to_session_id TEXT NOT NULL,
					message_type TEXT NOT NULL DEFAULT 'normal'
						CHECK(message_type IN ('normal', 'interrupt', 'escalation_context')),
					payload TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'pending'
						CHECK(status IN ('pending', 'delivered', 'dead_letter')),
					created_at INTEGER NOT NULL,
					delivered_at INTEGER
				)
			`);
			db.exec(`
				INSERT INTO task_messages_new
				SELECT id, task_id, group_id,
					CASE from_role WHEN 'craft' THEN 'worker' WHEN 'lead' THEN 'leader' ELSE from_role END,
					CASE to_role WHEN 'craft' THEN 'worker' WHEN 'lead' THEN 'leader' ELSE to_role END,
					to_session_id, message_type, payload, status, created_at, delivered_at
				FROM task_messages
			`);
			db.exec(`DROP TABLE task_messages`);
			db.exec(`ALTER TABLE task_messages_new RENAME TO task_messages`);
			db.exec(`CREATE INDEX idx_task_messages_group ON task_messages(group_id, status)`);
			db.exec(`CREATE INDEX idx_task_messages_task ON task_messages(task_id)`);
		} finally {
			db.exec(`PRAGMA foreign_keys = ON`);
		}
	}

	// 5. Rebuild sessions table with updated type CHECK
	if (tableExists(db, 'sessions')) {
		// Check if new types already allowed
		const testId = '__migration36_test__';
		try {
			db.exec(
				`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type)
				 VALUES ('${testId}', 'test', '/', datetime('now'), datetime('now'), 'active', '{}', '{}', 'planner')`
			);
			db.exec(`DELETE FROM sessions WHERE id = '${testId}'`);
			// Already has new types, just migrate data
			db.exec(`UPDATE sessions SET type = 'coder' WHERE type = 'craft'`);
			db.exec(`UPDATE sessions SET type = 'leader' WHERE type = 'lead'`);
			return;
		} catch {
			// Need to rebuild
		}

		db.exec(`PRAGMA foreign_keys = OFF`);
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
					labels TEXT,
					sub_session_order INTEGER DEFAULT 0,
					type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby')),
					session_context TEXT
				)
			`);
			db.exec(`
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at,
					status, config, metadata, is_worktree, worktree_path, main_repo_path,
					worktree_branch, git_branch, sdk_session_id, available_commands,
					processing_state, archived_at, parent_id, labels,
					COALESCE(sub_session_order, 0),
					CASE type WHEN 'craft' THEN 'coder' WHEN 'lead' THEN 'leader' ELSE type END,
					session_context
				FROM sessions
			`);
			db.exec(`DROP TABLE sessions`);
			db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
		} finally {
			db.exec(`PRAGMA foreign_keys = ON`);
		}
	}
}

/** Helper for migration 36: rebuild session_groups table */
function rebuildSessionGroups(db: BunDatabase): void {
	db.exec(`PRAGMA foreign_keys = OFF`);
	try {
		db.exec(`
			CREATE TABLE session_groups_new (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_worker'
					CHECK(state IN ('awaiting_worker', 'awaiting_leader', 'awaiting_human', 'hibernated', 'completed', 'failed')),
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			)
		`);
		db.exec(`
			INSERT INTO session_groups_new
			SELECT id, group_type, ref_id,
				CASE state
					WHEN 'awaiting_craft' THEN 'awaiting_worker'
					WHEN 'awaiting_lead' THEN 'awaiting_leader'
					ELSE state
				END,
				version, metadata, created_at, completed_at
			FROM session_groups
		`);
		db.exec(`DROP TABLE session_groups`);
		db.exec(`ALTER TABLE session_groups_new RENAME TO session_groups`);
		db.exec(`CREATE INDEX idx_session_groups_ref ON session_groups(ref_id)`);
		db.exec(`CREATE INDEX idx_session_groups_state ON session_groups(state)`);
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}
