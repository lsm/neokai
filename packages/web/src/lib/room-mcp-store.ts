/**
 * RoomMcpStore - Per-room MCP enablement state with LiveQuery subscriptions
 *
 * ARCHITECTURE: Subscribes to mcpEnablement.byRoom LiveQuery to get per-room
 * overrides for MCP server enablement.
 *
 * - Initial state: Fetched via LiveQuery snapshot on subscribe
 * - Updates: Real-time via liveQuery.delta events
 * - Reconnect: Re-subscribes with same subscriptionId on hub reconnection
 * - Teardown: Calls liveQuery.unsubscribe to clean up server-side subscription
 *
 * Signal (reactive state):
 * - roomMcpOverrides: Map of serverId -> { serverId, enabled, name, sourceType, description }
 *   representing per-room override rows from mcpEnablement.byRoom
 */

import { signal } from '@preact/signals';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';
import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('kai:web:room-mcp-store');

export interface RoomMcpOverride {
	serverId: string;
	enabled: boolean;
	name: string;
	sourceType: string;
	description?: string;
}

class RoomMcpStore {
	/** Per-room override rows keyed by serverId */
	readonly overrides = signal<Map<string, RoomMcpOverride>>(new Map());

	/** Loading state */
	readonly loading = signal<boolean>(false);

	/** Error state — set when subscribe() fails */
	readonly error = signal<string | null>(null);

	/** Room ID this store is subscribed to */
	private roomId: string | null = null;

	/** Cleanup functions registered during subscribe() */
	private cleanups: Array<() => void> = [];

	/**
	 * Stale-event guard: set of currently active subscriptionIds.
	 */
	private activeSubscriptionIds = new Set<string>();

	/** Guard: true once subscribe() has been called and not yet torn down */
	private subscribed = false;

	/**
	 * Subscribe to the per-room MCP enablement LiveQuery for a specific room.
	 *
	 * Idempotent per roomId: safe to call multiple times with same roomId;
	 * subsequent calls are no-ops until unsubscribe() is called.
	 *
	 * Re-throws errors so callers can handle failures.
	 */
	async subscribe(roomId: string): Promise<void> {
		// If already subscribed to the same room, no-op
		if (this.subscribed && this.roomId === roomId) return;

		// If subscribed to a different room, unsubscribe first
		if (this.subscribed && this.roomId !== roomId) {
			this.unsubscribe();
		}

		this.roomId = roomId;
		this.subscribed = true;

		const subscriptionId = `mcpEnablement-${roomId}`;

		try {
			const hub = await connectionManager.getHub();

			// Guard: unsubscribe() was called before hub became available
			if (!this.subscribed) return;

			this.loading.value = true;
			this.activeSubscriptionIds.add(subscriptionId);

			// --- Snapshot handler ---
			const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
				if (event.subscriptionId !== subscriptionId) return;
				if (!this.activeSubscriptionIds.has(subscriptionId)) return; // stale-event guard
				const newMap = new Map<string, RoomMcpOverride>();
				for (const row of event.rows as RoomMcpOverride[]) {
					newMap.set(row.serverId, row);
				}
				this.overrides.value = newMap;
				this.loading.value = false;
			});
			this.cleanups.push(unsubSnapshot);
			this.cleanups.push(() => this.activeSubscriptionIds.delete(subscriptionId));

			// --- Delta handler ---
			const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
				if (event.subscriptionId !== subscriptionId) return;
				if (!this.activeSubscriptionIds.has(subscriptionId)) return; // stale-event guard
				const current = new Map(this.overrides.value);

				if (event.removed?.length) {
					for (const row of event.removed as RoomMcpOverride[]) {
						current.delete(row.serverId);
					}
				}
				if (event.updated?.length) {
					for (const row of event.updated as RoomMcpOverride[]) {
						current.set(row.serverId, row);
					}
				}
				if (event.added?.length) {
					for (const row of event.added as RoomMcpOverride[]) {
						current.set(row.serverId, row);
					}
				}
				this.overrides.value = current;
			});
			this.cleanups.push(unsubDelta);

			// --- Reconnect handler ---
			const unsubReconnect = hub.onConnection((state) => {
				if (state !== 'connected') return;
				if (!this.activeSubscriptionIds.has(subscriptionId)) return;
				this.loading.value = true;
				hub
					.request('liveQuery.subscribe', {
						queryName: 'mcpEnablement.byRoom',
						params: [roomId],
						subscriptionId,
					})
					.catch((err) => {
						logger.warn('RoomMcpStore LiveQuery re-subscribe failed:', err);
						this.loading.value = false;
					});
			});
			this.cleanups.push(unsubReconnect);

			// --- Subscribe to the named query ---
			await hub.request('liveQuery.subscribe', {
				queryName: 'mcpEnablement.byRoom',
				params: [roomId],
				subscriptionId,
			});

			// Guard: abort if unsubscribed while the subscribe request was in flight
			if (!this.subscribed) {
				this.teardownCleanly();
				return;
			}
		} catch (err) {
			this.subscribed = false;
			this.roomId = null;
			this.teardownCleanly();
			this.error.value =
				err instanceof Error ? err.message : 'Failed to subscribe to room MCP enablement';
			logger.error('Failed to subscribe RoomMcpStore LiveQuery:', err);
			throw err;
		}
	}

	/**
	 * Run all cleanup functions and reset state.
	 */
	private teardownCleanly(): void {
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

	/**
	 * Unsubscribe and reset state.
	 *
	 * Calls liveQuery.unsubscribe so the server cleans up the subscription.
	 * Safe to call even if subscribe() was never called.
	 */
	unsubscribe(): void {
		if (!this.subscribed) {
			this.error.value = null;
			return;
		}
		this.subscribed = false;

		const subscriptionId = this.roomId ? `mcpEnablement-${this.roomId}` : null;
		if (subscriptionId) {
			this.activeSubscriptionIds.delete(subscriptionId);
		}

		this.teardownCleanly();

		// Tell the server to dispose the subscription.
		if (subscriptionId) {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub.request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {});
			}
		}

		this.overrides.value = new Map();
		this.roomId = null;
	}

	/**
	 * Get the effective enabled state for a server:
	 * - If there's a per-room override, use it
	 * - Otherwise, use the global default
	 */
	getEffectiveEnabled(serverId: string, globalEnabled: boolean): boolean {
		const override = this.overrides.value.get(serverId);
		return override !== undefined ? override.enabled : globalEnabled;
	}
}

/** Singleton store instance for room MCP enablement.
 *
 * Supports subscribing to one room at a time. Switching rooms via subscribe(roomId)
 * automatically unsubscribes the previous room. If concurrent room subscriptions
 * are needed in the future, convert this to a per-room Map of store instances. */
export const roomMcpStore = new RoomMcpStore();
