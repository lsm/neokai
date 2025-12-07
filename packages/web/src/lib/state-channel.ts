/**
 * StateChannel - Client-side fine-grained state synchronization
 *
 * Features:
 * - Snapshot on connect + delta updates (hybrid)
 * - Optimistic reads, confirmed writes
 * - Server-only persistence
 * - Automatic reconnection handling
 */

import { signal, computed, type Signal } from '@preact/signals';
import type { MessageHub } from '@liuboer/shared';
import type { UnsubscribeFn } from '@liuboer/shared/message-hub/types';

/**
 * State Channel Options
 */
export interface StateChannelOptions<T> {
	/**
	 * Session ID for session-scoped channels
	 * Use "global" for global channels
	 */
	sessionId?: string;

	/**
	 * Enable delta updates (more efficient)
	 * Default: true
	 */
	enableDeltas?: boolean;

	/**
	 * Merge function for delta updates
	 * Only used if enableDeltas is true
	 */
	mergeDelta?: (current: T, delta: any) => T;

	/**
	 * Auto-refresh interval in ms (0 to disable)
	 * Default: 0 (disabled, rely on pub/sub)
	 */
	refreshInterval?: number;

	/**
	 * Enable debug logging
	 * Default: false
	 */
	debug?: boolean;

	/**
	 * Optimistic update timeout (ms)
	 * How long to wait before reverting optimistic update
	 * Default: 5000
	 */
	optimisticTimeout?: number;
}

/**
 * Optimistic update tracker
 */
interface OptimisticUpdate<T> {
	id: string;
	original: T;
	optimistic: T;
	timestamp: number;
	timeout: ReturnType<typeof setTimeout>;
}

/**
 * Fine-grained State Channel
 *
 * Manages synchronization of a single state property
 */
export class StateChannel<T> {
	private state = signal<T | null>(null);
	private loading = signal<boolean>(false);
	private error = signal<Error | null>(null);
	private lastSync = signal<number>(0);

	private subscriptions: UnsubscribeFn[] = [];
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private optimisticUpdates = new Map<string, OptimisticUpdate<T>>();

	constructor(
		private hub: MessageHub,
		private channelName: string,
		private options: StateChannelOptions<T> = {}
	) {
		this.options = {
			sessionId: 'global',
			enableDeltas: true,
			refreshInterval: 0,
			debug: false,
			optimisticTimeout: 5000,
			...options,
		};
	}

	/**
	 * Start syncing this channel
	 */
	async start(): Promise<void> {
		this.log(`Starting channel: ${this.channelName}`);

		try {
			// 1. Get initial snapshot
			await this.fetchSnapshot();

			// 2. Subscribe to updates (now async)
			await this.setupSubscriptions();

			// 3. Setup auto-refresh if configured
			if (this.options.refreshInterval && this.options.refreshInterval > 0) {
				this.setupAutoRefresh();
			}

			// 4. Handle reconnections
			this.setupReconnectionHandler();

			this.log(`Channel started: ${this.channelName}`);
		} catch (err) {
			this.error.value = err instanceof Error ? err : new Error(String(err));
			throw err;
		}
	}

	/**
	 * Stop syncing and cleanup
	 */
	stop(): void {
		this.log(`Stopping channel: ${this.channelName}`);

		// Unsubscribe from all events
		this.subscriptions.forEach((unsub) => unsub());
		this.subscriptions = [];

		// Clear refresh timer
		if (this.refreshTimer !== null) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}

		// Clear optimistic updates
		this.optimisticUpdates.forEach((update) => {
			clearTimeout(update.timeout);
		});
		this.optimisticUpdates.clear();

