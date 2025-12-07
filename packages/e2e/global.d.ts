/**
 * Global type declarations for E2E tests
 *
 * This file provides proper Window augmentation to avoid (window as any) casts.
 * All window properties exposed by the web app for testing should be declared here.
 */

import type { MessageHub } from '@liuboer/shared/message-hub/message-hub';
import type { Session } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import type { ConnectionState } from '@liuboer/shared/message-hub/types';

/**
 * Session state signal structure (from Preact signals)
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
interface SessionState {
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
	sessions?: Map<string, SessionState>;
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
		currentSessionIdSignal?: StateSignal<string>;

		/** Connection manager for simulating connection issues */
		connectionManager?: ConnectionManager;

		/** Test-specific helper functions (set dynamically by tests) */
		__checkInterrupt?: () => boolean;
		__getConnectionStates?: () => string[];
	}
}

export {};
