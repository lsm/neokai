/**
 * useGroupMessageLiveQuery
 *
 * Subscribes to the `sessionGroupMessages.byGroup` LiveQuery named query for a given group ID.
 * Replaces polling / `state.groupMessages.delta` event listening with the standardized
 * LiveQuery protocol.
 *
 * Lifecycle:
 * - On mount (or groupId change): registers snapshot/delta event listeners, then calls
 *   `liveQuery.subscribe` with a fresh subscriptionId.
 * - `liveQuery.snapshot`: replaces the message list entirely (server sends the full current
 *   set of rows). Stale events from superseded subscriptions are discarded.
 * - `liveQuery.delta`: appends messages from the `added` array only — `session_group_messages`
 *   is append-only so `updated`/`removed` are ignored. Stale events discarded.
 * - On unmount / groupId change: fires `liveQuery.unsubscribe` (fire-and-forget) and
 *   removes event listeners.
 * - null groupId: clears messages immediately, no subscription is created.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';
import { useMessageHub } from './useMessageHub';

export interface GroupMessage {
	id: number;
	groupId: string;
	sessionId: string | null;
	role: string;
	messageType: string;
	content: string;
	createdAt: number;
}

export interface UseGroupMessageLiveQueryResult {
	messages: GroupMessage[];
	loading: boolean;
	error: string | null;
}

/**
 * Subscribe to session group messages via LiveQuery for a given group.
 *
 * @param groupId - The group to subscribe to, or null to clear and not subscribe.
 */
export function useGroupMessageLiveQuery(groupId: string | null): UseGroupMessageLiveQueryResult {
	const { request, onEvent } = useMessageHub();
	const [messages, setMessages] = useState<GroupMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Track the active subscriptionId so snapshot/delta handlers can discard stale events
	// from prior subscriptions during rapid group switching.
	const activeSubIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!groupId) {
			setMessages([]);
			setLoading(false);
			setError(null);
			activeSubIdRef.current = null;
			return;
		}

		const subscriptionId = crypto.randomUUID();
		activeSubIdRef.current = subscriptionId;

		setLoading(true);
		setError(null);
		setMessages([]);

		let cancelled = false;

		// Register snapshot handler before calling subscribe so that no snapshot
		// event can slip through between registering and the RPC resolving.
		const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId !== subscriptionId || cancelled) return;
			setMessages((event.rows as GroupMessage[]) ?? []);
			setLoading(false);
		});

		// Register delta handler — append-only: only process `added`.
		const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
			if (event.subscriptionId !== subscriptionId || cancelled) return;
			if (event.added && event.added.length > 0) {
				setMessages((prev) => [...prev, ...(event.added as GroupMessage[])]);
			}
		});

		// Issue the subscribe RPC. The server sends `liveQuery.snapshot` synchronously
		// before returning so the event listeners above will capture it.
		request<{ ok: true }>('liveQuery.subscribe', {
			queryName: 'sessionGroupMessages.byGroup',
			params: [groupId],
			subscriptionId,
		}).catch((err: unknown) => {
			if (!cancelled) {
				setError(err instanceof Error ? err.message : 'Failed to subscribe to group messages');
				setLoading(false);
			}
		});

		return () => {
			cancelled = true;

			if (activeSubIdRef.current === subscriptionId) {
				activeSubIdRef.current = null;
			}

			unsubSnapshot();
			unsubDelta();

			// Tell the server to dispose the subscription. Fire-and-forget — if the
			// connection is already gone the server will clean up on disconnect anyway.
			request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {});
		};
	}, [groupId, request, onEvent]);

	return { messages, loading, error };
}
