import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import { useMessageMaps } from '../../hooks/useMessageMaps';
import { SpaceTaskThreadEventFeed } from './thread/SpaceTaskThreadEventFeed';
import { SpaceTaskCardFeed } from './thread/compact/SpaceTaskCardFeed';
import { buildThreadEvents, parseThreadRow } from './thread/space-task-thread-events';
import { getSpaceTaskThreadRenderStyle } from '../../lib/space-task-thread-config';

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

	const containerTop = container.getBoundingClientRect().top;
	let found: AgentTag | null = null;
	for (const row of Array.from(rows)) {
		if (row.getBoundingClientRect().top <= containerTop + 8) {
			found = {
				label: row.dataset.agentLabel ?? '',
				color: row.dataset.agentColor ?? '',
			};
		} else {
			break;
		}
	}

	if (!found) {
		const first = rows[0] as HTMLElement;
		found = {
			label: first.dataset.agentLabel ?? '',
			color: first.dataset.agentColor ?? '',
		};
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
	const { rows, isLoading, isReconnecting } = useSpaceTaskMessages(taskId, 'full');
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

	const hasRows = parsedRows.length > 0;
	const [currentAgent, setCurrentAgent] = useState<AgentTag | null>(null);

	useEffect(() => {
		if (renderStyle !== 'compact' || !hasRows) {
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
		if (renderStyle !== 'compact' || !hasRows || !containerRef.current) {
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
