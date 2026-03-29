import { cn } from '../../../lib/utils';
import type { SpaceTaskThreadEvent, SpaceTaskThreadRenderMode } from './space-task-thread-events';
import type { UseMessageMapsResult } from '../../../hooks/useMessageMaps';
import { SDKMessageRenderer } from '../../sdk/SDKMessageRenderer';

interface SpaceTaskThreadEventRowProps {
	event: SpaceTaskThreadEvent;
	mode: Exclude<SpaceTaskThreadRenderMode, 'verbose'>;
	showTaskTitle?: boolean;
	maps: UseMessageMapsResult;
}

const KIND_STYLES: Record<SpaceTaskThreadEvent['kind'], string> = {
	thinking: 'text-amber-300',
	tool: 'text-blue-300',
	subagent: 'text-purple-300',
	text: 'text-gray-200',
	user: 'text-cyan-300',
	system: 'text-gray-400',
	result: 'text-emerald-300',
	rate_limit: 'text-red-300',
	progress: 'text-blue-300',
	unknown: 'text-gray-300',
};

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
}

export function SpaceTaskThreadEventRow({
	event,
	mode,
	showTaskTitle = false,
	maps,
}: SpaceTaskThreadEventRowProps) {
	if (mode === 'compact' && event.kind === 'user' && event.message) {
		return (
			<div class="flex justify-end py-1" data-testid="space-task-event-row">
				<div class="max-w-full">
					<SDKMessageRenderer
						message={event.message}
						sessionId={event.sessionId ?? undefined}
						toolResultsMap={maps.toolResultsMap}
						toolInputsMap={maps.toolInputsMap}
						subagentMessagesMap={maps.subagentMessagesMap}
						sessionInfo={maps.sessionInfoMap.get((event.message as { uuid?: string }).uuid ?? '')}
						taskContext={true}
					/>
				</div>
			</div>
		);
	}

	return (
		<div
			class={cn('min-w-0', mode === 'compact' ? 'px-1 py-1.5' : 'px-1 py-1')}
			data-testid="space-task-event-row"
		>
			<div class="flex items-start gap-2">
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2 min-w-0">
						<span class="text-[10px] uppercase tracking-[0.14em] text-gray-500">{event.label}</span>
						<span class={cn('text-xs font-medium', KIND_STYLES[event.kind])}>{event.title}</span>
					</div>
					<div class="mt-0.5 text-sm text-gray-300 leading-snug whitespace-normal break-words">
						{event.summary}
					</div>
					{showTaskTitle && <div class="mt-0.5 text-[11px] text-gray-500">{event.taskTitle}</div>}
				</div>
				<span class="flex-shrink-0 text-[10px] text-gray-600">
					{formatTimestamp(event.createdAt)}
				</span>
			</div>
		</div>
	);
}
