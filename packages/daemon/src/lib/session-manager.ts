import type { Session } from "@liuboer/shared";
import { Database } from "../storage/database";
import { AgentSession } from "./agent-session";
import { EventBusManager } from "./event-bus-manager";
import type { AuthManager } from "./auth-manager";

export class SessionManager {
  private sessions: Map<string, AgentSession> = new Map();

  constructor(
    private db: Database,
    private eventBusManager: EventBusManager,
    private authManager: AuthManager,
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

    // Get or create EventBus for this session
    const eventBus = this.eventBusManager.getOrCreateEventBus(sessionId);

    // Create agent session with EventBus and auth function
    const agentSession = new AgentSession(
      session,
      this.db,
      eventBus,
      () => this.authManager.getCurrentApiKey(),
    );

    this.sessions.set(sessionId, agentSession);

    // Emit session created event
    await eventBus.emit({
      id: crypto.randomUUID(),
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

    // Get or create EventBus for this session
    const eventBus = this.eventBusManager.getOrCreateEventBus(sessionId);

    // Create agent session with EventBus and auth function
    const agentSession = new AgentSession(
      session,
      this.db,
      eventBus,
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
    // Get EventBus before cleanup
    const eventBus = this.eventBusManager.getEventBus(sessionId);

    // Emit session ended event
    if (eventBus) {
      await eventBus.emit({
        id: crypto.randomUUID(),
        type: "session.ended",
        sessionId,
        timestamp: new Date().toISOString(),
        data: { reason: "deleted" },
      });
    }

    // Remove from memory
    this.sessions.delete(sessionId);

    // Remove from database
    this.db.deleteSession(sessionId);

    // Cleanup EventBus
    await this.eventBusManager.removeEventBus(sessionId);
  }



  getActiveSessions(): number {
    return this.sessions.size;
  }

  getTotalSessions(): number {
    return this.db.listSessions().length;
  }
}
