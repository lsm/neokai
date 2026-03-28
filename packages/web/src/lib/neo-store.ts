/**
 * NeoStore - Signal-based frontend store for Neo's state.
 *
 * ARCHITECTURE:
 * - `neo.messages` LiveQuery provides real-time updates to Neo chat messages.
 * - `neo.activity` LiveQuery provides real-time updates to Neo activity feed.
 * - `panelOpen` is persisted in localStorage so state survives page reloads.
 * - Mutation methods call RPC handlers directly and let LiveQuery push updates.
 *
 * Signals (reactive state):
 * - messages:            Neo chat messages from the persistent session.
 * - activity:            Neo activity log entries (audit trail of tool calls).
 * - loading:             True while awaiting subscribe request acknowledgement.
 * - error:               Set when subscribe() fails; cleared on unsubscribe.
 * - panelOpen:           Whether the Neo slide-out panel is visible.
 * - activeTab:           Which tab is shown in the panel ('chat' | 'activity').
 * - pendingConfirmation: Action waiting for user confirmation (id + description).
 */

import { signal } from '@preact/signals';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';
import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('kai:web:neo-store');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A row returned by the `neo.messages` LiveQuery.
 * The `content` column is the raw JSON-serialised SDK message (sdk_message).
 */
export interface NeoMessage {
	id: string;
	sessionId: string;
	messageType: string;
	messageSubtype: string | null;
	/** Raw JSON string of the sdk_message column. */
	content: string;
	createdAt: number;
	sendStatus: string | null;
	origin: string | null;
}

/**
 * A row returned by the `neo.activity` LiveQuery.
 */
export interface NeoActivityEntry {
	id: string;
	toolName: string;
	input: string | null;
	output: string | null;
	status: 'success' | 'error' | 'cancelled';
	error: string | null;
	targetType: string | null;
	targetId: string | null;
	undoable: boolean;
	undoData: string | null;
	createdAt: string;
}

/**
 * A pending confirmation — an action that Neo is requesting approval for.
 */
export interface PendingConfirmation {
	actionId: string;
	description: string;
	riskLevel?: 'low' | 'medium' | 'high';
}

export type NeoActiveTab = 'chat' | 'activity';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MESSAGES_SUBSCRIPTION_ID = 'neo-messages-global';
const ACTIVITY_SUBSCRIPTION_ID = 'neo-activity-global';
const PANEL_OPEN_KEY = 'neo:panelOpen';

// ---------------------------------------------------------------------------
// NeoStore class
// ---------------------------------------------------------------------------

class NeoStore {
	// -- Reactive signals --

	/** Neo chat messages, ordered oldest-first (mirrors neo.messages LiveQuery). */
	readonly messages = signal<NeoMessage[]>([]);

	/** Neo activity feed, ordered newest-first (mirrors neo.activity LiveQuery). */
	readonly activity = signal<NeoActivityEntry[]>([]);

	/** True while the subscribe requests are in flight (cleared once acknowledged). */
	readonly loading = signal<boolean>(false);

	/** Error state — set when subscribe() fails; cleared on unsubscribe. */
	readonly error = signal<string | null>(null);

	/** Whether the Neo slide-out panel is visible. Persisted in localStorage. */
	readonly panelOpen = signal<boolean>(this._readPanelOpen());

	/** Which tab is active in the Neo panel. */
	readonly activeTab = signal<NeoActiveTab>('chat');

	/** Pending action waiting for user confirmation, or null if none. */
	readonly pendingConfirmation = signal<PendingConfirmation | null>(null);

	// -- Internal state --

	private cleanups: Array<() => void> = [];
	private activeSubscriptionIds = new Set<string>();
	private subscribed = false;
	private refCount = 0;
	/** Set to true after loadHistory() completes so a concurrent LiveQuery snapshot won't race it. */
	private historyLoaded = false;

	// ---------------------------------------------------------------------------
	// Panel open/close helpers (with localStorage persistence)
	// ---------------------------------------------------------------------------

