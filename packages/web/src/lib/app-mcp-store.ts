/**
 * AppMcpStore - Application-level MCP server registry with LiveQuery subscriptions
 *
 * ARCHITECTURE: LiveQuery supersedes mcp.registry.changed for frontend UI purposes
 * - Initial state: Fetched via LiveQuery snapshot on subscribe
 * - Updates: Real-time via liveQuery.delta events
 * - Reconnect: Re-subscribes with same subscriptionId on hub reconnection
 * - Teardown: Calls liveQuery.unsubscribe to clean up server-side subscription
 *
 * Signal (reactive state):
 * - appMcpServers: List of all application-level MCP servers
 */

import { signal } from '@preact/signals';
import type { AppMcpServer, LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';
import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('kai:web:app-mcp-store');

const SUBSCRIPTION_ID = 'mcpServers-global';

class AppMcpStore {
	/** All application-level MCP servers */
	readonly appMcpServers = signal<AppMcpServer[]>([]);

	/** Loading state */
	readonly loading = signal<boolean>(false);

	/** Cleanup functions registered during subscribe() */
	private cleanups: Array<() => void> = [];

	/** Guard: true once subscribe() has been called and not yet torn down */
	private subscribed = false;

	/**
	 * Subscribe to the global MCP server registry via LiveQuery.
	 *
	 * Idempotent: safe to call multiple times; subsequent calls are no-ops
	 * until unsubscribe() is called.
	 */
	async subscribe(): Promise<void> {
		if (this.subscribed) return;
		this.subscribed = true;

		try {
			const hub = await connectionManager.getHub();

			this.loading.value = true;

			// --- Snapshot handler ---
			const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
				if (event.subscriptionId !== SUBSCRIPTION_ID) return;
				this.appMcpServers.value = event.rows as AppMcpServer[];
				this.loading.value = false;
			});
			this.cleanups.push(unsubSnapshot);

			// --- Delta handler ---
			const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
				if (event.subscriptionId !== SUBSCRIPTION_ID) return;
				let current = this.appMcpServers.value;
				if (event.removed?.length) {
					const removedIds = new Set((event.removed as AppMcpServer[]).map((r) => r.id));
					current = current.filter((s) => !removedIds.has(s.id));
				}
				if (event.updated?.length) {
					const updatedMap = new Map((event.updated as AppMcpServer[]).map((u) => [u.id, u]));
					current = current.map((s) => updatedMap.get(s.id) ?? s);
				}
				if (event.added?.length) {
					current = [...current, ...(event.added as AppMcpServer[])];
				}
				this.appMcpServers.value = current;
			});
			this.cleanups.push(unsubDelta);

			// --- Reconnect handler ---
			// Re-subscribe with the same subscriptionId so we get a fresh snapshot
			// after the WebSocket reconnects.
			const unsubReconnect = hub.onConnection((state) => {
				if (state !== 'connected') return;
				this.loading.value = true;
				hub
					.request('liveQuery.subscribe', {
						queryName: 'mcpServers.global',
						params: [],
						subscriptionId: SUBSCRIPTION_ID,
					})
					.catch((err) => {
						logger.warn('AppMcpStore LiveQuery re-subscribe failed:', err);
						this.loading.value = false;
					});
			});
			this.cleanups.push(unsubReconnect);

			// --- Subscribe to the named query ---
			await hub.request('liveQuery.subscribe', {
				queryName: 'mcpServers.global',
				params: [],
				subscriptionId: SUBSCRIPTION_ID,
			});
		} catch (err) {
			this.subscribed = false;
			this.loading.value = false;
			logger.error('Failed to subscribe AppMcpStore LiveQuery:', err);
		}
	}

	/**
	 * Unsubscribe and reset state.
	 *
	 * Calls liveQuery.unsubscribe so the server cleans up the subscription.
	 * Safe to call even if subscribe() was never called.
	 */
	unsubscribe(): void {
		if (!this.subscribed) return;
		this.subscribed = false;

		for (const fn of this.cleanups) {
			try {
				fn();
			} catch {
				/* ignore */
			}
		}
		this.cleanups = [];

		// Tell the server to dispose the subscription.
		const hub = connectionManager.getHubIfConnected();
		if (hub) {
			hub.request('liveQuery.unsubscribe', { subscriptionId: SUBSCRIPTION_ID }).catch(() => {});
		}

		this.appMcpServers.value = [];
		this.loading.value = false;
	}
}

/** Singleton store instance */
export const appMcpStore = new AppMcpStore();
