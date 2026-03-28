import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import { useMessageMaps } from '../../hooks/useMessageMaps';
import { SDKMessageRenderer } from '../sdk/SDKMessageRenderer';

interface SpaceTaskUnifiedThreadProps {
	taskId: string;
}

interface ParsedThreadRow {
	id: string | number;
	sessionId: string | null;
	label: string;
	taskId: string;
	taskTitle: string;
	message: SDKMessage | null;
	fallbackText: string | null;
}

interface ThreadGroup {
	id: string;
	label: string;
	taskId: string;
	taskTitle: string;
	rows: ParsedThreadRow[];
}

function parseThreadRow(
	row: ReturnType<typeof useSpaceTaskMessages>['rows'][number]
): ParsedThreadRow {
	try {
		const parsed = JSON.parse(row.content) as SDKMessage;
		const withTimestamp = {
			...(parsed as Record<string, unknown>),
			timestamp: row.createdAt,
		} as unknown as SDKMessage;
		return {
			id: row.id,
			sessionId: row.sessionId,
			label: row.label,
			taskId: row.taskId,
			taskTitle: row.taskTitle,
			message: withTimestamp,
			fallbackText: null,
		};
	} catch {
		return {
			id: row.id,
			sessionId: row.sessionId,
			label: row.label,
			taskId: row.taskId,
			taskTitle: row.taskTitle,
			message: null,
			fallbackText: row.content,
		};
	}
}

export function SpaceTaskUnifiedThread({ taskId }: SpaceTaskUnifiedThreadProps) {
	const { rows, isLoading, isReconnecting } = useSpaceTaskMessages(taskId);
	const containerRef = useRef<HTMLDivElement>(null);

	const parsedRows = useMemo(() => rows.map(parseThreadRow), [rows]);
	const parsedMessages = useMemo(
		() => parsedRows.map((row) => row.message).filter((message): message is SDKMessage => !!message),
		[parsedRows]
	);
	const maps = useMessageMaps(parsedMessages, `space-task-${taskId}`);
	const groups = useMemo<ThreadGroup[]>(() => {
		const next: ThreadGroup[] = [];
		for (const row of parsedRows) {
			const previous = next[next.length - 1];
			const isSameGroup =
				previous &&
				previous.label === row.label &&
				previous.taskId === row.taskId;
			if (isSameGroup) {
				previous.rows.push(row);
				continue;
			}
			next.push({
				id: `${row.label}-${row.taskId}-${row.id}`,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				rows: [row],
			});
		}
		return next;
	}, [parsedRows]);

	useEffect(() => {
		if (!containerRef.current) return;
		containerRef.current.scrollTop = containerRef.current.scrollHeight;
	}, [parsedRows.length]);

	if (isReconnecting) {
		return (
			<div class="h-full flex items-center justify-center text-sm text-gray-500">
				Reconnecting task thread…
			</div>
		);
	}

	if (isLoading) {
		return (
			<div class="h-full flex items-center justify-center text-sm text-gray-500">
				Loading task thread…
			</div>
		);
	}

	if (parsedRows.length === 0) {
		return (
			<div class="h-full flex items-center justify-center px-6 text-center">
				<p class="text-sm text-gray-500">No task-agent activity yet.</p>
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			class="h-full overflow-y-auto py-3 space-y-5"
			data-testid="space-task-unified-thread"
		>
			{groups.map((group) => (
				<div key={group.id} data-testid="space-task-thread-row">
					<div class="mb-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-gray-500">
						<span>{group.label}</span>
						{group.taskId !== taskId && <span>{group.taskTitle}</span>}
					</div>

					<div class="space-y-2">
						{group.rows.map((row) =>
							row.message ? (
								<SDKMessageRenderer
									key={String(row.id)}
									message={row.message}
									sessionId={row.sessionId ?? undefined}
									toolResultsMap={maps.toolResultsMap}
									toolInputsMap={maps.toolInputsMap}
									subagentMessagesMap={maps.subagentMessagesMap}
									sessionInfo={maps.sessionInfoMap.get((row.message as { uuid?: string }).uuid ?? '')}
									taskContext={true}
								/>
							) : (
								<pre key={String(row.id)} class="whitespace-pre-wrap text-sm text-gray-300 font-mono">
									{row.fallbackText}
								</pre>
							)
						)}
					</div>
				</div>
			))}
		</div>
	);
}
