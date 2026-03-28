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
}

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

export function useSpaceTaskMessages(taskId: string | null): UseSpaceTaskMessagesResult {
	const { request, onEvent, isConnected } = useMessageHub();
	const [rows, setRows] = useState<SpaceTaskThreadMessageRow[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const activeSubIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!taskId || !isConnected) {
			setRows([]);
			setIsLoading(false);
			activeSubIdRef.current = null;
			return;
		}

		const subscriptionId = nextTaskMessageSubId(taskId);
		activeSubIdRef.current = subscriptionId;
		setRows([]);
		setIsLoading(true);

		const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId !== activeSubIdRef.current) return;
			setRows(sortRows((event.rows as SpaceTaskThreadMessageRow[]) ?? []));
			setIsLoading(false);
		});

		const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
			if (event.subscriptionId !== activeSubIdRef.current) return;
			setRows((prev) => applyDelta(prev, event));
		});

		request('liveQuery.subscribe', {
			queryName: 'spaceTaskMessages.byTask',
			params: [taskId],
			subscriptionId,
		}).catch(() => {
			if (activeSubIdRef.current === subscriptionId) {
				setIsLoading(false);
			}
		});

		return () => {
			unsubSnapshot();
			unsubDelta();
			activeSubIdRef.current = null;
			Promise.resolve(request('liveQuery.unsubscribe', { subscriptionId })).catch(() => {});
		};
	}, [taskId, isConnected, onEvent, request]);

	const sortedRows = useMemo(() => sortRows(rows), [rows]);

	return {
		rows: sortedRows,
		isLoading,
		isReconnecting: !isConnected && taskId !== null,
	};
}

