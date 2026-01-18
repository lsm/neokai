/**
 * Database Schema Management
 *
 * Responsibilities:
 * - Table definitions for all tables
 * - Index creation
 * - Default value initialization
 */

import type { Database as BunDatabase } from "bun:sqlite";
import {
  DEFAULT_GLOBAL_TOOLS_CONFIG,
  DEFAULT_GLOBAL_SETTINGS,
} from "@liuboer/shared";

// Re-export migrations
export { runMigrations } from "./migrations";

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
}
