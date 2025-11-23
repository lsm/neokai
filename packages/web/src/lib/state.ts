/**
 * Application State Management
 *
 * Fine-grained state channels for client-server synchronization
 *
 * Architecture:
 * - Fine-grained channels (one per state property)
 * - Snapshot on connect + delta updates
 * - Optimistic reads, confirmed writes
 * - Server-only persistence
 */

import { signal, computed, type Signal } from "@preact/signals";
import type { MessageHub } from "@liuboer/shared";
import type {
  Session,
  AuthStatus,
  DaemonConfig,
  HealthStatus,
  Message,
  ContextInfo,
} from "@liuboer/shared";
import type { SDKMessage } from "@liuboer/shared/sdk";
import type {
  SessionsState,
  AuthState,
  ConfigState,
  HealthState,
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
import { STATE_CHANNELS } from "@liuboer/shared";
import { StateChannel, ComputedStateChannel, DeltaMergers } from "./state-channel";

/**
 * Global State Channels
 */
class GlobalStateChannels {
  // Sessions list
  sessions: StateChannel<SessionsState>;

  // Auth status
  auth: StateChannel<AuthState>;

  // Daemon config
  config: StateChannel<ConfigState>;

  // Health status
  health: StateChannel<HealthState>;

  constructor(private hub: MessageHub) {
    // Initialize channels with delta support
    this.sessions = new StateChannel<SessionsState>(
      hub,
      STATE_CHANNELS.GLOBAL_SESSIONS,
      {
        sessionId: "global",
        enableDeltas: true,
        mergeDelta: (current, delta: SessionsUpdate) => {
          return {
            ...current,
            sessions: DeltaMergers.array(current.sessions, delta),
            timestamp: delta.timestamp,
          };
        },
        debug: false,
      },
    );

    this.auth = new StateChannel<AuthState>(
      hub,
      STATE_CHANNELS.GLOBAL_AUTH,
      {
        sessionId: "global",
        enableDeltas: false, // Auth is small, full updates are fine
        debug: false,
      },
    );

    this.config = new StateChannel<ConfigState>(
      hub,
      STATE_CHANNELS.GLOBAL_CONFIG,
      {
        sessionId: "global",
        enableDeltas: false,
        debug: false,
      },
    );

    this.health = new StateChannel<HealthState>(
      hub,
      STATE_CHANNELS.GLOBAL_HEALTH,
      {
        sessionId: "global",
        enableDeltas: false,
        refreshInterval: 30000, // Refresh health every 30s
        debug: false,
      },
    );
  }

  /**
   * Start all global channels
   */
  async start(): Promise<void> {
    await Promise.all([
      this.sessions.start(),
      this.auth.start(),
      this.config.start(),
      this.health.start(),
    ]);
  }

  /**
   * Stop all global channels
   */
  stop(): void {
    this.sessions.stop();
    this.auth.stop();
    this.config.stop();
    this.health.stop();
  }
}

/**
 * Session-Specific State Channels
 */
class SessionStateChannels {
  // Session metadata
  session: StateChannel<SessionMetaState>;

  // Messages
  messages: StateChannel<MessagesState>;

  // SDK Messages
  sdkMessages: StateChannel<SDKMessagesState>;

  // Agent state
  agent: StateChannel<AgentState>;

  // Context info
  context: StateChannel<ContextState>;

  // Available commands
  commands: StateChannel<CommandsState>;

  constructor(
    private hub: MessageHub,
    private sessionId: string,
  ) {
    this.session = new StateChannel<SessionMetaState>(
      hub,
      STATE_CHANNELS.SESSION_META,
      {
        sessionId,
        enableDeltas: false,
        debug: false,
      },
    );

    this.messages = new StateChannel<MessagesState>(
      hub,
      STATE_CHANNELS.SESSION_MESSAGES,
      {
        sessionId,
        enableDeltas: true,
        mergeDelta: (current, delta: MessagesUpdate) => {
          return {
            ...current,
            messages: DeltaMergers.array(current.messages, delta),
            messageCount: current.messages.length,
            timestamp: delta.timestamp,
          };
        },
        debug: false,
      },
    );

    this.sdkMessages = new StateChannel<SDKMessagesState>(
      hub,
      STATE_CHANNELS.SESSION_SDK_MESSAGES,
      {
        sessionId,
        enableDeltas: true,
        mergeDelta: (current, delta: SDKMessagesUpdate) => {
          return {
            ...current,
            sdkMessages: DeltaMergers.append(current.sdkMessages, delta),
            timestamp: delta.timestamp,
          };
        },
        debug: false,
      },
    );

    this.agent = new StateChannel<AgentState>(
      hub,
      STATE_CHANNELS.SESSION_AGENT,
      {
        sessionId,
        enableDeltas: false,
        debug: false,
      },
    );

    this.context = new StateChannel<ContextState>(
      hub,
      STATE_CHANNELS.SESSION_CONTEXT,
      {
        sessionId,
        enableDeltas: false,
        debug: false,
      },
    );

    this.commands = new StateChannel<CommandsState>(
      hub,
      STATE_CHANNELS.SESSION_COMMANDS,
      {
        sessionId,
        enableDeltas: false,
        debug: false,
      },
    );
  }

  /**
   * Start all session channels
   */
  async start(): Promise<void> {
    await Promise.all([
      this.session.start(),
      this.messages.start(),
      this.sdkMessages.start(),
      this.agent.start(),
      this.context.start(),
      this.commands.start(),
    ]);
  }

  /**
   * Stop all session channels
   */
  stop(): void {
    this.session.stop();
    this.messages.stop();
    this.sdkMessages.stop();
    this.agent.stop();
    this.context.stop();
    this.commands.stop();
  }
}

/**
 * Application State Manager
 */
class ApplicationState {
  private hub: MessageHub | null = null;
  private initialized = signal(false);

  // Global channels
  global: GlobalStateChannels | null = null;

  // Session channels (lazy-loaded)
  private sessionChannels = new Map<string, SessionStateChannels>();

  // Current session ID (from existing signal)
  private currentSessionIdSignal = signal<string | null>(null);

  /**
   * Initialize state management with MessageHub
   */
  async initialize(hub: MessageHub, currentSessionId: Signal<string | null>): Promise<void> {
    if (this.initialized.value) {
      console.warn("State already initialized");
      return;
    }

    this.hub = hub;
    this.currentSessionIdSignal = currentSessionId;

    // Initialize global channels
    this.global = new GlobalStateChannels(hub);
    await this.global.start();

    // Setup current session auto-loading
    this.setupCurrentSessionAutoLoad();

    this.initialized.value = true;

    console.log("[State] Initialized with fine-grained channels");
  }

  /**
   * Get or create session channels
   */
  getSessionChannels(sessionId: string): SessionStateChannels {
    if (!this.hub) {
      throw new Error("State not initialized");
    }

    if (!this.sessionChannels.has(sessionId)) {
      const channels = new SessionStateChannels(this.hub, sessionId);
      this.sessionChannels.set(sessionId, channels);

      // Start channels immediately
      channels.start().catch(console.error);
    }

    return this.sessionChannels.get(sessionId)!;
  }

  /**
   * Cleanup session channels (when session closed)
   */
  cleanupSessionChannels(sessionId: string): void {
    const channels = this.sessionChannels.get(sessionId);
    if (channels) {
      channels.stop();
      this.sessionChannels.delete(sessionId);
    }
  }

  /**
   * Setup auto-loading of current session channels
   */
  private setupCurrentSessionAutoLoad(): void {
    // Watch for current session changes and auto-load channels
    this.currentSessionIdSignal.subscribe((sessionId) => {
      if (sessionId) {
        // Ensure channels are loaded for current session
        this.getSessionChannels(sessionId);
      }
    });
  }

  /**
   * Cleanup all state
   */
  cleanup(): void {
    // Stop global channels
    this.global?.stop();
    this.global = null;

    // Stop all session channels
    this.sessionChannels.forEach((channels) => channels.stop());
    this.sessionChannels.clear();

    this.hub = null;
    this.initialized.value = false;
  }
}

// Singleton instance
export const appState = new ApplicationState();

/**
 * Convenience signals - reactive accessors for UI components
 */

// Global state signals
export const sessions = new ComputedStateChannel<Session[]>(() => {
  return appState.global?.sessions.value?.sessions || [];
});

export const authStatus = new ComputedStateChannel<AuthStatus | null>(() => {
  return appState.global?.auth.value?.authStatus || null;
});

export const daemonConfig = new ComputedStateChannel<DaemonConfig | null>(() => {
  return appState.global?.config.value?.config || null;
});

export const healthStatus = new ComputedStateChannel<HealthStatus | null>(() => {
  return appState.global?.health.value?.health || null;
});

// Current session signals (derived from currentSessionId)
export const currentSession = new ComputedStateChannel<Session | null>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return null;

  const channels = appState.getSessionChannels(sessionId);
  return channels.session.value?.session || null;
});

