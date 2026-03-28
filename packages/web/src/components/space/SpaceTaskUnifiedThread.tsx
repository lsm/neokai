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
			class="h-full overflow-y-auto px-4 py-3 space-y-3"
			data-testid="space-task-unified-thread"
		>
			{parsedRows.map((row) => (
				<div
					key={String(row.id)}
					class="rounded-lg border border-dark-700 bg-dark-900/55 px-3 py-2"
					data-testid="space-task-thread-row"
				>
					<div class="mb-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-gray-500">
						<span>{row.label}</span>
						{row.taskId !== taskId && (
							<span class="rounded-full border border-dark-600 bg-dark-950 px-2 py-0.5 text-gray-400">
								{row.taskTitle}
							</span>
						)}
					</div>

					{row.message ? (
						<SDKMessageRenderer
							message={row.message}
							sessionId={row.sessionId ?? undefined}
							toolResultsMap={maps.toolResultsMap}
							toolInputsMap={maps.toolInputsMap}
							subagentMessagesMap={maps.subagentMessagesMap}
							sessionInfo={maps.sessionInfoMap.get((row.message as { uuid?: string }).uuid ?? '')}
							taskContext={true}
						/>
					) : (
						<pre class="whitespace-pre-wrap text-sm text-gray-300 font-mono">{row.fallbackText}</pre>
					)}
				</div>
			))}
		</div>
	);
}
