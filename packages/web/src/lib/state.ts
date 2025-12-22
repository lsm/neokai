/**
 * Application State Management
 *
 * Architecture:
 * - Global state: Managed by globalStore (sessions, system, settings)
 * - Session state: Managed by SessionStateChannels (per-session data)
 * - Connection state: Managed by connectionState signal
 */

import { signal, computed, type Signal } from '@preact/signals';
import type { MessageHub } from '@liuboer/shared';
import type { Session, AuthStatus, DaemonConfig, HealthStatus, ContextInfo } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import type {
	SystemState,
	SessionState,
	SDKMessagesState,
	AgentProcessingState,
	SDKMessagesUpdate,
} from '@liuboer/shared';
import { STATE_CHANNELS } from '@liuboer/shared';
import { StateChannel, DeltaMergers } from './state-channel';
import { globalStore } from './global-store';

/**
 * Session-Specific State Channels
 */
class SessionStateChannels {
	// Unified session state (metadata + agent + commands + context)
	session: StateChannel<SessionState>;

	// SDK Messages
	sdkMessages: StateChannel<SDKMessagesState>;

	constructor(
		private hub: MessageHub,
		private sessionId: string
	) {
		// Unified session state channel
		this.session = new StateChannel<SessionState>(hub, STATE_CHANNELS.SESSION, {
			sessionId,
			enableDeltas: false,
			debug: false,
		});

		// SDK Messages channel
		this.sdkMessages = new StateChannel<SDKMessagesState>(
			hub,
			STATE_CHANNELS.SESSION_SDK_MESSAGES,
			{
				sessionId,
				enableDeltas: true,
				mergeDelta: (current, delta) => {
					const typedDelta = delta as SDKMessagesUpdate;
					return {
						...current,
						sdkMessages: DeltaMergers.append(current.sdkMessages, typedDelta),
						timestamp: typedDelta.timestamp,
					};
				},
				debug: false,
			}
		);
	}

	/**
	 * Start all session channels
	 */
	async start(): Promise<void> {
		await Promise.all([this.session.start(), this.sdkMessages.start()]);
	}

	/**
	 * Refresh all session channels (force fetch latest state from server)
	 * Used after reconnection to ensure state is in sync
	 */
	async refresh(): Promise<void> {
		await Promise.all([this.session.refresh(), this.sdkMessages.refresh()]);
	}

	/**
	 * Stop all session channels
	 *
	 * IMPORTANT: Async to await all unsubscribe operations.
	 * This ensures clean session switches without subscription accumulation.
	 */
	async stop(): Promise<void> {
		await Promise.all([this.session.stop(), this.sdkMessages.stop()]);
	}
}

/**
 * Application State Manager
 *
 * Manages per-session state channels. Global state is handled by globalStore.
 */
class ApplicationState {
	private hub: MessageHub | null = null;
	private initialized = signal(false);

	// Active session channels - only ONE session can have channels at a time
	// This is the session whose chat container is currently displayed
	private activeSessionId: string | null = null;
	private activeSessionChannels: SessionStateChannels | null = null;

	// Current session ID (from existing signal)
	private currentSessionIdSignal = signal<string | null>(null);

	// Track subscriptions to prevent memory leaks
	private subscriptions: Array<() => void> = [];

	/**
	 * Initialize state management with MessageHub
	 *
	 * Global state is handled by globalStore. This only sets up session channels.
	 */
	async initialize(hub: MessageHub, currentSessionId: Signal<string | null>): Promise<void> {
		if (this.initialized.value) {
			console.warn('State already initialized');
			return;
		}

		this.hub = hub;
		this.currentSessionIdSignal = currentSessionId;

		// Setup current session auto-loading
		this.setupCurrentSessionAutoLoad();

		this.initialized.value = true;

		console.log('[State] Initialized (global state handled by globalStore)');
	}

