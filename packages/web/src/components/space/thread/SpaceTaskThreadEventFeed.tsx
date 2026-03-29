import type { SpaceTaskThreadEvent } from './space-task-thread-events';
import { SpaceTaskThreadEventRow } from './SpaceTaskThreadEventRow';

interface SpaceTaskThreadEventFeedProps {
	events: SpaceTaskThreadEvent[];
	taskId: string;
	mode: 'compact' | 'roster';
}

export function SpaceTaskThreadEventFeed({ events, taskId, mode }: SpaceTaskThreadEventFeedProps) {
	if (mode === 'roster') {
		return (
			<div class="space-y-1.5" data-testid="space-task-event-feed-roster">
				{events.map((event, index) => {
					const previous = index > 0 ? events[index - 1] : null;
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
							/>
						</div>
					);
				})}
			</div>
		);
	}

	return (
		<div class="space-y-2" data-testid="space-task-event-feed-compact">
			{events.map((event) => (
				<SpaceTaskThreadEventRow
					key={event.id}
					event={event}
					mode="compact"
					showTaskTitle={event.taskId !== taskId}
				/>
			))}
		</div>
	);
}
