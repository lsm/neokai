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
  SystemState,
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

  // Unified system state (auth + config + health)
  system: StateChannel<SystemState>;

  constructor(private hub: MessageHub) {
    // Initialize channels with delta support
    this.sessions = new StateChannel<SessionsState>(
      hub,
      STATE_CHANNELS.GLOBAL_SESSIONS,
      {
        sessionId: "global",
        enableDeltas: true,
        mergeDelta: (current, delta: SessionsUpdate) => {
          console.log('[State] Merging sessions delta:', {
            currentCount: current.sessions.length,
            delta: delta,
          });
          const merged = {
            ...current,
            sessions: DeltaMergers.array(current.sessions, delta),
            timestamp: delta.timestamp,
          };
          console.log('[State] After merge, sessions count:', merged.sessions.length);
          return merged;
        },
        debug: true, // Enable debug to see what's happening
      },
    );

    // NEW: Unified system state channel
    this.system = new StateChannel<SystemState>(
      hub,
      STATE_CHANNELS.GLOBAL_SYSTEM,
      {
        sessionId: "global",
        enableDeltas: false, // System state is small, full updates are fine
        refreshInterval: 30000, // Refresh every 30s (for health uptime)
        debug: true, // Enable debug to see what's happening
      },
    );
  }

  /**
   * Start all global channels
   */
  async start(): Promise<void> {
    await Promise.all([
      this.sessions.start(),
      this.system.start(),
    ]);
  }

  /**
   * Stop all global channels
   */
  stop(): void {
    this.sessions.stop();
    this.system.stop();
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

  // Cleanup functions for subscriptions
  private cleanupFunctions: Array<() => void> = [];

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

    // Subscribe to immediate commands updates (broadcasted when SDK fetches commands)
    // IMPORTANT: hub.subscribe() returns a Promise, must await it
    hub.subscribe(
      'session.commands-updated',
      (data: { availableCommands: string[] }) => {
        console.log(`[State] Received commands update for session ${sessionId}:`, data.availableCommands);
        // Update the commands channel immediately
        this.commands.$.value = {
          availableCommands: data.availableCommands,
          timestamp: Date.now(),
        };
      },
      { sessionId }
    ).then(unsub => {
      this.cleanupFunctions.push(unsub);
    }).catch(err => {
      console.error(`[State] Failed to subscribe to session.commands-updated for session ${sessionId}:`, err);
    });
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

    // Cleanup subscriptions
    this.cleanupFunctions.forEach(cleanup => {
      if (typeof cleanup === 'function') {
        cleanup();
      }
    });
    this.cleanupFunctions = [];
  }
}

/**
 * Application State Manager
 */
class ApplicationState {
  private hub: MessageHub | null = null;
  private initialized = signal(false);

  // Global channels - must be a signal so computed signals can track when it's initialized
  global = signal<GlobalStateChannels | null>(null);

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
    const globalChannels = new GlobalStateChannels(hub);
    await globalChannels.start();
    this.global.value = globalChannels;

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
    this.global.value?.stop();
    this.global.value = null;

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

// Global state signals - exported as direct Preact computed signals for proper reactivity
// IMPORTANT: Access appState.global.value (signal) then the channel's .$.value for proper tracking
export const sessions = computed<Session[]>(() => {
  const global = appState.global.value;
  if (!global) return [];
  const stateValue = global.sessions.$.value;
  const value = stateValue?.sessions || [];
  console.log('[State Signal] sessions.value:', value);
  return value;
});

// NEW: Extract from unified system state
export const systemState = computed<SystemState | null>(() => {
  const global = appState.global.value;
  if (!global) return null;
  return global.system.$.value;
});

export const authStatus = computed<AuthStatus | null>(() => {
  const system = systemState.value;
  const value = system?.auth || null;
  console.log('[State Signal] authStatus.value:', value);
  return value;
});

export const daemonConfig = computed<DaemonConfig | null>(() => {
  const system = systemState.value;
  if (!system) return null;

  // Reconstruct DaemonConfig from SystemState
  return {
    version: system.version,
    claudeSDKVersion: system.claudeSDKVersion,
    defaultModel: system.defaultModel,
    maxSessions: system.maxSessions,
    storageLocation: system.storageLocation,
    authMethod: system.auth.method,
    authStatus: system.auth,
  };
});

export const healthStatus = computed<HealthStatus | null>(() => {
  const system = systemState.value;
  return system?.health || null;
});

// Current session signals (derived from currentSessionId) - exported as direct Preact computed signals
// IMPORTANT: Access the underlying signal via .$ to ensure Preact tracks the dependency
export const currentSession = computed<Session | null>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return null;

  const channels = appState.getSessionChannels(sessionId);
  const stateValue = channels.session.$.value;
  return stateValue?.session || null;
});

export const currentMessages = computed<Message[]>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return [];

  const channels = appState.getSessionChannels(sessionId);
  const stateValue = channels.messages.$.value;
  return stateValue?.messages || [];
});

export const currentSDKMessages = computed<SDKMessage[]>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return [];

  const channels = appState.getSessionChannels(sessionId);
  const stateValue = channels.sdkMessages.$.value;
  return stateValue?.sdkMessages || [];
});

export const currentAgentState = computed<AgentState | null>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return null;

  const channels = appState.getSessionChannels(sessionId);
  return channels.agent.$.value || null;
});

export const currentContextInfo = computed<ContextInfo | null>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return null;

  const channels = appState.getSessionChannels(sessionId);
  const stateValue = channels.context.$.value;
  return stateValue?.contextInfo || null;
});

export const currentCommands = computed<string[]>(() => {
  const sessionId = appState["currentSessionIdSignal"].value;
  if (!sessionId) return [];

  const channels = appState.getSessionChannels(sessionId);
  const stateValue = channels.commands.$.value;
  return stateValue?.availableCommands || [];
});

/**
 * Derived/computed state - exported as direct Preact computed signals
 */
export const isAgentWorking = computed<boolean>(() => {
  return currentAgentState.value?.isProcessing || false;
});

export const canSendMessage = computed<boolean>(() => {
  const auth = authStatus.value;
  const agentWorking = isAgentWorking.value;

  return auth?.isAuthenticated === true && !agentWorking;
});

export const totalSessions = computed<number>(() => {
  return sessions.value.length;
});

export const activeSessions = computed<number>(() => {
  return sessions.value.filter(s => s.status === 'active').length;
});

export const recentSessions = computed<Session[]>(() => {
  return sessions.value
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, 5);
});

/**
 * Global WebSocket connection state
 * Single source of truth for the entire app
 */
export type ConnectionState = "connecting" | "connected" | "disconnected";
export const connectionState = signal<ConnectionState>("connecting");

/**
 * Helper functions for optimistic updates
 */

/**
 * Create a new session (optimistic)
 */
export async function createSessionOptimistic(
  workspacePath?: string,
): Promise<string> {
  const global = appState.global.value;
  if (!global) {
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
  global.sessions.updateOptimistic(
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
  const global = appState.global.value;
  if (!global) {
    throw new Error("State not initialized");
  }

  // Optimistic update
  global.sessions.updateOptimistic(
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
