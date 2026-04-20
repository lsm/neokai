import { cn } from '../../../lib/utils';
import type {
	SpaceTaskThreadEvent,
	SpaceTaskThreadRenderMode,
	TodoItem,
} from './space-task-thread-events';
import type { UseMessageMapsResult } from '../../../hooks/useMessageMaps';
import { SDKMessageRenderer } from '../../sdk/SDKMessageRenderer';
import { ToolIcon } from '../../sdk/tools/ToolIcon';
import { getToolColors } from '../../sdk/tools/tool-utils';
import { getAgentColor } from './space-task-thread-agent-colors';

interface SpaceTaskThreadEventRowProps {
	event: SpaceTaskThreadEvent;
	mode: Exclude<SpaceTaskThreadRenderMode, 'verbose'>;
	showTaskTitle?: boolean;
	maps: UseMessageMapsResult;
	showAgentLabel?: boolean;
}

const KIND_STYLES: Record<SpaceTaskThreadEvent['kind'], string> = {
	thinking: 'text-amber-300',
	tool: 'text-blue-300',
	subagent: 'text-purple-300',
	text: 'text-gray-200',
	user: 'text-cyan-300',
	system: 'text-gray-400',
	result: 'text-emerald-300',
	rate_limit: 'text-red-300',
	progress: 'text-blue-300',
	unknown: 'text-gray-300',
};

const BODY_STYLES: Record<SpaceTaskThreadEvent['kind'], string> = {
	thinking: 'text-gray-100',
	tool: 'text-slate-300',
	subagent: 'text-gray-100',
	text: 'text-gray-100',
	user: 'text-gray-100',
	system: 'text-slate-300',
	result: 'text-gray-100',
	rate_limit: 'text-red-200',
	progress: 'text-slate-300',
	unknown: 'text-slate-300',
};

function shortAgentLabel(label: string): string {
	return label.replace(/\s+agent$/i, '').toUpperCase();
}

/** TodoWrite uses cyan in the thread pane to avoid clashing with Thinking (amber). */
const TODO_THREAD_ICON_COLOR = 'text-cyan-500 dark:text-cyan-400';
const TODO_THREAD_BODY_COLOR = 'text-cyan-300 dark:text-cyan-200';

function getEventTitleClass(event: SpaceTaskThreadEvent): string {
	if (event.kind === 'thinking') return getToolColors('Thinking').iconColor;
	if (event.kind === 'tool' && event.iconToolName === 'TodoWrite') return TODO_THREAD_ICON_COLOR;
	if (event.kind === 'tool' && event.iconToolName)
		return getToolColors(event.iconToolName).iconColor;
	if (event.kind === 'subagent') return getToolColors('Task').iconColor;
	if (event.kind === 'progress' && event.iconToolName)
		return getToolColors(event.iconToolName).iconColor;
	return KIND_STYLES[event.kind];
}

function getEventBodyClass(event: SpaceTaskThreadEvent): string {
	if (event.kind === 'thinking') {
		const colors = getToolColors('Thinking');
		return colors.lightText ?? colors.text;
	}
	if (event.kind === 'tool' && event.iconToolName === 'TodoWrite') return TODO_THREAD_BODY_COLOR;
	if (event.kind === 'tool' && event.iconToolName) {
		const colors = getToolColors(event.iconToolName);
		return colors.lightText ?? colors.text;
	}
	if (event.kind === 'subagent') {
		const colors = getToolColors('Task');
		return colors.lightText ?? colors.text;
	}
	if (event.kind === 'progress' && event.iconToolName) {
		const colors = getToolColors(event.iconToolName);
		return colors.lightText ?? colors.text;
	}
	return BODY_STYLES[event.kind];
}

function getEventIcon(event: SpaceTaskThreadEvent) {
	if (event.kind === 'thinking') {
		return <ToolIcon toolName="Thinking" size="xs" />;
	}
	if (event.kind === 'tool' && event.iconToolName) {
		return <ToolIcon toolName={event.iconToolName} size="xs" />;
	}
	if (event.kind === 'subagent') {
		return <ToolIcon toolName="Task" size="xs" />;
	}
	if (event.kind === 'progress') {
		return <ToolIcon toolName={event.iconToolName ?? 'Bash'} size="xs" animated />;
	}
	return null;
}

function isBashToolEvent(event: SpaceTaskThreadEvent): boolean {
	return event.kind === 'tool' && event.iconToolName === 'Bash';
}

