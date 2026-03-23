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
 */

import { useEffect, useRef, useState } from 'preact/hooks';
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

export interface UseGroupMessagesResult {
	messages: SessionGroupMessage[];
	isLoading: boolean;
	/** True when the WebSocket is disconnected but a groupId is set — messages will reload on reconnect. */
	isReconnecting: boolean;
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
 * @param groupId - The session group ID to subscribe to, or null to clear/unsubscribe.
 * @returns Current message list and loading state.
 *
 * @example
 * ```tsx
 * function TaskMessages({ groupId }: { groupId: string | null }) {
 *   const { messages, isLoading } = useGroupMessages(groupId);
 *
 *   if (isLoading) return <Spinner />;
 *   return <MessageList messages={messages} />;
 * }
 * ```
 */
export function useGroupMessages(groupId: string | null): UseGroupMessagesResult {
	const { request, onEvent, isConnected } = useMessageHub();
	const [messages, setMessages] = useState<SessionGroupMessage[]>([]);
	const [isLoading, setIsLoading] = useState(false);

	// Track the active subscriptionId to guard against stale events from prior
	// group subscriptions (e.g., rapid task switching or reconnect cycles).
	const activeSubIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!groupId || !isConnected) {
			setMessages([]);
			setIsLoading(false);
			activeSubIdRef.current = null;
			return;
		}

		const subscriptionId = generateGroupMessagesSubId(groupId);
		activeSubIdRef.current = subscriptionId;
		setIsLoading(true);
		setMessages([]);

		// Register event listeners BEFORE sending the subscribe request so the
		// snapshot that is delivered synchronously as part of the subscribe
		// response is not missed.
		const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId !== activeSubIdRef.current) return;
			setMessages(event.rows as SessionGroupMessage[]);
			setIsLoading(false);
		});

		const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
			if (event.subscriptionId !== activeSubIdRef.current) return;
			setMessages((prev) => {
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
	}, [groupId, isConnected, request, onEvent]);

	return { messages, isLoading, isReconnecting: !isConnected && groupId !== null };
}