		this.log(`Channel stopped: ${this.channelName}`);
	}

	/**
	 * Get current state value (may be optimistic)
	 */
	get value(): T | null {
		return this.state.value;
	}

	/**
	 * Get reactive signal
	 */
	get $(): Signal<T | null> {
		return this.state;
	}

	/**
	 * Get loading signal
	 */
	get isLoading(): Signal<boolean> {
		return this.loading;
	}

	/**
	 * Get error signal
	 */
	get hasError(): Signal<Error | null> {
		return this.error;
	}

	/**
	 * Get last sync timestamp signal
	 */
	get lastSyncTime(): Signal<number> {
		return this.lastSync;
	}

	/**
	 * Check if state is stale
	 */
	isStale(maxAge: number = 60000): boolean {
		return Date.now() - this.lastSync.value > maxAge;
	}

	/**
	 * Force refresh from server (confirmed read)
	 */
	async refresh(): Promise<void> {
		this.log(`Refreshing channel: ${this.channelName}`);
		await this.fetchSnapshot();
	}

	/**
	 * Update state optimistically (for writes)
	 * Will revert if server update doesn't arrive within timeout
	 */
	updateOptimistic(id: string, updater: (current: T) => T, confirmed?: Promise<void>): void {
		if (!this.state.value) {
			console.warn(`Cannot update optimistically: state is null`);
			return;
		}

		const original = this.state.value;
		const optimistic = updater(original);

		this.log(`Optimistic update: ${id}`, { original, optimistic });

		// Apply optimistic update immediately
		this.state.value = optimistic;

		// If confirmation promise provided, use it to control lifecycle
		if (confirmed) {
			// Setup timeout only if promise doesn't resolve
			let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
				this.log(`Optimistic update timeout: ${id}, reverting`);
				this.revertOptimistic(id);
				timeoutId = null;
			}, this.options.optimisticTimeout);

			// Track update with timeout
			this.optimisticUpdates.set(id, {
				id,
				original,
				optimistic,
				timestamp: Date.now(),
				timeout: timeoutId,
			});

			confirmed
				.then(() => {
					// Cancel timeout and commit
					if (timeoutId) {
						clearTimeout(timeoutId);
						timeoutId = null;
					}
					this.log(`Optimistic update confirmed: ${id}`);
					this.commitOptimistic(id);
				})
				.catch((err) => {
					// Cancel timeout and revert
					if (timeoutId) {
						clearTimeout(timeoutId);
						timeoutId = null;
					}
					this.log(`Optimistic update failed: ${id}`, err);
					this.revertOptimistic(id);
				});
		} else {
			// No confirmation promise - use timeout-based revert
			const timeout = setTimeout(() => {
				this.log(`Optimistic update timeout: ${id}, reverting`);
				this.revertOptimistic(id);
			}, this.options.optimisticTimeout);

			// Track update
			this.optimisticUpdates.set(id, {
				id,
				original,
				optimistic,
				timestamp: Date.now(),
				timeout,
			});
		}
	}

	/**
	 * Commit an optimistic update (server confirmed)
	 */
	private commitOptimistic(id: string): void {
		const update = this.optimisticUpdates.get(id);
		if (update) {
			clearTimeout(update.timeout);
			this.optimisticUpdates.delete(id);
		}
	}

	/**
	 * Revert an optimistic update (server rejected or timeout)
	 */
	private revertOptimistic(id: string): void {
		const update = this.optimisticUpdates.get(id);
		if (update) {
			clearTimeout(update.timeout);
			this.state.value = update.original;
			this.optimisticUpdates.delete(id);
		}
	}

	/**
	 * Fetch snapshot from server
	 */
	private async fetchSnapshot(): Promise<void> {
		this.loading.value = true;
		this.error.value = null;

		try {
			// For RPC calls, pass sessionId as data parameter (not in options)
			// because StateManager handlers expect it in the data, not as session routing
			const callData =
				this.options.sessionId !== 'global' ? { sessionId: this.options.sessionId } : {};

			const snapshot = await this.hub.call<T>(
				this.channelName,
				callData,
				// Always use "global" for RPC routing - handlers are registered globally
				{ sessionId: 'global' }
			);

			this.state.value = snapshot;
			this.lastSync.value = Date.now();

			this.log(`Snapshot fetched: ${this.channelName}`, snapshot);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.error.value = error;
			this.log(`Snapshot fetch failed: ${this.channelName}`, error);
			throw error;
		} finally {
			this.loading.value = false;
		}
	}

	/**
	 * Setup subscriptions to state updates
	 */
	private async setupSubscriptions(): Promise<void> {
		// Subscribe to full updates
		// IMPORTANT: hub.subscribe() returns a Promise<UnsubscribeFn>, must await it
		const fullUpdateSub = await this.hub.subscribe<T>(
			this.channelName,
			(data) => {
				this.log(`Full update received: ${this.channelName}`, data);
				this.state.value = data;
				this.lastSync.value = Date.now();
				this.error.value = null;
			},
			{ sessionId: this.options.sessionId }
		);

		this.subscriptions.push(fullUpdateSub);

		// Subscribe to delta updates if enabled
		if (this.options.enableDeltas && this.options.mergeDelta) {
			const deltaChannel = `${this.channelName}.delta`;
			console.log(
				`[StateChannel:${this.channelName}] Subscribing to delta channel:`,
				deltaChannel,
				'with sessionId:',
				this.options.sessionId
			);

			const deltaUpdateSub = await this.hub.subscribe<any>(
				deltaChannel,
				(delta) => {
					console.log(`[StateChannel:${this.channelName}] <<<< DELTA RECEIVED >>>>`, delta);
					this.log(`Delta update received: ${this.channelName}`, delta);

					if (this.state.value && this.options.mergeDelta) {
						const oldState = this.state.value;
						this.state.value = this.options.mergeDelta(this.state.value, delta);
						console.log(`[StateChannel:${this.channelName}] State updated from delta:`, {
							oldState,
							newState: this.state.value,
						});
						this.lastSync.value = Date.now();
						this.error.value = null;
					} else {
						console.warn(
							`[StateChannel:${this.channelName}] Cannot apply delta - state or mergeDelta missing`,
							{
								hasState: !!this.state.value,
								hasMergeDelta: !!this.options.mergeDelta,
							}
						);
					}
				},
				{ sessionId: this.options.sessionId }
			);

			this.subscriptions.push(deltaUpdateSub);
			console.log(
				`[StateChannel:${this.channelName}] Successfully subscribed to delta channel:`,
				deltaChannel
			);
		}
	}

	/**
	 * Setup auto-refresh timer
	 */
	private setupAutoRefresh(): void {
		if (!this.options.refreshInterval) return;

		this.refreshTimer = setInterval(() => {
			if (this.isStale(this.options.refreshInterval!)) {
				this.log(`Auto-refreshing stale channel: ${this.channelName}`);
				this.refresh().catch(console.error);
			}
		}, this.options.refreshInterval);
	}

	/**
	 * Setup reconnection handler
	 */
	private setupReconnectionHandler(): void {
		const reconnectSub = this.hub.onConnection((state) => {
			if (state === 'connected') {
				this.log(`Reconnected, refreshing channel: ${this.channelName}`);
				this.refresh().catch(console.error);
			} else if (state === 'disconnected' || state === 'error') {
				this.error.value = new Error(`Connection ${state}`);
			}
		});

		this.subscriptions.push(reconnectSub);
	}

	/**
	 * Debug logging
	 */
	private log(message: string, ...args: any[]): void {
		if (this.options.debug) {
			console.log(`[StateChannel:${this.channelName}] ${message}`, ...args);
		}
	}
}