function isReadToolEvent(event: SpaceTaskThreadEvent): boolean {
	return event.kind === 'tool' && event.iconToolName === 'Read';
}

function isGrepToolEvent(event: SpaceTaskThreadEvent): boolean {
	return event.kind === 'tool' && event.iconToolName === 'Grep';
}

function isGlobToolEvent(event: SpaceTaskThreadEvent): boolean {
	return event.kind === 'tool' && event.iconToolName === 'Glob';
}

function isTodoToolEvent(event: SpaceTaskThreadEvent): boolean {
	return event.kind === 'tool' && event.iconToolName === 'TodoWrite';
}

function renderEventTitle(event: SpaceTaskThreadEvent) {
	if (isGlobToolEvent(event)) {
		const sepToken = ': ';
		const sep = event.title.indexOf(sepToken);
		if (sep !== -1) {
			return (
				<>
					{event.title.slice(0, sep + sepToken.length)}
					<span class="text-pink-300 truncate min-w-0 flex-1 overflow-hidden normal-case tracking-normal font-sans">
						{event.title.slice(sep + sepToken.length)}
					</span>
				</>
			);
		}
	}
	if (isBashToolEvent(event) || isReadToolEvent(event) || isGrepToolEvent(event)) {
		const sepToken = ': ';
		const sep = event.title.indexOf(sepToken);
		if (sep !== -1) {
			const detailClass = cn(
				'truncate min-w-0 flex-1 overflow-hidden normal-case tracking-normal font-sans',
				isBashToolEvent(event)
					? 'text-gray-100'
					: isReadToolEvent(event)
						? (getToolColors('Read').lightText ?? getToolColors('Read').text)
						: (getToolColors('Grep').lightText ?? getToolColors('Grep').text)
			);
			return (
				<>
					{event.title.slice(0, sep + sepToken.length)}
					<span class={detailClass}>{event.title.slice(sep + sepToken.length)}</span>
				</>
			);
		}
	}
	return event.title;
}

function renderEventSummary(event: SpaceTaskThreadEvent) {
	if (isBashToolEvent(event)) {
		return (
			<span>
				<span class="text-emerald-400">$ </span>
				{event.summary}
			</span>
		);
	}
	return event.summary;
}

