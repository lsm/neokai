/**
 * StateChannel - Client-side fine-grained state synchronization
 *
 * Features:
 * - Snapshot on connect + delta updates (hybrid)
 * - Optimistic reads, confirmed writes
 * - Server-only persistence
 * - Automatic reconnection handling
 */

import { signal, computed, type Signal, batch } from '@preact/signals';
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
	mergeDelta?: (current: T, delta: unknown) => T;

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

	/**
	 * Non-blocking subscription setup
	 * If true, subscriptions are setup in background (fire-and-forget)
	 * This improves startup time at the cost of possibly missing early events
	 * Default: false
	 */
	nonBlocking?: boolean;

	/**
	 * Use optimistic subscriptions (subscribeOptimistic)
	 * If true, uses non-blocking subscriptions that don't wait for server ACK
	 * This provides the best UI responsiveness
	 * Default: false
	 */
	useOptimisticSubscriptions?: boolean;
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
			nonBlocking: false,
			useOptimisticSubscriptions: false,
			...options,
		};
	}

	/**
	 * Start syncing this channel
	 *
	 * Supports three modes:
	 * 1. Blocking (default): Waits for snapshot AND subscriptions
	 * 2. Non-blocking: Waits for snapshot, subscriptions setup in background
	 * 3. Optimistic: Uses subscribeOptimistic for immediate local registration
	 */
	async start(): Promise<void> {
		this.log(
			`Starting channel: ${this.channelName} (nonBlocking: ${this.options.nonBlocking}, optimistic: ${this.options.useOptimisticSubscriptions})`
		);

		try {
			// 1. Get initial snapshot (always await - required for initial state)
			await this.fetchSnapshot();

			// 2. Subscribe to updates (behavior depends on options)
			if (this.options.useOptimisticSubscriptions) {
				// Optimistic: Use subscribeOptimistic for instant local registration
				this.setupOptimisticSubscriptions();
			} else if (this.options.nonBlocking) {
				// Non-blocking: Setup subscriptions in background
				this.setupSubscriptions().catch((err) => {
					console.error(
						`[StateChannel:${this.channelName}] Background subscription setup failed:`,
						err
					);
				});
			} else {
				// Blocking (default): Wait for subscriptions
				await this.setupSubscriptions();
			}

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
	 *
	 * IMPORTANT: This is async to ensure all unsubscribe operations complete
	 * before returning. This prevents subscription accumulation when rapidly
	 * switching sessions (each unsubscribe sends a message to the server and
	 * waits for ACK).
	 */
	async stop(): Promise<void> {
		console.log(`[StateChannel] Stopping channel: ${this.channelName} (${this.subscriptions.length} subscriptions)`);

		// Unsubscribe from all events (AWAIT to ensure unsubscribe completes)
		await Promise.all(this.subscriptions.map((unsub) => unsub()));
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

		console.log(`[StateChannel] Channel stopped: ${this.channelName}`);
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
	private async fetchSnapshot(since?: number): Promise<void> {
		this.loading.value = true;
		this.error.value = null;

		try {
			// For RPC calls, pass sessionId as data parameter (not in options)
			// because StateManager handlers expect it in the data, not as session routing
			const callData =
				this.options.sessionId !== 'global'
					? { sessionId: this.options.sessionId, since }
					: { since };

			const snapshot = await this.hub.call<T>(
				this.channelName,
				callData,
				// Always use "global" for RPC routing - handlers are registered globally
				{ sessionId: 'global' }
			);

			// Smart merge: if incremental (since provided), merge; otherwise replace
			if (since !== undefined && since > 0) {
				this.mergeSnapshot(snapshot);
			} else {
				this.state.value = snapshot;
			}

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
	 * Merge snapshot with existing state (for reconnection and incremental sync)
	 * Handles SDK messages specially: deduplicates by uuid and sorts by timestamp
	 */
	private mergeSnapshot(snapshot: T): void {
		const current = this.state.value;

		// Handle SDK messages state (has sdkMessages array)
		if (
			current &&
			typeof current === 'object' &&
			typeof snapshot === 'object' &&
			snapshot !== null &&
			'sdkMessages' in current &&
			'sdkMessages' in snapshot
		) {
			const currentMessages = (current as Record<string, unknown>).sdkMessages;
			const snapshotMessages = (snapshot as Record<string, unknown>).sdkMessages;

			if (Array.isArray(currentMessages) && Array.isArray(snapshotMessages)) {
				const merged = this.mergeSdkMessages(
					currentMessages as Array<Record<string, unknown>>,
					snapshotMessages as Array<Record<string, unknown>>
				);
				this.state.value = { ...(snapshot as object), sdkMessages: merged } as T;
				return;
			}
		}

		// For other state types, replace is fine
		this.state.value = snapshot;
	}

	/**
	 * Merge two SDK message arrays (deduplicate by uuid + sort by timestamp)
	 */
	private mergeSdkMessages(
		existing: Array<Record<string, unknown>>,
		incoming: Array<Record<string, unknown>>
	): Array<Record<string, unknown>> {
		const map = new Map<string, Record<string, unknown>>();

		// Add existing messages
		for (const msg of existing) {
			const id = msg.uuid as string;
			if (id) {
				map.set(id, msg);
			}
		}

		// Add/update with incoming messages
		for (const msg of incoming) {
			const id = msg.uuid as string;
			if (id) {
				map.set(id, msg);
			}
		}

		// Sort by timestamp (ascending - oldest to newest)
		return Array.from(map.values()).sort((a, b) => {
			const timeA = (a.timestamp as number) || 0;
			const timeB = (b.timestamp as number) || 0;
			return timeA - timeB;
		});
	}

	/**
	 * Setup subscriptions to state updates (PARALLEL - uses Promise.all)
	 *
	 * This method was refactored from sequential awaits to parallel Promise.all
	 * to reduce total subscription time from O(n*timeout) to O(timeout)
	 */
	private async setupSubscriptions(): Promise<void> {
		// Collect all subscription promises for parallel execution
		const subscriptionPromises: Promise<UnsubscribeFn>[] = [];

		// 1. Subscribe to full updates
		subscriptionPromises.push(
			this.hub.subscribe<T>(
				this.channelName,
				(data) => {
					this.log(`Full update received: ${this.channelName}`, data);
					// Batch signal updates to prevent cascading renders
					batch(() => {
						this.state.value = data;
						this.lastSync.value = Date.now();
						this.error.value = null;
					});
				},
				{ sessionId: this.options.sessionId }
			)
		);

		// 2. Subscribe to delta updates if enabled
		if (this.options.enableDeltas && this.options.mergeDelta) {
			const deltaChannel = `${this.channelName}.delta`;
			this.log(`Subscribing to delta channel: ${deltaChannel}`);

			subscriptionPromises.push(
				this.hub.subscribe<unknown>(
					deltaChannel,
					(delta) => {
						this.log(`Delta update received: ${this.channelName}`, delta);

						if (this.state.value && this.options.mergeDelta) {
							// Batch signal updates to prevent cascading renders
							batch(() => {
								this.state.value = this.options.mergeDelta!(this.state.value!, delta);
								this.lastSync.value = Date.now();
								this.error.value = null;
							});
						} else {
							console.warn(
								`[StateChannel:${this.channelName}] Cannot apply delta - state or mergeDelta missing`
							);
						}
					},
					{ sessionId: this.options.sessionId }
				)
			);
		}

		// Execute all subscriptions in parallel (reduces timeout from O(n) to O(1))
		const results = await Promise.all(subscriptionPromises);
		this.subscriptions.push(...results);

		this.log(`Subscriptions setup complete: ${results.length} subscriptions`);
	}

	/**
	 * Setup optimistic subscriptions (NON-BLOCKING - uses subscribeOptimistic)
	 *
	 * This method uses subscribeOptimistic for completely synchronous subscription
	 * setup. Handlers are registered locally immediately, server ACKs happen in background.
	 * This provides the best UI responsiveness at the cost of possibly missing
	 * the first few events before server-side subscription is confirmed.
	 */
	private setupOptimisticSubscriptions(): void {
		// 1. Subscribe to full updates (synchronous, immediate)
		const fullUpdateSub = this.hub.subscribeOptimistic<T>(
			this.channelName,
			(data) => {
				this.log(`Full update received: ${this.channelName}`, data);
				// Batch signal updates to prevent cascading renders
				batch(() => {
					this.state.value = data;
					this.lastSync.value = Date.now();
					this.error.value = null;
				});
			},
			{ sessionId: this.options.sessionId }
		);

		this.subscriptions.push(fullUpdateSub);

		// 2. Subscribe to delta updates if enabled (synchronous, immediate)
		if (this.options.enableDeltas && this.options.mergeDelta) {
			const deltaChannel = `${this.channelName}.delta`;
			this.log(`Subscribing (optimistic) to delta channel: ${deltaChannel}`);

			const deltaUpdateSub = this.hub.subscribeOptimistic<unknown>(
				deltaChannel,
				(delta) => {
					this.log(`Delta update received: ${this.channelName}`, delta);

					if (this.state.value && this.options.mergeDelta) {
						// Batch signal updates to prevent cascading renders
						batch(() => {
							this.state.value = this.options.mergeDelta!(this.state.value!, delta);
							this.lastSync.value = Date.now();
							this.error.value = null;
						});
					} else {
						console.warn(
							`[StateChannel:${this.channelName}] Cannot apply delta - state or mergeDelta missing`
						);
					}
				},
				{ sessionId: this.options.sessionId }
			);

			this.subscriptions.push(deltaUpdateSub);
		}

		this.log(`Optimistic subscriptions setup complete`);
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
				this.log(`Reconnected, performing hybrid refresh: ${this.channelName}`);
				this.hybridRefresh().catch(console.error);
			} else if (state === 'disconnected' || state === 'error') {
				this.error.value = new Error(`Connection ${state}`);
			}
		});

		this.subscriptions.push(reconnectSub);
	}

	/**
	 * Hybrid refresh on reconnection:
	 * - Try incremental sync if recently disconnected (< 5 min)
	 * - Fall back to full sync (with merge) for longer disconnections
	 *
	 * NOTE: MessageHub.resubscribeAll() is already called BEFORE this handler
	 * (see message-hub.ts line 172). We removed the defensive forceResubscribe()
	 * call here because it was contributing to the subscription storm problem.
	 * The debounce in resubscribeAll() now handles any duplicate calls.
	 */
	private async hybridRefresh(): Promise<void> {
		const lastSyncTime = this.lastSync.value;
		const now = Date.now();
		const gap = now - lastSyncTime;
		const INCREMENTAL_THRESHOLD = 5 * 60 * 1000; // 5 minutes

		// If we have a recent sync time and gap is reasonable, try incremental
		if (lastSyncTime > 0 && gap < INCREMENTAL_THRESHOLD) {
			this.log(
				`Attempting incremental sync since ${new Date(lastSyncTime).toISOString()} (gap: ${Math.round(gap / 1000)}s)`
			);
			try {
				await this.fetchSnapshot(lastSyncTime);
				this.log(`Incremental sync successful`);
				return;
			} catch (err) {
				this.log(`Incremental sync failed, falling back to full sync`, err);
			}
		} else {
			this.log(
				`Gap too large (${Math.round(gap / 1000)}s) or no previous sync, using full sync with merge`
			);
		}

		// Fallback: full sync with merge (if we have existing state)
		try {
			if (this.state.value) {
				// Fetch full snapshot and merge (this will deduplicate)
				await this.fetchSnapshot(0); // 0 triggers merge in fetchSnapshot
				this.log(`Full sync with merge completed`);
			} else {
				// No existing state, just do a clean fetch
				await this.fetchSnapshot();
				this.log(`Full sync completed (no existing state)`);
			}
		} catch (err) {
			this.log(`Full sync failed`, err);
			throw err;
		}
	}

	/**
	 * Debug logging
	 */
	private log(message: string, ...args: unknown[]): void {
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

		// Add items (prepend to show newest first)
		if (delta.added) {
			result.unshift(...delta.added);
		}

		return result;
	},

	/**
	 * Merge object properties
	 */
	object: <T extends Record<string, unknown>>(current: T, delta: Partial<T>): T => {
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
