import type { Session } from "@liuboer/shared";
import type { MessageHub, EventBus } from "@liuboer/shared";
import { generateUUID } from "@liuboer/shared";
import { Database } from "../storage/database";
import { AgentSession } from "./agent-session";
import type { AuthManager } from "./auth-manager";

export class SessionManager {
  private sessions: Map<string, AgentSession> = new Map();

  // FIX: Session lazy-loading race condition
  private sessionLoadLocks = new Map<string, Promise<AgentSession | null>>();

  constructor(
    private db: Database,
    private messageHub: MessageHub,
    private authManager: AuthManager,
    private eventBus: EventBus,  // FIX: Use EventBus instead of StateManager
    private config: {
      defaultModel: string;
      maxTokens: number;
      temperature: number;
      workspaceRoot: string;
    },
  ) {}

  async createSession(params: {
    workspacePath?: string;
    initialTools?: string[];
    config?: Partial<Session["config"]>;
  }): Promise<string> {
    const sessionId = generateUUID();

    const sessionWorkspacePath = params.workspacePath || this.config.workspaceRoot;

    const session: Session = {
      id: sessionId,
      title: `Session ${new Date().toLocaleString()}`,
      workspacePath: sessionWorkspacePath,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active",
      config: {
        model: params.config?.model || this.config.defaultModel,
        maxTokens: params.config?.maxTokens || this.config.maxTokens,
        temperature: params.config?.temperature || this.config.temperature,
      },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    };

    // Save to database
    this.db.createSession(session);

    // Create agent session with MessageHub and auth function
    const agentSession = new AgentSession(
      session,
      this.db,
      this.messageHub,
      () => this.authManager.getCurrentApiKey(),
    );

    this.sessions.set(sessionId, agentSession);

    // Emit session created event via MessageHub (legacy)
    await this.messageHub.publish(
      `session.created`,
      { session },
      { sessionId: "global" }
    );

    // FIX: Emit event via EventBus (no StateManager dependency!)
    console.log('[SessionManager] Emitting session:created event for session:', sessionId);
    await this.eventBus.emit('session:created', { session });
    console.log('[SessionManager] Event emitted, returning sessionId:', sessionId);

    return sessionId;
  }

  /**
   * Get session (with lazy-loading race condition fix)
   *
   * FIX: Prevents multiple simultaneous loads of the same session
   * which would create duplicate Claude API connections
   */
  getSession(sessionId: string): AgentSession | null {
    // Check in-memory first
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    // Check if load already in progress
    const loadInProgress = this.sessionLoadLocks.get(sessionId);
    if (loadInProgress) {
      // Wait for the load to complete (this is sync, so we throw an error)
      // Callers should use getSessionAsync() for concurrent access
      throw new Error(
        `Session ${sessionId} is being loaded. Use getSessionAsync() for concurrent access.`
      );
    }

    // Load synchronously (for backward compatibility)
    const session = this.db.getSession(sessionId);
    if (!session) return null;

    // Create agent session with MessageHub and auth function
    const agentSession = new AgentSession(
      session,
      this.db,
      this.messageHub,
      () => this.authManager.getCurrentApiKey(),
    );
    this.sessions.set(sessionId, agentSession);

    return agentSession;
  }

  /**
   * Get session asynchronously (preferred for concurrent access)
   *
   * FIX: Handles concurrent requests properly with locking
   */
  async getSessionAsync(sessionId: string): Promise<AgentSession | null> {
    // Check in-memory first
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    // Check if load already in progress
    const loadInProgress = this.sessionLoadLocks.get(sessionId);
    if (loadInProgress) {
      return await loadInProgress;  // Wait for existing load
    }

    // Start new load with lock
    const loadPromise = this.loadSessionFromDB(sessionId);
    this.sessionLoadLocks.set(sessionId, loadPromise);

    try {
      const agentSession = await loadPromise;
      if (agentSession) {
        this.sessions.set(sessionId, agentSession);
      }
      return agentSession;
    } finally {
      this.sessionLoadLocks.delete(sessionId);
    }
  }

  /**
   * Load session from database (private helper)
   */
  private async loadSessionFromDB(sessionId: string): Promise<AgentSession | null> {
    const session = this.db.getSession(sessionId);
    if (!session) return null;

    // Create agent session with MessageHub and auth function
    return new AgentSession(
      session,
      this.db,
      this.messageHub,
      () => this.authManager.getCurrentApiKey(),
    );
  }

  listSessions(): Session[] {
    return this.db.listSessions();
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    this.db.updateSession(sessionId, updates);

    // Update in-memory session if exists
    const agentSession = this.sessions.get(sessionId);
    if (agentSession) {
      agentSession.updateMetadata(updates);
    }

    // FIX: Emit event via EventBus
    await this.eventBus.emit('session:updated', { sessionId, updates });
  }

  async deleteSession(sessionId: string): Promise<void> {
    // FIX: Transaction-like cleanup with proper error handling
    const agentSession = this.sessions.get(sessionId);
    let dbDeleted = false;

    try {
      // 1. Cleanup resources (can fail)
      if (agentSession) {
        await agentSession.cleanup();
      }

      // 2. Delete from DB (can fail)
      this.db.deleteSession(sessionId);
      dbDeleted = true;

      // 3. Remove from memory (shouldn't fail)
      this.sessions.delete(sessionId);

      // 4. Notify clients (can fail, but don't rollback)
      try {
        await this.messageHub.publish(
          `session.deleted`,
          { sessionId, reason: "deleted" },
          { sessionId: "global" }
        );

        // FIX: Emit event via EventBus
        await this.eventBus.emit('session:deleted', { sessionId });
      } catch (error) {
        console.error('[SessionManager] Failed to broadcast deletion:', error);
        // Don't rollback - session is already deleted
      }
    } catch (error) {
      // Rollback if DB delete failed
      if (!dbDeleted) {
        console.error('[SessionManager] Session deletion failed:', error);
        throw error;
      }

      // If cleanup failed but DB delete succeeded, log but don't rollback
      console.error('[SessionManager] Session deleted but cleanup failed:', error);
    }
  }



  getActiveSessions(): number {
    return this.sessions.size;
  }

  getTotalSessions(): number {
    return this.db.listSessions().length;
  }

  /**
   * Cleanup all sessions (called during shutdown)
   */
  async cleanup(): Promise<void> {
    console.log(`[SessionManager] Cleaning up ${this.sessions.size} active sessions...`);

    // Cleanup all in-memory sessions
    for (const [sessionId, agentSession] of this.sessions) {
      try {
        agentSession.cleanup();
      } catch (error) {
        console.error(`[SessionManager] Error cleaning up session ${sessionId}:`, error);
      }
    }

    // Clear session map
    this.sessions.clear();
    console.log(`[SessionManager] All sessions cleaned up`);
  }
}