	private _readPanelOpen(): boolean {
		try {
			return localStorage.getItem(PANEL_OPEN_KEY) === 'true';
		} catch {
			return false;
		}
	}

	private _writePanelOpen(open: boolean): void {
		try {
			localStorage.setItem(PANEL_OPEN_KEY, String(open));
		} catch {
			/* ignore QuotaExceededError etc. */
		}
	}

	openPanel(): void {
		this.panelOpen.value = true;
		this._writePanelOpen(true);
	}

	closePanel(): void {
		this.panelOpen.value = false;
		this._writePanelOpen(false);
	}

	togglePanel(): void {
		if (this.panelOpen.value) {
			this.closePanel();
		} else {
			this.openPanel();
		}
	}

	// ---------------------------------------------------------------------------
	// subscribe() — start both LiveQuery subscriptions
	// ---------------------------------------------------------------------------

	/**
	 * Subscribe to both `neo.messages` and `neo.activity` LiveQuery feeds.
	 *
	 * Idempotent: subsequent calls are no-ops until unsubscribe() is called.
	 * Re-throws errors so callers can surface them (e.g. in a toast).
	 */
	async subscribe(): Promise<void> {
		this.refCount++;
		if (this.subscribed) return;
		this.subscribed = true;

		try {
			const hub = await connectionManager.getHub();

			// Guard: unsubscribe() was called before the hub became available.
			if (!this.subscribed) return;

			this.loading.value = true;
			this.activeSubscriptionIds.add(MESSAGES_SUBSCRIPTION_ID);
			this.activeSubscriptionIds.add(ACTIVITY_SUBSCRIPTION_ID);

			// ── Snapshot handler ──────────────────────────────────────────────
			const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
				if (event.subscriptionId === MESSAGES_SUBSCRIPTION_ID) {
					if (!this.activeSubscriptionIds.has(MESSAGES_SUBSCRIPTION_ID)) return;
					this.messages.value = event.rows as NeoMessage[];
				} else if (event.subscriptionId === ACTIVITY_SUBSCRIPTION_ID) {
					if (!this.activeSubscriptionIds.has(ACTIVITY_SUBSCRIPTION_ID)) return;
					this.activity.value = event.rows as NeoActivityEntry[];
				}
			});
			this.cleanups.push(unsubSnapshot);
			this.cleanups.push(() => this.activeSubscriptionIds.delete(MESSAGES_SUBSCRIPTION_ID));
			this.cleanups.push(() => this.activeSubscriptionIds.delete(ACTIVITY_SUBSCRIPTION_ID));

