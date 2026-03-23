/**
 * useGroupMessages Hook
 *
 * Subscribes to group timeline messages via LiveQuery for real-time streaming.
 * Messages are delivered via an initial snapshot followed by delta updates.
 *
 * Design constraints:
 * - Canonical source: timeline rows are queried from persisted sdk_messages +
 *   task_group_events (not a runtime projection table).
 * - Delta handling supports added/updated/removed rows to stay correct even when
 *   row mappers evolve or ordering metadata changes.
 * - Stale-event guard: tracks the active subscriptionId and discards events from
 *   prior group subscriptions during rapid task switching.
 * - Reconnect handling: `isConnected` is included in the effect dependency array
 *   so the subscription is re-established after a WebSocket disconnect/reconnect.
 * - Pagination: only the newest `pageSize` messages are shown initially. Older
 *   messages are stored in an internal buffer and revealed via `loadEarlier()`.
 *   New messages from live deltas are always appended and visible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useMessageHub } from './useMessageHub';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';

export interface SessionGroupMessage {
	id: number | string;
	groupId: string;
	sessionId: string | null;
	role: string;
	messageType: string;
	content: string;
	createdAt: number;
}

/** Default number of messages shown initially and per "load earlier" page. */
export const DEFAULT_PAGE_SIZE = 50;

export interface UseGroupMessagesOptions {
	/** Number of messages to show per page (default: DEFAULT_PAGE_SIZE). */
	pageSize?: number;
}

export interface UseGroupMessagesResult {
	messages: SessionGroupMessage[];
	isLoading: boolean;
	/** True when the WebSocket is disconnected but a groupId is set — messages will reload on reconnect. */
	isReconnecting: boolean;
	/** True when there are older messages not currently displayed. */
	hasOlder: boolean;
	/** Reveals the previous page of older messages from the buffer. Instant (no network request). */
	loadEarlier: () => void;
}

let _subscriptionCounter = 0;

/** Generates a unique subscription ID for each group subscription. Exported for testing. */
export function generateGroupMessagesSubId(groupId: string): string {
	_subscriptionCounter += 1;
	return `group-messages-${groupId}-${_subscriptionCounter}`;
}

/**
 * Resets the module-level subscription counter.
 * Call this in `beforeEach` to keep counter values deterministic across tests.
 */
export function resetSubscriptionCounterForTesting(): void {
	_subscriptionCounter = 0;
}

/**
 * Hook to subscribe to session group messages via LiveQuery.
 *
 * Re-subscribes automatically when the WebSocket reconnects (`isConnected`
 * is included in the effect dependency array).
 *
 * Pagination: internally stores ALL messages from the LiveQuery snapshot.
 * Only the newest `pageSize` messages are exposed via `messages`. Older
 * messages are hidden and revealed one page at a time via `loadEarlier()`.
 * New live-delta messages are always appended to the visible end.
 *
 * @param groupId - The session group ID to subscribe to, or null to clear/unsubscribe.
 * @param options - Optional configuration (pageSize).
 * @returns Current message list, loading state, and pagination controls.
 *
 * @example
 * ```tsx
 * function TaskMessages({ groupId }: { groupId: string | null }) {
 *   const { messages, isLoading, hasOlder, loadEarlier } = useGroupMessages(groupId);
 *
 *   if (isLoading) return <Spinner />;
 *   return (
 *     <>
 *       {hasOlder && <button onClick={loadEarlier}>Load earlier</button>}
 *       <MessageList messages={messages} />
 *     </>
 *   );
 * }
 * ```
 */
