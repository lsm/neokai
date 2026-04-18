import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import { useMessageMaps } from '../../hooks/useMessageMaps';
import { SpaceTaskThreadEventFeed } from './thread/SpaceTaskThreadEventFeed';
import { SpaceTaskCardFeed } from './thread/compact/SpaceTaskCardFeed';
import { buildThreadEvents, parseThreadRow } from './thread/space-task-thread-events';
import { getSpaceTaskThreadRenderStyle } from '../../lib/space-task-thread-config';

// ── Scroll-spy helpers ───────────────────────────────────────────────────────

interface AgentTag {
	label: string;
	color: string;
}

/** Strips the trailing "Agent" word for compact display, e.g. "Task Agent" → "TASK". */
function shortAgentLabel(label: string): string {
	return label.replace(/\s+agent$/i, '').toUpperCase();
}

/**
 * Walk all `[data-agent-label]` blocks inside `container` and return the agent
 * of the last block whose top edge is at or above the container's top edge.
 * This is the block currently occupying the visible top of the scroll area.
 *
 * Falls back to the first block when nothing has scrolled past the top yet
 * (e.g. scrollTop=0) so the tag is always visible when content exists.
 */
function findCurrentAgent(container: HTMLElement): AgentTag | null {
	const blocks = container.querySelectorAll<HTMLElement>('[data-agent-label]');
	if (blocks.length === 0) return null;
	const containerTop = container.getBoundingClientRect().top;
	let found: AgentTag | null = null;
	for (const el of Array.from(blocks)) {
		if (el.getBoundingClientRect().top <= containerTop + 8) {
			found = { label: el.dataset.agentLabel ?? '', color: el.dataset.agentColor ?? '' };
		} else {
			break;
		}
	}
	// At scroll=0 nothing is above the fold — show the first block's agent.
	if (!found) {
		const first = blocks[0] as HTMLElement;
		found = { label: first.dataset.agentLabel ?? '', color: first.dataset.agentColor ?? '' };
	}
	return found;
}

interface SpaceTaskUnifiedThreadProps {
	taskId: string;
	bottomInsetClass?: string;
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
	isAgentActive = false,
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

	// ── Scroll-spy: floating agent name tag ──────────────────────────────────
	const [currentAgent, setCurrentAgent] = useState<AgentTag | null>(null);

	// Attach scroll listener. Re-registers when renderStyle changes or when rows
	// first appear (parsedRows.length>0 transitions the early-return path to the
	// main return path, which is the first time containerRef.current is set).
	const hasRows = parsedRows.length > 0;
	useEffect(() => {
		if (!hasRows) {
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

	// Re-probe when rows change so the tag reflects newly rendered blocks.
	useEffect(() => {
		if (!hasRows || !containerRef.current) return;
		setCurrentAgent(findCurrentAgent(containerRef.current));
	}, [parsedRows.length, hasRows]);

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
			{/* Scroll-spy agent name tag — shows which agent's block is at the top of view */}
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
			<div ref={containerRef} class={`flex-1 overflow-y-auto ${bottomInsetClass}`}>
				<div class="min-h-[calc(100%+1px)]">
					{renderStyle === 'compact' ? (
						<SpaceTaskCardFeed
							parsedRows={parsedRows}
							taskId={taskId}
							maps={maps}
							isAgentActive={isAgentActive}
						/>
					) : (
						<SpaceTaskThreadEventFeed events={threadEvents} taskId={taskId} maps={maps} />
					)}
				</div>
			</div>
		</div>
	);
}
