/**
 * StateManager - Server-side state coordinator
 *
 * Manages authoritative state and broadcasts changes to clients
 * via fine-grained state channels
 */

import type { MessageHub } from "@liuboer/shared";
import type { SessionManager } from "./session-manager";
import type { AuthManager } from "./auth-manager";
import type { Config } from "../config";
import type {
  SessionsState,
  AuthState,
  ConfigState,
  HealthState,
  GlobalStateSnapshot,
  SessionStateSnapshot,
  SessionMetaState,
  MessagesState,
  SDKMessagesState,
  AgentState,
  ContextState,
  CommandsState,
  SessionsUpdate,
  MessagesUpdate,
  SDKMessagesUpdate,
} from "@liuboer/shared";
import type { Session } from "@liuboer/shared";
import { STATE_CHANNELS } from "@liuboer/shared";

const VERSION = "0.1.0";
const CLAUDE_SDK_VERSION = "0.1.37";
const startTime = Date.now();

export class StateManager {
  private stateVersion = 0;

  constructor(
    private messageHub: MessageHub,
    private sessionManager: SessionManager,
    private authManager: AuthManager,
    private config: Config,
  ) {
    this.setupHandlers();
  }

  /**
   * Setup RPC handlers for state snapshots
   */
  private setupHandlers(): void {
    // Global state snapshot
    this.messageHub.handle(STATE_CHANNELS.GLOBAL_SNAPSHOT, async () => {
      return await this.getGlobalSnapshot();
    });

    // Session state snapshot
    this.messageHub.handle(STATE_CHANNELS.SESSION_SNAPSHOT, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getSessionSnapshot(sessionId);
    });

    // Individual channel requests (fallback for on-demand refresh)
    this.messageHub.handle(STATE_CHANNELS.GLOBAL_SESSIONS, async () => {
      return await this.getSessionsState();
    });

    this.messageHub.handle(STATE_CHANNELS.GLOBAL_AUTH, async () => {
      return await this.getAuthState();
    });

    this.messageHub.handle(STATE_CHANNELS.GLOBAL_CONFIG, async () => {
      return await this.getConfigState();
    });

    this.messageHub.handle(STATE_CHANNELS.GLOBAL_HEALTH, async () => {
      return await this.getHealthState();
    });

