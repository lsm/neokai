import { Database as BunDatabase } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { AuthMethod, Message, OAuthTokens, Session, ToolCall } from "@liuboer/shared";

export class Database {
  private db: BunDatabase;

  constructor(private dbPath: string) {
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

    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        thinking TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Tool calls table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'success', 'error')),
        error TEXT,
        duration INTEGER,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      )
    `);

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

    // OAuth state table (temporary storage during OAuth flow)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);

    // Initialize auth_config with default values if not exists
    this.db.exec(`
      INSERT OR IGNORE INTO auth_config (id, auth_method, updated_at)
      VALUES (1, 'none', datetime('now'))
    `);

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_message
      ON tool_calls(message_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session
      ON events(session_id, timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_states_expires
      ON oauth_states(expires_at)`);
  }

  /**
   * Run database migrations for schema changes
   */
  private runMigrations() {
    // Migration 1: Add oauth_token_encrypted column if it doesn't exist
    try {
      // Check if column exists by trying to query it
      this.db.prepare(`SELECT oauth_token_encrypted FROM auth_config LIMIT 1`).all();
    } catch (_error) {
      // Column doesn't exist, add it
      console.log("🔧 Running migration: Adding oauth_token_encrypted column");
      this.db.exec(`ALTER TABLE auth_config ADD COLUMN oauth_token_encrypted TEXT`);
    }
  }

  // Session operations
  createSession(session: Session): void {
    const stmt = this.db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
    );
  }

  getSession(id: string): Session | null {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      title: row.title as string,
      workspacePath: row.workspace_path as string,
      createdAt: row.created_at as string,
      lastActiveAt: row.last_active_at as string,
      status: row.status as "active" | "paused" | "ended",
      config: JSON.parse(row.config as string),
      metadata: JSON.parse(row.metadata as string),
    };
  }

  listSessions(): Session[] {
    const stmt = this.db.prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`);
    const rows = stmt.all() as Record<string, unknown>[];

    return rows.map((r) => {
      return {
        id: r.id as string,
        title: r.title as string,
        workspacePath: r.workspace_path as string,
        createdAt: r.created_at as string,
        lastActiveAt: r.last_active_at as string,
        status: r.status as "active" | "paused" | "ended",
        config: JSON.parse(r.config as string),
        metadata: JSON.parse(r.metadata as string),
      };
    });
  }

  updateSession(id: string, updates: Partial<Session>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.title) {
      fields.push("title = ?");
      values.push(updates.title);
    }
    if (updates.workspacePath) {
      fields.push("workspace_path = ?");
      values.push(updates.workspacePath);
    }
    if (updates.status) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.lastActiveAt) {
      fields.push("last_active_at = ?");
      values.push(updates.lastActiveAt);
    }

    if (fields.length > 0) {
      values.push(id);
      const stmt = this.db.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`);
      stmt.run(...values);
    }
  }

  deleteSession(id: string): void {
    const stmt = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
    stmt.run(id);
  }

  // Message operations
  saveMessage(message: Message): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp, thinking, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.thinking || null,
      message.metadata ? JSON.stringify(message.metadata) : null,
    );

    // Save tool calls if any
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        this.saveToolCall(toolCall);
      }
    }
  }

  getMessages(sessionId: string, limit = 100, offset = 0): Message[] {
    const stmt = this.db.prepare(
      `SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    );
    const rows = stmt.all(sessionId, limit, offset) as Record<string, unknown>[];

    return rows.map((r) => {
      const message: Message = {
        id: r.id as string,
        sessionId: r.session_id as string,
        role: r.role as "user" | "assistant" | "system",
        content: r.content as string,
        timestamp: r.timestamp as string,
        thinking: r.thinking as string | undefined,
        metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
      };

      // Load tool calls
      message.toolCalls = this.getToolCallsForMessage(message.id);

      return message;
    }).reverse(); // Return in chronological order
  }

  // Tool call operations
  saveToolCall(toolCall: ToolCall): void {
    const stmt = this.db.prepare(
      `INSERT INTO tool_calls (id, message_id, tool, input, output, status, error, duration, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      toolCall.id,
      toolCall.messageId,
      toolCall.tool,
      JSON.stringify(toolCall.input),
      toolCall.output ? JSON.stringify(toolCall.output) : null,
      toolCall.status,
      toolCall.error || null,
      toolCall.duration || null,
      toolCall.timestamp,
    );
  }

  getToolCallsForMessage(messageId: string): ToolCall[] {
    const stmt = this.db.prepare(
      `SELECT * FROM tool_calls WHERE message_id = ? ORDER BY timestamp`
    );
    const rows = stmt.all(messageId) as Record<string, unknown>[];

    return rows.map((r) => {
      return {
        id: r.id as string,
        messageId: r.message_id as string,
        tool: r.tool as string,
        input: JSON.parse(r.input as string),
        output: r.output ? JSON.parse(r.output as string) : undefined,
        status: r.status as "pending" | "success" | "error",
        error: r.error as string | undefined,
        duration: r.duration as number | undefined,
        timestamp: r.timestamp as string,
      };
    });
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
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    // Generate IV
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      dataBuffer
    );

    // Export key
    const exportedKey = await crypto.subtle.exportKey("raw", key);

    // Combine key + iv + encrypted data
    const combined = new Uint8Array(
      exportedKey.byteLength + iv.byteLength + encrypted.byteLength
    );
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
    const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));

    // Extract key, IV, and encrypted data
    const keyData = combined.slice(0, 32);
    const iv = combined.slice(32, 44);
    const encryptedData = combined.slice(44);

    // Import key
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    // Decrypt
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encryptedData
    );

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
    if (!row) return "none";
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

  /**
   * @deprecated OAuth flow is no longer supported via the web UI.
   * Save OAuth state temporarily during flow
   */
  saveOAuthState(state: string, codeVerifier: string, expiresInMinutes = 10): void {
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO oauth_states (state, code_verifier, created_at, expires_at)
       VALUES (?, ?, datetime('now'), ?)`
    );
    stmt.run(state, codeVerifier, expiresAt);
  }

  /**
   * @deprecated OAuth flow is no longer supported via the web UI.
   * Get and delete OAuth state (one-time use)
   */
  getOAuthState(state: string): string | null {
    // Check if state exists and not expired
    const selectStmt = this.db.prepare(
      `SELECT code_verifier FROM oauth_states WHERE state = ? AND expires_at > datetime('now')`
    );
    const row = selectStmt.get(state) as Record<string, unknown> | undefined;

    if (!row) return null;

    const codeVerifier = row.code_verifier as string;

    // Delete the state (one-time use)
    const deleteStmt = this.db.prepare(`DELETE FROM oauth_states WHERE state = ?`);
    deleteStmt.run(state);

    return codeVerifier;
  }

  /**
   * @deprecated OAuth flow is no longer supported via the web UI.
   * Clean up expired OAuth states
   */
  cleanupExpiredOAuthStates(): void {
    const stmt = this.db.prepare(`DELETE FROM oauth_states WHERE expires_at < datetime('now')`);
    stmt.run();
  }

  close() {
    this.db.close();
  }
}