			// ── Delta handler ─────────────────────────────────────────────────
			const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
				if (event.subscriptionId === MESSAGES_SUBSCRIPTION_ID) {
					if (!this.activeSubscriptionIds.has(MESSAGES_SUBSCRIPTION_ID)) return;
					this.messages.value = this._applyDelta(
						this.messages.value,
						event,
						(m) => (m as NeoMessage).id
					) as NeoMessage[];
				} else if (event.subscriptionId === ACTIVITY_SUBSCRIPTION_ID) {
					if (!this.activeSubscriptionIds.has(ACTIVITY_SUBSCRIPTION_ID)) return;
					this.activity.value = this._applyDelta(
						this.activity.value,
						event,
						(a) => (a as NeoActivityEntry).id
					) as NeoActivityEntry[];
				}
			});
			this.cleanups.push(unsubDelta);

			// ── Reconnect handler — re-subscribe after WebSocket reconnects ────
			const unsubReconnect = hub.onConnection((state) => {
				if (state !== 'connected') return;
				// Stale-event guard: don't re-subscribe if already torn down.
				if (!this.activeSubscriptionIds.has(MESSAGES_SUBSCRIPTION_ID)) return;
				this.loading.value = true;

				Promise.all([
					hub
						.request('liveQuery.subscribe', {
							queryName: 'neo.messages',
							params: [100, 0],
							subscriptionId: MESSAGES_SUBSCRIPTION_ID,
						})
						.catch((err) => {
							logger.warn('NeoStore messages LiveQuery re-subscribe failed:', err);
						}),
					hub
						.request('liveQuery.subscribe', {
							queryName: 'neo.activity',
							params: [50, 0],
							subscriptionId: ACTIVITY_SUBSCRIPTION_ID,
						})
						.catch((err) => {
							logger.warn('NeoStore activity LiveQuery re-subscribe failed:', err);
						}),
				])
					.catch(() => {})
					.finally(() => {
						this.loading.value = false;
					});
			});
			this.cleanups.push(unsubReconnect);

			// ── Initial subscriptions ──────────────────────────────────────────
			await Promise.all([
				hub.request('liveQuery.subscribe', {
					queryName: 'neo.messages',
					params: [100, 0],
					subscriptionId: MESSAGES_SUBSCRIPTION_ID,
				}),
				hub.request('liveQuery.subscribe', {
					queryName: 'neo.activity',
					params: [50, 0],
					subscriptionId: ACTIVITY_SUBSCRIPTION_ID,
				}),
			]);

			// Loading cleared once both subscribe requests are acknowledged.
			// The snapshot handlers will populate data as it arrives.
			this.loading.value = false;

			// Guard: unsubscribe() raced with the subscribe requests.
			if (!this.subscribed) {
				this._teardownCleanly();
				return;
			}
		} catch (err) {
			this.refCount = Math.max(0, this.refCount - 1);
			this.subscribed = false;
			this._teardownCleanly();
			this.error.value = err instanceof Error ? err.message : 'Failed to subscribe to Neo store';
			logger.error('Failed to subscribe NeoStore LiveQuery:', err);
			throw err;
		}
	}

	/**
	 * Unsubscribe from both LiveQuery feeds and reset signals.
	 * Safe to call even if subscribe() was never called.
	 */
	unsubscribe(): void {
		this.refCount = Math.max(0, this.refCount - 1);
		if (this.refCount > 0) return;
		if (!this.subscribed) {
			// Still reset error signal even if we were never subscribed
			// (e.g., subscribe() failed and set this.subscribed = false in its catch block).
			this.error.value = null;
			return;
		}
		this.subscribed = false;

		// Clear ids immediately so any queued events are discarded.
		this.activeSubscriptionIds.delete(MESSAGES_SUBSCRIPTION_ID);
		this.activeSubscriptionIds.delete(ACTIVITY_SUBSCRIPTION_ID);

		this._teardownCleanly();

		const hub = connectionManager.getHubIfConnected();
		if (hub) {
			hub
				.request('liveQuery.unsubscribe', { subscriptionId: MESSAGES_SUBSCRIPTION_ID })
				.catch(() => {});
			hub
				.request('liveQuery.unsubscribe', { subscriptionId: ACTIVITY_SUBSCRIPTION_ID })
				.catch(() => {});
		}

		this.messages.value = [];
		this.activity.value = [];
	}

	private _teardownCleanly(): void {
		this.activeSubscriptionIds.delete(MESSAGES_SUBSCRIPTION_ID);
		this.activeSubscriptionIds.delete(ACTIVITY_SUBSCRIPTION_ID);
		for (const fn of this.cleanups) {
			try {
				fn();
			} catch {
				/* ignore */
			}
		}
		this.cleanups = [];
		this.loading.value = false;
		this.error.value = null;
	}

	// ---------------------------------------------------------------------------
	// Delta helper
	// ---------------------------------------------------------------------------

	private _applyDelta<T>(
		current: T[],
		event: LiveQueryDeltaEvent,
		getId: (row: unknown) => string
	): T[] {
		let result = current;
		if (event.removed?.length) {
			const removedIds = new Set(event.removed.map(getId));
			result = result.filter((item) => !removedIds.has(getId(item)));
		}
		if (event.updated?.length) {
			const updatedMap = new Map(event.updated.map((u) => [getId(u), u as T]));
			result = result.map((item) => updatedMap.get(getId(item)) ?? item);
		}
		if (event.added?.length) {
			result = [...result, ...(event.added as T[])];
		}
		return result;
	}

	// ---------------------------------------------------------------------------
	// loadHistory() — one-shot history fetch before LiveQuery snapshot
	// ---------------------------------------------------------------------------

	/**
	 * Load initial message history via `neo.history` RPC.
	 *
	 * Intended to be called before subscribe() to show history immediately while
	 * LiveQuery is initialising. Guards against both:
	 * - Concurrent LiveQuery snapshots overwriting (via `historyLoaded` flag)
	 * - Overwriting data already populated by LiveQuery (skips if subscribed)
	 *
	 * The LiveQuery snapshot will merge seamlessly once it arrives.
	 */
	async loadHistory(): Promise<void> {
		// If already subscribed, LiveQuery owns message state — skip.
		if (this.subscribed) return;
		try {
			const hub = await connectionManager.getHub();
			const response = await hub.request<{ messages: NeoMessage[]; hasMore: boolean }>(
				'neo.history',
				{ limit: 100 }
			);
			// Guard: LiveQuery snapshot arrived or subscribe() completed while we awaited.
			if (!this.subscribed) {
				this.messages.value = response.messages ?? [];
				this.historyLoaded = true;
			}
		} catch (err) {
			logger.warn('NeoStore loadHistory failed:', err);
		}
	}

	// ---------------------------------------------------------------------------
	// sendMessage()
	// ---------------------------------------------------------------------------

	/**
	 * Send a user message to the Neo session.
	 *
	 * The server-side LiveQuery will push the persisted response once the Neo
	 * session produces it — no polling needed.
	 *
	 * Returns the RPC response so callers can surface errors.
	 */
	async sendMessage(
		text: string
	): Promise<{ success: boolean; error?: string; errorCode?: string }> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{
			success: boolean;
			error?: string;
			errorCode?: string;
		}>('neo.send', { message: text });
		return response;
	}

	// ---------------------------------------------------------------------------
	// clearSession()
	// ---------------------------------------------------------------------------

	/**
	 * Reset the Neo session. Clears server-side history and resets the local
	 * messages signal so the UI reflects the fresh state immediately.
	 */
	async clearSession(): Promise<{ success: boolean; error?: string }> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{ success: boolean; error?: string }>(
			'neo.clearSession',
			{}
		);
		if (response.success) {
			this.messages.value = [];
			this.historyLoaded = false;
		}
		return response;
	}

	// ---------------------------------------------------------------------------
	// confirmAction() / cancelAction()
	// ---------------------------------------------------------------------------

	/**
	 * Execute a pending Neo action identified by `actionId`.
	 * Clears `pendingConfirmation` regardless of outcome.
	 */
	async confirmAction(actionId: string): Promise<{ success: boolean; error?: string }> {
		try {
			const hub = await connectionManager.getHub();
			const response = await hub.request<{ success: boolean; result?: unknown; error?: string }>(
				'neo.confirmAction',
				{ actionId }
			);
			this.pendingConfirmation.value = null;
			return { success: response.success, error: response.error };
		} catch (err) {
			this.pendingConfirmation.value = null;
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Discard a pending Neo action identified by `actionId`.
	 * Clears `pendingConfirmation` regardless of outcome.
	 */
	async cancelAction(actionId: string): Promise<{ success: boolean; error?: string }> {
		try {
			const hub = await connectionManager.getHub();
			const response = await hub.request<{ success: boolean; error?: string }>('neo.cancelAction', {
				actionId,
			});
			this.pendingConfirmation.value = null;
			return { success: response.success, error: response.error };
		} catch (err) {
			this.pendingConfirmation.value = null;
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Singleton NeoStore instance. */
export const neoStore = new NeoStore();
