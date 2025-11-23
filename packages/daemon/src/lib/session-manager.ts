import type { Session } from "@liuboer/shared";
import type { MessageHub } from "@liuboer/shared";
import { Database } from "../storage/database";
import { AgentSession } from "./agent-session";
import type { AuthManager } from "./auth-manager";
import type { StateManager } from "./state-manager";

export class SessionManager {
  private sessions: Map<string, AgentSession> = new Map();
  private stateManager: StateManager | null = null;

  constructor(
    private db: Database,
    private messageHub: MessageHub,
    private authManager: AuthManager,
    private config: {
      defaultModel: string;
      maxTokens: number;
      temperature: number;
      workspaceRoot: string;
    },
  ) {}

  /**
   * Set state manager (called after initialization to avoid circular dependency)
   */
  setStateManager(stateManager: StateManager): void {
    this.stateManager = stateManager;
  }

  async createSession(params: {
    workspacePath?: string;
    initialTools?: string[];
    config?: Partial<Session["config"]>;
  }): Promise<string> {
    const sessionId = crypto.randomUUID();

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
      `global:session.created`,
      { session },
      { sessionId: "global" }
    );

    // Broadcast state change via StateManager
    if (this.stateManager) {
      await this.stateManager.broadcastSessionsDelta({
        added: [session],
        timestamp: Date.now(),
      });
    }

    return sessionId;
  }

  getSession(sessionId: string): AgentSession | null {
    // Check in-memory first
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    // Load from database
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

    // Broadcast state change via StateManager
    if (this.stateManager) {
      // Broadcast session meta change
      await this.stateManager.broadcastSessionMetaChange(sessionId);

      // Also update global sessions list
      const updatedSession = this.db.getSession(sessionId);
      if (updatedSession) {
        await this.stateManager.broadcastSessionsDelta({
          updated: [updatedSession],
          timestamp: Date.now(),
        });
      }
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Emit session ended event via MessageHub (legacy)
    await this.messageHub.publish(
      `global:session.deleted`,
      { sessionId, reason: "deleted" },
      { sessionId: "global" }
    );

    // Broadcast state change via StateManager
    if (this.stateManager) {
      await this.stateManager.broadcastSessionsDelta({
        removed: [sessionId],
        timestamp: Date.now(),
      });
    }

    // Remove from memory
    this.sessions.delete(sessionId);

    // Remove from database
    this.db.deleteSession(sessionId);
  }



  getActiveSessions(): number {
    return this.sessions.size;
  }

  getTotalSessions(): number {
    return this.db.listSessions().length;
  }
}
