/**
 * SpaceTaskPane Component
 *
 * Focused task view: one full-size thread surface with live task-agent chat
 * and multi-agent activity in the same panel.
 */

import { useEffect, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceAgent, navigateToSpaceSession } from '../../lib/router';
import { cn } from '../../lib/utils';
import type {
	SpaceTaskActivityMember,
	SpaceTaskActivityState,
	SpaceTaskPriority,
	SpaceTaskStatus,
} from '@neokai/shared';
import { ReadonlySessionChat } from '../room/ReadonlySessionChat';

interface SpaceTaskPaneProps {
	taskId: string | null;
	spaceId?: string;
	onClose?: () => void;
}

const STATUS_LABELS: Record<SpaceTaskStatus, string> = {
	draft: 'Draft',
	pending: 'Pending',
	in_progress: 'In Progress',
	review: 'Review',
	completed: 'Completed',
	needs_attention: 'Needs Attention',
	cancelled: 'Cancelled',
	archived: 'Archived',
	rate_limited: 'Rate Limited',
	usage_limited: 'Usage Limited',
};

const STATUS_CLASSES: Record<SpaceTaskStatus, string> = {
	draft: 'bg-gray-800 text-gray-400 border-gray-700',
	pending: 'bg-gray-800 text-gray-300 border-gray-600',
	in_progress: 'bg-blue-900/30 text-blue-300 border-blue-700/50',
	review: 'bg-purple-900/30 text-purple-300 border-purple-700/50',
	completed: 'bg-green-900/30 text-green-300 border-green-700/50',
	needs_attention: 'bg-yellow-900/30 text-yellow-300 border-yellow-700/50',
	cancelled: 'bg-gray-800 text-gray-500 border-gray-700',
	archived: 'bg-gray-900 text-gray-600 border-gray-800',
	rate_limited: 'bg-orange-900/30 text-orange-300 border-orange-700/50',
	usage_limited: 'bg-orange-900/30 text-orange-400 border-orange-700/50',
};

const PRIORITY_LABELS: Record<SpaceTaskPriority, string> = {
	low: 'Low',
	normal: 'Normal',
	high: 'High',
	urgent: 'Urgent',
};

const PRIORITY_BADGE_CLASSES: Record<SpaceTaskPriority, string> = {
	low: 'border-gray-700 bg-dark-950 text-gray-400',
	normal: 'border-dark-700 bg-dark-950 text-gray-400',
	high: 'border-orange-700/50 bg-orange-950/30 text-orange-300',
	urgent: 'border-red-700/50 bg-red-950/30 text-red-300',
};

const TASK_TYPE_LABELS = {
	planning: 'Planning',
	coding: 'Coding',
	research: 'Research',
	design: 'Design',
	review: 'Review',
} as const;

const ACTIVITY_STATE_LABELS: Record<SpaceTaskActivityState, string> = {
	active: 'Active',
	queued: 'Queued',
	idle: 'Idle',
	waiting_for_input: 'Needs Input',
	completed: 'Completed',
	failed: 'Issue',
	interrupted: 'Interrupted',
};

const ACTIVITY_STATE_BADGE_CLASSES: Record<SpaceTaskActivityState, string> = {
	active: 'border-blue-700/50 bg-blue-950/20 text-blue-300',
	queued: 'border-gray-700 bg-dark-950 text-gray-400',
	idle: 'border-dark-700 bg-dark-950 text-gray-500',
	waiting_for_input: 'border-yellow-700/50 bg-yellow-950/20 text-yellow-300',
	completed: 'border-green-700/50 bg-green-950/20 text-green-300',
	failed: 'border-red-700/50 bg-red-950/20 text-red-300',
	interrupted: 'border-orange-700/50 bg-orange-950/20 text-orange-300',
};

function StatusBadge({ status }: { status: SpaceTaskStatus }) {
	return (
		<span
			class={cn(
				'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border',
				STATUS_CLASSES[status]
			)}
		>
			{STATUS_LABELS[status]}
		</span>
	);
}