export const currentMessages = new ComputedStateChannel<Message[]>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return [];

  const channels = appState.getSessionChannels(sessionId);
  return channels.messages.value?.messages || [];
});

export const currentSDKMessages = new ComputedStateChannel<SDKMessage[]>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return [];

  const channels = appState.getSessionChannels(sessionId);
  return channels.sdkMessages.value?.sdkMessages || [];
});

export const currentAgentState = new ComputedStateChannel<AgentState | null>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return null;

  const channels = appState.getSessionChannels(sessionId);
  return channels.agent.value || null;
});

export const currentContextInfo = new ComputedStateChannel<ContextInfo | null>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return null;

  const channels = appState.getSessionChannels(sessionId);
  return channels.context.value?.contextInfo || null;
});

export const currentCommands = new ComputedStateChannel<string[]>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return [];

  const channels = appState.getSessionChannels(sessionId);
  return channels.commands.value?.availableCommands || [];
});

/**
 * Derived/computed state
 */
export const isAgentWorking = new ComputedStateChannel<boolean>(() => {
  return currentAgentState.value?.isProcessing || false;
});

export const canSendMessage = new ComputedStateChannel<boolean>(() => {
  const auth = authStatus.value;
  const agentWorking = isAgentWorking.value;

  return auth?.isAuthenticated === true && !agentWorking;
});

