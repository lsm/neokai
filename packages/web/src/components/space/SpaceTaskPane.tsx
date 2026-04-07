import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceAgent } from '../../lib/router';
import { spaceOverlaySessionIdSignal, spaceOverlayAgentNameSignal } from '../../lib/signals';
import type {
	SpaceTask,
	SpaceTaskActivityMember,
	SpaceTaskActivityState,
	SpaceTaskPriority,
	SpaceTaskStatus,
} from '@neokai/shared';
import { cn } from '../../lib/utils';
import { SpaceTaskUnifiedThread } from './SpaceTaskUnifiedThread';
import { TaskArtifactsPanel } from './TaskArtifactsPanel';
import { TaskStatusActions } from './TaskStatusActions';
import MentionAutocomplete from './MentionAutocomplete';
import { WorkflowCanvas } from './WorkflowCanvas';

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

function activityStateDotClass(state: SpaceTaskActivityState): string {
	switch (state) {
		case 'active':
			return 'bg-green-400 animate-pulse';
		case 'queued':
			return 'bg-amber-400';
		case 'idle':
			return 'bg-gray-500';
		case 'waiting_for_input':
			return 'bg-blue-400';
		case 'completed':
			return 'bg-gray-600';
		case 'failed':
			return 'bg-red-400';
		case 'interrupted':
			return 'bg-yellow-400';
	}
}