/**
 * Computed state channel - derives state from other channels
 */
export class ComputedStateChannel<T> {
	private state: Signal<T>;

	constructor(compute: () => T) {
		this.state = computed(compute);
	}

	get value(): T {
		return this.state.value;
	}

	get $(): Signal<T> {
		return this.state;
	}
}

/**
 * Delta merge helpers for common patterns
 */
export const DeltaMergers = {
	/**
	 * Merge array with added/updated/removed items
	 */
	array: <T extends { id: string }>(
		current: T[],
		delta: {
			added?: T[];
			updated?: T[];
			removed?: string[];
		}
	): T[] => {
		let result = [...current];

		// Remove items
		if (delta.removed) {
			result = result.filter((item) => !delta.removed!.includes(item.id));
		}

		// Update items
		if (delta.updated) {
			delta.updated.forEach((updated) => {
				const index = result.findIndex((item) => item.id === updated.id);
				if (index !== -1) {
					result[index] = updated;
				}
			});
		}

		// Add items
		if (delta.added) {
			result.push(...delta.added);
		}

		return result;
	},

	/**
	 * Merge object properties
	 */
	object: <T extends Record<string, any>>(current: T, delta: Partial<T>): T => {
		return { ...current, ...delta };
	},

	/**
	 * Append to array
	 */
	append: <T>(current: T[], delta: { added?: T[] }): T[] => {
		if (delta.added) {
			return [...current, ...delta.added];
		}
		return current;
	},
};
