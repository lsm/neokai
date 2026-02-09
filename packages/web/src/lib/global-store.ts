/**
 * GlobalStore - Unified global state management
 *
 * Manages application-wide state that's not session-specific:
 * - Sessions list (all sessions)
 * - System state (auth, config, health, API connection)
 * - Global settings
 *
 * Signals (reactive state):
 * - sessions: All sessions list
 * - systemState: Unified system state
 * - settings: Global settings
 *
 * Computed accessors (derived state):
 * - authStatus, healthStatus, sessionCount, recentSessions
 */

import { signal, computed } from '@preact/signals';
import type {
	Session,
	AuthStatus,
	HealthStatus,
	SessionsState,
	SessionsUpdate,
	SystemState,
	SettingsState,
} from '@neokai/shared';
import { STATE_CHANNELS } from '@neokai/shared';
import type { GlobalSettings } from '@neokai/shared/types/settings';
import { connectionManager } from './connection-manager';

export class GlobalStore {
	// ========================================
	// Core Signals
	// ========================================

	/** All sessions */
	readonly sessions = signal<Session[]>([]);

	/** Whether there are any archived sessions in the database */
	readonly hasArchivedSessions = signal<boolean>(false);

	/** Unified system state (auth + config + health + API connection) */
	readonly systemState = signal<SystemState | null>(null);

	/** Global settings */
	readonly settings = signal<GlobalSettings | null>(null);

	// ========================================
	// Computed Accessors
	// ========================================

	/** Authentication status */
	readonly authStatus = computed<AuthStatus | null>(() => this.systemState.value?.auth || null);

	/** Health status */
	readonly healthStatus = computed<HealthStatus | null>(
		() => this.systemState.value?.health || null
	);

	/** Total session count */
	readonly sessionCount = computed<number>(() => this.sessions.value.length);

	/** Recent sessions (last 5) */
	readonly recentSessions = computed<Session[]>(() => {
		return [...this.sessions.value]
			.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
			.slice(0, 5);
	});

	/** Active sessions only */
	readonly activeSessions = computed<Session[]>(() => {
		return this.sessions.value.filter((s) => s.status === 'active');
	});

	/** API connection status */
	readonly apiConnectionStatus = computed<'connected' | 'degraded' | 'disconnected'>(
		() => this.systemState.value?.apiConnection?.status || 'connected'
	);

	// ========================================
	// Private State
	// ========================================

	/** Subscription cleanup functions */
	private cleanupFunctions: Array<() => void> = [];

	/** Whether already initialized */
	private initialized = false;

	// ========================================
	// Initialization
	// ========================================

	/**
	 * Initialize global store with subscriptions
	 * Called once on app startup
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		try {
			const hub = await connectionManager.getHub();

			// Fetch initial state snapshot
			const snapshot = await hub.request<{
				sessions: SessionsState;
				system: SystemState;
				settings: SettingsState;
			}>(STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

			if (snapshot) {
				this.sessions.value = snapshot.sessions?.sessions || [];
				this.hasArchivedSessions.value = snapshot.sessions?.hasArchivedSessions || false;
				this.systemState.value = snapshot.system || null;
				this.settings.value = snapshot.settings?.settings || null;
			}

			// Subscribe to sessions changes (full state)
			const unsubSessions = hub.onEvent<SessionsState>(STATE_CHANNELS.GLOBAL_SESSIONS, (state) => {
				this.sessions.value = state.sessions || [];
				this.hasArchivedSessions.value = state.hasArchivedSessions || false;
			});
			this.cleanupFunctions.push(unsubSessions);

			// Subscribe to sessions delta updates (added/updated/removed)
			const unsubSessionsDelta = hub.onEvent<SessionsUpdate>(
				`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
				(delta) => {
					this.applySessionsDelta(delta);
				}
			);
			this.cleanupFunctions.push(unsubSessionsDelta);

			// Subscribe to system state changes
			const unsubSystem = hub.onEvent<SystemState>(STATE_CHANNELS.GLOBAL_SYSTEM, (state) => {
				this.systemState.value = state;
			});
			this.cleanupFunctions.push(unsubSystem);

			// Subscribe to settings changes
			const unsubSettings = hub.onEvent<SettingsState>(STATE_CHANNELS.GLOBAL_SETTINGS, (state) => {
				this.settings.value = state.settings || null;
			});
			this.cleanupFunctions.push(unsubSettings);

			this.initialized = true;
		} catch (err) {
			console.error('[GlobalStore] Failed to initialize:', err);
		}
	}

	/**
	 * Refresh all global state from server
	 * Called after reconnection to sync missed updates
	 *
	 * CRITICAL: This fetches the latest snapshot from the server to ensure
	 * the UI is in sync after WebSocket reconnection or Safari background tab resume.
	 */
	async refresh(): Promise<void> {
		if (!this.initialized) {
			return;
		}

		try {
			const hub = await connectionManager.getHub();

			// Fetch fresh snapshot
			const snapshot = await hub.request<{
				sessions: SessionsState;
				system: SystemState;
				settings: SettingsState;
			}>(STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

			if (snapshot) {
				this.sessions.value = snapshot.sessions?.sessions || [];
				this.hasArchivedSessions.value = snapshot.sessions?.hasArchivedSessions || false;
				this.systemState.value = snapshot.system || null;
				this.settings.value = snapshot.settings?.settings || null;
			}

			// State refreshed after reconnection
		} catch (err) {
			console.error('[GlobalStore] Failed to refresh state:', err);
			throw err;
		}
	}

	/**
	 * Apply delta updates to sessions list
	 * Called when receiving incremental updates from server
	 */
	private applySessionsDelta(delta: SessionsUpdate): void {
		let sessions = [...this.sessions.value];

		// Remove sessions
		if (delta.removed && delta.removed.length > 0) {
			sessions = sessions.filter((s) => !delta.removed!.includes(s.id));
		}

		// Update existing sessions
		if (delta.updated && delta.updated.length > 0) {
			for (const updated of delta.updated) {
				const index = sessions.findIndex((s) => s.id === updated.id);
				if (index !== -1) {
					sessions[index] = updated as Session;
				}
			}
		}

		// Add new sessions (prepend to show newest first)
		if (delta.added && delta.added.length > 0) {
			sessions.unshift(...(delta.added as Session[]));
		}

		this.sessions.value = sessions;
	}

	/**
	 * Cleanup subscriptions
	 * Called on app shutdown
	 */
	destroy(): void {
		for (const cleanup of this.cleanupFunctions) {
			try {
				cleanup();
			} catch {
				// Ignore cleanup errors
			}
		}
		this.cleanupFunctions = [];
		this.initialized = false;
	}

	// ========================================
	// Session Helpers
	// ========================================

	/**
	 * Get session by ID
	 */
	getSession(sessionId: string): Session | undefined {
		return this.sessions.value.find((s) => s.id === sessionId);
	}

	/**
	 * Update a session in the list (local optimistic update)
	 */
	updateSession(sessionId: string, updates: Partial<Session>): void {
		this.sessions.value = this.sessions.value.map((s) =>
			s.id === sessionId ? { ...s, ...updates } : s
		);
	}

	/**
	 * Remove a session from the list (local optimistic update)
	 */
	removeSession(sessionId: string): void {
		this.sessions.value = this.sessions.value.filter((s) => s.id !== sessionId);
	}

	/**
	 * Add a session to the list (local optimistic update)
	 */
	addSession(session: Session): void {
		this.sessions.value = [...this.sessions.value, session];
	}
}

/** Singleton global store instance */
export const globalStore = new GlobalStore();
