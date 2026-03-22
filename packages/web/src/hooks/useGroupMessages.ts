/**
 * useGroupMessages Hook
 *
 * Subscribes to session group messages via LiveQuery for real-time streaming.
 * Messages are delivered via an initial snapshot followed by append-only deltas.
 *
 * Design constraints:
 * - Append-only invariant: session_group_messages rows are never updated or deleted.
 *   Only `added` from delta events is processed; `updated`/`removed` are ignored.
 * - Stale-event guard: tracks the active subscriptionId and discards events from
 *   prior group subscriptions during rapid task switching.
 * - Reconnect handling: `isConnected` is included in the effect dependency array
 *   so the subscription is re-established after a WebSocket disconnect/reconnect.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { useMessageHub } from './useMessageHub';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';

export interface SessionGroupMessage {
	id: number;
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
			// Append-only: only process `added`; ignore `updated` and `removed`.
			if (event.added && event.added.length > 0) {
				setMessages((prev) => [...prev, ...(event.added as SessionGroupMessage[])]);
			}
		});

		// Send the subscribe request. Errors are non-fatal: clear loading state.
		request('liveQuery.subscribe', {
			queryName: 'sessionGroupMessages.byGroup',
			params: [groupId],
			subscriptionId,
		}).catch(() => {
			if (activeSubIdRef.current === subscriptionId) {
				setIsLoading(false);
			}
		});

		return () => {
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

	return { messages, isLoading };
}