function ActivityMemberList({
	members,
	taskId,
}: {
	members: SpaceTaskActivityMember[];
	taskId: string;
}) {
	if (members.length === 0) return null;

	const handleMemberClick = (member: SpaceTaskActivityMember) => {
		spaceOverlayAgentNameSignal.value = member.label;
		spaceOverlaySessionIdSignal.value = member.sessionId;
	};

	return (
		<div
			class="px-4 py-2 border-b border-dark-800"
			data-testid="activity-members-list"
			data-task-id={taskId}
		>
			<p class="text-xs text-gray-500 mb-1.5">Agents</p>
			<div class="flex flex-wrap gap-1.5">
				{members.map((member) => (
					<button
						key={member.id}
						type="button"
						onClick={() => handleMemberClick(member)}
						class="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium bg-dark-800 hover:bg-dark-700 text-gray-300 hover:text-gray-100 transition-colors"
						data-testid="activity-member-item"
						data-member-id={member.id}
						data-member-state={member.state}
						title={`${member.label} — ${ACTIVITY_STATE_LABELS[member.state]}`}
					>
						<span
							class={cn(
								'inline-block w-1.5 h-1.5 rounded-full flex-shrink-0',
								activityStateDotClass(member.state)
							)}
							data-testid="activity-member-state-dot"
						/>
						<span class="truncate max-w-[10rem]">{member.label}</span>
						<span class="text-gray-500 text-[10px]">{ACTIVITY_STATE_LABELS[member.state]}</span>
					</button>
				))}
			</div>
		</div>
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
	const tasks = spaceStore.tasks.value;
	const task = taskId ? (tasks.find((t) => t.id === taskId) ?? null) : null;
	const activityMembers: SpaceTaskActivityMember[] = taskId
		? (spaceStore.taskActivity.value.get(taskId) ?? [])
		: [];

	const [threadSessionId, setThreadSessionId] = useState<string | null>(null);
	const [ensuringThread, setEnsuringThread] = useState(false);
	const [threadDraft, setThreadDraft] = useState('');
	const [threadSendError, setThreadSendError] = useState<string | null>(null);
	const [sendingThread, setSendingThread] = useState(false);
	const [statusTransitioning, setStatusTransitioning] = useState(false);
	const [showArtifacts, setShowArtifacts] = useState(false);
	const [showCanvas, setShowCanvas] = useState(false);
	const [mentionQuery, setMentionQuery] = useState<string | null>(null);
	const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const lastCursorRef = useRef(0);

	const handleThreadDraftInput = useCallback((e: Event) => {
		const target = e.target as HTMLTextAreaElement;
		const value = target.value;
		const cursor = target.selectionStart ?? value.length;
		lastCursorRef.current = cursor;
		setThreadDraft(value);

		// Detect @query at cursor position
		const textBeforeCursor = value.slice(0, cursor);
		const match = textBeforeCursor.match(/@(\w*)$/);
		if (match) {
			setMentionQuery(match[1]);
			setMentionSelectedIndex(0);
		} else {
			setMentionQuery(null);
		}
	}, []);

	const handleMentionSelect = useCallback(
		(name: string) => {
			if (!textareaRef.current) return;
			const textarea = textareaRef.current;
			const cursor = textarea.selectionStart ?? lastCursorRef.current;
			const textBeforeCursor = threadDraft.slice(0, cursor);
			const textAfterCursor = threadDraft.slice(cursor);
			const match = textBeforeCursor.match(/@(\w*)$/);
			if (!match) return;
			const start = cursor - match[0].length;
			const newValue = threadDraft.slice(0, start) + '@' + name + ' ' + textAfterCursor;
			setThreadDraft(newValue);
			setMentionQuery(null);
			setMentionSelectedIndex(0);
			// Re-focus textarea
			setTimeout(() => {
				if (textareaRef.current) {
					const newCursor = start + name.length + 2; // '@' + name + ' '
					textareaRef.current.focus();
					textareaRef.current.setSelectionRange(newCursor, newCursor);
				}
			}, 0);
		},
		[threadDraft]
	);

	const handleMentionClose = useCallback(() => {
		setMentionQuery(null);
		setMentionSelectedIndex(0);
	}, []);

	useEffect(() => {
		setThreadSendError(null);
		setThreadDraft('');
		setShowArtifacts(false);
		setShowCanvas(false);
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
	const mentionAgents =
		mentionQuery !== null && workflowAgentIds !== null
			? spaceStore.agents.value.filter(
					(a) =>
						workflowAgentIds.has(a.id) &&
						a.name.toLowerCase().startsWith(mentionQuery.toLowerCase())
				)
			: [];

	const isTerminalTask =
		task.status === 'done' || task.status === 'cancelled' || task.status === 'archived';
	const hasUnifiedWorkflowThread =
		!!task.workflowRunId || !!agentSessionId || activityMembers.length > 0;
	const showInlineComposer = !isTerminalTask;
	const canSendThreadMessage = !isTerminalTask && !ensuringThread && !sendingThread;
	const showHeaderSessionAction = !!runtimeSpaceId && (!!agentSessionId || !isTerminalTask);
	const activitySummary = STATUS_LABELS[task.status];
	const agentActionLabel =
		task.activeSession === 'leader'
			? 'View Leader Session'
			: task.activeSession === 'worker'
				? 'View Worker Session'
				: agentSessionId
					? 'View Agent Session'
					: 'Open Space Agent';

	const handleNodeClick = (nodeId: string, nodeTasks: SpaceTask[]) => {
		// Find the first task for this node that has an agent session open
		const nodeTask = nodeTasks.find((t) => t.taskAgentSessionId);
		if (nodeTask?.taskAgentSessionId) {
			spaceOverlayAgentNameSignal.value = nodeTask.title ?? `Node ${nodeId}`;
			spaceOverlaySessionIdSignal.value = nodeTask.taskAgentSessionId;
		} else if (agentSessionId) {
			// Fall back to the task agent session
			spaceOverlayAgentNameSignal.value = agentActionLabel;
			spaceOverlaySessionIdSignal.value = agentSessionId;
		}
	};

	const handleThreadSend = async (e: Event) => {
		e.preventDefault();
		const nextMessage = threadDraft.trim();
		if (!nextMessage) return;
		if (!runtimeSpaceId || !task) return;

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
			setThreadDraft('');
		} catch (err) {
			setThreadSendError(formatTaskThreadError(err));
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

	return (
		<div class="flex flex-col h-full overflow-hidden bg-dark-900">
			<div class="px-4 py-3 flex-shrink-0">
				<div class="flex items-start gap-3 border-b border-dark-800 pb-3">
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
						<h2 class="text-lg font-semibold text-gray-100 min-w-0 truncate">{task.title}</h2>
						<div class="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-400">
							<span data-testid="task-status-label">{activitySummary}</span>
							{task.priority !== 'normal' && (
								<span class="text-xs uppercase tracking-[0.12em] text-gray-500">
									{PRIORITY_LABELS[task.priority]} Priority
								</span>
							)}
						</div>
					</div>
					{task.workflowRunId && canvasWorkflowId && (
						<button
							type="button"
							onClick={() => {
								setShowCanvas((v) => !v);
								setShowArtifacts(false);
							}}
							class={cn(
								'flex-shrink-0 px-2 py-1 text-xs font-medium transition-colors',
								showCanvas
									? 'text-blue-300 hover:text-blue-200'
									: 'text-gray-400 hover:text-gray-200'
							)}
							data-testid="canvas-toggle"
							aria-pressed={showCanvas}
						>
							Canvas
						</button>
					)}
					{task.workflowRunId && (
						<button
							type="button"
							onClick={() => {
								setShowArtifacts((v) => !v);
								setShowCanvas(false);
							}}
							class={cn(
								'flex-shrink-0 px-2 py-1 text-xs font-medium transition-colors',
								showArtifacts
									? 'text-blue-300 hover:text-blue-200'
									: 'text-gray-400 hover:text-gray-200'
							)}
							data-testid="artifacts-toggle"
							aria-pressed={showArtifacts}
						>
							Artifacts
						</button>
					)}
					{showHeaderSessionAction && (
						<button
							type="button"
							onClick={() => {
								if (agentSessionId) {
									spaceOverlayAgentNameSignal.value = agentActionLabel;
									spaceOverlaySessionIdSignal.value = agentSessionId;
								} else {
									navigateToSpaceAgent(runtimeSpaceId);
								}
							}}
							class="flex-shrink-0 px-2 py-1 text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors"
							data-testid={agentSessionId ? 'view-agent-session-btn' : 'open-space-agent-btn'}
						>
							{agentActionLabel}
						</button>
					)}
				</div>
			</div>

			{activityMembers.length > 0 && (
				<ActivityMemberList members={activityMembers} taskId={task.id} />
			)}

			{task.status === 'blocked' && task.result && (
				<div
					class="mx-4 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2"
					data-testid="task-blocked-banner"
				>
					<p class="text-xs font-medium text-amber-300">Blocked</p>
					<p class="mt-0.5 text-sm text-amber-200/90">{task.result}</p>
				</div>
			)}

			<div class="flex-1 min-h-0 overflow-hidden px-4">
				{showCanvas && task.workflowRunId && canvasWorkflowId ? (
					<div class="h-full" data-testid="canvas-view">
						<WorkflowCanvas
							workflowId={canvasWorkflowId}
							runId={task.workflowRunId}
							spaceId={runtimeSpaceId ?? task.spaceId}
							onNodeClick={agentSessionId ? handleNodeClick : undefined}
							class="h-full"
						/>
					</div>
				) : showArtifacts && task.workflowRunId ? (
					<TaskArtifactsPanel
						runId={task.workflowRunId}
						onClose={() => setShowArtifacts(false)}
						class="h-full"
					/>
				) : (
					<div class="h-full flex flex-col">
						<div class="flex-1 min-h-0" data-testid="task-thread-panel">
							{hasUnifiedWorkflowThread ? (
								<SpaceTaskUnifiedThread taskId={task.id} />
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

						<div class="py-3 space-y-3 border-t border-dark-800">
							{showInlineComposer && (
								<form onSubmit={handleThreadSend} class="space-y-3">
									<div class="relative">
										{mentionQuery !== null && mentionAgents.length > 0 && (
											<MentionAutocomplete
												agents={mentionAgents}
												selectedIndex={mentionSelectedIndex}
												onSelect={handleMentionSelect}
												onClose={handleMentionClose}
											/>
										)}
										<textarea
											ref={textareaRef}
											value={threadDraft}
											onInput={handleThreadDraftInput}
											onKeyDown={(e) => {
												// Handle @mention autocomplete navigation
												if (mentionQuery !== null && mentionAgents.length > 0) {
													if (e.key === 'ArrowDown') {
														e.preventDefault();
														setMentionSelectedIndex((i) =>
															Math.min(i + 1, mentionAgents.length - 1)
														);
														return;
													}
													if (e.key === 'ArrowUp') {
														e.preventDefault();
														setMentionSelectedIndex((i) => Math.max(i - 1, 0));
														return;
													}
													if (e.key === 'Enter' && !e.shiftKey) {
														e.preventDefault();
														if (mentionAgents[mentionSelectedIndex]) {
															handleMentionSelect(mentionAgents[mentionSelectedIndex].name);
														}
														return;
													}
													if (e.key === 'Escape') {
														e.preventDefault();
														setMentionQuery(null);
														return;
													}
												}
												// Existing Enter to submit
												if (e.key === 'Enter' && !e.shiftKey) {
													e.preventDefault();
													(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
												}
											}}
											rows={3}
											placeholder={
												agentSessionId
													? 'Message the task agent (Enter to send, Shift+Enter for newline)'
													: 'Type a message — a task agent session will be created on send'
											}
											disabled={sendingThread}
											class="w-full bg-transparent border-0 rounded-none px-0 py-0 text-sm text-gray-100 placeholder-gray-600 focus:outline-none resize-none disabled:opacity-60"
										/>
									</div>
									<div class="flex items-center justify-between gap-3">
										<p class="text-xs text-gray-500">
											Reply here to steer the task. Agent updates appear in the thread above.
										</p>
										<button
											type="submit"
											disabled={!canSendThreadMessage || !threadDraft.trim()}
											class="px-2 py-1 text-xs font-medium text-blue-300 hover:text-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
										>
											{sendingThread ? 'Sending...' : 'Send to Task Agent'}
										</button>
									</div>
								</form>
							)}

							<TaskStatusActions
								status={task.status}
								onTransition={handleStatusTransition}
								disabled={statusTransitioning}
							/>

							{threadSendError && <p class="text-xs text-red-300">{threadSendError}</p>}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
