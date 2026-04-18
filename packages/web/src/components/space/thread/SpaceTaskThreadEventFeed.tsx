import type { SpaceTaskThreadEvent } from './space-task-thread-events';
import { SpaceTaskThreadEventRow } from './SpaceTaskThreadEventRow';
import type { UseMessageMapsResult } from '../../../hooks/useMessageMaps';
import { getAgentColor } from './space-task-thread-agent-colors';

interface SpaceTaskThreadEventFeedProps {
	events: SpaceTaskThreadEvent[];
	taskId: string;
	maps: UseMessageMapsResult;
}

function isEmptyUserEvent(event: SpaceTaskThreadEvent): boolean {
	if (event.kind !== 'user') return false;

	const content = (event.message as { message?: { content?: unknown } } | null | undefined)?.message
		?.content;

	if (typeof content === 'string') {
		return content.trim().length === 0;
	}

	if (Array.isArray(content)) {
		const hasText = content.some((block) => {
			if (!block || typeof block !== 'object') return false;
			const blockObj = block as { type?: unknown; text?: unknown };
			return (
				blockObj.type === 'text' &&
				typeof blockObj.text === 'string' &&
				blockObj.text.trim().length > 0
			);
		});
		return !hasText;
	}

	// Unknown/empty user payloads should not consume vertical space in compact feed.
	return true;
}

function shouldRenderEvent(event: SpaceTaskThreadEvent): boolean {
	// Never show non-error rate-limit notices in compact feeds.
	if (event.kind === 'rate_limit' && !event.isError) return false;

	// Compact mode is a Slack-like active conversation stream:
	// - hide system init noise
	// - hide successful terminal result summaries
	// - hide empty user placeholders (prevents fake gaps / header resets)
	if (event.kind === 'system' && event.systemSubtype === 'init') return false;
	if (event.kind === 'result' && event.resultSubtype === 'success') return false;
	if (isEmptyUserEvent(event)) return false;
	return true;
}

function normalizeAgentKey(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function SpaceTaskThreadEventFeed({ events, taskId, maps }: SpaceTaskThreadEventFeedProps) {
	const visibleEvents = events.filter(shouldRenderEvent);

	return (
		<div class="space-y-0.5" data-testid="space-task-event-feed-legacy">
			{visibleEvents.map((event, index) => {
				if (event.kind === 'user') {
					return (
						<SpaceTaskThreadEventRow
							key={`user-${event.id}-${index}`}
							event={event}
							mode="compact"
							showTaskTitle={event.taskId !== taskId}
							maps={maps}
							showAgentLabel={false}
						/>
					);
				}

				const previous = index > 0 ? visibleEvents[index - 1] : null;
				const next = index < visibleEvents.length - 1 ? visibleEvents[index + 1] : null;
				const currentKey = normalizeAgentKey(event.label);
				const previousSameAgent =
					previous && previous.kind !== 'user' && normalizeAgentKey(previous.label) === currentKey;
				const nextSameAgent =
					next && next.kind !== 'user' && normalizeAgentKey(next.label) === currentKey;
				const inSameAgentRun = Boolean(previousSameAgent || nextSameAgent);
				const showGroupHeader = !previousSameAgent && nextSameAgent;
				const showInlineLabel = !inSameAgentRun;

				return (
					<div
						key={`agent-event-${event.id}-${index}`}
						class="space-y-px"
						data-agent-label={event.label}
						data-agent-color={getAgentColor(event.label)}
					>
						{showGroupHeader && (
							<div
								class="pt-1 text-[11px] uppercase tracking-[0.16em] font-mono"
								style={{ color: getAgentColor(event.label) }}
							>
								{event.label}
							</div>
						)}
						<SpaceTaskThreadEventRow
							event={event}
							mode="compact"
							showTaskTitle={event.taskId !== taskId}
							maps={maps}
							showAgentLabel={showInlineLabel}
						/>
					</div>
				);
			})}
		</div>
	);
}
