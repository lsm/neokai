/**
 * Global type declarations for E2E tests
 *
 * This file provides proper Window augmentation to avoid (window as any) casts.
 * All window properties exposed by the web app for testing should be declared here.
 */

import type { MessageHub } from '@liuboer/shared/message-hub/message-hub';
import type { Session, ContextInfo, AgentProcessingState } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import type { ConnectionState } from '@liuboer/shared/message-hub/types';
import type { Signal } from '@preact/signals';

/**
 * SessionStore interface (simplified for E2E tests)
 *
 * The SessionStore has both signals and computed properties.
 * - Core signals: activeSessionId, sessionState, sdkMessages
 * - Computed properties (also signals): agentState, contextInfo, commandsData, error
 */
interface SessionStore {
	// ========================================
	// Core Signals
	// ========================================

	/** Current active session ID (signal) */
	activeSessionId: Signal<string | null>;

	/** Unified session state from state.session channel (signal) */
	sessionState: Signal<{
		sessionInfo?: Session;
		agentState?: AgentProcessingState;
		contextInfo?: ContextInfo | null;
		commandsData?: { availableCommands?: string[] } | null;
		error?: { message: string; details?: unknown; occurredAt: number } | null;
	} | null>;

	/** SDK messages from state.sdkMessages channel (signal) */
	sdkMessages: Signal<SDKMessage[]>;

	// ========================================
	// Computed Properties (Signals)
	// ========================================

	/** Agent processing state (computed signal, returns { status: 'idle' } as default) */
	agentState: Signal<AgentProcessingState>;

	/** Context info (computed signal) */
	contextInfo: Signal<ContextInfo | null>;

	/** Available slash commands (computed signal, returns string[] directly) */
	commandsData: Signal<string[]>;

	/** Session error state (computed signal) */
	error: Signal<{
		message: string;
		details?: unknown;
		occurredAt: number;
	} | null>;
}

/**
 * GlobalStore interface (simplified for E2E tests)
 */
interface GlobalStore {
	/** All sessions (signal) */
	sessions: Signal<Session[]>;

	/** Whether there are any archived sessions in the database (signal) */
	hasArchivedSessions: Signal<boolean>;

	/** Unified system state (signal) */
	systemState: Signal<{
		auth?: unknown;
		health?: unknown;
		apiConnection?: unknown;
	} | null>;

	/** Global settings (signal) */
	settings: Signal<unknown | null>;
}

/**
 * State signal structure (from Preact signals)
 */
interface StateSignal<T> {
	value?: T;
}

/**
 * Wrapper signal for state channels
 */
interface StateChannelSignal<T> {
	$: StateSignal<T>;
}

/**
 * Sessions state structure
 */
interface SessionsState {
	sessions: Session[];
}

/**
 * Agent state for a session
 */
interface AgentState {
	status?: 'idle' | 'processing' | 'error';
	currentTool?: string;
}

/**
 * Context state for a session
 */
interface ContextState {
	model?: string;
	totalUsed?: number;
	totalCapacity?: number;
	percentUsed?: number;
}

/**
 * Commands state for a session
 */
interface CommandsState {
	commands?: string[];
}

/**
 * Session-specific state map
 */
interface SessionStateMap {
	agent?: StateChannelSignal<AgentState>;
	context?: StateChannelSignal<ContextState>;
	commands?: StateChannelSignal<CommandsState>;
}

/**
 * Global application state exposed on window
 */
interface AppState {
	messageHub?: MessageHub;
	currentSessionIdSignal?: StateSignal<string>;
	global?: StateSignal<{
		sessions?: StateChannelSignal<SessionsState>;
	}>;
	sessions?: Map<string, SessionStateMap>;
}

/**
 * Connection manager exposed on window
 */
interface ConnectionManager {
	simulateDisconnect: () => void;
	getState: () => ConnectionState;
}

/**
 * MessageHub-like interface for E2E tests (subset of actual MessageHub)
 */
interface TestMessageHub {
	getState(): ConnectionState;
	subscribe<T = unknown>(
		event: string,
		handler: (data: T) => void | Promise<void>,
		options?: { sessionId?: string }
	): Promise<() => Promise<void>>;
	call<T = unknown, R = unknown>(
		method: string,
		data?: T,
		options?: { sessionId?: string; timeout?: number }
	): Promise<R>;
}

/**
 * Window augmentation for E2E tests
 *
 * These properties are exposed by the web app for testing purposes.
 * Using this declaration avoids (window as any) casts throughout tests.
 */
declare global {
	interface Window {
		/** MessageHub instance for direct RPC/event access in tests */
		__messageHub?: TestMessageHub;

		/** Collected SDK messages for test assertions */
		__sdkMessages?: SDKMessage[];

		/** Application state for observing signals */
		appState?: AppState;

		/** Current session ID signal (if exposed globally) */
		currentSessionIdSignal?: Signal<string | null>;

		/** Slash commands signal */
		slashCommandsSignal?: Signal<string[]>;

		/** Connection manager for simulating connection issues */
		connectionManager?: ConnectionManager;

		/** GlobalStore for sessions list */
		globalStore?: GlobalStore;

		/** SessionStore for current session state */
		sessionStore?: SessionStore;

		/** Test-specific helper functions (set dynamically by tests) */
		__checkInterrupt?: () => boolean;
		__getConnectionStates?: () => string[];
	}
}

export {};
