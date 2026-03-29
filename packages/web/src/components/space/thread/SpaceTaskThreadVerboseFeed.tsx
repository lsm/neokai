import { useMemo } from 'preact/hooks';
import type { UseMessageMapsResult } from '../../../hooks/useMessageMaps';
import { SDKMessageRenderer } from '../../sdk/SDKMessageRenderer';
import type { ParsedThreadRow } from './space-task-thread-events';

interface ThreadGroup {
	id: string;
	label: string;
	taskId: string;
	taskTitle: string;
	rows: ParsedThreadRow[];
}

interface SpaceTaskThreadVerboseFeedProps {
	parsedRows: ParsedThreadRow[];
	taskId: string;
	maps: UseMessageMapsResult;
}

export function SpaceTaskThreadVerboseFeed({
	parsedRows,
	taskId,
	maps,
}: SpaceTaskThreadVerboseFeedProps) {
	const groups = useMemo<ThreadGroup[]>(() => {
		const next: ThreadGroup[] = [];
		for (const row of parsedRows) {
			const previous = next[next.length - 1];
			const isSameGroup =
				previous && previous.label === row.label && previous.taskId === row.taskId;
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

	return (
		<div class="space-y-5" data-testid="space-task-event-feed-verbose">
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
									sessionInfo={maps.sessionInfoMap.get(
										(row.message as { uuid?: string }).uuid ?? ''
									)}
									taskContext={true}
								/>
							) : (
								<pre
									key={String(row.id)}
									class="whitespace-pre-wrap text-sm text-gray-300 font-mono"
								>
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
