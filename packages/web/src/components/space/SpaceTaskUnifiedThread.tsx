import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useMessageMaps } from '../../hooks/useMessageMaps';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import { getSpaceTaskThreadRenderStyle } from '../../lib/space-task-thread-config';
import { SpaceTaskCardFeed } from './thread/compact/SpaceTaskCardFeed';
import { MinimalThreadFeed } from './thread/minimal/MinimalThreadFeed';
import { parseThreadRow } from './thread/space-task-thread-events';

interface AgentTag {
	label: string;
	color: string;
}

function shortAgentLabel(label: string): string {
	return label.replace(/\s+agent$/i, '').toUpperCase();
}

function findCurrentAgent(container: HTMLElement): AgentTag | null {
	const rows = container.querySelectorAll<HTMLElement>('[data-agent-label]');
	if (rows.length === 0) return null;

	const containerRect = container.getBoundingClientRect();
	const topEdge = containerRect.top + 8;
	let currentBlock: HTMLElement | null = null;
	for (const row of Array.from(rows)) {
		if (row.getBoundingClientRect().top <= topEdge) {
			currentBlock = row;
		} else {
			break;
		}
	}

	if (!currentBlock) {
		currentBlock = rows[0] as HTMLElement;
	}

	// Hide the floating tag when the block's own inline header is visible in the
	// viewport — the user can already see which agent they're reading, so the
	// sticky label is redundant.
	const header = currentBlock.querySelector<HTMLElement>('[data-testid="compact-block-header"]');
	if (header) {
		const headerRect = header.getBoundingClientRect();
		const isHeaderOnScreen =
			headerRect.bottom > containerRect.top && headerRect.top < containerRect.bottom;
		if (isHeaderOnScreen) return null;
	}

	return {
		label: currentBlock.dataset.agentLabel ?? '',
		color: currentBlock.dataset.agentColor ?? '',
	};
}

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
	 * Whether the agent session is currently active (not idle / completed /
	 * failed / interrupted). Forwarded to the compact feed to gate the running
	 * border animation.
	 */
	isAgentActive?: boolean;
}

export function SpaceTaskUnifiedThread({
	taskId,
	bottomInsetClass = 'pb-3',
	topInsetClass = '',
	isAgentActive = false,
}: SpaceTaskUnifiedThreadProps) {
	// Read render style on every render so the value stays fresh after a
	// localStorage write (e.g. via setSpaceTaskThreadRenderStyle in devtools).
	const renderStyle = getSpaceTaskThreadRenderStyle();
	const { rows, isLoading, isReconnecting } = useSpaceTaskMessages(taskId, 'compact');
	const containerRef = useRef<HTMLDivElement>(null);
	const didInitialScrollRef = useRef<string | null>(null);

	const parsedRows = useMemo(() => rows.map(parseThreadRow), [rows]);
	const parsedMessages = useMemo(
		() =>
			parsedRows.map((row) => row.message).filter((message): message is SDKMessage => !!message),
		[parsedRows]
	);
	const maps = useMessageMaps(parsedMessages, `space-task-${taskId}`);

	useEffect(() => {
		if (!containerRef.current) return;
		// Both compact and minimal feeds scroll to the top on first mount —
		// they're both summary views where the entry point is the start of
		// the conversation, not the latest event.
		if (didInitialScrollRef.current !== taskId) {
			containerRef.current.scrollTop = 0;
			didInitialScrollRef.current = taskId;
		}
	}, [taskId, parsedRows.length]);

	const hasRows = parsedRows.length > 0;
	const [currentAgent, setCurrentAgent] = useState<AgentTag | null>(null);

	useEffect(() => {
		// The floating agent-name tag is anchored to compact feed blocks
		// (via [data-agent-label]). The minimal feed has its own per-row
		// agent header, so the floating tag would be redundant there.
		if (!hasRows || renderStyle !== 'compact') {
			setCurrentAgent(null);
			return;
		}

		const container = containerRef.current;
		if (!container) return;

		const update = () => setCurrentAgent(findCurrentAgent(container));
		update();
		container.addEventListener('scroll', update, { passive: true });
		return () => container.removeEventListener('scroll', update);
	}, [hasRows, renderStyle]);

	useEffect(() => {
		if (!hasRows || renderStyle !== 'compact' || !containerRef.current) {
			setCurrentAgent(null);
			return;
		}
		setCurrentAgent(findCurrentAgent(containerRef.current));
	}, [parsedRows.length, hasRows, renderStyle]);

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
			{currentAgent && (
				<div
					class="absolute top-2 left-4 z-10 flex items-center gap-1.5 px-2 py-[3px] rounded bg-dark-900/85 border border-dark-700 backdrop-blur-[2px] pointer-events-none select-none"
					aria-hidden="true"
					data-testid="agent-name-tag"
				>
					<span
						class="w-1.5 h-1.5 rounded-full flex-shrink-0"
						style={{ backgroundColor: currentAgent.color }}
					/>
					<span
						class="text-[10px] uppercase tracking-[0.16em] font-mono font-medium"
						style={{ color: currentAgent.color }}
					>
						{shortAgentLabel(currentAgent.label)}
					</span>
				</div>
			)}
			<div ref={containerRef} class={`flex-1 overflow-y-auto ${topInsetClass} ${bottomInsetClass}`}>
				<div class="min-h-[calc(100%+1px)]">
					{renderStyle === 'minimal' ? (
						<MinimalThreadFeed parsedRows={parsedRows} isAgentActive={isAgentActive} />
					) : (
						<SpaceTaskCardFeed
							parsedRows={parsedRows}
							taskId={taskId}
							maps={maps}
							isAgentActive={isAgentActive}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
