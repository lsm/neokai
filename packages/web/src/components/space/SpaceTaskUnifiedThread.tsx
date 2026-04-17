import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import { useMessageMaps } from '../../hooks/useMessageMaps';
import { SpaceTaskThreadEventFeed } from './thread/SpaceTaskThreadEventFeed';
import { SpaceTaskCardFeed } from './thread/compact/SpaceTaskCardFeed';
import { buildThreadEvents, parseThreadRow } from './thread/space-task-thread-events';
import { getSpaceTaskThreadRenderStyle } from '../../lib/space-task-thread-config';

interface SpaceTaskUnifiedThreadProps {
	taskId: string;
	bottomInsetClass?: string;
}

export function SpaceTaskUnifiedThread({
	taskId,
	bottomInsetClass = 'pb-3',
}: SpaceTaskUnifiedThreadProps) {
	// Read render style on every render so that the value stays fresh after a
	// localStorage write (e.g. via setSpaceTaskThreadRenderStyle in devtools).
	const renderStyle = getSpaceTaskThreadRenderStyle();
	const { rows, isLoading, isReconnecting } = useSpaceTaskMessages(taskId);
	const containerRef = useRef<HTMLDivElement>(null);

	const parsedRows = useMemo(() => rows.map(parseThreadRow), [rows]);
	const threadEvents = useMemo(() => buildThreadEvents(parsedRows), [parsedRows]);
	const parsedMessages = useMemo(
		() =>
			parsedRows.map((row) => row.message).filter((message): message is SDKMessage => !!message),
		[parsedRows]
	);
	const maps = useMessageMaps(parsedMessages, `space-task-${taskId}`);

	useEffect(() => {
		if (!containerRef.current) return;
		containerRef.current.scrollTop = containerRef.current.scrollHeight;
	}, [parsedRows.length, threadEvents.length]);

	if (isReconnecting) {
		return (
			<div class="h-full overflow-y-auto">
				<div class="min-h-[calc(100%+1px)] flex items-center justify-center text-sm text-gray-500">
					Reconnecting task thread…
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div class="h-full overflow-y-auto">
				<div class="min-h-[calc(100%+1px)] flex items-center justify-center text-sm text-gray-500">
					Loading task thread…
				</div>
			</div>
		);
	}

	if (parsedRows.length === 0) {
		return (
			<div class="h-full overflow-y-auto">
				<div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6 text-center">
					<p class="text-sm text-gray-500">No task-agent activity yet.</p>
				</div>
			</div>
		);
	}

	return (
		<div class="h-full min-h-0 flex flex-col" data-testid="space-task-unified-thread">
			<div ref={containerRef} class={`flex-1 overflow-y-auto ${bottomInsetClass}`}>
				<div class="min-h-[calc(100%+1px)]">
					{renderStyle === 'compact' ? (
						<SpaceTaskCardFeed events={threadEvents} taskId={taskId} maps={maps} />
					) : (
						<SpaceTaskThreadEventFeed events={threadEvents} taskId={taskId} maps={maps} />
					)}
				</div>
			</div>
		</div>
	);
}
