import { useEffect, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceAgent } from '../../lib/router';
import { spaceOverlaySessionIdSignal, spaceOverlayAgentNameSignal } from '../../lib/signals';
import type {
	SpaceTaskActivityMember,
	SpaceTaskActivityState,
	SpaceTaskPriority,
	SpaceTaskStatus,
} from '@neokai/shared';
import { cn } from '../../lib/utils';
import { SpaceTaskUnifiedThread } from './SpaceTaskUnifiedThread';
import { TaskArtifactsPanel } from './TaskArtifactsPanel';
import { getTransitionActions } from './TaskStatusActions';
import { ThreadedChatComposer } from './ThreadedChatComposer';
import { ReadOnlyWorkflowCanvas } from './ReadOnlyWorkflowCanvas';
import { Dropdown, type DropdownMenuItem } from '../ui/Dropdown';

interface SpaceTaskPaneProps {
	taskId: string | null;
	spaceId?: string;
	onClose?: () => void;
}

const STATUS_LABELS: Record<SpaceTaskStatus, string> = {
	open: 'Open',
	in_progress: 'In Progress',
	review: 'Awaiting Review',
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
	const [activeView, setActiveView] = useState<'thread' | 'canvas' | 'artifacts'>('thread');

	useEffect(() => {
		setThreadSendError(null);
		setActiveView('thread');
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
	const hasUnifiedWorkflowThread =
		!!task.workflowRunId || !!agentSessionId || activityMembers.length > 0;
	const showInlineComposer = !isTerminalTask;
	const canSendThreadMessage = !isTerminalTask && !ensuringThread && !sendingThread;
	const showHeaderSessionAction = !!runtimeSpaceId && (!!agentSessionId || !isTerminalTask);
	const canShowCanvasTab = !!task.workflowRunId && !!canvasWorkflowId;
	const canShowArtifactsTab = !!task.workflowRunId;
	const activitySummary = STATUS_LABELS[task.status];
	const transitionActions = getTransitionActions(task.status);
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
			setActiveView('thread');
			return;
		}
		if (activeView === 'artifacts' && !canShowArtifactsTab) {
			setActiveView('thread');
		}
	}, [activeView, canShowCanvasTab, canShowArtifactsTab]);

	const handleNodeClick = (_nodeId: string, _nodeName: string, _agentSlotNames: string[]) => {
		// Resolve agent display names from the store using the workflow node’s agent IDs.
		// nodeExecution is often absent; resolve via the agent store instead.
		const workflowNode = workflow?.nodes.find((n) => n.id === _nodeId);
		const agentDisplayNames = workflowNode
			? workflowNode.agents
					.map((sa) => spaceStore.agents.value.find((a) => a.id === sa.agentId)?.name)
					.filter((n): n is string => !!n)
			: [];

		// Exact-match against activity member labels (same data source as the “Agents” buttons).
		// For multi-agent nodes, returns the first matching member.
		const nodeMember = activityMembers.find(
			(m) => m.kind === 'node_agent' && agentDisplayNames.includes(m.label)
		);
		if (nodeMember) {
			spaceOverlayAgentNameSignal.value = nodeMember.label;
			spaceOverlaySessionIdSignal.value = nodeMember.sessionId;
			return;
		}

		// Fall back to the task agent session (coordinator/leader)
		const taskAgentMember = activityMembers.find((m) => m.kind === 'task_agent');
		if (taskAgentMember) {
			spaceOverlayAgentNameSignal.value = taskAgentMember.label;
			spaceOverlaySessionIdSignal.value = taskAgentMember.sessionId;
			return;
		}

		// Last resort: use the task’s own agentSessionId
		if (agentSessionId) {
			spaceOverlayAgentNameSignal.value = agentActionLabel;
			spaceOverlaySessionIdSignal.value = agentSessionId;
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

	const handleTaskAgentAction = () => {
		if (!runtimeSpaceId) return;
		if (agentSessionId) {
			spaceOverlayAgentNameSignal.value = agentActionLabel;
			spaceOverlaySessionIdSignal.value = agentSessionId;
			return;
		}
		navigateToSpaceAgent(runtimeSpaceId);
	};

	const taskActionItems: DropdownMenuItem[] = [];
	if (showHeaderSessionAction) {
		taskActionItems.push({
			label: agentActionLabel,
			onClick: handleTaskAgentAction,
		});
	}
	if (activityMembers.length > 0) {
		if (taskActionItems.length > 0) {
			taskActionItems.push({ type: 'divider' });
		}
		taskActionItems.push(
			...activityMembers.map((member) => ({
				label: `Open ${member.label} (${ACTIVITY_STATE_LABELS[member.state]})`,
				onClick: () => {
					spaceOverlayAgentNameSignal.value = member.label;
					spaceOverlaySessionIdSignal.value = member.sessionId;
				},
			}))
		);
	}
	if (transitionActions.length > 0) {
		if (taskActionItems.length > 0) {
			taskActionItems.push({ type: 'divider' });
		}
		taskActionItems.push(
			...transitionActions.map(({ target, label }) => ({
				label,
				onClick: () => {
					void handleStatusTransition(target);
				},
				disabled: statusTransitioning,
			}))
		);
	}

	return (
		<div class="flex flex-col h-full overflow-hidden bg-dark-900">
			<div class="px-4 py-3 flex-shrink-0">
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
						<h2 class="text-sm sm:text-lg font-semibold text-gray-100 min-w-0 truncate">
							{task.title}
						</h2>
						<div class="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-400">
							<span data-testid="task-status-label">{activitySummary}</span>
							{task.priority !== 'normal' && (
								<span class="text-xs uppercase tracking-[0.12em] text-gray-500">
									{PRIORITY_LABELS[task.priority]} Priority
								</span>
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
									class="flex-shrink-0 p-1.5 text-gray-400 hover:text-gray-200 transition-colors"
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

			<div class="flex-1 min-h-0 overflow-hidden relative">
				<div class="absolute top-3 right-4 z-20 flex items-center gap-1 rounded-3xl border border-dark-700 bg-dark-800/60 p-1 backdrop-blur-sm">
					<button
						type="button"
						onClick={() => setActiveView('thread')}
						class={cn(
							'px-2.5 py-1 text-xs font-medium rounded-2xl transition-all',
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
									setActiveView('thread');
									return;
								}
								spaceStore.ensureNodeExecutions().catch(() => {});
								setActiveView('canvas');
							}}
							class={cn(
								'px-2.5 py-1 text-xs font-medium rounded-2xl transition-all',
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
								setActiveView((view) => (view === 'artifacts' ? 'thread' : 'artifacts'))
							}
							class={cn(
								'px-2.5 py-1 text-xs font-medium rounded-2xl transition-all',
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
						onClose={() => setActiveView('thread')}
						class="h-full"
					/>
				) : (
					<div class="h-full flex flex-col relative">
						{task.status === 'blocked' && task.result && (
							<div
								class="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2"
								data-testid="task-blocked-banner"
							>
								<p class="text-xs font-medium text-amber-300">Blocked</p>
								<p class="mt-0.5 text-sm text-amber-200/90">{task.result}</p>
							</div>
						)}
						<div class="flex-1 min-h-0" data-testid="task-thread-panel">
							{hasUnifiedWorkflowThread ? (
								<SpaceTaskUnifiedThread
									taskId={task.id}
									bottomInsetClass={showInlineComposer ? 'pb-16' : 'pb-3'}
								/>
							) : (
								<div class="h-full px-4 py-10 text-center">
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
							)}
						</div>

						{showInlineComposer && (
							<div class="absolute bottom-0 left-0 right-0 z-10">
								<ThreadedChatComposer
									mentionCandidates={mentionCandidates}
									hasTaskAgentSession={!!agentSessionId}
									canSend={canSendThreadMessage}
									isSending={sendingThread}
									errorMessage={threadSendError}
									onSend={sendThreadMessage}
								/>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
