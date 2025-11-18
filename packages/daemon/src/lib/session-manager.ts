import type { Session } from "@liuboer/shared";
import { Database } from "../storage/database";
import { AgentSession } from "./agent-session";
import { EventBus } from "./event-bus";
import type { AuthManager } from "./auth-manager";

export class SessionManager {
  private sessions: Map<string, AgentSession> = new Map();

  constructor(
    private db: Database,
    private eventBus: EventBus,
    private authManager: AuthManager,
    private config: {
      defaultModel: string;
      maxTokens: number;
      temperature: number;
    },
  ) {}

  async createSession(params: {
    workspacePath?: string;
    initialTools?: string[];
    config?: Partial<Session["config"]>;
  }): Promise<string> {
    const sessionId = crypto.randomUUID();

    const session: Session = {
      id: sessionId,
      title: `Session ${new Date().toLocaleString()}`,
      workspacePath: params.workspacePath || process.cwd(),
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

    // Create agent session with EventBus and auth function
    const agentSession = new AgentSession(
      session,
      this.db,
      this.eventBus,
      () => this.authManager.getCurrentApiKey(),
    );

    this.sessions.set(sessionId, agentSession);

    // Emit session created event
    await this.eventBus.emit({
      type: "session.created",
      sessionId,
      timestamp: new Date().toISOString(),
      data: { session },
    });

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

    // Create agent session with EventBus and auth function
    const agentSession = new AgentSession(
      session,
      this.db,
      this.eventBus,
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
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Remove from memory
    this.sessions.delete(sessionId);

    // Remove from database
    this.db.deleteSession(sessionId);

    // Emit session ended event
    await this.eventBus.emit({
      type: "session.ended",
      sessionId,
      timestamp: new Date().toISOString(),
      data: { reason: "deleted" },
    });
  }

  async clearMessages(sessionId: string): Promise<void> {
    // Clear messages from database
    this.db.clearMessages(sessionId);

    // Reload history in the agent session if it's in memory
    const agentSession = this.sessions.get(sessionId);
    if (agentSession) {
      agentSession.reloadHistory();
    }

    // Update session metadata
    await this.updateSession(sessionId, {
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        toolCallCount: 0,
      },
    });

    // Emit messages cleared event
    await this.eventBus.emit({
      type: "messages.cleared",
      sessionId,
      timestamp: new Date().toISOString(),
      data: {},
    });
  }

  getActiveSessions(): number {
    return this.sessions.size;
  }

  getTotalSessions(): number {
    return this.db.listSessions().length;
  }
}
