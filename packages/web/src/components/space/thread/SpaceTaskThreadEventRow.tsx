import { cn } from '../../../lib/utils';
import type { SpaceTaskThreadEvent, SpaceTaskThreadRenderMode } from './space-task-thread-events';

interface SpaceTaskThreadEventRowProps {
	event: SpaceTaskThreadEvent;
	mode: Exclude<SpaceTaskThreadRenderMode, 'verbose'>;
	showTaskTitle?: boolean;
}

const KIND_STYLES: Record<SpaceTaskThreadEvent['kind'], string> = {
	thinking: 'text-amber-300',
	tool: 'text-blue-300',
	subagent: 'text-purple-300',
	text: 'text-gray-200',
	user: 'text-cyan-300',
	system: 'text-gray-400',
	result: 'text-emerald-300',
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
}: SpaceTaskThreadEventRowProps) {
	return (
		<div
			class={cn(
				'min-w-0',
				mode === 'compact'
					? 'rounded-md border border-dark-800 bg-dark-900/40 px-2.5 py-2'
					: 'px-1 py-1'
			)}
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
