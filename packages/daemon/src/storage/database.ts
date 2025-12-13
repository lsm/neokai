import { Database as BunDatabase } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import type { AuthMethod, OAuthTokens, Session } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import { generateUUID } from '@liuboer/shared';

/**
 * SQLite parameter value type.
 * These are the valid types that can be bound to SQLite prepared statement parameters.
 */
type SQLiteValue = string | number | boolean | null | Buffer | Uint8Array;

export class Database {
	private db: BunDatabase;

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
			console.log('🔧 Running migration: Adding oauth_token_encrypted column');
			this.db.exec(`ALTER TABLE auth_config ADD COLUMN oauth_token_encrypted TEXT`);
		}

		// Migration 2: Remove messages and tool_calls tables (replaced by sdk_messages)
		try {
			// Check if messages table exists
			this.db.prepare(`SELECT 1 FROM messages LIMIT 1`).all();
			// Table exists, drop it
			console.log('🔧 Running migration: Dropping messages and tool_calls tables');
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
			console.log('🔧 Running migration: Adding worktree columns to sessions table');
			this.db.exec(`ALTER TABLE sessions ADD COLUMN is_worktree INTEGER DEFAULT 0`);
			this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
			this.db.exec(`ALTER TABLE sessions ADD COLUMN main_repo_path TEXT`);
			this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_branch TEXT`);
		}

		// Migration 4: Add git_branch column for non-worktree git sessions
		try {
			this.db.prepare(`SELECT git_branch FROM sessions LIMIT 1`).all();
		} catch {
			console.log('🔧 Running migration: Adding git_branch column to sessions table');
			this.db.exec(`ALTER TABLE sessions ADD COLUMN git_branch TEXT`);
		}
	}

	// Session operations
	createSession(session: Session): void {
		const stmt = this.db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
			session.gitBranch ?? null
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
			fields.push('metadata = ?');
			values.push(JSON.stringify(updates.metadata));
		}
		if (updates.config) {
			// Merge partial config updates with existing config
			const existing = this.getSession(id);
			const mergedConfig = existing ? { ...existing.config, ...updates.config } : updates.config;
			fields.push('config = ?');
			values.push(JSON.stringify(mergedConfig));
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

	// Authentication operations

	/**
	 * Simple encryption using AES-GCM
	 * Note: For production, consider using a proper key derivation function
	 */
	private async encryptData(data: string): Promise<string> {
		const encoder = new TextEncoder();
		const dataBuffer = encoder.encode(data);

		// Generate a random encryption key (in production, derive from a master key)
		const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
			'encrypt',
			'decrypt',
		]);

		// Generate IV
		const iv = crypto.getRandomValues(new Uint8Array(12));

		// Encrypt
		const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, dataBuffer);

		// Export key
		const exportedKey = await crypto.subtle.exportKey('raw', key);

		// Combine key + iv + encrypted data
		const combined = new Uint8Array(exportedKey.byteLength + iv.byteLength + encrypted.byteLength);
		combined.set(new Uint8Array(exportedKey), 0);
		combined.set(iv, exportedKey.byteLength);
		combined.set(new Uint8Array(encrypted), exportedKey.byteLength + iv.byteLength);

		// Return as base64
		return btoa(String.fromCharCode(...combined));
	}

	/**
	 * Decrypt data encrypted with encryptData
	 */
	private async decryptData(encrypted: string): Promise<string> {
		// Decode from base64
		const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

		// Extract key, IV, and encrypted data
		const keyData = combined.slice(0, 32);
		const iv = combined.slice(32, 44);
		const encryptedData = combined.slice(44);

		// Import key
		const key = await crypto.subtle.importKey(
			'raw',
			keyData,
			{ name: 'AES-GCM', length: 256 },
			false,
			['decrypt']
		);

		// Decrypt
		const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encryptedData);

		// Convert back to string
		const decoder = new TextDecoder();
		return decoder.decode(decrypted);
	}

	// ============================================================================
	// DEPRECATED: The following methods are deprecated and should not be used.
	// Authentication credentials must be provided via environment variables only.
	// These methods remain only for backward compatibility with existing tests.
	// ============================================================================

	/**
	 * @deprecated Authentication is now managed via environment variables only.
	 * Get current authentication method
	 */
	getAuthMethod(): AuthMethod {
		const stmt = this.db.prepare(`SELECT auth_method FROM auth_config WHERE id = 1`);
		const row = stmt.get() as Record<string, unknown> | undefined;
		if (!row) return 'none';
		return row.auth_method as AuthMethod;
	}

	/**
	 * @deprecated Authentication is now managed via environment variables only.
	 * Save OAuth tokens (encrypted)
	 */
	async saveOAuthTokens(tokens: OAuthTokens): Promise<void> {
		const encrypted = await this.encryptData(JSON.stringify(tokens));
		const stmt = this.db.prepare(
			`UPDATE auth_config SET auth_method = 'oauth', oauth_tokens_encrypted = ?, api_key_encrypted = NULL, updated_at = datetime('now') WHERE id = 1`
		);
		stmt.run(encrypted);
	}

	/**
	 * @deprecated Authentication is now managed via environment variables only.
	 * Get OAuth tokens (decrypted)
	 */
	async getOAuthTokens(): Promise<OAuthTokens | null> {
		const stmt = this.db.prepare(`SELECT oauth_tokens_encrypted FROM auth_config WHERE id = 1`);
		const row = stmt.get() as Record<string, unknown> | undefined;
		if (!row) return null;

		const encrypted = row.oauth_tokens_encrypted as string | null;
		if (!encrypted) return null;

		const decrypted = await this.decryptData(encrypted);
		return JSON.parse(decrypted) as OAuthTokens;
	}

	/**
	 * @deprecated Authentication is now managed via environment variables only.
	 * Save API key (encrypted)
	 */
	async saveApiKey(apiKey: string): Promise<void> {
		const encrypted = await this.encryptData(apiKey);
		const stmt = this.db.prepare(
			`UPDATE auth_config SET auth_method = 'api_key', api_key_encrypted = ?, oauth_tokens_encrypted = NULL, updated_at = datetime('now') WHERE id = 1`
		);
		stmt.run(encrypted);
	}

	/**
	 * @deprecated Authentication is now managed via environment variables only.
	 * Get API key (decrypted)
	 */
	async getApiKey(): Promise<string | null> {
		const stmt = this.db.prepare(`SELECT api_key_encrypted FROM auth_config WHERE id = 1`);
		const row = stmt.get() as Record<string, unknown> | undefined;
		if (!row) return null;

		const encrypted = row.api_key_encrypted as string | null;
		if (!encrypted) return null;

		return await this.decryptData(encrypted);
	}

	/**
	 * @deprecated Authentication is now managed via environment variables only.
	 * Save long-lived OAuth token (from claude setup-token)
	 */
	async saveOAuthLongLivedToken(token: string): Promise<void> {
		const encrypted = await this.encryptData(token);
		const stmt = this.db.prepare(
			`UPDATE auth_config SET auth_method = 'oauth_token', oauth_token_encrypted = ?, api_key_encrypted = NULL, oauth_tokens_encrypted = NULL, updated_at = datetime('now') WHERE id = 1`
		);
		stmt.run(encrypted);
	}

	/**
	 * @deprecated Authentication is now managed via environment variables only.
	 * Get long-lived OAuth token (decrypted)
	 */
	async getOAuthLongLivedToken(): Promise<string | null> {
		const stmt = this.db.prepare(`SELECT oauth_token_encrypted FROM auth_config WHERE id = 1`);
		const row = stmt.get() as Record<string, unknown> | undefined;
		if (!row) return null;

		const encrypted = row.oauth_token_encrypted as string | null;
		if (!encrypted) return null;

		return await this.decryptData(encrypted);
	}

	/**
	 * @deprecated Authentication is now managed via environment variables only.
	 * Clear all authentication
	 */
	clearAuth(): void {
		const stmt = this.db.prepare(
			`UPDATE auth_config SET auth_method = 'none', api_key_encrypted = NULL, oauth_tokens_encrypted = NULL, oauth_token_encrypted = NULL, updated_at = datetime('now') WHERE id = 1`
		);
		stmt.run();
	}

	// OAuth web flow methods removed - no longer supported
	// Authentication is now managed via environment variables only:
	// - ANTHROPIC_API_KEY for API key authentication
	// - CLAUDE_CODE_OAUTH_TOKEN for long-lived OAuth token authentication

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

	close() {
		this.db.close();
	}
}
