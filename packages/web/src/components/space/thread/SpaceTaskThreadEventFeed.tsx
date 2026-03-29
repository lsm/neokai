import type { SpaceTaskThreadEvent } from './space-task-thread-events';
import { SpaceTaskThreadEventRow } from './SpaceTaskThreadEventRow';
import type { UseMessageMapsResult } from '../../../hooks/useMessageMaps';

interface SpaceTaskThreadEventFeedProps {
	events: SpaceTaskThreadEvent[];
	taskId: string;
	mode: 'compact' | 'roster';
	maps: UseMessageMapsResult;
}

function shouldRenderEvent(event: SpaceTaskThreadEvent, mode: 'compact' | 'roster'): boolean {
	// Compact mode is a Slack-like active conversation stream:
	// - hide system init noise
	// - hide successful terminal result summaries
	// - hide non-error rate-limit notices
	if (mode === 'compact') {
		if (event.kind === 'system' && event.systemSubtype === 'init') return false;
		if (event.kind === 'result' && event.resultSubtype === 'success') return false;
		if (event.kind === 'rate_limit' && !event.isError) return false;
	}
	return true;
}

export function SpaceTaskThreadEventFeed({
	events,
	taskId,
	mode,
	maps,
}: SpaceTaskThreadEventFeedProps) {
	const visibleEvents = events.filter((event) => shouldRenderEvent(event, mode));

	if (mode === 'roster') {
		return (
			<div class="space-y-1.5" data-testid="space-task-event-feed-roster">
				{visibleEvents.map((event, index) => {
					const previous = index > 0 ? visibleEvents[index - 1] : null;
					const showAgentHeader = !previous || previous.label !== event.label;
					return (
						<div key={event.id} class="space-y-0.5">
							{showAgentHeader && (
								<div class="pt-1 text-[10px] uppercase tracking-[0.16em] text-gray-600">
									{event.label}
								</div>
							)}
							<SpaceTaskThreadEventRow
								event={event}
								mode="roster"
								showTaskTitle={event.taskId !== taskId}
								maps={maps}
							/>
						</div>
					);
				})}
			</div>
		);
	}

	return (
		<div class="space-y-2" data-testid="space-task-event-feed-compact">
			{visibleEvents.map((event) => (
				<SpaceTaskThreadEventRow
					key={event.id}
					event={event}
					mode="compact"
					showTaskTitle={event.taskId !== taskId}
					maps={maps}
				/>
			))}
		</div>
	);
}
