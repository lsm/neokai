import { Database as BunDatabase } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import type { Session, GlobalToolsConfig } from '@liuboer/shared';
import { DEFAULT_GLOBAL_TOOLS_CONFIG } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import { generateUUID } from '@liuboer/shared';
import { Logger } from '../lib/logger';

/**
 * SQLite parameter value type.
 * These are the valid types that can be bound to SQLite prepared statement parameters.
 */
type SQLiteValue = string | number | boolean | null | Buffer | Uint8Array;

export class Database {
	private db: BunDatabase;
	private logger = new Logger('Database');

	constructor(private dbPath: string) {
		// Initialize as null until initialize() is called
		// This pattern is necessary because BunDatabase constructor is synchronous
		// but we want to allow async directory creation before opening the DB
		this.db = null as unknown as BunDatabase;
	}

	async initialize() {
		// Ensure directory exists
		const dir = dirname(this.dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Open database
		this.db = new BunDatabase(this.dbPath);

		// Enable WAL mode for better concurrency and crash recovery
		// WAL mode provides:
		// - Better performance for concurrent reads/writes
		// - Atomic commits (prevents partial writes)
		// - Better crash recovery (no data loss on unexpected shutdown)
		this.db.exec('PRAGMA journal_mode = WAL');

		// Set synchronous mode to NORMAL for durability with good performance
		// NORMAL = fsync only at critical moments (WAL checkpoints)
		// This ensures durability while maintaining performance
		this.db.exec('PRAGMA synchronous = NORMAL');

		// Enable foreign key constraints (required for CASCADE deletes)
		this.db.exec('PRAGMA foreign_keys = ON');

		// Create tables
		this.createTables();

		// Run migrations
		this.runMigrations();
	}

	private createTables() {
		// Sessions table
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended')),
        config TEXT NOT NULL,
        metadata TEXT NOT NULL
      )
    `);

		// Messages and tool_calls tables removed - we now only use sdk_messages table
		// This provides a cleaner design with single source of truth

		// Events table
		this.db.exec(`
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
		this.db.exec(`
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
		this.db.exec(`
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
		this.db.exec(`
      INSERT OR IGNORE INTO auth_config (id, auth_method, updated_at)
      VALUES (1, 'none', datetime('now'))
    `);

		// Global tools configuration table
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_tools_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

		// Initialize global_tools_config with default values if not exists
		this.db.exec(`
      INSERT OR IGNORE INTO global_tools_config (id, config, updated_at)
      VALUES (1, '${JSON.stringify(DEFAULT_GLOBAL_TOOLS_CONFIG)}', datetime('now'))
    `);

		// Create indexes
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session
      ON events(session_id, timestamp)`);
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session
      ON sdk_messages(session_id, timestamp)`);
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_type
      ON sdk_messages(message_type, message_subtype)`);
	}

	/**
	 * Run database migrations for schema changes
	 */
	private runMigrations() {
		// Migration 1: Add oauth_token_encrypted column if it doesn't exist
		try {
			// Check if column exists by trying to query it
			this.db.prepare(`SELECT oauth_token_encrypted FROM auth_config LIMIT 1`).all();
		} catch {
			// Column doesn't exist, add it
			this.logger.log('🔧 Running migration: Adding oauth_token_encrypted column');
			this.db.exec(`ALTER TABLE auth_config ADD COLUMN oauth_token_encrypted TEXT`);
		}

		// Migration 2: Remove messages and tool_calls tables (replaced by sdk_messages)
		try {
			// Check if messages table exists
			this.db.prepare(`SELECT 1 FROM messages LIMIT 1`).all();
			// Table exists, drop it
			this.logger.log('🔧 Running migration: Dropping messages and tool_calls tables');
			this.db.exec(`DROP TABLE IF EXISTS tool_calls`);
			this.db.exec(`DROP TABLE IF EXISTS messages`);
			this.db.exec(`DROP INDEX IF EXISTS idx_messages_session`);
			this.db.exec(`DROP INDEX IF EXISTS idx_tool_calls_message`);
		} catch {
			// Tables don't exist, migration already complete
		}

		// Migration 3: Add worktree columns to sessions table
		try {
			this.db.prepare(`SELECT is_worktree FROM sessions LIMIT 1`).all();
		} catch {
			this.logger.log('🔧 Running migration: Adding worktree columns to sessions table');
			this.db.exec(`ALTER TABLE sessions ADD COLUMN is_worktree INTEGER DEFAULT 0`);
			this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
			this.db.exec(`ALTER TABLE sessions ADD COLUMN main_repo_path TEXT`);
			this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_branch TEXT`);
		}

		// Migration 4: Add git_branch column for non-worktree git sessions
		try {
			this.db.prepare(`SELECT git_branch FROM sessions LIMIT 1`).all();
		} catch {
			this.logger.log('🔧 Running migration: Adding git_branch column to sessions table');
			this.db.exec(`ALTER TABLE sessions ADD COLUMN git_branch TEXT`);
		}

		// Migration 5: Add sdk_session_id column for session resumption
		try {
			this.db.prepare(`SELECT sdk_session_id FROM sessions LIMIT 1`).all();
		} catch {
			this.logger.log('🔧 Running migration: Adding sdk_session_id column to sessions table');
			this.db.exec(`ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT`);
		}

		// Migration 6: Add available_commands column for slash commands persistence
		try {
			this.db.prepare(`SELECT available_commands FROM sessions LIMIT 1`).all();
		} catch {
			this.logger.log('🔧 Running migration: Adding available_commands column to sessions table');
			this.db.exec(`ALTER TABLE sessions ADD COLUMN available_commands TEXT`);
		}

		// Migration 7: Add processing_state column for agent state persistence
		try {
			this.db.prepare(`SELECT processing_state FROM sessions LIMIT 1`).all();
		} catch {
			this.logger.log('🔧 Running migration: Adding processing_state column to sessions table');
			this.db.exec(`ALTER TABLE sessions ADD COLUMN processing_state TEXT`);
		}
	}

	// Session operations
	createSession(session: Session): void {
		const stmt = this.db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, available_commands, processing_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		stmt.run(
			session.id,
			session.title,
			session.workspacePath,
			session.createdAt,
			session.lastActiveAt,
			session.status,
			JSON.stringify(session.config),
			JSON.stringify(session.metadata),
			session.worktree?.isWorktree ? 1 : 0,
			session.worktree?.worktreePath ?? null,
			session.worktree?.mainRepoPath ?? null,
			session.worktree?.branch ?? null,
			session.gitBranch ?? null,
			session.sdkSessionId ?? null,
			session.availableCommands ? JSON.stringify(session.availableCommands) : null,
			session.processingState ?? null
		);
	}

	getSession(id: string): Session | null {
		const stmt = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;

		const isWorktree = row.is_worktree === 1;
		const worktree = isWorktree
			? {
					isWorktree: true as const,
					worktreePath: row.worktree_path as string,
					mainRepoPath: row.main_repo_path as string,
					branch: row.worktree_branch as string,
				}
			: undefined;

		const availableCommands =
			row.available_commands && typeof row.available_commands === 'string'
				? (JSON.parse(row.available_commands) as string[])
				: undefined;

		return {
			id: row.id as string,
			title: row.title as string,
			workspacePath: row.workspace_path as string,
			createdAt: row.created_at as string,
			lastActiveAt: row.last_active_at as string,
			status: row.status as 'active' | 'paused' | 'ended',
			config: JSON.parse(row.config as string),
			metadata: JSON.parse(row.metadata as string),
			worktree,
			gitBranch: (row.git_branch as string | null) ?? undefined,
			sdkSessionId: (row.sdk_session_id as string | null) ?? undefined,
			availableCommands,
			processingState: (row.processing_state as string | null) ?? undefined,
		};
	}

	listSessions(): Session[] {
		const stmt = this.db.prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`);
		const rows = stmt.all() as Record<string, unknown>[];

		return rows.map((r) => {
			const isWorktree = r.is_worktree === 1;
			const worktree = isWorktree
				? {
						isWorktree: true as const,
						worktreePath: r.worktree_path as string,
						mainRepoPath: r.main_repo_path as string,
						branch: r.worktree_branch as string,
					}
				: undefined;

			const availableCommands =
				r.available_commands && typeof r.available_commands === 'string'
					? (JSON.parse(r.available_commands) as string[])
					: undefined;

			return {
				id: r.id as string,
				title: r.title as string,
				workspacePath: r.workspace_path as string,
				createdAt: r.created_at as string,
				lastActiveAt: r.last_active_at as string,
				status: r.status as 'active' | 'paused' | 'ended',
				config: JSON.parse(r.config as string),
				metadata: JSON.parse(r.metadata as string),
				worktree,
				gitBranch: (r.git_branch as string | null) ?? undefined,
				sdkSessionId: (r.sdk_session_id as string | null) ?? undefined,
				availableCommands,
				processingState: (r.processing_state as string | null) ?? undefined,
			};
		});
	}

	updateSession(id: string, updates: Partial<Session>): void {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (updates.title) {
			fields.push('title = ?');
			values.push(updates.title);
		}
		if (updates.workspacePath) {
			fields.push('workspace_path = ?');
			values.push(updates.workspacePath);
		}
		if (updates.status) {
			fields.push('status = ?');
			values.push(updates.status);
		}
		if (updates.lastActiveAt) {
			fields.push('last_active_at = ?');
			values.push(updates.lastActiveAt);
		}
		if (updates.metadata) {
			// Merge partial metadata updates with existing metadata
			// Filter out undefined/null values to allow clearing fields
			const existing = this.getSession(id);
			const mergedMetadata = existing ? { ...existing.metadata } : {};
			for (const [key, value] of Object.entries(updates.metadata)) {
				if (value === undefined || value === null) {
					delete mergedMetadata[key as keyof typeof mergedMetadata];
				} else {
					(mergedMetadata as Record<string, unknown>)[key] = value;
				}
			}
			fields.push('metadata = ?');
			values.push(JSON.stringify(mergedMetadata));
		}
		if (updates.config) {
			// Merge partial config updates with existing config
			const existing = this.getSession(id);
			const mergedConfig = existing ? { ...existing.config, ...updates.config } : updates.config;
			fields.push('config = ?');
			values.push(JSON.stringify(mergedConfig));
		}
		if (updates.sdkSessionId !== undefined) {
			fields.push('sdk_session_id = ?');
			values.push(updates.sdkSessionId ?? null);
		}
		if (updates.availableCommands !== undefined) {
			fields.push('available_commands = ?');
			values.push(updates.availableCommands ? JSON.stringify(updates.availableCommands) : null);
		}
		if (updates.processingState !== undefined) {
			fields.push('processing_state = ?');
			values.push(updates.processingState ?? null);
		}

		if (fields.length > 0) {
			values.push(id);
			const stmt = this.db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`);
			stmt.run(...values);
		}
	}

	deleteSession(id: string): void {
		const stmt = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
		stmt.run(id);
	}

	// ============================================================================
	// Authentication operations
	// ============================================================================
	// Authentication is now managed via environment variables only:
	// - ANTHROPIC_API_KEY for API key authentication
	// - CLAUDE_CODE_OAUTH_TOKEN for long-lived OAuth token authentication
	//
	// The auth_config table remains for potential future use but is not
	// actively used by the application.

	// ============================================================================
	// Global Tools Configuration operations
	// ============================================================================

	/**
	 * Get the global tools configuration
	 */
	getGlobalToolsConfig(): GlobalToolsConfig {
		const stmt = this.db.prepare(`SELECT config FROM global_tools_config WHERE id = 1`);
		const row = stmt.get() as { config: string } | undefined;

		if (!row) {
			return DEFAULT_GLOBAL_TOOLS_CONFIG;
		}

		try {
			return JSON.parse(row.config) as GlobalToolsConfig;
		} catch {
			return DEFAULT_GLOBAL_TOOLS_CONFIG;
		}
	}

	/**
	 * Save the global tools configuration
	 */
	saveGlobalToolsConfig(config: GlobalToolsConfig): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO global_tools_config (id, config, updated_at)
			VALUES (1, ?, datetime('now'))
		`);
		stmt.run(JSON.stringify(config));
	}

	// ============================================================================
	// SDK Message operations
	// ============================================================================

	/**
	 * Save a full SDK message to the database
	 *
	 * FIX: Enhanced with proper error handling and logging
	 * Returns true on success, false on failure
	 */
	saveSDKMessage(sessionId: string, message: SDKMessage): boolean {
		try {
			const id = generateUUID();
			const messageType = message.type;
			const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
			const timestamp = new Date().toISOString();

			const stmt = this.db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run(id, sessionId, messageType, messageSubtype, JSON.stringify(message), timestamp);
			return true;
		} catch (error) {
			// Log error but don't throw - prevents stream from dying
			console.error('[Database] Failed to save SDK message:', error);
			console.error('[Database] Message type:', message.type, 'Session:', sessionId);
			return false;
		}
	}

	/**
	 * Get SDK messages for a session
	 *
	 * Returns messages in chronological order (oldest to newest).
	 *
	 * Pagination modes:
	 * 1. Initial load (no before): Returns the NEWEST `limit` messages
	 * 2. Load older (with before): Returns messages BEFORE the given timestamp
	 * 3. Load newer (with since): Returns messages AFTER the given timestamp
	 *
	 * @param sessionId - The session ID to get messages for
	 * @param limit - Maximum number of messages to return (default: 100)
	 * @param before - Cursor: get messages older than this timestamp (milliseconds)
	 * @param since - Get messages newer than this timestamp (milliseconds)
	 */
	getSDKMessages(sessionId: string, limit = 100, before?: number, since?: number): SDKMessage[] {
		let query = `SELECT sdk_message, timestamp FROM sdk_messages WHERE session_id = ?`;
		const params: SQLiteValue[] = [sessionId];

		// Cursor-based pagination: get messages BEFORE a timestamp (for loading older)
		if (before !== undefined && before > 0) {
			query += ` AND timestamp < ?`;
			params.push(new Date(before).toISOString());
		}

		// Get messages AFTER a timestamp (for loading newer / real-time updates)
		if (since !== undefined && since > 0) {
			query += ` AND timestamp > ?`;
			params.push(new Date(since).toISOString());
		}

		// Order DESC to get newest messages first, then reverse for chronological display
		query += ` ORDER BY timestamp DESC LIMIT ?`;
		params.push(limit);

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];

		// Parse SDK message and inject the timestamp from the database row
		const messages = rows.map((r) => {
			const sdkMessage = JSON.parse(r.sdk_message as string) as SDKMessage;
			const timestamp = new Date(r.timestamp as string).getTime();
			// Inject timestamp into SDK message object for client-side filtering
			return { ...sdkMessage, timestamp } as SDKMessage & { timestamp: number };
		});

		// Reverse to get chronological order (oldest to newest) for display
		return messages.reverse();
	}

	/**
	 * Get SDK messages by type
	 */
	getSDKMessagesByType(
		sessionId: string,
		messageType: string,
		messageSubtype?: string,
		limit = 100
	): SDKMessage[] {
		let query = `SELECT sdk_message FROM sdk_messages WHERE session_id = ? AND message_type = ?`;
		const params: SQLiteValue[] = [sessionId, messageType];

		if (messageSubtype) {
			query += ` AND message_subtype = ?`;
			params.push(messageSubtype);
		}

		query += ` ORDER BY timestamp ASC LIMIT ?`;
		params.push(limit);

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];

		return rows.map((r) => JSON.parse(r.sdk_message as string) as SDKMessage);
	}

	/**
	 * Get the count of SDK messages for a session
	 */
	getSDKMessageCount(sessionId: string): number {
		const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM sdk_messages WHERE session_id = ?`);
		const result = stmt.get(sessionId) as { count: number };
		return result.count;
	}

	/**
	 * Get the underlying Bun SQLite database instance
	 * Used by background job queues (e.g., liteque) that need direct DB access
	 */
	getDatabase(): BunDatabase {
		return this.db;
	}

	/**
	 * Get the database file path
	 * Used by background job queues to create their own connections to the same DB file
	 */
	getDatabasePath(): string {
		return this.dbPath;
	}

	close() {
		this.db.close();
	}
}
