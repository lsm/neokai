import { Database as DB } from "@db/sqlite";
import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";
import type { Message, Session, ToolCall } from "@liuboer/shared";

export class Database {
  private db: DB;

  constructor(private dbPath: string) {
    this.db = null as unknown as DB;
  }

  async initialize() {
    // Ensure directory exists
    await ensureDir(dirname(this.dbPath));

    // Open database
    this.db = new DB(this.dbPath);

    // Create tables
    this.createTables();
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

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_message
      ON tool_calls(message_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session
      ON events(session_id, timestamp)`);
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
    const rows = stmt.all(id) as unknown[];

    if (rows.length === 0) return null;

    const row = rows[0] as Record<string, unknown>;
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
    const rows = stmt.all() as unknown[];

    return rows.map((row) => {
      const r = row as Record<string, unknown>;
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
      stmt.run(...(values as (string | number | boolean | null | undefined)[]));
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
    const rows = stmt.all(sessionId, limit, offset) as unknown[];

    return rows.map((row) => {
      const r = row as Record<string, unknown>;
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
    const rows = stmt.all(messageId) as unknown[];

    return rows.map((row) => {
      const r = row as Record<string, unknown>;
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

  close() {
    this.db.close();
  }
}
