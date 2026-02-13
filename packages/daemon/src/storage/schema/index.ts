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
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived')),
        config TEXT NOT NULL,
        metadata TEXT NOT NULL
      )
    `);

	// Messages and tool_calls tables removed - we now only use sdk_messages table
	// This provides a cleaner design with single source of truth

	// Events table
	db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

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

	// Neo tables - self-aware architecture foundation

	// Rooms table - conceptual workspaces
	db.exec(`
      CREATE TABLE IF NOT EXISTS neo_rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        default_workspace TEXT,
        default_model TEXT,
        session_ids TEXT DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        neo_context_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

	// Neo memories table - persistent memory storage
	db.exec(`
      CREATE TABLE IF NOT EXISTS neo_memories (
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
        FOREIGN KEY (room_id) REFERENCES neo_rooms(id) ON DELETE CASCADE
      )
    `);

	// Neo tasks table - task management
	db.exec(`
      CREATE TABLE IF NOT EXISTS neo_tasks (
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
        FOREIGN KEY (room_id) REFERENCES neo_rooms(id) ON DELETE CASCADE
      )
    `);

	// Neo contexts table - conversation history per room
	db.exec(`
      CREATE TABLE IF NOT EXISTS neo_contexts (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL UNIQUE,
        total_tokens INTEGER DEFAULT 0,
        last_compacted_at INTEGER,
        status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'thinking', 'waiting_for_input')),
        current_task_id TEXT,
        current_session_id TEXT,
        FOREIGN KEY (room_id) REFERENCES neo_rooms(id) ON DELETE CASCADE
      )
    `);

	// Neo context messages table
	db.exec(`
      CREATE TABLE IF NOT EXISTS neo_context_messages (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        session_id TEXT,
        task_id TEXT,
        FOREIGN KEY (context_id) REFERENCES neo_contexts(id) ON DELETE CASCADE
      )
    `);

	// Create indexes
	createIndexes(db);
}

/**
 * Create database indexes for performance
 */
function createIndexes(db: BunDatabase): void {
	db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session
      ON events(session_id, timestamp)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session
      ON sdk_messages(session_id, timestamp)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_type
      ON sdk_messages(message_type, message_subtype)`);

	// Neo indexes
	db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_memories_room ON neo_memories(room_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_memories_type ON neo_memories(type)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_tasks_room ON neo_tasks(room_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_tasks_status ON neo_tasks(status)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_neo_context_messages_context ON neo_context_messages(context_id)`
	);
}
