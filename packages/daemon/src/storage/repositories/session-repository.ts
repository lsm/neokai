/**
 * Session Repository
 *
 * Responsibilities:
 * - Session create/read/update/delete operations
 * - Row-to-Session object mapping
 * - Partial update merging (metadata, config)
 */

import type { Database as BunDatabase } from "bun:sqlite";
import type { Session } from "@liuboer/shared";
import type { SQLiteValue } from "../types";

export class SessionRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Create a new session
   */
  createSession(session: Session): void {
    const stmt = this.db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, available_commands, processing_state, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      session.availableCommands
        ? JSON.stringify(session.availableCommands)
        : null,
      session.processingState ?? null,
      session.archivedAt ?? null,
    );
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): Session | null {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToSession(row);
  }

  /**
   * List all sessions ordered by last active time (most recent first)
   */
  listSessions(): Session[] {
    const stmt = this.db.prepare(
      `SELECT * FROM sessions ORDER BY last_active_at DESC`,
    );
    const rows = stmt.all() as Record<string, unknown>[];

    return rows.map((r) => this.rowToSession(r));
  }

  /**
   * Update a session with partial updates
   *
   * Supports merging partial metadata and config updates with existing values.
   */
  updateSession(id: string, updates: Partial<Session>): void {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

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
      fields.push("metadata = ?");
      values.push(JSON.stringify(mergedMetadata));
    }
    if (updates.config) {
      // Merge partial config updates with existing config
      const existing = this.getSession(id);
      const mergedConfig = existing
        ? { ...existing.config, ...updates.config }
        : updates.config;
      fields.push("config = ?");
      values.push(JSON.stringify(mergedConfig));
    }
    if (updates.sdkSessionId !== undefined) {
      fields.push("sdk_session_id = ?");
      values.push(updates.sdkSessionId ?? null);
    }
    if (updates.availableCommands !== undefined) {
      fields.push("available_commands = ?");
      values.push(
        updates.availableCommands
          ? JSON.stringify(updates.availableCommands)
          : null,
      );
    }
    if (updates.processingState !== undefined) {
      fields.push("processing_state = ?");
      values.push(updates.processingState ?? null);
    }
    if (updates.archivedAt !== undefined) {
      fields.push("archived_at = ?");
      values.push(updates.archivedAt ?? null);
    }
    // Handle worktree update (including clearing it when archiving)
    if ("worktree" in updates) {
      if (updates.worktree === undefined || updates.worktree === null) {
        // Clear worktree fields
        fields.push(
          "is_worktree = ?",
          "worktree_path = ?",
          "main_repo_path = ?",
          "worktree_branch = ?",
        );
        values.push(0, null, null, null);
      } else {
        // Update worktree fields
        fields.push(
          "is_worktree = ?",
          "worktree_path = ?",
          "main_repo_path = ?",
          "worktree_branch = ?",
        );
        values.push(
          1,
          updates.worktree.worktreePath,
          updates.worktree.mainRepoPath,
          updates.worktree.branch,
        );
      }
    }

    if (fields.length > 0) {
      values.push(id);
      const stmt = this.db.prepare(
        `UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`,
      );
      stmt.run(...values);
    }
  }

  /**
   * Delete a session by ID
   */
  deleteSession(id: string): void {
    const stmt = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
    stmt.run(id);
  }

  /**
   * Convert a database row to a Session object
   * Shared helper for getSession and listSessions
   */
  rowToSession(row: Record<string, unknown>): Session {
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
      row.available_commands && typeof row.available_commands === "string"
        ? (JSON.parse(row.available_commands) as string[])
        : undefined;

    return {
      id: row.id as string,
      title: row.title as string,
      workspacePath: row.workspace_path as string,
      createdAt: row.created_at as string,
      lastActiveAt: row.last_active_at as string,
      status: row.status as "active" | "paused" | "ended" | "archived",
      config: JSON.parse(row.config as string),
      metadata: JSON.parse(row.metadata as string),
      worktree,
      gitBranch: (row.git_branch as string | null) ?? undefined,
      sdkSessionId: (row.sdk_session_id as string | null) ?? undefined,
      availableCommands,
      processingState: (row.processing_state as string | null) ?? undefined,
      archivedAt: (row.archived_at as string | null) ?? undefined,
    };
  }
}
