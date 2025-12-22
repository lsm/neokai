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

import { signal, computed, type Signal } from '@preact/signals';
import type { MessageHub } from '@liuboer/shared';
import type { Session, AuthStatus, DaemonConfig, HealthStatus, ContextInfo } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import type {
	SessionsState,
	SystemState,
	SettingsState,
	SessionState,
	SDKMessagesState,
	AgentProcessingState,
	SessionsUpdate,
	SDKMessagesUpdate,
} from '@liuboer/shared';
import { STATE_CHANNELS } from '@liuboer/shared';
import { StateChannel, DeltaMergers } from './state-channel';

/**
 * Global State Channels
 */
class GlobalStateChannels {
	// Sessions list
	sessions: StateChannel<SessionsState>;

	// Unified system state (auth + config + health)
	system: StateChannel<SystemState>;

	// Global settings
	settings: StateChannel<SettingsState>;

	constructor(private hub: MessageHub) {
		// Initialize channels with delta support
		this.sessions = new StateChannel<SessionsState>(hub, STATE_CHANNELS.GLOBAL_SESSIONS, {
			sessionId: 'global',
			enableDeltas: true,
			mergeDelta: (current, delta) => {
				const typedDelta = delta as SessionsUpdate;
				return {
					...current,
					sessions: DeltaMergers.array(current.sessions, typedDelta),
					timestamp: typedDelta.timestamp,
				};
			},
			debug: false,
		});

		// NEW: Unified system state channel
		this.system = new StateChannel<SystemState>(hub, STATE_CHANNELS.GLOBAL_SYSTEM, {
			sessionId: 'global',
			enableDeltas: false, // System state is small, full updates are fine
			refreshInterval: 30000, // Refresh every 30s (for health uptime)
			debug: false,
		});

		// Global settings channel
		this.settings = new StateChannel<SettingsState>(hub, STATE_CHANNELS.GLOBAL_SETTINGS, {
			sessionId: 'global',
			enableDeltas: false, // Settings are small, full updates are fine
			debug: false,
		});
	}

	/**
	 * Start all global channels
	 */
	async start(): Promise<void> {
		await Promise.all([this.sessions.start(), this.system.start(), this.settings.start()]);
	}

	/**
	 * Refresh all global channels (force fetch latest state from server)
	 * Used after reconnection to ensure state is in sync
	 */
	async refresh(): Promise<void> {
		await Promise.all([this.sessions.refresh(), this.system.refresh(), this.settings.refresh()]);
	}

	/**
	 * Stop all global channels
	 *
	 * IMPORTANT: Async to await all unsubscribe operations.
	 */
	async stop(): Promise<void> {
		await Promise.all([this.sessions.stop(), this.system.stop(), this.settings.stop()]);
	}
}

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
 */
class ApplicationState {
	private hub: MessageHub | null = null;
	private initialized = signal(false);

	// Global channels - must be a signal so computed signals can track when it's initialized
	global = signal<GlobalStateChannels | null>(null);

	// Active session channels - only ONE session can have channels at a time
	// This is the session whose chat container is currently displayed
	private activeSessionId: string | null = null;
	private activeSessionChannels: SessionStateChannels | null = null;

	// Current session ID (from existing signal)
	private currentSessionIdSignal = signal<string | null>(null);

	// FIX: Track subscriptions to prevent memory leaks
	private subscriptions: Array<() => void> = [];

