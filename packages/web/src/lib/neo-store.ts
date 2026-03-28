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
 * - loading:             True while awaiting LiveQuery snapshot or an RPC op.
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

	/** True while awaiting the LiveQuery snapshot or an async RPC operation. */
	readonly loading = signal<boolean>(false);

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

			// ── neo.messages snapshot ──────────────────────────────────────────
			const unsubMsgSnapshot = hub.onEvent<LiveQuerySnapshotEvent>(
				'liveQuery.snapshot',
				(event) => {
					if (event.subscriptionId === MESSAGES_SUBSCRIPTION_ID) {
						if (!this.activeSubscriptionIds.has(MESSAGES_SUBSCRIPTION_ID)) return;
						this.messages.value = event.rows as NeoMessage[];
						this.loading.value = false;
					} else if (event.subscriptionId === ACTIVITY_SUBSCRIPTION_ID) {
						if (!this.activeSubscriptionIds.has(ACTIVITY_SUBSCRIPTION_ID)) return;
						this.activity.value = event.rows as NeoActivityEntry[];
					}
				}
			);
			this.cleanups.push(unsubMsgSnapshot);
			this.cleanups.push(() => this.activeSubscriptionIds.delete(MESSAGES_SUBSCRIPTION_ID));
			this.cleanups.push(() => this.activeSubscriptionIds.delete(ACTIVITY_SUBSCRIPTION_ID));

			// ── neo.messages delta ─────────────────────────────────────────────
			const unsubMsgDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
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
			this.cleanups.push(unsubMsgDelta);

			// ── Reconnect handler — re-subscribe after WebSocket reconnects ────
			const unsubReconnect = hub.onConnection((state) => {
				if (state !== 'connected') return;
				this.loading.value = true;

				const resubMessages = hub
					.request('liveQuery.subscribe', {
						queryName: 'neo.messages',
						params: [100, 0],
						subscriptionId: MESSAGES_SUBSCRIPTION_ID,
					})
					.catch((err) => {
						logger.warn('NeoStore messages LiveQuery re-subscribe failed:', err);
						this.loading.value = false;
					});

				const resubActivity = hub
					.request('liveQuery.subscribe', {
						queryName: 'neo.activity',
						params: [50, 0],
						subscriptionId: ACTIVITY_SUBSCRIPTION_ID,
					})
					.catch((err) => {
						logger.warn('NeoStore activity LiveQuery re-subscribe failed:', err);
					});

				Promise.all([resubMessages, resubActivity]).catch(() => {});
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

			// Guard: unsubscribe() raced with the subscribe requests.
			if (!this.subscribed) {
				this._teardownCleanly();
				return;
			}
		} catch (err) {
			this.refCount = Math.max(0, this.refCount - 1);
			this.subscribed = false;
			this._teardownCleanly();
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
		if (!this.subscribed) return;
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
	// loadHistory() — one-shot history fetch on init
	// ---------------------------------------------------------------------------

	/**
	 * Load initial message history via `neo.history` RPC.
	 * Called on store initialisation before LiveQuery has a snapshot.
	 * LiveQuery will take over once subscribed.
	 */
	async loadHistory(): Promise<void> {
		try {
			const hub = await connectionManager.getHub();
			const response = await hub.request<{ messages: NeoMessage[]; hasMore: boolean }>(
				'neo.history',
				{ limit: 100 }
			);
			// Only apply if LiveQuery hasn't already populated messages.
			if (this.messages.value.length === 0) {
				this.messages.value = response.messages ?? [];
			}
		} catch (err) {
			logger.warn('NeoStore loadHistory failed:', err);
		}
	}

	// ---------------------------------------------------------------------------
	// loadActivity() — alias for subscribe(), kept for explicit API
	// ---------------------------------------------------------------------------

	/**
	 * Subscribe to the `neo.activity` LiveQuery (delegated to subscribe()).
	 * Provided as a named method for clarity; callers that only want activity
	 * should still call subscribe() to also get messages.
	 */
	async loadActivity(): Promise<void> {
		await this.subscribe();
	}

	// ---------------------------------------------------------------------------
	// sendMessage()
	// ---------------------------------------------------------------------------

	/**
	 * Send a user message to Neo and add an optimistic entry to the messages signal.
	 *
	 * The server-side LiveQuery will push the persisted assistant response once
	 * the Neo session produces it — no polling needed.
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
