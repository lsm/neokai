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
	SystemState,
	SettingsState,
} from '@liuboer/shared';
import { STATE_CHANNELS } from '@liuboer/shared';
import type { GlobalSettings } from '@liuboer/shared/types/settings';
import { connectionManager } from './connection-manager';

class GlobalStore {
	// ========================================
	// Core Signals
	// ========================================

	/** All sessions */
	readonly sessions = signal<Session[]>([]);

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
			const snapshot = await hub.call<{
				sessions: SessionsState;
				system: SystemState;
				settings: SettingsState;
			}>(STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

			if (snapshot) {
				this.sessions.value = snapshot.sessions?.sessions || [];
				this.systemState.value = snapshot.system || null;
				this.settings.value = snapshot.settings?.settings || null;
			}

			// Subscribe to sessions changes
			const unsubSessions = hub.subscribeOptimistic<SessionsState>(
				STATE_CHANNELS.GLOBAL_SESSIONS,
				(state) => {
					this.sessions.value = state.sessions || [];
				},
				{ sessionId: 'global' }
			);
			this.cleanupFunctions.push(unsubSessions);

			// Subscribe to system state changes
			const unsubSystem = hub.subscribeOptimistic<SystemState>(
				STATE_CHANNELS.GLOBAL_SYSTEM,
				(state) => {
					this.systemState.value = state;
				},
				{ sessionId: 'global' }
			);
			this.cleanupFunctions.push(unsubSystem);

			// Subscribe to settings changes
			const unsubSettings = hub.subscribeOptimistic<SettingsState>(
				STATE_CHANNELS.GLOBAL_SETTINGS,
				(state) => {
					this.settings.value = state.settings || null;
				},
				{ sessionId: 'global' }
			);
			this.cleanupFunctions.push(unsubSettings);

			this.initialized = true;
		} catch (err) {
			console.error('[GlobalStore] Failed to initialize:', err);
		}
	}

	/**
	 * Cleanup subscriptions
	 * Called on app shutdown
	 */
	destroy(): void {
		for (const cleanup of this.cleanupFunctions) {
			try {
				cleanup();
			} catch (err) {
				console.warn('[GlobalStore] Cleanup error:', err);
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
