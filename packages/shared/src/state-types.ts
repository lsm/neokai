/**
 * State Types for Client-Server Synchronization
 *
 * Fine-grained state channels - each property has its own channel
 */

import type {
  AuthStatus,
  Session,
  Message,
  DaemonConfig,
  HealthStatus,
  ContextInfo,
} from "./types.ts";
import type { SDKMessage } from "./sdk/sdk.d.ts";

/**
 * Global State Channels
 * These are available to all clients and use sessionId: "global"
 */

// State channel: global:state.sessions
export interface SessionsState {
  sessions: Session[];
  timestamp: number;
}

// State channel: global:state.system (UNIFIED)
// Combines auth, config, and health into single channel
export interface SystemState {
  // Version & build info
  version: string;
  claudeSDKVersion: string;

  // Configuration
  defaultModel: string;
  maxSessions: number;
  storageLocation: string;

  // Authentication
  auth: AuthStatus;

  // System health
  health: HealthStatus;

  timestamp: number;
}

/**
 * Session-Specific State Channels
 * These use sessionId: <session-id> for routing
 */

// State channel: {sessionId}:state.session
export interface SessionMetaState {
  session: Session;
  timestamp: number;
}

// State channel: {sessionId}:state.messages
export interface MessagesState {
  messages: Message[];
  messageCount: number;
  timestamp: number;
}

// State channel: {sessionId}:state.sdkMessages
export interface SDKMessagesState {
  sdkMessages: SDKMessage[];
  timestamp: number;
}

// State channel: {sessionId}:state.agent
export interface AgentState {
  isProcessing: boolean;
  currentTask: string | null;
  status: 'idle' | 'working' | 'waiting' | 'error';
  timestamp: number;
}

// State channel: {sessionId}:state.context
export interface ContextState {
  contextInfo: ContextInfo | null;
  timestamp: number;
}

// State channel: {sessionId}:state.commands
export interface CommandsState {
  availableCommands: string[];
  timestamp: number;
}

/**
 * State Channel Metadata
 */
export interface StateChannelMeta {
  channel: string;
  sessionId: string;
  lastUpdate: number;
  version: number; // For conflict resolution
}

/**
 * State Snapshot - Full state for initial sync
 */
export interface GlobalStateSnapshot {
  sessions: SessionsState;
  system: SystemState;
  meta: StateChannelMeta;
}

export interface SessionStateSnapshot {
  session: SessionMetaState;
  messages: MessagesState;
  sdkMessages: SDKMessagesState;
  agent: AgentState;
  context: ContextState;
  commands: CommandsState;
  meta: StateChannelMeta;
}

/**
 * State Update Events
 * Incremental updates for specific channels
 */

// For array updates, we can send deltas
export interface SessionsUpdate {
  added?: Session[];
  updated?: Session[];
  removed?: string[]; // session IDs
  timestamp: number;
}

export interface MessagesUpdate {
  added?: Message[];
  updated?: Message[];
  removed?: string[]; // message IDs
  timestamp: number;
}

export interface SDKMessagesUpdate {
  added?: SDKMessage[];
  timestamp: number;
}

/**
 * State Channel Names
 * Centralized channel name constants
 */
export const STATE_CHANNELS = {
  // Global channels
  GLOBAL_SESSIONS: 'state.sessions',
  GLOBAL_SYSTEM: 'state.system', // Unified system state (auth + config + health)
  GLOBAL_SNAPSHOT: 'state.global.snapshot',

  // Session channels (prefix with sessionId:)
  SESSION_META: 'state.session',
  SESSION_MESSAGES: 'state.messages',
  SESSION_SDK_MESSAGES: 'state.sdkMessages',
  SESSION_AGENT: 'state.agent',
  SESSION_CONTEXT: 'state.context',
  SESSION_COMMANDS: 'state.commands',
  SESSION_SNAPSHOT: 'state.session.snapshot',
} as const;

/**
 * State change event types
 */
export type StateChangeEvent<T> = {
  type: 'full' | 'partial' | 'delta';
  data: T;
  timestamp: number;
  version: number;
};
