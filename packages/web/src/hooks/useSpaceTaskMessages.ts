import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LiveQueryDeltaEvent, LiveQuerySnapshotEvent } from '@neokai/shared';
import { useMessageHub } from './useMessageHub';

export interface SpaceTaskThreadMessageRow {
	id: string | number;
	sessionId: string | null;
	kind: 'task_agent' | 'node_agent';
	role: string;
	label: string;
	taskId: string;
	taskTitle: string;
	messageType: string;
	content: string;
	createdAt: number;
	parentToolUseId?: string | null;
	/**
	 * Server-computed turn index (per session) for compact thread grouping.
	 * Present in compact query rows; absent in full rows.
	 */
	turnIndex?: number;
	/**
	 * Count of earlier non-terminal messages hidden by compact cap in this
	 * session-turn. Present in compact query rows; absent in full rows.
	 */
	turnHiddenMessageCount?: number;
	/**
	 * Total messages stored for this session — populated by the compact query
	 * variant when the server has sliced the result set. When equal to the
	 * number of delivered rows for this session, nothing was truncated.
	 *
	 * Absent (undefined) when the full/legacy query is used.
	 */
	sessionMessageCount?: number;
}

export type SpaceTaskMessagesQueryVariant = 'compact' | 'full';

export interface UseSpaceTaskMessagesResult {
	rows: SpaceTaskThreadMessageRow[];
	isLoading: boolean;
	isReconnecting: boolean;
}

let _taskMessageSubCounter = 0;
function nextTaskMessageSubId(taskId: string): string {
	_taskMessageSubCounter += 1;
	return `space-task-messages-${taskId}-${_taskMessageSubCounter}`;
}

function sortRows(rows: SpaceTaskThreadMessageRow[]): SpaceTaskThreadMessageRow[] {
	return [...rows].sort((a, b) => {
		if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
		return String(a.id).localeCompare(String(b.id));
	});
}

function applyDelta(
	currentRows: SpaceTaskThreadMessageRow[],
	event: LiveQueryDeltaEvent
): SpaceTaskThreadMessageRow[] {
	const next = new Map(currentRows.map((row) => [String(row.id), row]));
	for (const row of (event.removed ?? []) as SpaceTaskThreadMessageRow[]) {
		next.delete(String(row.id));
	}
	for (const row of (event.updated ?? []) as SpaceTaskThreadMessageRow[]) {
		next.set(String(row.id), row);
	}
	for (const row of (event.added ?? []) as SpaceTaskThreadMessageRow[]) {
		next.set(String(row.id), row);
	}
	return sortRows(Array.from(next.values()));
}

export function useSpaceTaskMessages(
	taskId: string | null,
	variant: SpaceTaskMessagesQueryVariant = 'compact'
): UseSpaceTaskMessagesResult {
	const { request, onEvent, isConnected } = useMessageHub();
	const [rows, setRows] = useState<SpaceTaskThreadMessageRow[]>([]);
	/**
	 * The task id whose LiveQuery snapshot has been applied to `rows`.
	 * `null` means either no subscription is active or we are still waiting
	 * for the first snapshot of the current `taskId`. `isLoading` is derived
	 * from the mismatch between this and the incoming `taskId`, which keeps
	 * the loading state correct from the very first render — no useEffect
	 * transition is needed to flip it to `true`, so the empty-state branch
	 * can never flash on mount or on task switch.
	 */
	const [loadedForTaskId, setLoadedForTaskId] = useState<string | null>(null);
	const activeSubIdRef = useRef<string | null>(null);

	const queryName =
		variant === 'full' ? 'spaceTaskMessages.byTask' : 'spaceTaskMessages.byTask.compact';

	useEffect(() => {
		if (!taskId || !isConnected) {
			setRows([]);
			setLoadedForTaskId(null);
			activeSubIdRef.current = null;
			return;
		}

		const subscriptionId = nextTaskMessageSubId(taskId);
		activeSubIdRef.current = subscriptionId;
		// Clear stale rows from a previous subscription synchronously. The
		// empty-state UI is still suppressed because `loadedForTaskId` is now
		// out of sync with `taskId`, so consumers see the loading state.
		setRows([]);
		setLoadedForTaskId(null);

		const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId !== activeSubIdRef.current) return;
			setRows(sortRows((event.rows as SpaceTaskThreadMessageRow[]) ?? []));
			setLoadedForTaskId(taskId);
		});

		const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
			if (event.subscriptionId !== activeSubIdRef.current) return;
			setRows((prev) => applyDelta(prev, event));
		});

		request('liveQuery.subscribe', {
			queryName,
			params: [taskId],
			subscriptionId,
		}).catch(() => {
			// Release the loading gate on subscribe failure so consumers can
			// surface the empty state (or, more likely, the reconnecting state
			// once the websocket drops) rather than stalling forever.
			if (activeSubIdRef.current === subscriptionId) {
				setLoadedForTaskId(taskId);
			}
		});

		return () => {
			unsubSnapshot();
			unsubDelta();
			activeSubIdRef.current = null;
			Promise.resolve(request('liveQuery.unsubscribe', { subscriptionId })).catch(() => {});
		};
	}, [taskId, isConnected, onEvent, request, queryName]);

	const sortedRows = useMemo(() => sortRows(rows), [rows]);

	// Derived: we are loading whenever we have an active taskId but have not
	// yet applied a snapshot for it. Computing this (instead of tracking it
	// as separate state) means the very first render — before the effect
	// runs — already returns `isLoading=true`, which is what suppresses the
	// empty-state flash on slow networks and on task switch.
	const isLoading = taskId !== null && isConnected && loadedForTaskId !== taskId;

	return {
		rows: sortedRows,
		isLoading,
		isReconnecting: !isConnected && taskId !== null,
	};
}
