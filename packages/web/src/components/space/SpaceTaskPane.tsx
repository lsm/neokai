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

const ACTIVITY_STATE_DOT_CLASSES: Record<SpaceTaskActivityState, string> = {
	active: 'bg-blue-400',
	queued: 'bg-gray-400',
	idle: 'bg-gray-600',
	waiting_for_input: 'bg-yellow-400',
	completed: 'bg-green-400',
	failed: 'bg-red-400',
	interrupted: 'bg-orange-400',
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

function ActivityStateBadge({ state }: { state: SpaceTaskActivityState }) {
	return (
		<InfoBadge label={ACTIVITY_STATE_LABELS[state]} className={ACTIVITY_STATE_BADGE_CLASSES[state]} />
	);
}

function describeActivityMember(member: SpaceTaskActivityMember): string {
	if (member.error) return member.error;
	if (member.state === 'active') {
		return member.currentStep
			? member.currentStep
			: member.processingPhase
				? `${member.label} is ${member.processingPhase}.`
				: `${member.label} is working.`;
	}
	if (member.state === 'waiting_for_input') {
		return member.currentStep || 'Waiting for a human response before continuing.';
	}
	if (member.state === 'completed') {
		return member.completionSummary || member.currentStep || 'Finished its assigned work.';
	}
	if (member.state === 'failed' || member.state === 'interrupted') {
		return member.currentStep || 'This agent needs attention before it can continue.';
	}
	if (member.state === 'queued') {
		return member.currentStep || 'Queued to run when capacity is available.';
	}
	return member.currentStep || 'Idle right now.';
}

// ============================================================================
// Human Input
// ============================================================================

interface HumanInputAreaProps {
	task: SpaceTask;
}

function HumanInputArea({ task }: HumanInputAreaProps) {
	const [inputText, setInputText] = useState(task.inputDraft ?? '');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		if (!inputText.trim()) return;

		try {
			setSubmitting(true);
			setError(null);
			// Persist the draft first so it is never lost even if the status transition fails
			await spaceStore.updateTask(task.id, { inputDraft: inputText.trim() });
			// Then attempt to resume the task — the server validates the transition
			await spaceStore.updateTask(task.id, { status: 'in_progress' });
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to submit response');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div class="mt-4 border border-yellow-800/50 rounded-lg p-4 bg-yellow-900/10">
			<h3 class="text-sm font-medium text-yellow-300 mb-2">Human Input Required</h3>
			<p class="text-xs text-gray-400 mb-3">
				This task needs your attention before it can continue.
			</p>
			{error && (
				<div class="mb-3 text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded px-3 py-2">
					{error}
				</div>
			)}
			<form onSubmit={handleSubmit} class="space-y-3">
				<textarea
					value={inputText}
					onInput={(e) => setInputText((e.target as HTMLTextAreaElement).value)}
					placeholder="Type your response or approval..."
					rows={3}
					class="w-full bg-dark-800 border border-dark-600 rounded-md px-3 py-2 text-gray-100
						placeholder-gray-600 focus:outline-none focus:border-yellow-600 resize-none text-sm"
				/>
				<button
					type="submit"
					disabled={submitting || !inputText.trim()}
					class="px-4 py-1.5 text-xs font-medium bg-yellow-700 hover:bg-yellow-600
						text-yellow-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{submitting ? 'Submitting...' : 'Submit Response'}
				</button>
			</form>
		</div>
	);
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
	const tasksByRun = spaceStore.tasksByRun.value;

	if (!taskId) {
		return (
			<div class="flex items-center justify-center h-full p-6">
				<p class="text-sm text-gray-600 text-center">Select a task to view details</p>
			</div>
		);
	}

	const task = tasks.find((t) => t.id === taskId);

	if (!task) {
		return (
			<div class="flex items-center justify-center h-full p-6">
				<p class="text-sm text-gray-600 text-center">Task not found</p>
			</div>
		);
	}

	const agentSessionId = task.taskAgentSessionId;
	const activityRows = spaceStore.taskActivity.value.get(task.id) ?? [];
	const runtimeSpaceId = spaceId ?? task.spaceId;
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
	const visibleCurrentStep = humanHandoffPending
		? 'Your response was saved. Open the space agent to continue the conversation while this task resumes.'
		: task.currentStep;
	const attentionCopy =
		task.status === 'needs_attention'
			? 'This task is blocked on human input.'
			: humanHandoffPending
				? 'Your response was sent. Waiting for agent follow-up.'
			: task.currentStep || 'Agent activity will surface here as the task advances.';
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
	const threadLabel = agentSessionId ? 'Task agent thread' : 'Space agent thread';
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
	const activityDetail =
		task.error && task.status !== 'needs_attention'
			? task.error
			: visibleCurrentStep ||
				(task.status === 'completed'
					? task.completionSummary || task.result || 'The agent finished this task.'
					: task.status === 'review'
						? task.completionSummary || 'An agent is waiting for your review.'
						: task.status === 'pending'
							? 'This task has not started yet.'
							: `Use the ${threadLabel.toLowerCase()} to steer the next step.`);
	const relatedWorkflowTasks = task.workflowRunId
		? [...(tasksByRun.get(task.workflowRunId) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
		: [];
	const workflowCanvasId = workflow?.id ?? null;
	const compactRelatedTasks = task.workflowRunId
		? relatedWorkflowTasks.map((relatedTask) => {
				const relatedNode =
					relatedTask.workflowNodeId && workflow
						? (workflow.nodes.find((node) => node.id === relatedTask.workflowNodeId) ?? null)
						: null;
				const relatedCustomAgent = relatedTask.customAgentId
					? (agents.find((agent) => agent.id === relatedTask.customAgentId) ?? null)
					: null;
				return {
					task: relatedTask,
					agentLabel: relatedCustomAgent?.name
						? relatedCustomAgent.name
						: relatedTask.agentName
							? formatAgentLabel(relatedTask.agentName)
							: relatedNode?.name || formatAgentLabel(relatedTask.assignedAgent ?? 'coder'),
					summary:
						relatedTask.currentStep ||
						relatedTask.completionSummary ||
						relatedTask.error ||
						(relatedTask.activeSession
							? `${formatAgentLabel(relatedTask.activeSession)} agent is active`
							: STATUS_LABELS[relatedTask.status]),
				};
			})
		: [];
	const liveTaskAgent = activityRows.find((member) => member.kind === 'task_agent') ?? null;

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
						<p class="mt-1 text-sm text-gray-500">{attentionCopy}</p>
					</div>
					{runtimeSpaceId && (
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
					<div class="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
						<SectionCard title="What&apos;s Happening" tone={task.status === 'needs_attention' ? 'warning' : 'default'}>
							<p class="text-base font-medium text-gray-100">{activityHeadline}</p>
							<p class="mt-2 text-sm leading-relaxed text-gray-400">{activityDetail}</p>
							<div class="mt-4 flex flex-wrap gap-2">
								<InfoBadge label={`Assigned: ${assignedAgentLabel}`} />
								<InfoBadge label={`Thread: ${threadLabel}`} />
								{task.activeSession && (
									<InfoBadge
										label={`Live: ${liveActorLabel}`}
										className="border-blue-700/50 bg-blue-950/20 text-blue-300"
									/>
								)}
								{task.workflowRunId && workflowRun && (
									<InfoBadge
										label={`Run: ${workflowRun.title}`}
										className="border-cyan-700/50 bg-cyan-950/20 text-cyan-300"
									/>
								)}
							</div>
						</SectionCard>

						<SectionCard title="Task Agent" tone={humanHandoffPending ? 'warning' : 'default'}>
							<p class="text-sm text-gray-300">
								{liveTaskAgent || agentSessionId
									? 'Open the linked task thread to direct the agent, answer follow-up questions, or inspect the latest result.'
									: 'This task does not have its own live agent thread yet. Use the shared space agent to steer the work and get updates.'}
							</p>
							<div class="mt-4 grid gap-3">
								<div class="rounded-xl border border-dark-700 bg-dark-900/70 px-3 py-3">
									<p class="text-[11px] uppercase tracking-[0.18em] text-gray-500">Current Control Point</p>
									<p class="mt-2 text-sm text-gray-100">
										{liveTaskAgent || agentSessionId ? 'Linked task agent' : 'Shared space agent'}
									</p>
									<p class="mt-1 text-xs text-gray-500">
										{task.status === 'needs_attention'
											? 'Answer the open question here, then continue in the agent thread if more direction is needed.'
											: humanHandoffPending
												? 'Your last response is saved below. Open the agent thread if you want to keep driving the task.'
												: 'Use the agent thread when you want to redirect execution, ask for an update, or inspect results.'}
									</p>
								</div>
							</div>
						</SectionCard>
					</div>

					<SectionCard title="Agent Activity">
						{activityRows.length > 0 ? (
							<div class="space-y-2">
								{activityRows.map((member) => (
									<div
										key={member.id}
										class="flex items-start gap-3 rounded-xl border border-dark-700 bg-dark-900/70 px-3 py-3"
									>
										<span
											class={cn(
												'mt-1 h-2.5 w-2.5 rounded-full flex-shrink-0',
												ACTIVITY_STATE_DOT_CLASSES[member.state]
											)}
										/>
										<div class="min-w-0 flex-1">
											<div class="flex flex-wrap items-center gap-2">
												<p class="text-sm font-medium text-gray-100">{member.label}</p>
												{member.kind === 'task_agent' && (
													<InfoBadge
														label="Task Agent"
														className="border-violet-700/50 bg-violet-950/20 text-violet-300"
													/>
												)}
												{member.taskId === task.id && (
													<InfoBadge
														label="Current Task"
														className="border-blue-700/50 bg-blue-950/20 text-blue-300"
													/>
												)}
												<ActivityStateBadge state={member.state} />
											</div>
											<p class="mt-1 text-sm text-gray-300 truncate">
												{member.taskTitle ?? task.title}
											</p>
											<p class="mt-1 text-xs text-gray-500">{describeActivityMember(member)}</p>
										</div>
										<div class="text-right flex-shrink-0">
											<p class="text-[11px] uppercase tracking-[0.16em] text-gray-600">Messages</p>
											<p class="mt-1 text-sm text-gray-300">{member.messageCount}</p>
											{member.processingPhase && member.state === 'active' && (
												<p class="mt-1 text-[11px] text-blue-300 uppercase tracking-[0.16em]">
													{member.processingPhase}
												</p>
											)}
										</div>
									</div>
								))}
							</div>
						) : compactRelatedTasks.length > 0 ? (
							<div class="space-y-2">
								{compactRelatedTasks.map(({ task: relatedTask, agentLabel, summary }) => (
									<div
										key={relatedTask.id}
										class="flex items-start gap-3 rounded-xl border border-dark-700 bg-dark-900/70 px-3 py-3"
									>
										<span
											class={cn(
												'mt-1 h-2.5 w-2.5 rounded-full flex-shrink-0',
												relatedTask.id === task.id
													? 'bg-blue-400'
													: STATUS_DOT_CLASSES[relatedTask.status]
											)}
										/>
										<div class="min-w-0 flex-1">
											<div class="flex flex-wrap items-center gap-2">
												<p class="text-sm font-medium text-gray-100">{agentLabel}</p>
												{relatedTask.id === task.id && (
													<InfoBadge
														label="Current Task"
														className="border-blue-700/50 bg-blue-950/20 text-blue-300"
													/>
												)}
												<StatusBadge status={relatedTask.status} />
											</div>
											<p class="mt-1 text-sm text-gray-300 truncate">{relatedTask.title}</p>
											<p class="mt-1 text-xs text-gray-500">{summary}</p>
										</div>
									</div>
								))}
							</div>
						) : (
							<div class="rounded-xl border border-dark-700 bg-dark-900/70 px-4 py-4">
								<p class="text-sm font-medium text-gray-100">No live agent roster yet</p>
								<p class="mt-2 text-sm text-gray-400">
									{task.status === 'needs_attention'
										? 'The agent is waiting for your answer before it can continue.'
										: task.activeSession
											? `${liveActorLabel} is actively producing work for this task.`
											: agentSessionId
												? 'This task has a dedicated agent thread, but no agent is actively speaking right now.'
												: 'There is no dedicated task-agent session yet, so the shared space agent is your main control surface.'}
								</p>
								{visibleCurrentStep && (
									<p class="mt-3 text-xs text-gray-500">
										<span class="text-gray-400">Latest signal:</span> {visibleCurrentStep}
									</p>
								)}
							</div>
						)}
					</SectionCard>

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

					{task.inputDraft && task.status !== 'needs_attention' && (
						<SectionCard title="Latest Human Handoff" tone={humanHandoffPending ? 'warning' : 'default'}>
							<p class="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{task.inputDraft}</p>
							<p class="mt-3 text-xs text-gray-500">
								{humanHandoffPending
									? 'Your response has been saved. Continue in the space agent if you want to steer the next step.'
									: 'Most recent human input saved on this task.'}
							</p>
						</SectionCard>
					)}

					{/* Description */}
					{task.description && (
						<SectionCard title="Description">
							<p class="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
								{task.description}
							</p>
						</SectionCard>
					)}

					{/* Progress */}
					{task.progress != null && task.progress > 0 && (
						<SectionCard title="Progress">
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
						</SectionCard>
					)}

					{/* Result */}
					{task.result && (
						<SectionCard title="Result">
							<p class="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{task.result}</p>
						</SectionCard>
					)}

					{/* Error */}
					{task.error && (
						<SectionCard title="Error" tone="error">
							<p class="text-sm text-red-400 leading-relaxed whitespace-pre-wrap">{task.error}</p>
						</SectionCard>
					)}

					{/* PR link */}
					{task.prUrl && (
						<SectionCard title="Pull Request">
							<div class="flex items-center gap-2">
								<a
									href={task.prUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
								>
									{task.prNumber ? `PR #${task.prNumber}` : 'Pull Request'}
								</a>
							</div>
						</SectionCard>
					)}

					{/* Human input area */}
					{task.status === 'needs_attention' && <HumanInputArea task={task} />}
				</div>
			</div>
		</div>
	);
}
