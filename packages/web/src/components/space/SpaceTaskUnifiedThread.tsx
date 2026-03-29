import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import { useMessageMaps } from '../../hooks/useMessageMaps';
import { SpaceTaskThreadEventFeed } from './thread/SpaceTaskThreadEventFeed';
import { SpaceTaskThreadModeToggle } from './thread/SpaceTaskThreadModeToggle';
import { SpaceTaskThreadVerboseFeed } from './thread/SpaceTaskThreadVerboseFeed';
import {
	type SpaceTaskThreadRenderMode,
	buildThreadEvents,
	parseThreadRow,
} from './thread/space-task-thread-events';

interface SpaceTaskUnifiedThreadProps {
	taskId: string;
}

const THREAD_MODE_STORAGE_KEY = 'space-task-thread-view-mode';

function getInitialThreadMode(): SpaceTaskThreadRenderMode {
	if (typeof window === 'undefined') return 'compact';
	const stored = window.localStorage.getItem(THREAD_MODE_STORAGE_KEY);
	if (stored === 'verbose' || stored === 'compact' || stored === 'roster') {
		return stored;
	}
	return 'compact';
}

export function SpaceTaskUnifiedThread({ taskId }: SpaceTaskUnifiedThreadProps) {
	const { rows, isLoading, isReconnecting } = useSpaceTaskMessages(taskId);
	const containerRef = useRef<HTMLDivElement>(null);
	const [viewMode, setViewMode] = useState<SpaceTaskThreadRenderMode>(getInitialThreadMode);

	const parsedRows = useMemo(() => rows.map(parseThreadRow), [rows]);
	const threadEvents = useMemo(() => buildThreadEvents(parsedRows), [parsedRows]);
	const parsedMessages = useMemo(
		() =>
			parsedRows.map((row) => row.message).filter((message): message is SDKMessage => !!message),
		[parsedRows]
	);
	const maps = useMessageMaps(parsedMessages, `space-task-${taskId}`);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		window.localStorage.setItem(THREAD_MODE_STORAGE_KEY, viewMode);
	}, [viewMode]);

	useEffect(() => {
		if (!containerRef.current) return;
		containerRef.current.scrollTop = containerRef.current.scrollHeight;
	}, [parsedRows.length, threadEvents.length, viewMode]);

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
		<div class="h-full min-h-0 flex flex-col" data-testid="space-task-unified-thread">
			<div class="flex-shrink-0 py-2 flex items-center justify-end">
				<SpaceTaskThreadModeToggle value={viewMode} onChange={setViewMode} />
			</div>

			<div ref={containerRef} class="flex-1 overflow-y-auto pb-3">
				{viewMode === 'verbose' ? (
					<SpaceTaskThreadVerboseFeed parsedRows={parsedRows} taskId={taskId} maps={maps} />
				) : (
					<SpaceTaskThreadEventFeed events={threadEvents} taskId={taskId} mode={viewMode} />
				)}
			</div>
		</div>
	);
}
