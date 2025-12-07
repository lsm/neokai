/**
 * State Types for Client-Server Synchronization
 *
 * Fine-grained state channels - each property has its own channel
 */

import type { AuthStatus, Session, DaemonConfig, HealthStatus, ContextInfo } from './types.ts';
import type { SDKMessage } from './sdk/sdk.d.ts';

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

/**
 * Agent processing state
 * Tracks what the agent is currently doing
 * Moved from daemon/agent-session.ts to shared for type consistency
 */
export type AgentProcessingState =
	| { status: 'idle' }
	| { status: 'queued'; messageId: string }
	| { status: 'processing'; messageId: string }
	| { status: 'interrupted' };

/**
 * Commands data structure
 */
export interface CommandsData {
	availableCommands: string[];
}

/**
 * UNIFIED Session State
 * Combines all session-specific state (metadata, agent, commands, context)
 * into a single state channel for simpler synchronization
 *
 * State channel: {sessionId}:state.session
 *
 * This replaces the old fragmented approach of:
 * - state.session (metadata only)
 * - agent.state event (agent state)
 * - session.commands-updated event (commands)
 * - state.context (context info)
 */
export interface SessionState {
	// Session metadata
	session: Session;

	// Agent processing state
	agent: AgentProcessingState;

	// Available slash commands
	commands: CommandsData;

	// Context information (placeholder - will implement later)
	context: ContextInfo | null;

	timestamp: number;
}

// State channel: {sessionId}:state.sdkMessages
export interface SDKMessagesState {
	sdkMessages: SDKMessage[];
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
	// Unified session state (metadata, agent, commands, context)
	session: SessionState;
	// SDK messages (kept separate due to different update pattern)
	sdkMessages: SDKMessagesState;
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
	SESSION: 'state.session', // Unified session state (metadata + agent + commands + context)
	SESSION_SDK_MESSAGES: 'state.sdkMessages',
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