	/**
	 * Get or create session channels
	 *
	 * INVARIANT: Only ONE session can have active channels at any time.
	 * This is the "current active session" whose chat container is displayed.
	 *
	 * Session data shown in lists (sidebar, recent sessions) should come from
	 * globalStore.sessions, NOT per-session subscriptions.
	 *
	 * CRITICAL: Returns channels synchronously but initiates async cleanup/start.
	 * The cleanup waits for all unsubscribe ACKs before starting new subscriptions,
	 * preventing the subscription accumulation that caused rate limit errors.
	 */
	getSessionChannels(sessionId: string): SessionStateChannels {
		if (!this.hub) {
			throw new Error('State not initialized');
		}

		// If requesting the same session, return existing channels
		if (this.activeSessionId === sessionId && this.activeSessionChannels) {
			return this.activeSessionChannels;
		}

		// Cleanup previous session's channels before creating new ones
		// CRITICAL: Must await stop() to ensure unsubscribes complete before new subscribes
		const previousChannels = this.activeSessionChannels;
		const previousSessionId = this.activeSessionId;

		// Create new channels for the requested session (but don't start yet)
		const channels = new SessionStateChannels(this.hub, sessionId);
		this.activeSessionId = sessionId;
		this.activeSessionChannels = channels;

		// Async cleanup + start sequence (awaits unsubscribes before subscribes)
		(async () => {
			if (previousChannels) {
				console.log(`[State] Switching session: cleaning up channels for ${previousSessionId}`);
				await previousChannels.stop(); // AWAIT unsubscribes
				console.log(`[State] Cleanup complete for ${previousSessionId}`);
			}

			// Now start new session's channels
			console.log(`[State] Starting channels for ${sessionId}`);
			await channels.start();
			console.log(`[State] Channels started for ${sessionId}`);
		})().catch((err) => {
			console.error(`[State] Session channel switch error:`, err);
		});

		return channels;
	}

	/**
	 * Cleanup session channels (when navigating away from a session)
	 *
	 * IMPORTANT: Async to await all unsubscribe operations.
	 */
	async cleanupSessionChannels(sessionId: string): Promise<void> {
		if (this.activeSessionId === sessionId && this.activeSessionChannels) {
			console.log(`[State] Cleaning up channels for session: ${sessionId}`);
			await this.activeSessionChannels.stop();
			this.activeSessionId = null;
			this.activeSessionChannels = null;
			console.log(`[State] Cleanup complete for session: ${sessionId}`);
		}
	}

	/**
	 * Setup auto-loading of current session channels
	 *
	 * FIX: Cleanup previous session's channels when switching sessions.
	 * This prevents subscription accumulation that caused the "subscription storm"
	 * on reconnection. Only the ACTIVE session should have subscriptions.
	 */
	private setupCurrentSessionAutoLoad(): void {
		let previousSessionId: string | null = null;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const DEBOUNCE_MS = 150; // Debounce rapid session switches to prevent rate limit errors

		const unsub = this.currentSessionIdSignal.subscribe((sessionId: string | null) => {
			// Cancel any pending session switch
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}

			// Debounce the actual channel setup to prevent subscription storm on rapid switching
			debounceTimer = setTimeout(() => {
				(async () => {
					// CLEANUP: Stop previous session's channels before starting new ones
					// This prevents subscription accumulation across session switches
					if (previousSessionId && previousSessionId !== sessionId) {
						console.log(`[State] Cleaning up channels for previous session: ${previousSessionId}`);
						await this.cleanupSessionChannels(previousSessionId);
					}

					// START: Load channels for new current session
					if (sessionId) {
						this.getSessionChannels(sessionId);
					}

					previousSessionId = sessionId;
				})().catch(console.error);

				debounceTimer = null;
			}, DEBOUNCE_MS);
		});
		this.subscriptions.push(unsub);
	}

	/**
	 * Refresh all state channels (force fetch latest state from server)
	 * Used after reconnection validation to ensure state is in sync
	 *
	 * This is critical for the Safari background tab issue where the connection
	 * may appear healthy but subscriptions are stale.
	 */
	async refreshAll(): Promise<void> {
		if (!this.initialized.value) {
			console.warn('[State] Cannot refresh: state not initialized');
			return;
		}

		console.log('[State] Refreshing state channels after reconnection validation');

		// Refresh current session channels
		if (this.activeSessionChannels) {
			await this.activeSessionChannels.refresh();
		}

		console.log('[State] Session state channels refreshed');
	}

	/**
	 * Cleanup all state
	 *
	 * NOTE: Fire-and-forget for stop() calls since this is final cleanup.
	 * During session switching, proper await is done in getSessionChannels().
	 */
	cleanup(): void {
		// Cleanup all signal subscriptions to prevent memory leaks
		this.subscriptions.forEach((unsub) => unsub());
		this.subscriptions = [];

		// Stop active session channels (fire-and-forget, we're shutting down)
		if (this.activeSessionChannels) {
			this.activeSessionChannels.stop().catch(console.error);
			this.activeSessionId = null;
			this.activeSessionChannels = null;
		}

		this.hub = null;
		this.initialized.value = false;
	}
}