	/**
	 * Initialize state management with MessageHub
	 */
	async initialize(hub: MessageHub, currentSessionId: Signal<string | null>): Promise<void> {
		if (this.initialized.value) {
			console.warn('State already initialized');
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

		console.log('[State] Initialized with fine-grained channels');
	}

	/**
	 * Get or create session channels
	 *
	 * INVARIANT: Only ONE session can have active channels at any time.
	 * This is the "current active session" whose chat container is displayed.
	 *
	 * Session data shown in lists (sidebar, recent sessions) should come from
	 * `state.sessions` (global channel), NOT per-session subscriptions.
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
	 *
	 * Before: Open 30 sessions → 4 global + 90 session = 94 subscriptions (never cleaned up)
	 * After: Open 30 sessions → 4 global + 3 session = 7 subscriptions (only active session)
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

		console.log('[State] Refreshing all state channels after reconnection validation');

		const promises: Promise<void>[] = [];

		// Refresh global channels
		if (this.global.value) {
			promises.push(this.global.value.refresh());
		}

		// Refresh current session channels
		if (this.activeSessionChannels) {
			promises.push(this.activeSessionChannels.refresh());
		}

		await Promise.all(promises);
		console.log('[State] All state channels refreshed');
	}

	/**
	 * Cleanup all state
	 *
	 * NOTE: Fire-and-forget for stop() calls since this is final cleanup.
	 * During session switching, proper await is done in getSessionChannels().
	 */
	cleanup(): void {
		// FIX: Cleanup all signal subscriptions to prevent memory leaks
		this.subscriptions.forEach((unsub) => unsub());
		this.subscriptions = [];

		// Stop global channels (fire-and-forget, we're shutting down)
		this.global.value?.stop().catch(console.error);
		this.global.value = null;

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
 */

// Global state signals - exported as direct Preact computed signals for proper reactivity
// IMPORTANT: Access appState.global.value (signal) then the channel's .$.value for proper tracking
export const sessions = computed<Session[]>(() => {
	const global = appState.global.value;
	if (!global) return [];
	const stateValue = global.sessions.$.value;
	return stateValue?.sessions || [];
});

// NEW: Extract from unified system state
export const systemState = computed<SystemState | null>(() => {
	const global = appState.global.value;
	if (!global) return null;
	return global.system.$.value;
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
	const global = appState.global.value;
	if (!global) return null;
	const stateValue = global.settings.$.value;
	return stateValue?.settings || null;
});

// Current session signals (derived from currentSessionId) - exported as direct Preact computed signals
// IMPORTANT: Access the underlying signal via .$ to ensure Preact tracks the dependency
export const currentSessionState = computed<SessionState | null>(() => {
	const sessionId = appState['currentSessionIdSignal'].value;
	if (!sessionId) return null;

	const channels = appState.getSessionChannels(sessionId);
	return channels.session.$.value || null;
});

export const currentSession = computed<Session | null>(() => {
	return currentSessionState.value?.session || null;
});

export const currentSDKMessages = computed<SDKMessage[]>(() => {
	const sessionId = appState['currentSessionIdSignal'].value;
	if (!sessionId) return [];

	const channels = appState.getSessionChannels(sessionId);
	const stateValue = channels.sdkMessages.$.value;
	return stateValue?.sdkMessages || [];
});

export const currentAgentState = computed<AgentProcessingState>(() => {
	return currentSessionState.value?.agent || { status: 'idle' };
});

export const currentContextInfo = computed<ContextInfo | null>(() => {
	return currentSessionState.value?.context || null;
});

export const currentCommands = computed<string[]>(() => {
	return currentSessionState.value?.commands?.availableCommands || [];
});

/**
 * Derived/computed state - exported as direct Preact computed signals
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
	const global = appState.global.value;
	if (!global) {
		throw new Error('State not initialized');
	}

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

	// Optimistic update (prepend to show newest first)
	global.sessions.updateOptimistic(tempId, (current) => ({
		...current,
		sessions: [tempSession, ...current.sessions],
		timestamp: Date.now(),
	}));

	// Actual API call will trigger server state update
	return tempId;
}

/**
 * Delete a session (optimistic)
 */
export function deleteSessionOptimistic(sessionId: string): void {
	const global = appState.global.value;
	if (!global) {
		throw new Error('State not initialized');
	}

	// Optimistic update
	global.sessions.updateOptimistic(`delete-${sessionId}`, (current) => ({
		...current,
		sessions: current.sessions.filter((s) => s.id !== sessionId),
		timestamp: Date.now(),
	}));
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