export function useGroupMessages(
	groupId: string | null,
	options?: UseGroupMessagesOptions
): UseGroupMessagesResult {
	const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
	const { request, onEvent, isConnected } = useMessageHub();
	// allMessages holds the complete sorted set received from LiveQuery.
	const [allMessages, setAllMessages] = useState<SessionGroupMessage[]>([]);
	// hiddenOlderCount is the number of old messages hidden at the start of allMessages.
	// Starts at max(0, snapshot.length - pageSize) so only the newest page is visible.
	const [hiddenOlderCount, setHiddenOlderCount] = useState(0);
	const [isLoading, setIsLoading] = useState(false);

	// Track the active subscriptionId to guard against stale events from prior
	// group subscriptions (e.g., rapid task switching or reconnect cycles).
	const activeSubIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!groupId || !isConnected) {
			setAllMessages([]);
			setHiddenOlderCount(0);
			setIsLoading(false);
			activeSubIdRef.current = null;
			return;
		}

		const subscriptionId = generateGroupMessagesSubId(groupId);
		activeSubIdRef.current = subscriptionId;
		setIsLoading(true);
		setAllMessages([]);
		setHiddenOlderCount(0);

		// Register event listeners BEFORE sending the subscribe request so the
		// snapshot that is delivered synchronously as part of the subscribe
		// response is not missed.
		const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId !== activeSubIdRef.current) return;
			const rows = event.rows as SessionGroupMessage[];
			const sorted = [...rows].sort((a, b) => {
				if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
				return String(a.id).localeCompare(String(b.id));
			});
			setAllMessages(sorted);
			// Hide all messages older than the newest `pageSize` so we start at the bottom.
			setHiddenOlderCount(Math.max(0, sorted.length - pageSize));
			setIsLoading(false);
		});

		const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
			if (event.subscriptionId !== activeSubIdRef.current) return;
			setAllMessages((prev) => {
				let next = prev;

				if (event.removed && event.removed.length > 0) {
					const removedIds = new Set(
						(event.removed as SessionGroupMessage[]).map((row) => String(row.id))
					);
					next = next.filter((row) => !removedIds.has(String(row.id)));
				}

				if (event.updated && event.updated.length > 0) {
					const updatedById = new Map(
						(event.updated as SessionGroupMessage[]).map((row) => [String(row.id), row])
					);
					next = next.map((row) => updatedById.get(String(row.id)) ?? row);
				}

				if (event.added && event.added.length > 0) {
					next = [...next, ...(event.added as SessionGroupMessage[])];
				}

				next.sort((a, b) => {
					if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
					return String(a.id).localeCompare(String(b.id));
				});
				return next;
			});
			// Note: hiddenOlderCount is intentionally NOT updated when new messages
			// arrive via delta. New messages append at the end and are always visible.
		});

		// Send the subscribe request with retry on failure.
		// Up to MAX_RETRIES additional attempts after the first, with increasing delays.
		// IMPORTANT: RETRY_DELAYS_MS must have exactly MAX_RETRIES entries — adding an extra
		// retry without a corresponding delay entry causes setTimeout(fn, undefined) → 0ms.
		const MAX_RETRIES = 2;
		const RETRY_DELAYS_MS: [number, number] = [500, 1500];

		let retryTimer: ReturnType<typeof setTimeout> | null = null;

		const subscribeWithRetry = (attempt: number): void => {
			request('liveQuery.subscribe', {
				queryName: 'sessionGroupMessages.byGroup',
				params: [groupId],
				subscriptionId,
			}).catch(() => {
				if (activeSubIdRef.current !== subscriptionId) return;
				if (attempt < MAX_RETRIES) {
					retryTimer = setTimeout(() => {
						retryTimer = null;
						if (activeSubIdRef.current === subscriptionId) {
							subscribeWithRetry(attempt + 1);
						}
					}, RETRY_DELAYS_MS[attempt]);
				} else {
					if (activeSubIdRef.current === subscriptionId) {
						setIsLoading(false);
					}
				}
			});
		};

		subscribeWithRetry(0);

		return () => {
			// Cancel any pending retry timer before clearing the subscription ID,
			// so the timer callback cannot observe a matching subscription ID after cleanup.
			if (retryTimer !== null) {
				clearTimeout(retryTimer);
				retryTimer = null;
			}

			// Remove event listeners first.
			unsubSnapshot();
			unsubDelta();

			// Clear the active sub ID so in-flight events from this subscription
			// are discarded once the new effect runs.
			activeSubIdRef.current = null;

			// Fire-and-forget: ask the server to clean up the subscription.
			// Wrap in Promise.resolve() so cleanup is safe even if request()
			// returns a non-thenable value (e.g. in certain test scenarios).
			Promise.resolve(request('liveQuery.unsubscribe', { subscriptionId })).catch(() => {
				// Ignore cleanup errors.
			});
		};
	}, [groupId, isConnected, pageSize, request, onEvent]);

	// Expose only the visible slice: allMessages starting from hiddenOlderCount.
	// New live-delta messages always appear at the end (never hidden).
	const messages = useMemo(
		() => allMessages.slice(hiddenOlderCount),
		[allMessages, hiddenOlderCount]
	);

	// Reveal one more page of older messages from the internal buffer.
	const loadEarlier = useCallback(() => {
		setHiddenOlderCount((prev) => Math.max(0, prev - pageSize));
	}, [pageSize]);

	return {
		messages,
		isLoading,
		isReconnecting: !isConnected && groupId !== null,
		hasOlder: hiddenOlderCount > 0,
		loadEarlier,
	};
}
