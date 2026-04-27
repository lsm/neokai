import type {
	SpaceTaskActivityMember,
	SpaceTaskActivityState,
	SpaceTaskPriority,
	SpaceTaskStatus,
} from '@neokai/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { borderColors } from '../../lib/design-tokens';
import { navigateToSpaceTask, pushOverlayHistory } from '../../lib/router';
import { currentSpaceIdSignal, currentSpaceTaskViewTabSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { resolveActiveTaskBanner } from '../../lib/task-banner.ts';
import { cn } from '../../lib/utils';
import { Dropdown, type DropdownMenuItem } from '../ui/Dropdown';
import { PendingGateBanner } from './PendingGateBanner';
import { PendingPostApprovalBanner } from './PendingPostApprovalBanner';
import { PendingTaskCompletionBanner } from './PendingTaskCompletionBanner';
import { ReadOnlyWorkflowCanvas } from './ReadOnlyWorkflowCanvas';
import { SpaceTaskUnifiedThread } from './SpaceTaskUnifiedThread';
import { SubmitForReviewModal } from './SubmitForReviewModal';
import { TaskArtifactsPanel } from './TaskArtifactsPanel';
import { TaskBlockedBanner } from './TaskBlockedBanner';
import { TaskSessionChatComposer } from './TaskSessionChatComposer';
import { getTransitionActions } from './TaskStatusActions';
import { useRunGateSummaries } from './use-run-gate-summaries.ts';

interface SpaceTaskPaneProps {
	taskId: string | null;
	spaceId?: string;
	onClose?: () => void;
}

const STATUS_LABELS: Record<SpaceTaskStatus, string> = {
	open: 'Open',
	in_progress: 'In Progress',
	review: 'Awaiting Review',
	// `approved` is the post-approval staging status: tasks land here when an
	// agent calls `approve_task`, then the PostApprovalRouter dispatches the
	// follow-up (auto-merge, human gate, or no-route → `done`).
	approved: 'Approved',
	done: 'Done',
	blocked: 'Blocked',
	cancelled: 'Cancelled',
	archived: 'Archived',
};

const PRIORITY_LABELS: Record<SpaceTaskPriority, string> = {
	low: 'Low',
	normal: 'Normal',
	high: 'High',
	urgent: 'Urgent',
};

const ACTIVITY_STATE_LABELS: Record<SpaceTaskActivityState, string> = {
	active: 'Active',
	queued: 'Queued',
	idle: 'Idle',
	waiting_for_input: 'Waiting',
	completed: 'Done',
	failed: 'Failed',
	interrupted: 'Interrupted',
};

const STATUS_BADGE_CLASSES: Record<SpaceTaskStatus, string> = {
	open: 'border-gray-500/30 bg-gray-500/10 text-gray-300',
	in_progress: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
	review: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
	approved: 'border-green-500/30 bg-green-500/10 text-green-300',
	done: 'border-green-500/25 bg-green-500/10 text-green-400',
	blocked: 'border-red-500/30 bg-red-500/10 text-red-300',
	cancelled: 'border-gray-500/25 bg-gray-500/10 text-gray-500',
	archived: 'border-gray-500/25 bg-gray-500/10 text-gray-500',
};

const PRIORITY_BADGE_CLASSES: Record<SpaceTaskPriority, string> = {
	low: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
	normal: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
	high: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
	urgent: 'border-red-500/30 bg-red-500/10 text-red-300',
};

function TaskMetaBadge({
	children,
	class: className,
}: {
	children: ComponentChildren;
	class?: string;
}) {
	return (
		<span
			class={cn(
				'inline-flex h-6 max-w-[8.5rem] items-center rounded-md border px-2 text-[11px] font-medium leading-none whitespace-nowrap',
				className
			)}
		>
			<span class="truncate">{children}</span>
		</span>
	);
}

function formatTaskThreadError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes('No handler for method: space.task.ensureAgentSession')) {
		return 'Task thread startup is unavailable on this daemon. Restart the app server to load the latest RPC handlers.';
	}
	if (message.includes('Task Agent session not started')) {
		return 'Task thread is still starting. Try sending again in a moment.';
	}
	if (message.includes('Session not found')) {
		return 'Task thread points to a stale session. Keep this pane open while it reconnects.';
	}
	return message || 'Failed to update task thread';
}

