import { cn } from '../../../lib/utils';
import type { SpaceTaskThreadEvent, SpaceTaskThreadRenderMode } from './space-task-thread-events';
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

function getEventTitleClass(event: SpaceTaskThreadEvent): string {
	if (event.kind === 'thinking') return getToolColors('Thinking').iconColor;
	if (event.kind === 'tool' && event.iconToolName)
		return getToolColors(event.iconToolName).iconColor;
	if (event.kind === 'subagent') return getToolColors('Task').iconColor;
	if (event.kind === 'progress' && event.iconToolName)
		return getToolColors(event.iconToolName).iconColor;
	return KIND_STYLES[event.kind];
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
	if (mode === 'compact' && event.kind === 'user' && event.message) {
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
		return (
			<div class="py-1" data-testid="space-task-event-row">
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

	if (mode === 'compact') {
		const agentColor = getAgentColor(event.label);
		const eventIcon = getEventIcon(event);
		return (
			<div class="py-px" data-testid="space-task-event-row">
				<div
					class={cn('border-l-2 pl-3.5 pr-1 py-1.5 space-y-1')}
					style={{ borderColor: agentColor }}
				>
					<div class="flex items-center gap-2 min-w-0">
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
								'text-[11px] uppercase tracking-[0.12em] font-medium font-mono inline-flex items-center gap-1.5',
								getEventTitleClass(event)
							)}
						>
							{eventIcon ?? <span class="text-[10px] leading-none">●</span>}
							{event.title}
						</span>
					</div>
					<div
						class={cn(
							'text-[13px] leading-snug whitespace-pre-wrap break-words font-mono',
							BODY_STYLES[event.kind]
						)}
					>
						{event.summary}
					</div>
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
						<span class={cn('text-xs font-medium', KIND_STYLES[event.kind])}>{event.title}</span>
					</div>
					<div class="mt-0.5 text-sm text-gray-300 leading-snug whitespace-normal break-words">
						{event.summary}
					</div>
					{showTaskTitle && <div class="mt-0.5 text-[11px] text-gray-500">{event.taskTitle}</div>}
				</div>
				<span class="flex-shrink-0 text-[10px] text-gray-600">
					{formatTimestamp(event.createdAt)}
				</span>
			</div>
		</div>
	);
}
