/**
 * SpaceTaskPane Component
 *
 * Full-width task detail view for the Space layout.
 * Shows task details, status, and human input area when needed.
 * Displayed as the full content area (replacing the tab view) when a task is selected.
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceAgent, navigateToSpaceSession } from '../../lib/router';
import { cn } from '../../lib/utils';
import type {
	SpaceTask,
	SpaceTaskStatus,
	SpaceTaskPriority,
	SpaceTaskActivityMember,
	SpaceTaskActivityState,
} from '@neokai/shared';
import { WorkflowCanvas } from './WorkflowCanvas';
import { ReadonlySessionChat } from '../room/ReadonlySessionChat';

interface SpaceTaskPaneProps {
	taskId: string | null;
	/** Space ID — required to enable "View Agent Session" navigation */
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

const STATUS_DOT_CLASSES: Record<SpaceTaskStatus, string> = {
	draft: 'bg-gray-500',
	pending: 'bg-gray-400',
	in_progress: 'bg-blue-400',
	review: 'bg-purple-400',
	completed: 'bg-green-400',
	needs_attention: 'bg-yellow-400',
	cancelled: 'bg-gray-600',
	archived: 'bg-gray-700',
	rate_limited: 'bg-orange-400',
	usage_limited: 'bg-orange-500',
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

function SectionCard({
	title,
	children,
	tone = 'default',
}: {
	title: string;
	children: ComponentChildren;
	tone?: 'default' | 'error' | 'warning';
}) {
	const toneClasses =
		tone === 'error'
			? 'border-red-800/40 bg-red-950/20'
			: tone === 'warning'
				? 'border-yellow-800/40 bg-yellow-950/10'
				: 'border-dark-700 bg-dark-900/60';
	return (
		<section class={cn('rounded-2xl border px-4 py-4', toneClasses)}>
			<h3
				class={cn(
					'text-xs font-semibold uppercase tracking-wider mb-2',
					tone === 'error' ? 'text-red-400' : tone === 'warning' ? 'text-yellow-300' : 'text-gray-500'
				)}
			>
				{title}
			</h3>
			{children}
		</section>
	);
}

function MetaCard({
	label,
	value,
	helper,
	accent,
}: {
	label: string;
	value: string;
	helper?: string;
	accent: string;
}) {
	return (
		<div class="rounded-xl border border-dark-700 bg-dark-900/80 px-3 py-3">
			<div class="flex items-center justify-between gap-3">
				<p class="text-[11px] uppercase tracking-[0.18em] text-gray-600">{label}</p>
				<span class={cn('h-2.5 w-2.5 rounded-full flex-shrink-0', accent)} />
			</div>
			<p class="mt-2 text-sm font-medium text-gray-100">{value}</p>
			{helper && <p class="mt-1 text-xs text-gray-500">{helper}</p>}
		</div>
	);
}

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

function formatAgentLabel(value: string): string {
	return value
		.split(/[_-\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
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

function formatTaskThreadError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes('No handler for method: space.task.ensureAgentSession')) {
		return 'Task thread startup is unavailable on the current daemon. Restart the app server to load the latest task-agent RPC handlers.';
	}
	if (message.includes('Task Agent session not started')) {
		return 'Task thread is still starting. Try sending again in a moment.';
	}
	return message || 'Failed to update task thread';
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
	const workflows = spaceStore.workflows.value;
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
		if (task.taskAgentSessionId) return;
		if (task.status === 'archived' || task.status === 'cancelled' || task.status === 'completed')
			return;

		let cancelled = false;
		setEnsuringThread(true);
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
				if (!cancelled) setEnsuringThread(false);
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
	const agentActionLabel =
		task.activeSession === 'leader'
			? 'View Leader Session'
			: task.activeSession === 'worker'
				? 'View Worker Session'
				: agentSessionId
					? 'View Agent Session'
					: 'Open Space Agent';
	const workflowLabel = task.workflowRunId ? 'Workflow Step' : 'Standalone Task';
	const humanHandoffPending = task.status === 'in_progress' && !!task.inputDraft && !agentSessionId;
	const normalizedDescription = normalizeNarrative(task.description);
	const normalizedTaskCurrentStep = normalizeNarrative(task.currentStep);
	const currentStepMatchesDescription =
		!!normalizedTaskCurrentStep &&
		!!normalizedDescription &&
		(normalizedTaskCurrentStep === normalizedDescription ||
			normalizedTaskCurrentStep.includes(normalizedDescription) ||
			normalizedDescription.includes(normalizedTaskCurrentStep));
	const taskCurrentStep =
		task.currentStep && !currentStepMatchesDescription && !isInstructionalStep(task.currentStep)
			? task.currentStep
			: null;
	const liveActivityStep =
		activityRows.find(
			(member) =>
				!!member.currentStep &&
				(member.state === 'active' ||
					member.state === 'waiting_for_input' ||
					member.state === 'failed' ||
					member.state === 'interrupted')
		)?.currentStep ?? null;
	const taskAgentActivity = activityRows.find((member) => member.kind === 'task_agent') ?? activityRows[0] ?? null;
	const activityStatusCopy = taskAgentActivity
		? `${taskAgentActivity.label} is ${ACTIVITY_STATE_LABELS[taskAgentActivity.state].toLowerCase()}.`
		: null;
	const memberStepRows = activityRows.filter(
		(member) =>
			!!member.currentStep &&
			(member.state === 'active' ||
				member.state === 'waiting_for_input' ||
				member.state === 'failed' ||
				member.state === 'interrupted')
	);
	const hasMemberStepRows = memberStepRows.length > 0;
	const visibleCurrentStep = humanHandoffPending
		? 'Your response was saved. Open the space agent to continue the conversation while this task resumes.'
		: !hasMemberStepRows
			? liveActivityStep ?? taskCurrentStep
			: null;
	const attentionCopy =
		task.status === 'needs_attention'
			? 'This task is blocked on human input.'
			: humanHandoffPending
				? 'Your response was sent. Waiting for agent follow-up.'
				: activityStatusCopy || visibleCurrentStep || 'Agent activity will surface here as the task advances.';
	const workflowRun = task.workflowRunId
		? (workflowRuns.find((run) => run.id === task.workflowRunId) ?? null)
		: null;
	const workflow =
		(workflowRun
			? workflows.find((item) => item.id === workflowRun.workflowId)
			: undefined) ??
		(task.workflowNodeId
			? workflows.find((item) => item.nodes.some((node) => node.id === task.workflowNodeId))
			: undefined) ??
		null;
	const workflowNode = task.workflowNodeId
		? (workflow?.nodes.find((node) => node.id === task.workflowNodeId) ?? null)
		: null;
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
	const liveActorLabel =
		task.activeSession === 'leader'
			? 'Leader agent'
			: task.activeSession === 'worker'
				? 'Worker agent'
				: agentSessionId
					? 'Task agent'
					: 'Space agent';
	const activityHeadline =
		task.status === 'needs_attention'
			? 'Waiting on your input'
			: task.status === 'in_progress'
				? task.activeSession
					? `${liveActorLabel} is working`
					: humanHandoffPending
						? 'Waiting for agent follow-up'
						: 'The task is in progress'
				: task.status === 'review'
					? 'Review is ready'
					: task.status === 'completed'
						? 'The task is complete'
						: task.status === 'pending'
							? 'The task is queued'
							: task.status === 'cancelled'
								? 'This task was cancelled'
								: task.status === 'rate_limited' || task.status === 'usage_limited'
									? 'The task is blocked by limits'
									: 'The task needs attention';
	const workflowCanvasId = workflow?.id ?? null;
	const liveTaskAgent = activityRows.find((member) => member.kind === 'task_agent') ?? null;
	const isTerminalTask =
		task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived';
	const showAgentActivitySection = !isTerminalTask && activityRows.length > 0;
	const activityIssue =
		task.error ??
		activityRows.find((member) => member.state === 'failed' || member.state === 'interrupted')?.error ??
		null;
	const isTaskReadOnly = isTerminalTask;
	const showInlineComposer = !!agentSessionId && !isTaskReadOnly;
	const showThreadStartupHint = !agentSessionId;
	const canSendThreadMessage =
		!!task &&
		!!runtimeSpaceId &&
		!!agentSessionId &&
		!isTaskReadOnly &&
		!ensuringThread &&
		!sendingThread;
	const showHeaderSessionAction = !!runtimeSpaceId && (!!agentSessionId || !isTerminalTask);

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
		if (!task || task.status !== 'completed') return;
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
			{/* Header */}
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
						<p class="mt-1 text-sm text-gray-300">{activityHeadline}</p>
						<p class="mt-1 text-sm text-gray-500">{attentionCopy}</p>
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

			{/* Body */}
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-5xl mx-auto px-4 py-5 space-y-4">
					<SectionCard title="Task Thread">
						<div class="mb-3 flex flex-wrap items-center gap-2">
							<InfoBadge label={`Assigned: ${assignedAgentLabel}`} />
							{task.workflowRunId && workflowRun && (
								<InfoBadge
									label={`Run: ${workflowRun.title}`}
									className="border-cyan-700/50 bg-cyan-950/20 text-cyan-300"
								/>
							)}
							{liveTaskAgent && (
								<InfoBadge
									label={`Live: ${liveTaskAgent.label}`}
									className="border-blue-700/50 bg-blue-950/20 text-blue-300"
								/>
							)}
						</div>

						<div class="rounded-xl border border-dark-700 bg-dark-900/70 overflow-hidden">
							{agentSessionId ? (
								<div class="h-[24rem] min-h-[20rem]">
									<ReadonlySessionChat sessionId={agentSessionId} />
								</div>
							) : (
								<div class="px-4 py-10 text-center">
									<p class="text-sm text-gray-300">
										{ensuringThread
											? 'Starting task thread...'
											: 'Task thread is not available yet.'}
									</p>
									<p class="mt-2 text-xs text-gray-500">
										{ensuringThread
											? 'Connecting a dedicated Task Agent session so you can chat here.'
											: 'Keep this view open and the thread will appear once the Task Agent session starts.'}
									</p>
								</div>
							)}
						</div>

						{showInlineComposer && (
							<form onSubmit={handleThreadSend} class="mt-3 space-y-3">
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
									placeholder={
										ensuringThread
											? 'Starting task thread...'
											: 'Message the task agent (Enter to send, Shift+Enter for newline)'
									}
									disabled={sendingThread}
									class="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100
										placeholder-gray-600 focus:outline-none focus:border-blue-600 resize-none disabled:opacity-60"
								/>
								<div class="flex items-center justify-between gap-3">
									<p class="text-xs text-gray-500">Messages sent here go directly to the task agent.</p>
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

						{showThreadStartupHint && (
							<p class="mt-3 text-xs text-gray-500">
								Waiting for task thread before messages can be sent.
							</p>
						)}

						{isTaskReadOnly && (
							<div class="mt-3 flex flex-wrap items-center gap-3">
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

						{runtimeSpaceId && agentSessionId && (
							<div class="mt-3">
								<button
									type="button"
									onClick={() => navigateToSpaceSession(runtimeSpaceId, agentSessionId)}
									class="px-3 py-1.5 text-xs font-medium bg-dark-800 hover:bg-dark-700 text-gray-200 rounded-lg border border-dark-600 transition-colors"
								>
									View Full Session
								</button>
							</div>
						)}

						{threadSendError && (
							<p class="mt-3 text-xs text-red-400 border border-red-800/50 bg-red-950/20 rounded-md px-3 py-2">
								{threadSendError}
							</p>
						)}
					</SectionCard>

					{showAgentActivitySection && (
						<SectionCard title="Agent Activity">
							<div class="flex flex-wrap gap-2">
								{activityRows.map((member) => (
									<InfoBadge
										key={member.id}
										label={`${member.label}: ${ACTIVITY_STATE_LABELS[member.state]}`}
										className={ACTIVITY_STATE_BADGE_CLASSES[member.state]}
									/>
								))}
							</div>
							{hasMemberStepRows && (
								<div class="mt-3 space-y-2">
									{memberStepRows.map((member) => (
										<p key={`${member.id}-step`} class="text-sm text-gray-400">
											<span class="text-gray-500">{member.label}:</span> {member.currentStep}
										</p>
									))}
								</div>
							)}
							{activityIssue && (
								<p class="mt-3 text-xs text-red-300 border border-red-800/40 bg-red-950/20 rounded-md px-3 py-2">
									{activityIssue}
								</p>
							)}
							{visibleCurrentStep && (
								<p class="mt-3 text-sm text-gray-400">{visibleCurrentStep}</p>
							)}
						</SectionCard>
					)}

					{/* Workflow context */}
					{task.workflowRunId && (
						<SectionCard title="Workflow Context">
							<div class="grid gap-3 md:grid-cols-3">
								<MetaCard
									label="Workflow"
									value={workflow?.name ?? 'Workflow unavailable'}
									helper={
										workflow
											? `${workflow.nodes.length} node${workflow.nodes.length === 1 ? '' : 's'} in this flow`
											: 'Task was created by a workflow run'
									}
									accent="bg-cyan-400"
								/>
								<MetaCard
									label="Run"
									value={workflowRun?.title ?? 'Run unavailable'}
									helper={
										workflowRun
											? `${workflowRun.status.replace('_', ' ')} · ${workflowRun.iterationCount}/${workflowRun.maxIterations} loops`
											: 'Run data is no longer available'
									}
									accent="bg-blue-400"
								/>
								<MetaCard
									label="Current Node"
									value={workflowNode?.name ?? 'Workflow step'}
									helper={
										task.workflowNodeId
											? `Node ${task.workflowNodeId.slice(0, 8)}`
											: 'No node identifier attached to this task'
									}
									accent="bg-violet-400"
								/>
							</div>

							{workflowCanvasId && (
								<div class="mt-4 rounded-2xl border border-dark-700 overflow-hidden" data-testid="task-workflow-canvas">
									<div class="border-b border-dark-700 bg-dark-900/80 px-4 py-3">
										<p class="text-[11px] uppercase tracking-[0.18em] text-gray-500">
											{workflowRun ? 'Live workflow view' : 'Workflow map'}
										</p>
										<p class="mt-1 text-sm text-gray-300">
											{workflowRun
												? 'This task sits inside a running workflow. The canvas shows the surrounding execution path.'
												: 'This task came from a workflow. The canvas shows the underlying structure.'}
										</p>
									</div>
									<WorkflowCanvas
										workflowId={workflowCanvasId}
										runId={workflowRun?.id ?? null}
										spaceId={runtimeSpaceId}
										class="h-[24rem] min-h-[22rem]"
									/>
								</div>
							)}
						</SectionCard>
					)}

					<SectionCard title="Task Details">
						<div class="space-y-3 text-sm text-gray-300">
							{task.inputDraft && (
								<div class="rounded-lg border border-yellow-800/40 bg-yellow-950/10 px-3 py-2">
									<p class="text-[11px] uppercase tracking-[0.16em] text-yellow-300">Latest Human Direction</p>
									<p class="mt-1 leading-relaxed whitespace-pre-wrap text-yellow-100/90">{task.inputDraft}</p>
								</div>
							)}
							{task.description && <p class="leading-relaxed whitespace-pre-wrap">{task.description}</p>}
							{task.progress != null && task.progress > 0 && (
								<div>
									<div class="flex items-center justify-between mb-1">
										<span class="text-xs text-gray-500">Progress</span>
										<span class="text-xs text-gray-500">{task.progress}%</span>
									</div>
									<div class="w-full bg-dark-700 rounded-full h-1.5">
										<div
											class="bg-blue-500 h-1.5 rounded-full transition-all"
											style={{ width: `${task.progress}%` }}
										/>
									</div>
								</div>
							)}
							{task.result && (
								<div>
									<p class="text-xs uppercase tracking-[0.16em] text-gray-500 mb-1">Result</p>
									<p class="leading-relaxed whitespace-pre-wrap">{task.result}</p>
								</div>
							)}
							{task.error && (
								<div class="text-red-300 border border-red-800/40 bg-red-950/20 rounded-md px-3 py-2 whitespace-pre-wrap">
									{task.error}
								</div>
							)}
							{task.prUrl && (
								<a
									href={task.prUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
								>
									{task.prNumber ? `PR #${task.prNumber}` : 'Pull Request'}
								</a>
							)}
						</div>
					</SectionCard>
				</div>
			</div>
		</div>
	);
}
