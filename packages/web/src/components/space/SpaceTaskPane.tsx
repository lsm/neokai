/**
 * SpaceTaskPane Component
 *
 * Full-width task detail view for the Space layout.
 * Shows task details, status, and human input area when needed.
 * Displayed as the full content area (replacing the tab view) when a task is selected.
 */

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceSession } from '../../lib/router';
import { cn } from '../../lib/utils';
import type { SpaceTask, SpaceTaskStatus, SpaceTaskPriority } from '@neokai/shared';
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
	const tasks = spaceStore.tasks.value;
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
	const runtimeSpaceId = spaceId ?? task.spaceId;
	const agentSessionLabel =
		task.activeSession === 'leader'
			? 'View Leader Session'
			: task.activeSession === 'worker'
				? 'View Worker Session'
				: 'View Agent Session';
	const workflowLabel = task.workflowRunId ? 'Workflow Step' : 'Standalone Task';
	const attentionCopy =
		task.status === 'needs_attention'
			? 'This task is blocked on human input.'
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
	const relatedWorkflowTasks = task.workflowRunId
		? [...(tasksByRun.get(task.workflowRunId) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
		: [];
	const workflowCanvasId = workflow?.id ?? null;

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
							<span class="rounded-full border border-dark-700 bg-dark-950 px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-gray-500">
								{workflowLabel}
							</span>
							<StatusBadge status={task.status} />
						</div>
						<h2 class="mt-3 text-lg font-semibold text-gray-100 min-w-0 truncate">{task.title}</h2>
						<p class="mt-1 text-sm text-gray-500">{attentionCopy}</p>
					</div>
					{agentSessionId && runtimeSpaceId && (
						<button
							type="button"
							onClick={() => navigateToSpaceSession(runtimeSpaceId, agentSessionId)}
							class="flex-shrink-0 px-3 py-1.5 text-xs font-medium bg-dark-800 hover:bg-dark-700
								text-gray-300 rounded-lg border border-dark-600 transition-colors"
							data-testid="view-agent-session-btn"
						>
							{agentSessionLabel}
						</button>
					)}
				</div>
			</div>

			{/* Body */}
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-5xl mx-auto px-4 py-5 space-y-4">
					<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
						<MetaCard
							label="Priority"
							value={`${PRIORITY_LABELS[task.priority]} priority`}
							helper={task.taskType ? `${task.taskType} task` : 'Execution priority'}
							accent={
								task.priority === 'urgent'
									? 'bg-red-400'
									: task.priority === 'high'
										? 'bg-orange-400'
										: task.priority === 'low'
											? 'bg-gray-500'
											: 'bg-blue-400'
							}
						/>
						<MetaCard
							label="Status"
							value={STATUS_LABELS[task.status]}
							helper={
								task.status === 'needs_attention'
									? 'Waiting on human input'
									: task.status === 'review'
										? 'Ready for review'
										: 'Current execution state'
							}
							accent={
								task.status === 'completed'
									? 'bg-green-400'
									: task.status === 'needs_attention' || task.status === 'review'
										? 'bg-yellow-400'
										: task.status === 'in_progress'
											? 'bg-blue-400'
											: 'bg-gray-500'
							}
						/>
						<MetaCard
							label="Session"
							value={task.activeSession ? `${task.activeSession} agent` : 'Shared agent thread'}
							helper={agentSessionId ? 'Deep-dive available in agent session' : 'No linked agent session'}
							accent={agentSessionId ? 'bg-violet-400' : 'bg-gray-500'}
						/>
						<MetaCard
							label="Source"
							value={task.workflowRunId ? 'Workflow-generated' : 'Standalone task'}
							helper={
								task.workflowNodeId ? `Node ${task.workflowNodeId.slice(0, 8)}` : 'Manual task scope'
							}
							accent={task.workflowRunId ? 'bg-cyan-400' : 'bg-emerald-400'}
						/>
					</div>

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

							{relatedWorkflowTasks.length > 0 && (
								<div class="mt-4">
									<div class="flex items-center justify-between gap-3">
										<h4 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
											Workflow Tasks
										</h4>
										<span class="text-xs text-gray-600">
											{relatedWorkflowTasks.length} task
											{relatedWorkflowTasks.length === 1 ? '' : 's'} in this run
										</span>
									</div>
								<div class="mt-2 space-y-2">
										{relatedWorkflowTasks.map((relatedTask) => (
											<div
												key={relatedTask.id}
												class="flex items-center gap-3 rounded-xl border border-dark-700 bg-dark-900/70 px-3 py-2.5"
											>
												<span
													class={cn(
														'h-2.5 w-2.5 rounded-full flex-shrink-0',
														relatedTask.id === task.id
															? 'bg-blue-400'
															: STATUS_DOT_CLASSES[relatedTask.status]
													)}
												/>
												<div class="min-w-0 flex-1">
													<p class="truncate text-sm text-gray-200">{relatedTask.title}</p>
													<p class="mt-0.5 text-xs text-gray-500">
														{relatedTask.workflowNodeId
															? `Node ${relatedTask.workflowNodeId.slice(0, 8)}`
															: 'Workflow-generated task'}
													</p>
												</div>
												<div class="flex items-center gap-2">
													{relatedTask.id === task.id && (
														<span class="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.16em] text-blue-200">
															Current
														</span>
													)}
													<StatusBadge status={relatedTask.status} />
												</div>
											</div>
										))}
									</div>
								</div>
							)}
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

					{/* Current step */}
					{task.currentStep && (
						<SectionCard title="Current Step" tone={task.status === 'needs_attention' ? 'warning' : 'default'}>
							<p class="text-xs text-gray-400">{task.currentStep}</p>
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