    // Session-specific channel requests
    this.messageHub.handle(STATE_CHANNELS.SESSION_META, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getSessionMetaState(sessionId);
    });

    this.messageHub.handle(STATE_CHANNELS.SESSION_MESSAGES, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getMessagesState(sessionId);
    });

    this.messageHub.handle(STATE_CHANNELS.SESSION_SDK_MESSAGES, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getSDKMessagesState(sessionId);
    });

    this.messageHub.handle(STATE_CHANNELS.SESSION_AGENT, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getAgentState(sessionId);
    });

    this.messageHub.handle(STATE_CHANNELS.SESSION_CONTEXT, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getContextState(sessionId);
    });

    this.messageHub.handle(STATE_CHANNELS.SESSION_COMMANDS, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getCommandsState(sessionId);
    });
  }

  // ========================================
  // Global State Getters
  // ========================================

  /**
   * Get full global state snapshot
   */
  async getGlobalSnapshot(): Promise<GlobalStateSnapshot> {
    const [sessions, auth, config, health] = await Promise.all([
      this.getSessionsState(),
      this.getAuthState(),
      this.getConfigState(),
      this.getHealthState(),
    ]);

    return {
      sessions,
      auth,
      config,
      health,
      meta: {
        channel: "global",
        sessionId: "global",
        lastUpdate: Date.now(),
        version: this.stateVersion,
      },
    };
  }

  private async getSessionsState(): Promise<SessionsState> {
    const sessions = this.sessionManager.listSessions();
    return {
      sessions,
      timestamp: Date.now(),
    };
  }

  private async getAuthState(): Promise<AuthState> {
    const authStatus = await this.authManager.getAuthStatus();
    return {
      authStatus,
      timestamp: Date.now(),
    };
  }

  private async getConfigState(): Promise<ConfigState> {
    const authStatus = await this.authManager.getAuthStatus();

    const config = {
      version: VERSION,
      claudeSDKVersion: CLAUDE_SDK_VERSION,
      defaultModel: this.config.defaultModel,
      maxSessions: this.config.maxSessions,
      storageLocation: this.config.dbPath,
      authMethod: authStatus.method,
      authStatus,
    };

    return {
      config,
      timestamp: Date.now(),
    };
  }

  private async getHealthState(): Promise<HealthState> {
    const health = {
      status: "ok" as const,
      version: VERSION,
      uptime: Date.now() - startTime,
      sessions: {
        active: this.sessionManager.getActiveSessions(),
        total: this.sessionManager.getTotalSessions(),
      },
    };

    return {
      health,
      timestamp: Date.now(),
    };
  }

  // ========================================
  // Session State Getters
  // ========================================

  /**
   * Get full session state snapshot
   */
  async getSessionSnapshot(sessionId: string): Promise<SessionStateSnapshot> {
    const [session, messages, sdkMessages, agent, context, commands] =
      await Promise.all([
        this.getSessionMetaState(sessionId),
        this.getMessagesState(sessionId),
        this.getSDKMessagesState(sessionId),
        this.getAgentState(sessionId),
        this.getContextState(sessionId),
        this.getCommandsState(sessionId),
      ]);

    return {
      session,
      messages,
      sdkMessages,
      agent,
      context,
      commands,
      meta: {
        channel: "session",
        sessionId,
        lastUpdate: Date.now(),
        version: this.stateVersion,
      },
    };
  }

  private async getSessionMetaState(sessionId: string): Promise<SessionMetaState> {
    const agentSession = this.sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    return {
      session: agentSession.getSessionData(),
      timestamp: Date.now(),
    };
  }

  private async getMessagesState(sessionId: string): Promise<MessagesState> {
    const agentSession = this.sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    const messages = agentSession.getMessages();

    return {
      messages,
      messageCount: messages.length,
      timestamp: Date.now(),
    };
  }

  private async getSDKMessagesState(sessionId: string): Promise<SDKMessagesState> {
    const agentSession = this.sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    const sdkMessages = agentSession.getSDKMessages();

    return {
      sdkMessages,
      timestamp: Date.now(),
    };
  }

  private async getAgentState(sessionId: string): Promise<AgentState> {
    const agentSession = this.sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    // TODO: Add these methods to AgentSession
    const isProcessing = false; // agentSession.isProcessing();
    const currentTask = null; // agentSession.getCurrentTask();

    let status: AgentState["status"] = "idle";
    if (isProcessing) {
      status = "working";
    }

    return {
      isProcessing,
      currentTask,
      status,
      timestamp: Date.now(),
    };
  }

  private async getContextState(sessionId: string): Promise<ContextState> {
    const agentSession = this.sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    // TODO: Add getContextInfo method to AgentSession
    const contextInfo = null; // agentSession.getContextInfo();

    return {
      contextInfo,
      timestamp: Date.now(),
    };
  }

  private async getCommandsState(sessionId: string): Promise<CommandsState> {
    const agentSession = this.sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    const availableCommands = await agentSession.getSlashCommands();

    return {
      availableCommands,
      timestamp: Date.now(),
    };
  }

  // ========================================
  // State Change Broadcasters
  // ========================================

  /**
   * Broadcast sessions list change (full update)
   */
  async broadcastSessionsChange(sessions?: Session[]): Promise<void> {
    const state = sessions
      ? { sessions, timestamp: Date.now() }
      : await this.getSessionsState();

    await this.messageHub.publish(STATE_CHANNELS.GLOBAL_SESSIONS, state, {
      sessionId: "global",
    });

    this.stateVersion++;
  }

  /**
   * Broadcast sessions delta update (more efficient for single changes)
   */
  async broadcastSessionsDelta(update: SessionsUpdate): Promise<void> {
    await this.messageHub.publish(
      `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
      update,
      { sessionId: "global" },
    );

    // Also broadcast full update for clients that don't support deltas
    await this.broadcastSessionsChange();
  }

  /**
   * Broadcast auth status change
   */
  async broadcastAuthChange(): Promise<void> {
    const state = await this.getAuthState();

    await this.messageHub.publish(STATE_CHANNELS.GLOBAL_AUTH, state, {
      sessionId: "global",
    });

    this.stateVersion++;
  }

  /**
   * Broadcast config change
   */
  async broadcastConfigChange(): Promise<void> {
    const state = await this.getConfigState();

    await this.messageHub.publish(STATE_CHANNELS.GLOBAL_CONFIG, state, {
      sessionId: "global",
    });

    this.stateVersion++;
  }

  /**
   * Broadcast health status change
   */
  async broadcastHealthChange(): Promise<void> {
    const state = await this.getHealthState();

    await this.messageHub.publish(STATE_CHANNELS.GLOBAL_HEALTH, state, {
      sessionId: "global",
    });

    this.stateVersion++;
  }

  /**
   * Broadcast session metadata change
   */
  async broadcastSessionMetaChange(sessionId: string): Promise<void> {
    const state = await this.getSessionMetaState(sessionId);

    await this.messageHub.publish(STATE_CHANNELS.SESSION_META, state, {
      sessionId,
    });

    // Also update global sessions list
    await this.broadcastSessionsChange();
  }

  /**
   * Broadcast messages change
   */
  async broadcastMessagesChange(sessionId: string): Promise<void> {
    const state = await this.getMessagesState(sessionId);

    await this.messageHub.publish(STATE_CHANNELS.SESSION_MESSAGES, state, {
      sessionId,
    });

    this.stateVersion++;
  }

  /**
   * Broadcast messages delta (single new message)
   */
  async broadcastMessagesDelta(
    sessionId: string,
    update: MessagesUpdate,
  ): Promise<void> {
    await this.messageHub.publish(
      `${STATE_CHANNELS.SESSION_MESSAGES}.delta`,
      update,
      { sessionId },
    );

    // Also broadcast full update for clients that don't support deltas
    await this.broadcastMessagesChange(sessionId);
  }

  /**
   * Broadcast SDK messages change
   */
  async broadcastSDKMessagesChange(sessionId: string): Promise<void> {
    const state = await this.getSDKMessagesState(sessionId);

    await this.messageHub.publish(STATE_CHANNELS.SESSION_SDK_MESSAGES, state, {
      sessionId,
    });

    this.stateVersion++;
  }

  /**
   * Broadcast SDK messages delta (single new message)
   */
  async broadcastSDKMessagesDelta(
    sessionId: string,
    update: SDKMessagesUpdate,
  ): Promise<void> {
    await this.messageHub.publish(
      `${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta`,
      update,
      { sessionId },
    );
  }

  /**
   * Broadcast agent state change
   */
  async broadcastAgentStateChange(sessionId: string): Promise<void> {
    const state = await this.getAgentState(sessionId);

    await this.messageHub.publish(STATE_CHANNELS.SESSION_AGENT, state, {
      sessionId,
    });

    this.stateVersion++;
  }

  /**
   * Broadcast context info change
   */
  async broadcastContextChange(sessionId: string): Promise<void> {
    const state = await this.getContextState(sessionId);

    await this.messageHub.publish(STATE_CHANNELS.SESSION_CONTEXT, state, {
      sessionId,
    });

    this.stateVersion++;
  }

  /**
   * Broadcast commands change
   */
  async broadcastCommandsChange(sessionId: string): Promise<void> {
    const state = await this.getCommandsState(sessionId);

    await this.messageHub.publish(STATE_CHANNELS.SESSION_COMMANDS, state, {
      sessionId,
    });

    this.stateVersion++;
  }
}