export const totalSessions = new ComputedStateChannel<number>(() => {
  return sessions.value.length;
});

export const activeSessions = new ComputedStateChannel<number>(() => {
  return sessions.value.filter(s => s.status === 'active').length;
});

export const recentSessions = new ComputedStateChannel<Session[]>(() => {
  return sessions.value
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, 5);
});

/**
 * Helper functions for optimistic updates
 */

/**
 * Create a new session (optimistic)
 */
export async function createSessionOptimistic(
  workspacePath?: string,
): Promise<string> {
  if (!appState.global) {
    throw new Error("State not initialized");
  }

  const tempId = `temp-${Date.now()}`;
  const tempSession: Session = {
    id: tempId,
    title: `Session ${new Date().toLocaleString()}`,
    workspacePath: workspacePath || "",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: "active",
    config: {
      model: "claude-sonnet-4",
      maxTokens: 8096,
      temperature: 1.0,
    },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      toolCallCount: 0,
    },
  };

  // Optimistic update
  appState.global.sessions.updateOptimistic(
    tempId,
    (current) => ({
      ...current,
      sessions: [...current.sessions, tempSession],
      timestamp: Date.now(),
    }),
  );

  // Actual API call will trigger server state update
  return tempId;
}

/**
 * Delete a session (optimistic)
 */
export function deleteSessionOptimistic(sessionId: string): void {
  if (!appState.global) {
    throw new Error("State not initialized");
  }

  // Optimistic update
  appState.global.sessions.updateOptimistic(
    `delete-${sessionId}`,
    (current) => ({
      ...current,
      sessions: current.sessions.filter((s) => s.id !== sessionId),
      timestamp: Date.now(),
    }),
  );
}

/**
 * Initialize application state
 */
export async function initializeApplicationState(
  hub: MessageHub,
  currentSessionId: Signal<string | null>,
): Promise<void> {
  await appState.initialize(hub, currentSessionId);
}

/**
 * Cleanup application state
 */
export function cleanupApplicationState(): void {
  appState.cleanup();
}