function CompactTodoList({ todos }: { todos: TodoItem[] }) {
	return (
		<div class="space-y-0.5">
			{todos.map((todo, idx) => {
				const isCompleted = todo.status === 'completed';
				const isInProgress = todo.status === 'in_progress';
				return (
					<div key={idx} class="flex items-center gap-1.5">
						<span class="flex-shrink-0 text-[13px] leading-none">
							{isCompleted ? (
								<span class="text-green-400">&#10003;</span>
							) : isInProgress ? (
								<span class="text-blue-400">&#9679;</span>
							) : (
								<span class="text-gray-500">&#9675;</span>
							)}
						</span>
						<span
							class={cn('text-[13px] leading-snug', isCompleted && 'text-gray-500 line-through')}
						>
							{todo.content}
						</span>
					</div>
				);
			})}
		</div>
	);
}

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
	maps,
	showAgentLabel = true,
}: SpaceTaskThreadEventRowProps) {
	const isBash = isBashToolEvent(event);
	const isTodo = isTodoToolEvent(event);
	const todoProgress =
		isTodo && event.todos && event.todos.length > 0
			? `${event.todos.filter((todo) => todo.status === 'completed').length}/${event.todos.length}`
			: null;

	if (mode === 'compact' && event.kind === 'user' && event.message) {
		// Synthetic messages render their own flex justify-end wrapper; skip outer alignment wrapper
		// to avoid double-nesting that causes visual skew in the space task pane.
		if ((event.message as { isSynthetic?: boolean }).isSynthetic) {
			return (
				<div data-testid="space-task-event-row">
					<SDKMessageRenderer
						message={event.message}
						sessionId={event.sessionId ?? undefined}
						toolResultsMap={maps.toolResultsMap}
						toolInputsMap={maps.toolInputsMap}
						subagentMessagesMap={maps.subagentMessagesMap}
						sessionInfo={maps.sessionInfoMap.get((event.message as { uuid?: string }).uuid ?? '')}
						taskContext={true}
					/>
				</div>
			);
		}
		return (
			<div class="flex justify-end py-1" data-testid="space-task-event-row">
				<div class="max-w-full">
					<SDKMessageRenderer
						message={event.message}
						sessionId={event.sessionId ?? undefined}
						toolResultsMap={maps.toolResultsMap}
						toolInputsMap={maps.toolInputsMap}
						subagentMessagesMap={maps.subagentMessagesMap}
						sessionInfo={maps.sessionInfoMap.get((event.message as { uuid?: string }).uuid ?? '')}
						taskContext={true}
					/>
				</div>
			</div>
		);
	}

	if (mode === 'compact' && event.kind === 'text' && event.message) {
		const agentColor = getAgentColor(event.label);
		return (
			<div class="py-px" data-testid="space-task-event-row">
				<div class="border-l-2 pl-3.5 pr-1 py-1.5" style={{ borderColor: agentColor }}>
					<div class="max-w-full">
						<SDKMessageRenderer
							message={event.message}
							sessionId={event.sessionId ?? undefined}
							toolResultsMap={maps.toolResultsMap}
							toolInputsMap={maps.toolInputsMap}
							subagentMessagesMap={maps.subagentMessagesMap}
							sessionInfo={maps.sessionInfoMap.get((event.message as { uuid?: string }).uuid ?? '')}
							taskContext={true}
						/>
					</div>
				</div>
			</div>
		);
	}

	if (mode === 'compact') {
		const agentColor = getAgentColor(event.label);
		const eventIcon = getEventIcon(event);
		return (
			<div class="py-px" data-testid="space-task-event-row">
				<div
					class={cn('border-l-2 pl-3.5 pr-1 py-1.5 space-y-1')}
					style={{ borderColor: agentColor }}
				>
					<div class="flex items-center gap-2 min-w-0 overflow-hidden">
						{showAgentLabel && (
							<span
								class="text-[11px] uppercase tracking-[0.12em] font-medium font-mono"
								style={{ color: agentColor }}
							>
								{shortAgentLabel(event.label)}
							</span>
						)}
						<span
							class={cn(
								'text-[11px] uppercase tracking-[0.12em] font-medium font-mono flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden',
								getEventTitleClass(event)
							)}
						>
							{eventIcon ?? <span class="text-[10px] leading-none">●</span>}
							{renderEventTitle(event)}
						</span>
						{todoProgress && (
							<span class="ml-auto flex-shrink-0 text-[11px] font-mono text-gray-500">
								{todoProgress}
							</span>
						)}
					</div>
					{event.summary && (
						<div
							class={cn(
								isBash
									? 'text-[13px] leading-snug whitespace-pre-wrap break-words font-mono rounded border border-slate-700/80 bg-black/45 py-1 pl-1 mr-2 text-emerald-300'
									: 'text-[13px] leading-snug whitespace-pre-wrap break-words font-mono',
								!isBash && !isTodo && getEventBodyClass(event)
							)}
						>
							{isTodo && event.todos ? (
								<CompactTodoList todos={event.todos} />
							) : (
								renderEventSummary(event)
							)}
						</div>
					)}
				</div>

				{showTaskTitle && <div class="mt-1 text-[11px] text-gray-500">{event.taskTitle}</div>}
			</div>
		);
	}

	return (
		<div
			class={cn('min-w-0', mode === 'compact' ? 'px-1 py-1.5' : 'px-1 py-1')}
			data-testid="space-task-event-row"
		>
			<div class="flex items-start gap-2">
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2 min-w-0">
						<span class="text-[10px] uppercase tracking-[0.14em] text-gray-500">{event.label}</span>
						<span class={cn('text-xs font-medium min-w-0 truncate', KIND_STYLES[event.kind])}>
							{event.title}
						</span>
						{todoProgress && (
							<span class="ml-auto flex-shrink-0 text-[10px] text-gray-500">{todoProgress}</span>
						)}
					</div>
					{event.summary && (
						<div
							class={cn(
								isBash
									? 'mt-0.5 text-sm leading-snug whitespace-pre-wrap break-words font-mono rounded border border-slate-700/80 bg-black/45 py-1 pl-1 mr-2 text-emerald-300'
									: 'mt-0.5 text-sm leading-snug whitespace-pre-wrap break-words',
								!isBash && !isTodo && getEventBodyClass(event)
							)}
						>
							{isTodo && event.todos ? (
								<CompactTodoList todos={event.todos} />
							) : (
								renderEventSummary(event)
							)}
						</div>
					)}
					{showTaskTitle && <div class="mt-0.5 text-[11px] text-gray-500">{event.taskTitle}</div>}
				</div>
				<span class="flex-shrink-0 text-[10px] text-gray-600">
					{formatTimestamp(event.createdAt)}
				</span>
			</div>
		</div>
	);
}
