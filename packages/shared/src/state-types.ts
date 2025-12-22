/**
 * State Types for Client-Server Synchronization
 *
 * Fine-grained state channels - each property has its own channel
 */

import type { AuthStatus, SessionInfo, HealthStatus, ContextInfo } from './types.ts';
import type { SDKMessage } from './sdk/sdk.d.ts';
import type { GlobalSettings } from './types/settings.ts';

/**
 * Global State Channels
 * These are available to all clients and use sessionId: "global"
 */

// State channel: global:state.sessions
export interface SessionsState {
	sessions: SessionInfo[];
	hasArchivedSessions: boolean; // Whether there are any archived sessions in the database
	timestamp: number;
}

/**
 * API Connection Status
 * Tracks connectivity between daemon and Claude API (not WebSocket)
 */
export type ApiConnectionStatus = 'connected' | 'degraded' | 'disconnected';

export interface ApiConnectionState {
	status: ApiConnectionStatus;
	/** Number of consecutive connection errors in current window */
	errorCount?: number;
	/** Last connection error message */
	lastError?: string;
	/** Timestamp of last successful API call */
	lastSuccessfulCall?: number;
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

	// API connectivity (daemon <-> Claude API)
	apiConnection: ApiConnectionState;

	timestamp: number;
}

// State channel: global:state.settings
export interface SettingsState {
	settings: GlobalSettings;
	timestamp: number;
}

/**
 * Session-Specific State Channels
 * These use sessionId: <session-id> for routing
 */

/**
 * Agent processing state
 * Tracks what the agent is currently doing with fine-grained phase information
 * Moved from daemon/agent-session.ts to shared for type consistency
 */
export type AgentProcessingState =
	| { status: 'idle' }
	| { status: 'queued'; messageId: string }
	| {
			status: 'processing';
			messageId: string;
			phase: 'initializing' | 'thinking' | 'streaming' | 'finalizing';
			streamingStartedAt?: number; // Timestamp when streaming began
			isCompacting?: boolean; // True during context compaction
	  }
	| { status: 'interrupted' };

/**
 * Commands data structure
 */
export interface CommandsData {
	availableCommands: string[];
}

/**
 * Session error state
 * Folded from separate session.error event into unified state.session
 */
export interface SessionError {
	message: string;
	details?: unknown; // StructuredError when available
	occurredAt: number;
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
	sessionInfo: SessionInfo;

	// Agent processing state
	agentState: AgentProcessingState;

	// Available slash commands
	commandsData: CommandsData;

	// Context information
	contextInfo: ContextInfo | null;

	// Error state (folded from session.error event)
	error: SessionError | null;

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
	settings: SettingsState;
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
	added?: SessionInfo[];
	updated?: SessionInfo[];
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
	GLOBAL_SETTINGS: 'state.settings', // Global settings state
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
