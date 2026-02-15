/**
 * Database Migrations
 *
 * All 15 migrations for schema changes.
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

	// Migration 14: Rename neo_* tables to generic names
	runMigration14(db);

	// Migration 15: Add allowed_paths and default_path columns to rooms table
	runMigration15(db);
}

/**
 * Migration 1: Add oauth_token_encrypted column if it doesn't exist
 */
function runMigration1(db: BunDatabase): void {
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
 * Migration 14: Rename neo_* tables to generic names
 *
 * Renames:
 * - neo_rooms -> rooms
 * - neo_memories -> memories
 * - neo_tasks -> tasks
 * - neo_contexts -> contexts
 * - neo_context_messages -> context_messages
 * - neo_context_id column -> context_id
 * - Indexes idx_neo_* -> idx_*
 */
function runMigration14(db: BunDatabase): void {
	// Check if migration already done by checking if neo_rooms table exists
	try {
		db.prepare(`SELECT 1 FROM neo_rooms LIMIT 1`).all();
	} catch {
		// neo_rooms doesn't exist, migration already complete
		return;
	}

	// Disable foreign keys during table renaming
	db.exec('PRAGMA foreign_keys = OFF');

	try {
		// Drop old indexes first
		db.exec(`DROP INDEX IF EXISTS idx_neo_memories_room`);
		db.exec(`DROP INDEX IF EXISTS idx_neo_memories_type`);
		db.exec(`DROP INDEX IF EXISTS idx_neo_tasks_room`);
		db.exec(`DROP INDEX IF EXISTS idx_neo_tasks_status`);
		db.exec(`DROP INDEX IF EXISTS idx_neo_context_messages_context`);

		// Rename tables
		db.exec(`ALTER TABLE neo_context_messages RENAME TO context_messages`);
		db.exec(`ALTER TABLE neo_contexts RENAME TO contexts`);
		db.exec(`ALTER TABLE neo_tasks RENAME TO tasks`);
		db.exec(`ALTER TABLE neo_memories RENAME TO memories`);
		db.exec(`ALTER TABLE neo_rooms RENAME TO rooms`);

		// Rename neo_context_id column to context_id in rooms table
		// SQLite doesn't support ALTER COLUMN, so we need to recreate the table
		db.exec(`
			CREATE TABLE rooms_new (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT,
				default_workspace TEXT,
				default_model TEXT,
				session_ids TEXT DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
				context_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			INSERT INTO rooms_new (id, name, description, default_workspace, default_model, session_ids, status, context_id, created_at, updated_at)
			SELECT id, name, description, default_workspace, default_model, session_ids, status, neo_context_id, created_at, updated_at
			FROM rooms;

			DROP TABLE rooms;

			ALTER TABLE rooms_new RENAME TO rooms;
		`);

		// Update foreign key references in contexts table
		db.exec(`
			CREATE TABLE contexts_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL UNIQUE,
				total_tokens INTEGER DEFAULT 0,
				last_compacted_at INTEGER,
				status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'thinking', 'waiting_for_input')),
				current_task_id TEXT,
				current_session_id TEXT,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);

			INSERT INTO contexts_new
			SELECT id, room_id, total_tokens, last_compacted_at, status, current_task_id, current_session_id
			FROM contexts;

			DROP TABLE contexts;

			ALTER TABLE contexts_new RENAME TO contexts;
		`);

		// Update foreign key references in memories table
		db.exec(`
			CREATE TABLE memories_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				type TEXT NOT NULL CHECK(type IN ('conversation', 'task_result', 'preference', 'pattern', 'note')),
				content TEXT NOT NULL,
				tags TEXT DEFAULT '[]',
				importance TEXT NOT NULL DEFAULT 'normal' CHECK(importance IN ('low', 'normal', 'high')),
				session_id TEXT,
				task_id TEXT,
				created_at INTEGER NOT NULL,
				last_accessed_at INTEGER NOT NULL,
				access_count INTEGER DEFAULT 0,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);

			INSERT INTO memories_new
			SELECT id, room_id, type, content, tags, importance, session_id, task_id, created_at, last_accessed_at, access_count
			FROM memories;

			DROP TABLE memories;

			ALTER TABLE memories_new RENAME TO memories;
		`);

		// Update foreign key references in tasks table
		db.exec(`
			CREATE TABLE tasks_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				session_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'blocked', 'completed', 'failed')),
				priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);

			INSERT INTO tasks_new
			SELECT id, room_id, title, description, session_id, status, priority, progress, current_step, result, error, depends_on, created_at, started_at, completed_at
			FROM tasks;

			DROP TABLE tasks;

			ALTER TABLE tasks_new RENAME TO tasks;
		`);

		// Update foreign key references in context_messages table
		db.exec(`
			CREATE TABLE context_messages_new (
				id TEXT PRIMARY KEY,
				context_id TEXT NOT NULL,
				role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
				content TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				token_count INTEGER NOT NULL,
				session_id TEXT,
				task_id TEXT,
				FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
			);

			INSERT INTO context_messages_new
			SELECT id, context_id, role, content, timestamp, token_count, session_id, task_id
			FROM context_messages;

			DROP TABLE context_messages;

			ALTER TABLE context_messages_new RENAME TO context_messages;
		`);

		// Create new indexes with renamed names
		db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_room ON memories(room_id)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_context_messages_context ON context_messages(context_id)`
		);
	} finally {
		// Re-enable foreign keys
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 15: Add allowed_paths and default_path columns to rooms table
 *
 * Adds multi-path workspace support to rooms:
 * - allowed_paths: JSON array of workspace paths this room can access
 * - default_path: Default path for new sessions
 *
 * Also migrates existing default_workspace to allowed_paths[0] if present.
 */
function runMigration15(db: BunDatabase): void {
	try {
		// Check if allowed_paths column already exists
		db.prepare(`SELECT allowed_paths FROM rooms LIMIT 1`).all();
	} catch {
		// Column doesn't exist, add the new columns
		db.exec(`ALTER TABLE rooms ADD COLUMN allowed_paths TEXT DEFAULT '[]'`);
		db.exec(`ALTER TABLE rooms ADD COLUMN default_path TEXT`);

		// Migrate existing default_workspace to allowed_paths
		// For each room with a default_workspace, set allowed_paths to [default_workspace]
		// and default_path to default_workspace
		const rooms = db
			.prepare(`SELECT id, default_workspace FROM rooms WHERE default_workspace IS NOT NULL`)
			.all() as { id: string; default_workspace: string }[];

		for (const room of rooms) {
			const allowedPaths = JSON.stringify([room.default_workspace]);
			db.prepare(`UPDATE rooms SET allowed_paths = ?, default_path = ? WHERE id = ?`).run(
				allowedPaths,
				room.default_workspace,
				room.id
			);
		}
	}
}
