/**
 * Database Schema Management
 *
 * Responsibilities:
 * - Table definitions for all tables
 * - Index creation
 * - Default value initialization
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

// Re-export migrations
// knip-ignore-next-line
export { runMigrations } from './migrations';
// knip-ignore-next-line
export { runMigration12 } from './migrations';

/**
 * Create all database tables and initialize defaults
 */
export function createTables(db: BunDatabase): void {
	// Sessions table
	db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
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

	// Messages and tool_calls tables removed - we now only use sdk_messages table
	// This provides a cleaner design with single source of truth

	// Authentication configuration table (stores current auth method and credentials)
	db.exec(`
      CREATE TABLE IF NOT EXISTS auth_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        auth_method TEXT NOT NULL CHECK(auth_method IN ('oauth', 'oauth_token', 'api_key', 'none')),
        api_key_encrypted TEXT,
        oauth_tokens_encrypted TEXT,
        oauth_token_encrypted TEXT,
        updated_at TEXT NOT NULL
      )
    `);

	// OAuth state table removed - web-based OAuth flow is no longer supported
	// Authentication is now handled via environment variables only

	// SDK Messages table (stores full SDK messages with all metadata)
	db.exec(`
      CREATE TABLE IF NOT EXISTS sdk_messages (
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

	// Initialize auth_config with default values if not exists
	db.exec(`
      INSERT OR IGNORE INTO auth_config (id, auth_method, updated_at)
      VALUES (1, 'none', datetime('now'))
    `);

	// Global tools configuration table
	db.exec(`
      CREATE TABLE IF NOT EXISTS global_tools_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

	// Initialize global_tools_config with default values if not exists
	db.exec(`
      INSERT OR IGNORE INTO global_tools_config (id, config, updated_at)
      VALUES (1, '${JSON.stringify(DEFAULT_GLOBAL_TOOLS_CONFIG)}', datetime('now'))
    `);

	// Global settings table
	db.exec(`
      CREATE TABLE IF NOT EXISTS global_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

	// Initialize global_settings with default values if not exists
	db.exec(`
      INSERT OR IGNORE INTO global_settings (id, settings, updated_at)
      VALUES (1, '${JSON.stringify(DEFAULT_GLOBAL_SETTINGS)}', datetime('now'))
    `);

	// Room tables - self-aware architecture foundation

	// Rooms table - conceptual workspaces
	db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        background_context TEXT,
        instructions TEXT,
        allowed_paths TEXT DEFAULT '[]',
        default_path TEXT,
        default_model TEXT,
        allowed_models TEXT DEFAULT '[]',
        session_ids TEXT DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        config TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

	// Tasks table - task management
	db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
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
        archived_at INTEGER,
        active_session TEXT,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      )
    `);

	// Goals table
	db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
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

	// GitHub integration tables

	// Room GitHub mappings - maps repositories to rooms
	db.exec(`
      CREATE TABLE IF NOT EXISTS room_github_mappings (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        repositories TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      )
    `);

	// Inbox items - GitHub events awaiting routing
	db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('github_issue', 'github_comment', 'github_pr')),
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        comment_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        author_permission TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'routed', 'dismissed', 'blocked')),
        routed_to_room_id TEXT,
        routed_at INTEGER,
        security_check TEXT NOT NULL,
        raw_event TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (routed_to_room_id) REFERENCES rooms(id) ON DELETE SET NULL
      )
    `);

	// Room Runtime tables — session groups for multi-agent collaboration

	db.exec(`
      CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY,
        group_type TEXT NOT NULL DEFAULT 'task',
        ref_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `);

	db.exec(`
      CREATE TABLE IF NOT EXISTS session_group_members (
        group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, session_id)
      )
    `);

	db.exec(`
      CREATE TABLE IF NOT EXISTS task_group_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      )
    `);

	db.exec(`
      CREATE TABLE IF NOT EXISTS job_queue (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
        payload TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        error TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        retry_count INTEGER NOT NULL DEFAULT 0,
        run_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      )
    `);

	// Create indexes
	createIndexes(db);
}

/**
 * Create database indexes for performance
 */
function createIndexes(db: BunDatabase): void {
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session
      ON sdk_messages(session_id, timestamp)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_type
      ON sdk_messages(message_type, message_subtype)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status
      ON sdk_messages(session_id, send_status)`);

	// Room indexes
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_room ON goals(room_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);

	// GitHub integration indexes
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_room_github_mappings_room ON room_github_mappings(room_id)`
	);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_items_status ON inbox_items(status)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_inbox_items_repository ON inbox_items(repository, issue_number)`
	);
	// Room Runtime indexes
	db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_ref ON session_groups(ref_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sgm_session ON session_group_members(session_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tge_group ON task_group_events(group_id, id)`);
	// Job queue indexes
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC)`
	);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status)`);
}
