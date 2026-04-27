import { useEffect, useMemo, useRef } from 'preact/hooks';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import { MinimalThreadFeed } from './thread/minimal/MinimalThreadFeed';
import { parseThreadRow } from './thread/space-task-thread-events';

interface SpaceTaskUnifiedThreadProps {
	taskId: string;
	bottomInsetClass?: string;
	/**
	 * Top padding applied to the scroll container so the first message clears
	 * any floating overlay (e.g. SpaceTaskPane's tab pill) at scroll-top. Older
	 * messages still scroll under the overlay's frosted-glass background; only
	 * the resting position is adjusted.
	 */
	topInsetClass?: string;
	/**
	 * Labels of agents whose underlying sessions are currently active. Forwarded
	 * to `MinimalThreadFeed` so the trailing non-terminal block of each
	 * still-running agent renders its own active rail. Per-agent (rather than a
	 * single boolean) so a Reviewer terminal `result` row landing after Coder's
	 * last row can't suppress Coder's still-running rail.
	 */
	activeAgentLabels?: ReadonlySet<string>;
}

export function SpaceTaskUnifiedThread({
	taskId,
	bottomInsetClass = 'pb-3',
	topInsetClass = '',
	activeAgentLabels,
}: SpaceTaskUnifiedThreadProps) {
	const { rows, activeTurnSummaries, isLoading, isReconnecting } = useSpaceTaskMessages(
		taskId,
		'compact'
	);
	const containerRef = useRef<HTMLDivElement>(null);
	const didInitialScrollRef = useRef<string | null>(null);

	const parsedRows = useMemo(() => rows.map(parseThreadRow), [rows]);

	useEffect(() => {
		if (!containerRef.current) return;
		// MinimalThreadFeed is a summary view — the entry point is the start
		// of the conversation, not the latest event.
		if (didInitialScrollRef.current !== taskId) {
			containerRef.current.scrollTop = 0;
			didInitialScrollRef.current = taskId;
		}
	}, [taskId, parsedRows.length]);

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
		<div class="h-full min-h-0 flex flex-col relative" data-testid="space-task-unified-thread">
			<div ref={containerRef} class={`flex-1 overflow-y-auto ${topInsetClass} ${bottomInsetClass}`}>
				<div class="min-h-[calc(100%+1px)]">
					<MinimalThreadFeed
						parsedRows={parsedRows}
						activeAgentLabels={activeAgentLabels}
						activeTurnSummaries={activeTurnSummaries}
					/>
				</div>
			</div>
		</div>
	);
}