function InfoBadge({
	label,
	className = 'border-dark-700 bg-dark-950 text-gray-400',
}: {
	label: string;
	className?: string;
}) {
	return (
		<span
			class={cn(
				'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em]',
				className
			)}
		>
			{label}
		</span>
	);
}

function normalizeNarrative(value: string | null | undefined): string {
	return (value ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

function isInstructionalStep(value: string | null | undefined): boolean {
	const normalized = normalizeNarrative(value);
	if (!normalized) return false;
	return (
		normalized.startsWith('describe ') ||
		normalized.includes('submit your response') ||
		normalized.includes('continue the conversation') ||
		normalized.includes('to continue')
	);
}

function formatAgentLabel(value: string): string {
	return value
		.split(/[_-\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function formatTaskThreadError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes('No handler for method: space.task.ensureAgentSession')) {
		return 'Task thread startup is unavailable on this daemon. Restart the app server to load the latest RPC handlers.';
	}
	if (message.includes('Task Agent session not started')) {
		return 'Task thread is still starting. Try sending again in a moment.';
	}
	return message || 'Failed to update task thread';
}

function buildActivityDetail(member: SpaceTaskActivityMember, taskDescription: string): string | null {
	if (member.error) return member.error;
	if (member.currentStep) {
		const currentStep = normalizeNarrative(member.currentStep);
		if (
			!isInstructionalStep(member.currentStep) &&
			currentStep &&
			currentStep !== normalizeNarrative(taskDescription)
		) {
			return member.currentStep;
		}
	}
	if (member.completionSummary) return member.completionSummary;
	if (member.processingPhase && member.state === 'active') {
		return `${member.label} is ${member.processingPhase}.`;
	}
	if (member.state === 'waiting_for_input') return 'Waiting for human input.';
	if (member.state === 'failed' || member.state === 'interrupted')
		return 'Needs intervention before continuing.';
	if (member.state === 'queued') return 'Queued to run.';
	return null;
}

function statusToActivityState(status: SpaceTaskStatus): SpaceTaskActivityState {
	switch (status) {
		case 'completed':
			return 'completed';
		case 'needs_attention':
			return 'waiting_for_input';
		case 'cancelled':
		case 'archived':
			return 'interrupted';
		case 'review':
			return 'waiting_for_input';
		case 'rate_limited':
		case 'usage_limited':
		case 'pending':
		case 'draft':
			return 'queued';
		default:
			return 'active';
	}
}

export function SpaceTaskPane({ taskId, spaceId, onClose }: SpaceTaskPaneProps) {
	useEffect(() => {
		if (!taskId) return;
		void spaceStore.subscribeTaskActivity(taskId).catch(() => {});
		return () => {
			spaceStore.unsubscribeTaskActivity(taskId);
		};
	}, [taskId]);

	const tasks = spaceStore.tasks.value;
	const agents = spaceStore.agents.value;
	const workflowRuns = spaceStore.workflowRuns.value;
	const task = taskId ? tasks.find((t) => t.id === taskId) ?? null : null;
	const runtimeSpaceIdCandidate = task?.spaceId ?? spaceId;

	const [threadSessionId, setThreadSessionId] = useState<string | null>(null);
	const [ensuringThread, setEnsuringThread] = useState(false);
	const [threadDraft, setThreadDraft] = useState('');
	const [threadSendError, setThreadSendError] = useState<string | null>(null);
	const [sendingThread, setSendingThread] = useState(false);
	const [reopeningTask, setReopeningTask] = useState(false);

	useEffect(() => {
		setThreadSendError(null);
		setThreadDraft('');
	}, [taskId]);

	useEffect(() => {
		if (!task) {
			setThreadSessionId(null);
			return;
		}
		setThreadSessionId(task.taskAgentSessionId ?? null);
	}, [task?.id, task?.taskAgentSessionId]);

	useEffect(() => {
		if (!task || !runtimeSpaceIdCandidate) return;
		if (task.status === 'archived' || task.status === 'cancelled' || task.status === 'completed')
			return;

		let cancelled = false;
		const showSpawnLoading = !task.taskAgentSessionId;
		if (showSpawnLoading) setEnsuringThread(true);
		setThreadSendError(null);

		spaceStore
			.ensureTaskAgentSession(task.id)
			.then((updatedTask) => {
				if (cancelled) return;
				setThreadSessionId(updatedTask.taskAgentSessionId ?? null);
			})
			.catch((err) => {
				if (cancelled) return;
				setThreadSendError(formatTaskThreadError(err));
			})
			.finally(() => {
				if (!cancelled && showSpawnLoading) setEnsuringThread(false);
			});

		return () => {
			cancelled = true;
		};
	}, [task?.id, task?.taskAgentSessionId, task?.status, runtimeSpaceIdCandidate]);

	if (!taskId) {
		return (
			<div class="flex items-center justify-center h-full p-6">
				<p class="text-sm text-gray-600 text-center">Select a task to view details</p>
			</div>
		);
	}

	if (!task) {
		return (
			<div class="flex items-center justify-center h-full p-6">
				<p class="text-sm text-gray-600 text-center">Task not found</p>
			</div>
		);
	}

	const runtimeSpaceId = spaceId ?? task.spaceId;
	const agentSessionId = task.taskAgentSessionId ?? threadSessionId;
	const activityRows = spaceStore.taskActivity.value.get(task.id) ?? [];
	const workflowRun = task.workflowRunId
		? (workflowRuns.find((run) => run.id === task.workflowRunId) ?? null)
		: null;
	const isTerminalTask =
		task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived';
	const showInlineComposer = !!agentSessionId && !isTerminalTask;
	const canSendThreadMessage = !!agentSessionId && !isTerminalTask && !ensuringThread && !sendingThread;
	const showHeaderSessionAction = !!runtimeSpaceId && (!!agentSessionId || !isTerminalTask);
	const taskAgentActivity = activityRows.find((member) => member.kind === 'task_agent') ?? activityRows[0] ?? null;
	const activitySummary = taskAgentActivity
		? `${taskAgentActivity.label} is ${ACTIVITY_STATE_LABELS[taskAgentActivity.state].toLowerCase()}.`
		: task.status === 'needs_attention'
			? 'Waiting on your input.'
			: task.status === 'in_progress'
				? 'Task is running.'
				: STATUS_LABELS[task.status];
	const agentActionLabel =
		task.activeSession === 'leader'
			? 'View Leader Session'
			: task.activeSession === 'worker'
				? 'View Worker Session'
				: agentSessionId
					? 'View Agent Session'
					: 'Open Space Agent';
	const workflowLabel = task.workflowRunId ? 'Workflow Step' : 'Standalone Task';

	const customAgent = task.customAgentId
		? (agents.find((agent) => agent.id === task.customAgentId) ?? null)
		: null;
	const assignedAgentLabel = customAgent?.name
		? customAgent.name
		: task.agentName
			? formatAgentLabel(task.agentName)
			: task.assignedAgent === 'general'
				? 'General Agent'
				: 'Coder Agent';

	const agentTimelineEvents = activityRows
		.map((member) => {
			const detail = buildActivityDetail(member, task.description ?? '');
			return {
				id: member.id,
				label: member.label,
				state: member.state,
				detail,
			};
		})
		.filter((item) => !!item.detail);
	const seenEventDetails = new Set(
		agentTimelineEvents.map((item) => normalizeNarrative(item.detail ?? ''))
	);
	const fallbackTaskStep =
		task.currentStep &&
		!isInstructionalStep(task.currentStep) &&
		normalizeNarrative(task.currentStep) !== normalizeNarrative(task.description)
			? task.currentStep
			: null;
	const fallbackTimelineEvents: Array<{
		id: string;
		label: string;
		state: SpaceTaskActivityState;
		detail: string;
	}> = [];
	if (task.error && !seenEventDetails.has(normalizeNarrative(task.error))) {
		fallbackTimelineEvents.push({
			id: `${task.id}-error`,
			label: 'Task',
			state: 'failed',
			detail: task.error,
		});
	}
	if (task.result && !seenEventDetails.has(normalizeNarrative(task.result))) {
		fallbackTimelineEvents.push({
			id: `${task.id}-result`,
			label: 'Task',
			state: 'completed',
			detail: task.result,
		});
	}
	if (fallbackTaskStep && !seenEventDetails.has(normalizeNarrative(fallbackTaskStep))) {
		fallbackTimelineEvents.push({
			id: `${task.id}-step`,
			label: 'Task',
			state: statusToActivityState(task.status),
			detail: fallbackTaskStep,
		});
	}
	const timelineEvents = [...agentTimelineEvents, ...fallbackTimelineEvents];

	const handleThreadSend = async (e: Event) => {
		e.preventDefault();
		const nextMessage = threadDraft.trim();
		if (!nextMessage) return;
		if (!runtimeSpaceId || !task) return;

		try {
			setSendingThread(true);
			setThreadSendError(null);

			if (!agentSessionId) {
				const ensured = await spaceStore.ensureTaskAgentSession(task.id);
				setThreadSessionId(ensured.taskAgentSessionId ?? null);
			}

			await spaceStore.sendTaskMessage(task.id, nextMessage);
			setThreadDraft('');
		} catch (err) {
			setThreadSendError(formatTaskThreadError(err));
		} finally {
			setSendingThread(false);
		}
	};

	const handleReopenTask = async () => {
		if (task.status !== 'completed') return;
		try {
			setReopeningTask(true);
			setThreadSendError(null);
			await spaceStore.updateTask(task.id, { status: 'in_progress' });
		} catch (err) {
			setThreadSendError(formatTaskThreadError(err));
		} finally {
			setReopeningTask(false);
		}
	};

	return (
		<div class="flex flex-col h-full overflow-hidden bg-dark-950">
			<div class="border-b border-dark-800 bg-dark-900/85 px-4 py-4 flex-shrink-0">
				<div class="flex items-start gap-3">
					{onClose && (
						<button
							type="button"
							onClick={onClose}
							class="mt-1 text-gray-400 hover:text-gray-200 transition-colors flex-shrink-0"
							aria-label="Back"
							data-testid="task-back-button"
						>
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M15 19l-7-7 7-7"
								/>
							</svg>
						</button>
					)}
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<InfoBadge label={workflowLabel} />
							<StatusBadge status={task.status} />
							{task.taskType && <InfoBadge label={TASK_TYPE_LABELS[task.taskType]} />}
							{task.priority !== 'normal' && (
								<InfoBadge
									label={`${PRIORITY_LABELS[task.priority]} Priority`}
									className={PRIORITY_BADGE_CLASSES[task.priority]}
								/>
							)}
						</div>
						<h2 class="mt-3 text-lg font-semibold text-gray-100 min-w-0 truncate">{task.title}</h2>
						<p class="mt-1 text-sm text-gray-400">{activitySummary}</p>
					</div>
					{showHeaderSessionAction && (
						<button
							type="button"
							onClick={() =>
								agentSessionId
									? navigateToSpaceSession(runtimeSpaceId, agentSessionId)
									: navigateToSpaceAgent(runtimeSpaceId)
							}
							class="flex-shrink-0 px-3 py-1.5 text-xs font-medium bg-dark-800 hover:bg-dark-700
								text-gray-300 rounded-lg border border-dark-600 transition-colors"
							data-testid={agentSessionId ? 'view-agent-session-btn' : 'open-space-agent-btn'}
						>
							{agentActionLabel}
						</button>
					)}
				</div>
			</div>

			<div class="flex-1 min-h-0 overflow-hidden px-4 py-4">
				<div class="h-full rounded-2xl border border-dark-700 bg-dark-900/60 overflow-hidden flex flex-col">
					<div class="px-4 py-3 border-b border-dark-700 bg-dark-900/80">
						<div class="flex flex-wrap items-center gap-2">
							<InfoBadge label={`Assigned: ${assignedAgentLabel}`} />
							{workflowRun && (
								<InfoBadge
									label={`Run: ${workflowRun.title}`}
									className="border-cyan-700/50 bg-cyan-950/20 text-cyan-300"
								/>
							)}
							{activityRows.map((member) => (
								<InfoBadge
									key={member.id}
									label={`${member.label}: ${ACTIVITY_STATE_LABELS[member.state]}`}
									className={ACTIVITY_STATE_BADGE_CLASSES[member.state]}
								/>
							))}
						</div>
					</div>

					<div class="flex-1 min-h-0 border-b border-dark-700 bg-dark-900/50">
						{agentSessionId ? (
							<div class="h-full" data-testid="task-thread-panel">
								<ReadonlySessionChat sessionId={agentSessionId} />
							</div>
						) : (
							<div class="h-full px-4 py-10 text-center" data-testid="task-thread-panel">
								<p class="text-sm text-gray-300">
									{ensuringThread ? 'Starting task thread...' : 'Task thread is not available yet.'}
								</p>
								<p class="mt-2 text-xs text-gray-500">
									{ensuringThread
										? 'Connecting a dedicated Task Agent session.'
										: 'Keep this view open while the Task Agent session starts.'}
								</p>
							</div>
						)}
					</div>

					<div class="px-4 py-3 space-y-3 bg-dark-950/60">
						{timelineEvents.length > 0 && (
							<div
								class="max-h-40 overflow-y-auto space-y-2 pr-1"
								data-testid="task-activity-thread"
							>
								{timelineEvents.map((event) => (
									<div
										key={`${event.id}-${event.state}`}
										class="rounded-md border border-dark-700 bg-dark-900/80 px-3 py-2"
									>
										<p class="text-xs uppercase tracking-[0.16em] text-gray-500">
											{event.label} · {ACTIVITY_STATE_LABELS[event.state]}
										</p>
										<p class="mt-1 text-sm text-gray-300 whitespace-pre-wrap">{event.detail}</p>
									</div>
								))}
							</div>
						)}

						{showInlineComposer && (
							<form onSubmit={handleThreadSend} class="space-y-3">
								<textarea
									value={threadDraft}
									onInput={(e) => setThreadDraft((e.target as HTMLTextAreaElement).value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter' && !e.shiftKey) {
											e.preventDefault();
											(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
										}
									}}
									rows={3}
									placeholder="Message the task agent (Enter to send, Shift+Enter for newline)"
									disabled={sendingThread}
									class="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100
										placeholder-gray-600 focus:outline-none focus:border-blue-600 resize-none disabled:opacity-60"
								/>
								<div class="flex items-center justify-between gap-3">
									<p class="text-xs text-gray-500">
										Send direction here. Activity updates from all task agents appear above.
									</p>
									<button
										type="submit"
										disabled={!canSendThreadMessage || !threadDraft.trim()}
										class="px-3 py-1.5 text-xs font-medium bg-blue-700 hover:bg-blue-600 text-blue-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
									>
										{sendingThread ? 'Sending...' : 'Send to Task Agent'}
									</button>
								</div>
							</form>
						)}

						{!agentSessionId && (
							<p class="text-xs text-gray-500">Waiting for task thread before messages can be sent.</p>
						)}

						{isTerminalTask && (
							<div class="flex flex-wrap items-center gap-3">
								<p class="text-xs text-gray-500">This task is read-only in its current state.</p>
								{task.status === 'completed' && (
									<button
										type="button"
										onClick={() => void handleReopenTask()}
										disabled={reopeningTask}
										class="px-3 py-1.5 text-xs font-medium bg-dark-800 hover:bg-dark-700 text-gray-200 rounded-lg border border-dark-600 transition-colors disabled:opacity-50"
									>
										{reopeningTask ? 'Reopening...' : 'Reopen Task'}
									</button>
								)}
							</div>
						)}

						{threadSendError && (
							<p class="text-xs text-red-300 border border-red-800/50 bg-red-950/20 rounded-md px-3 py-2">
								{threadSendError}
							</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