export function SpaceTaskPane({ taskId, spaceId, onClose }: SpaceTaskPaneProps) {
	// Lazy-load agents/workflows needed for mention autocomplete and canvas
	useEffect(() => {
		spaceStore.ensureConfigData().catch(() => {});
	}, [spaceId]);

	const tasks = spaceStore.tasks.value;
	const task = taskId ? (tasks.find((t) => t.id === taskId) ?? null) : null;
	const activityMembers: SpaceTaskActivityMember[] = taskId
		? (spaceStore.taskActivity.value.get(taskId) ?? [])
		: [];

	const [threadSessionId, setThreadSessionId] = useState<string | null>(null);
	const [ensuringThread, setEnsuringThread] = useState(false);
	const [threadSendError, setThreadSendError] = useState<string | null>(null);
	const [sendingThread, setSendingThread] = useState(false);
	const [statusTransitioning, setStatusTransitioning] = useState(false);
	const [showSubmitForReviewModal, setShowSubmitForReviewModal] = useState(false);
	// Modal-local error feedback. Separate from `threadSendError` because
	// `threadSendError` is rendered inside `TaskSessionChatComposer`, which is
	// only mounted when the inline composer is visible. A failed submit-for-
	// review RPC needs to surface inside the modal regardless of composer
	// visibility — see `SubmitForReviewModalProps.error`.
	const [submitForReviewError, setSubmitForReviewError] = useState<string | null>(null);
	const activeView = currentSpaceTaskViewTabSignal.value;

	useEffect(() => {
		setThreadSendError(null);
	}, [taskId]);

	useEffect(() => {
		if (!taskId) return;
		spaceStore.subscribeTaskActivity(taskId).catch(() => {
			// Ignore subscription errors — activity list is best-effort
		});
		return () => {
			spaceStore.unsubscribeTaskActivity(taskId);
		};
	}, [taskId]);

	useEffect(() => {
		if (!task) {
			setThreadSessionId(null);
			return;
		}
		setThreadSessionId(task.taskAgentSessionId ?? null);
	}, [task?.id, task?.taskAgentSessionId]);

	// Resolve runId/workflowId here (before the early returns) so the gate-status
	// hook is always called — React's Rules of Hooks require a stable call order.
	const _runId = task?.workflowRunId ?? null;
	const _workflowRunForHook = _runId
		? (spaceStore.workflowRuns.value.find((r) => r.id === _runId) ?? null)
		: null;
	const _workflowIdForHook = _workflowRunForHook?.workflowId ?? null;
	const { summaries: gateSummaries } = useRunGateSummaries(_runId, _workflowIdForHook);

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
	const navigationSpaceId = spaceId ?? currentSpaceIdSignal.value ?? task.spaceId;
	const agentSessionId = task.taskAgentSessionId ?? threadSessionId;

	// Resolve workflowId from the active run for canvas mode
	const workflowRun = task.workflowRunId
		? (spaceStore.workflowRuns.value.find((r) => r.id === task.workflowRunId) ?? null)
		: null;
	const canvasWorkflowId = workflowRun?.workflowId ?? null;

	// Scope @mention autocomplete to workflow agents only (no agents for non-workflow tasks)
	const workflow = canvasWorkflowId
		? (spaceStore.workflows.value.find((w) => w.id === canvasWorkflowId) ?? null)
		: null;
	const workflowAgentIds = workflow
		? new Set(workflow.nodes.flatMap((n) => n.agents.map((a) => a.agentId)))
		: null;
	const mentionCandidates =
		workflowAgentIds !== null
			? spaceStore.agents.value.filter((a) => workflowAgentIds.has(a.id))
			: [];

	const isTerminalTask =
		task.status === 'done' || task.status === 'cancelled' || task.status === 'archived';

	// Per-agent activity. Each member that's currently executing (not idle /
	// completed / failed / interrupted) contributes its label to the active set.
	// The thread feed keys the live rail off this set so that, in multi-session
	// workflows, every still-running agent's trailing non-terminal block renders
	// its own active rail — a single boolean would collapse incorrectly when one
	// agent's terminal result row lands after another agent's last visible row.
	//
	// `useMemo` keeps the `Set` reference stable between renders when the
	// activity-members snapshot hasn't changed, so descendants that diff
	// `activeAgentLabels` by identity (or use it as a hook dependency) don't
	// see spurious churn on every re-render of the pane.
	//
	// Aggregate boolean is still useful for UI bits that ask "is anything
	// running?" (the chat composer's processing indicator), so derive it from
	// the set rather than recomputing from `activityMembers`.
	const activeAgentLabels = useMemo(() => {
		const labels = new Set<string>();
		for (const m of activityMembers) {
			if (m.state === 'active' || m.state === 'queued' || m.state === 'waiting_for_input') {
				labels.add(m.label);
			}
		}
		return labels;
	}, [activityMembers]);
	const isAgentActive = activeAgentLabels.size > 0;
	const hasUnifiedWorkflowThread =
		!!task.workflowRunId || !!agentSessionId || activityMembers.length > 0;
	const showInlineComposer = !isTerminalTask;
	const canSendThreadMessage = !isTerminalTask && !ensuringThread && !sendingThread;
	const canShowCanvasTab = !!task.workflowRunId && !!canvasWorkflowId;
	const canShowArtifactsTab = !!task.workflowRunId;
	const activitySummary = STATUS_LABELS[task.status];
	const showHeaderStatusBadge = task.status !== 'review';
	const agentActionLabel =
		task.activeSession === 'leader'
			? 'View Leader Session'
			: task.activeSession === 'worker'
				? 'View Worker Session'
				: agentSessionId
					? 'View Agent Session'
					: 'Open Space Agent';

	useEffect(() => {
		if (activeView === 'canvas' && !canShowCanvasTab) {
			navigateToSpaceTask(navigationSpaceId, taskId, 'thread');
			return;
		}
		if (activeView === 'artifacts' && !canShowArtifactsTab) {
			navigateToSpaceTask(navigationSpaceId, taskId, 'thread');
		}
	}, [activeView, canShowCanvasTab, canShowArtifactsTab]);

	const handleNodeClick = (_nodeId: string, _nodeName: string, _agentSlotNames: string[]) => {
		// Match against activity member roles (slot names like “reviewer”, “coder”).
		// m.role is the agent slot name stored in the DB and directly corresponds to _agentSlotNames.
		// For multi-agent nodes, returns the first matching member.
		const nodeMember = activityMembers.find(
			(m) => m.kind === 'node_agent' && _agentSlotNames.includes(m.role)
		);
		if (nodeMember) {
			pushOverlayHistory(nodeMember.sessionId, nodeMember.label);
			return;
		}

		// Fall back to the task agent session (coordinator/leader)
		const taskAgentMember = activityMembers.find((m) => m.kind === 'task_agent');
		if (taskAgentMember) {
			pushOverlayHistory(taskAgentMember.sessionId, taskAgentMember.label);
			return;
		}

		// Last resort: use the task’s own agentSessionId
		if (agentSessionId) {
			pushOverlayHistory(agentSessionId, agentActionLabel);
		}
	};

	const sendThreadMessage = async (nextMessage: string): Promise<boolean> => {
		if (!nextMessage) return false;
		if (!runtimeSpaceId || !task) return false;

		try {
			setSendingThread(true);
			setThreadSendError(null);

			if (!agentSessionId) {
				setEnsuringThread(true);
				const ensured = await spaceStore.ensureTaskAgentSession(task.id);
				setThreadSessionId(ensured.taskAgentSessionId ?? null);
				setEnsuringThread(false);
			}

			await spaceStore.sendTaskMessage(task.id, nextMessage);
			return true;
		} catch (err) {
			setThreadSendError(formatTaskThreadError(err));
			return false;
		} finally {
			setEnsuringThread(false);
			setSendingThread(false);
		}
	};

	const handleStatusTransition = async (newStatus: SpaceTaskStatus) => {
		// Submitting for review is the human counterpart of the agent
		// `submit_for_approval` tool — it must stamp pending-completion metadata
		// so `PendingTaskCompletionBanner` renders. Open the optional-reason
		// modal instead of issuing a bare status update; the modal calls
		// `spaceStore.submitForReview` on confirm.
		if (newStatus === 'review') {
			setThreadSendError(null);
			setSubmitForReviewError(null);
			setShowSubmitForReviewModal(true);
			return;
		}
		try {
			setStatusTransitioning(true);
			setThreadSendError(null);
			await spaceStore.updateTask(task.id, { status: newStatus });
		} catch (err) {
			setThreadSendError(formatTaskThreadError(err));
		} finally {
			setStatusTransitioning(false);
		}
	};

	const handleSubmitForReviewConfirm = async (reason: string | null) => {
		try {
			setStatusTransitioning(true);
			setSubmitForReviewError(null);
			await spaceStore.submitForReview(task.id, reason);
			setShowSubmitForReviewModal(false);
		} catch (err) {
			// Render the error inside the modal — `threadSendError` is invisible
			// when the inline composer is hidden, which would leave the modal
			// frozen with no feedback after a failed submit.
			setSubmitForReviewError(formatTaskThreadError(err));
		} finally {
			setStatusTransitioning(false);
		}
	};

	const allTransitionActions = getTransitionActions(task.status);
	// Mirrors the filter in `TaskStatusActions`: any task in `review` is
	// "awaiting human approval via a dedicated banner" — the bare review→done /
	// review→cancelled buttons would bypass `PostApprovalRouter` and the
	// approval metadata stamping. Hide them so the only Approve / Cancel path
	// is the banner. Non-approval escape hatches (Reopen, Archive) stay.
	const filteredTransitionActions =
		task.status === 'review' ||
		task.pendingCheckpointType === 'task_completion' ||
		task.pendingCheckpointType === 'gate'
			? allTransitionActions.filter(({ target }) => target !== 'done' && target !== 'cancelled')
			: allTransitionActions;

	const taskActionItems: DropdownMenuItem[] = [];
	if (activityMembers.length > 0) {
		taskActionItems.push(
			...activityMembers.map((member) => ({
				label: `Open ${member.label} (${ACTIVITY_STATE_LABELS[member.state]})`,
				onClick: () => {
					pushOverlayHistory(member.sessionId, member.label);
				},
			}))
		);
	}
	if (filteredTransitionActions.length > 0) {
		if (taskActionItems.length > 0) {
			taskActionItems.push({ type: 'divider' as const });
		}
		taskActionItems.push(
			...filteredTransitionActions.map(({ target, label }) => ({
				label,
				onClick: () => {
					handleStatusTransition(target);
				},
				disabled: statusTransitioning,
				danger: target === 'cancelled' || target === 'archived',
			}))
		);
	}

	return (
		<div class="flex flex-col h-full overflow-hidden bg-dark-900">
			<div
				class={`px-3 sm:px-4 min-h-[65px] flex-shrink-0 bg-dark-850 border-b ${borderColors.ui.default}`}
			>
				<div class="flex min-h-[64px] items-center gap-2 sm:gap-3">
					{onClose && (
						<button
							type="button"
							onClick={onClose}
							class="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-dark-800 hover:text-gray-200 transition-colors flex-shrink-0"
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
					<div class="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
						<h2 class="text-sm sm:text-base font-semibold text-gray-100 min-w-0 leading-5 sm:flex-1 overflow-hidden break-words [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical]">
							{task.title}
						</h2>
						<div class="mt-1 flex items-center gap-1.5 overflow-hidden sm:mt-0 sm:flex-shrink-0">
							{showHeaderStatusBadge && (
								<TaskMetaBadge class={cn(STATUS_BADGE_CLASSES[task.status])}>
									<span data-testid="task-status-label">{activitySummary}</span>
								</TaskMetaBadge>
							)}
							{task.priority === 'low' && (
								<span class="inline-flex h-6 items-center whitespace-nowrap text-[11px] font-medium leading-none text-gray-600">
									Low Priority
								</span>
							)}
							{task.priority !== 'normal' && task.priority !== 'low' && (
								<TaskMetaBadge class={PRIORITY_BADGE_CLASSES[task.priority]}>
									{PRIORITY_LABELS[task.priority]} Priority
								</TaskMetaBadge>
							)}
						</div>
					</div>
					{taskActionItems.length > 0 && (
						<Dropdown
							items={taskActionItems}
							position="right"
							trigger={
								<button
									type="button"
									class="flex-shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-dark-800 hover:text-gray-200 transition-colors"
									data-testid="task-actions-menu-trigger"
									aria-label="Task Actions"
									title="Task Actions"
								>
									<svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
										<circle cx="10" cy="4" r="1.75" />
										<circle cx="10" cy="10" r="1.75" />
										<circle cx="10" cy="16" r="1.75" />
									</svg>
								</button>
							}
						/>
					)}
				</div>
			</div>

			{/* Banner block lives outside the tab content so blocked / pending
			    banners stay visible regardless of which tab the user is on.
			    `resolveActiveTaskBanner` returns null when no banner applies —
			    the wrapping fragment then renders nothing and the block takes
			    zero height. */}
			{(() => {
				// Single-slot precedence renderer — at most one banner is ever
				// shown. Precedence (high → low):
				//   blocked > post_approval_blocked > task_completion_pending > gate_pending
				// The helper captures the rule so it can be unit-tested
				// independently of the render tree.
				const banner = resolveActiveTaskBanner(task, gateSummaries);
				if (!banner) return null;
				const child =
					banner.kind === 'blocked' ? (
						<TaskBlockedBanner
							task={task}
							spaceId={runtimeSpaceId}
							onStatusTransition={handleStatusTransition}
						/>
					) : banner.kind === 'post_approval_blocked' ? (
						<PendingPostApprovalBanner task={task} spaceId={runtimeSpaceId} />
					) : banner.kind === 'task_completion_pending' ? (
						<PendingTaskCompletionBanner task={task} spaceId={runtimeSpaceId} />
					) : (
						// gate_pending — PendingGateBanner renders rows for every
						// waiting gate on the run.
						<PendingGateBanner
							runId={banner.runId}
							spaceId={runtimeSpaceId}
							workflowId={canvasWorkflowId}
						/>
					);
				return (
					<div class="flex-shrink-0" data-testid="task-pane-banner">
						{child}
					</div>
				);
			})()}

			<div class="flex-1 min-h-0 overflow-hidden relative" data-testid="task-pane-content">
				{/* Keep the tab switcher floating above each view without making
				    the full overlay rectangle intercept clicks. */}
				<div
					class="pointer-events-none absolute top-3 left-3 right-3 z-20 flex justify-center"
					data-testid="task-view-tab-pill"
				>
					<div class="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-dark-700 bg-dark-800/75 p-1 shadow-lg shadow-black/10 backdrop-blur-sm">
						<button
							type="button"
							onClick={() => navigateToSpaceTask(navigationSpaceId, taskId, 'thread')}
							class={cn(
								'px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap',
								activeView === 'thread'
									? 'text-gray-100 bg-dark-700/70 shadow-sm'
									: 'text-gray-300/80 hover:text-gray-100 hover:bg-dark-700/40'
							)}
							data-testid="thread-toggle"
							aria-pressed={activeView === 'thread'}
						>
							Thread
						</button>
						{canShowCanvasTab && (
							<button
								type="button"
								onClick={() => {
									if (activeView === 'canvas') {
										navigateToSpaceTask(navigationSpaceId, taskId, 'thread');
										return;
									}
									spaceStore.ensureNodeExecutions().catch(() => {});
									navigateToSpaceTask(navigationSpaceId, taskId, 'canvas');
								}}
								class={cn(
									'px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap',
									activeView === 'canvas'
										? 'text-gray-100 bg-dark-700/70 shadow-sm'
										: 'text-gray-300/80 hover:text-gray-100 hover:bg-dark-700/40'
								)}
								data-testid="canvas-toggle"
								aria-pressed={activeView === 'canvas'}
							>
								Canvas
							</button>
						)}
						{canShowArtifactsTab && (
							<button
								type="button"
								onClick={() =>
									currentSpaceTaskViewTabSignal.value === 'artifacts'
										? navigateToSpaceTask(navigationSpaceId, taskId, 'thread')
										: navigateToSpaceTask(navigationSpaceId, taskId, 'artifacts')
								}
								class={cn(
									'px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap',
									activeView === 'artifacts'
										? 'text-gray-100 bg-dark-700/70 shadow-sm'
										: 'text-gray-300/80 hover:text-gray-100 hover:bg-dark-700/40'
								)}
								data-testid="artifacts-toggle"
								aria-pressed={activeView === 'artifacts'}
							>
								Artifacts
							</button>
						)}
					</div>
				</div>
				{activeView === 'canvas' && task.workflowRunId && canvasWorkflowId ? (
					<div class="h-full" data-testid="canvas-view">
						<ReadOnlyWorkflowCanvas
							workflowId={canvasWorkflowId}
							runId={task.workflowRunId}
							spaceId={spaceId}
							onNodeClick={handleNodeClick}
							class="h-full"
						/>
					</div>
				) : activeView === 'artifacts' && task.workflowRunId ? (
					<TaskArtifactsPanel
						runId={task.workflowRunId}
						taskId={task.id}
						onClose={() => navigateToSpaceTask(navigationSpaceId, taskId, 'thread')}
						class="h-full"
					/>
				) : (
					<div class="h-full flex flex-col relative">
						<div class="flex-1 min-h-0" data-testid="task-thread-panel">
							{hasUnifiedWorkflowThread ? (
								<SpaceTaskUnifiedThread
									taskId={task.id}
									topInsetClass="pt-12"
									bottomInsetClass={
										showInlineComposer
											? threadSendError
												? 'pb-52 sm:pb-44'
												: 'pb-44 sm:pb-36'
											: 'pb-3'
									}
									activeAgentLabels={activeAgentLabels}
								/>
							) : (
								<div class="h-full overflow-y-auto">
									<div class="min-h-[calc(100%+1px)] px-4 py-10 text-center">
										<p class="text-sm text-gray-300">
											{ensuringThread
												? 'Starting task thread...'
												: 'Task thread is not available yet.'}
										</p>
										<p class="mt-2 text-xs text-gray-500">
											{ensuringThread
												? 'Connecting task and node-agent streams.'
												: 'Keep this view open while the task thread starts.'}
										</p>
									</div>
								</div>
							)}
						</div>

						{showInlineComposer && (
							<TaskSessionChatComposer
								sessionId={agentSessionId ?? ''}
								mentionCandidates={mentionCandidates}
								hasTaskAgentSession={!!agentSessionId}
								canSend={canSendThreadMessage}
								isSending={sendingThread}
								isProcessing={isAgentActive}
								errorMessage={threadSendError}
								onSend={sendThreadMessage}
							/>
						)}
					</div>
				)}
			</div>
			<SubmitForReviewModal
				isOpen={showSubmitForReviewModal}
				busy={statusTransitioning}
				onCancel={() => {
					if (!statusTransitioning) setShowSubmitForReviewModal(false);
				}}
				onConfirm={handleSubmitForReviewConfirm}
				error={submitForReviewError}
			/>
		</div>
	);
}