// Singleton instance
export const appState = new ApplicationState();

/**
 * Convenience signals - reactive accessors for UI components
 *
 * Global state is backed by globalStore. Session state uses SessionStateChannels.
 */

// Global state signals - delegating to globalStore
export const sessions = computed<Session[]>(() => {
	return globalStore.sessions.value;
});

export const hasArchivedSessions = computed<boolean>(() => {
	return globalStore.hasArchivedSessions.value;
});

// System state - delegating to globalStore
export const systemState = computed<SystemState | null>(() => {
	return globalStore.systemState.value;
});

export const authStatus = computed<AuthStatus | null>(() => {
	const system = systemState.value;
	return system?.auth || null;
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

export const apiConnectionStatus = computed<import('@liuboer/shared').ApiConnectionState | null>(
	() => {
		const system = systemState.value;
		return system?.apiConnection || null;
	}
);

export const globalSettings = computed<import('@liuboer/shared').GlobalSettings | null>(() => {
	return globalStore.settings.value;
});

// Current session signals (derived from currentSessionId)
export const currentSessionState = computed<SessionState | null>(() => {
	const sessionId = appState['currentSessionIdSignal'].value;
	if (!sessionId) return null;

	const channels = appState.getSessionChannels(sessionId);
	return channels.session.$.value || null;
});

export const currentSession = computed<Session | null>(() => {
	return currentSessionState.value?.sessionInfo || null;
});

export const currentSDKMessages = computed<SDKMessage[]>(() => {
	const sessionId = appState['currentSessionIdSignal'].value;
	if (!sessionId) return [];

	const channels = appState.getSessionChannels(sessionId);
	const stateValue = channels.sdkMessages.$.value;
	return stateValue?.sdkMessages || [];
});

export const currentAgentState = computed<AgentProcessingState>(() => {
	return currentSessionState.value?.agentState || { status: 'idle' };
});

export const currentContextInfo = computed<ContextInfo | null>(() => {
	return currentSessionState.value?.contextInfo || null;
});

export const currentCommands = computed<string[]>(() => {
	return currentSessionState.value?.commandsData?.availableCommands || [];
});

/**
 * Derived/computed state
 */
export const isAgentWorking = computed<boolean>(() => {
	const state = currentAgentState.value;
	return state.status === 'processing' || state.status === 'queued';
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
	return sessions.value.filter((s) => s.status === 'active').length;
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
export type ConnectionState =
	| 'connecting'
	| 'connected'
	| 'disconnected'
	| 'error'
	| 'reconnecting'
	| 'failed';
export const connectionState = signal<ConnectionState>('connecting');

/**
 * Helper functions for optimistic updates
 */

/**
 * Create a new session (optimistic)
 */
export async function createSessionOptimistic(workspacePath?: string): Promise<string> {
	const tempId = `temp-${Date.now()}`;
	const tempSession: Session = {
		id: tempId,
		title: `Session ${new Date().toLocaleString()}`,
		workspacePath: workspacePath || '',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: 'active',
		config: {
			model: 'claude-sonnet-4',
			maxTokens: 8096,
			temperature: 1.0,
		},
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		},
	};

	// Optimistic update using globalStore
	globalStore.addSession(tempSession);

	// Actual API call will trigger server state update
	return tempId;
}

/**
 * Delete a session (optimistic)
 */
export function deleteSessionOptimistic(sessionId: string): void {
	// Optimistic update using globalStore
	globalStore.removeSession(sessionId);
}

/**
 * Initialize application state
 */
export async function initializeApplicationState(
	hub: MessageHub,
	currentSessionId: Signal<string | null>
): Promise<void> {
	await appState.initialize(hub, currentSessionId);
}

/**
 * Cleanup application state
 */
export function cleanupApplicationState(): void {
	appState.cleanup();
}
