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
 *   set of rows). Stale events from superseded subscriptions are discarded. Clears any
 *   prior error state.
 * - `liveQuery.delta`: appends messages from the `added` array only — `session_group_messages`
 *   is append-only so `updated`/`removed` are ignored. Stale events discarded.
 * - On reconnect: re-issues `liveQuery.subscribe` with the same subscriptionId so the server
 *   delivers a fresh snapshot, resyncing stale state. The old server-side handle is already
 *   disposed on disconnect so no unsubscribe is sent first.
 * - On unmount / groupId change: fires `liveQuery.unsubscribe` (fire-and-forget) and
 *   removes event listeners.
 * - null groupId: clears messages immediately, no subscription is created.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';
import type { GroupMessage } from '../types/group-message';
import { useMessageHub } from './useMessageHub';

export type { GroupMessage } from '../types/group-message';

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
	const { request, onEvent, isConnected } = useMessageHub();
	const [messages, setMessages] = useState<GroupMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Refs that persist the active subscription state across renders so the
	// reconnect effect can re-issue subscribe without touching the main effect.
	const activeSubIdRef = useRef<string | null>(null);
	const activeGroupIdRef = useRef<string | null>(null);

	// ── Main subscription effect ──────────────────────────────────────────────
	useEffect(() => {
		if (!groupId) {
			setMessages([]);
			setLoading(false);
			setError(null);
			activeSubIdRef.current = null;
			activeGroupIdRef.current = null;
			return;
		}

		const subscriptionId = crypto.randomUUID();
		activeSubIdRef.current = subscriptionId;
		activeGroupIdRef.current = groupId;

		setLoading(true);
		setError(null);
		setMessages([]);

		let cancelled = false;

		// Register snapshot handler before calling subscribe so that no snapshot
		// event can slip through between registering and the RPC resolving.
		const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId !== subscriptionId || cancelled) return;
			// rows is unknown[] from the protocol; we trust the server schema here.
			setMessages((event.rows as GroupMessage[]) ?? []);
			setError(null); // Clear any prior subscribe error if snapshot arrives late
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
				activeGroupIdRef.current = null;
			}

			unsubSnapshot();
			unsubDelta();

			// Tell the server to dispose the subscription. Fire-and-forget — if the
			// connection is already gone the server will clean up on disconnect anyway.
			request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {});
		};
	}, [groupId, request, onEvent]);

	// ── Reconnect re-subscribe effect ─────────────────────────────────────────
	// After a WebSocket reconnect (false → true transition), re-issue the subscribe
	// RPC with the same subscriptionId so the server delivers a fresh snapshot.
	// The old server-side handle is already disposed on disconnect, so no unsubscribe
	// is needed first. The existing snapshot/delta handlers will accept the re-delivered
	// snapshot because the subscriptionId is unchanged.
	const prevConnectedRef = useRef<boolean>(isConnected);
	useEffect(() => {
		const wasConnected = prevConnectedRef.current;
		prevConnectedRef.current = isConnected;

		// Only act on a false → true (reconnect) transition
		if (!isConnected || wasConnected) return;

		const subId = activeSubIdRef.current;
		const gId = activeGroupIdRef.current;
		if (!subId || !gId) return;

		request<{ ok: true }>('liveQuery.subscribe', {
			queryName: 'sessionGroupMessages.byGroup',
			params: [gId],
			subscriptionId: subId,
		}).catch(() => {
			// Reconnect re-subscribe failure is transient; ignore — the next reconnect
			// cycle will retry automatically.
		});
	}, [isConnected, request]);

	return { messages, loading, error };
}
