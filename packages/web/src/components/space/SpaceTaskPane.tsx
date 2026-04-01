import { useEffect, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceAgent, navigateToSpaceSession } from '../../lib/router';
import type { SpaceTaskPriority, SpaceTaskStatus } from '@neokai/shared';
import { SpaceTaskUnifiedThread } from './SpaceTaskUnifiedThread';

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

const PRIORITY_LABELS: Record<SpaceTaskPriority, string> = {
	low: 'Low',
	normal: 'Normal',
	high: 'High',
	urgent: 'Urgent',
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
	const tasks = spaceStore.tasks.value;
	const task = taskId ? (tasks.find((t) => t.id === taskId) ?? null) : null;
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
	const isTerminalTask =
		task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived';
	const showInlineComposer = !!agentSessionId && !isTerminalTask;
	const canSendThreadMessage =
		!!agentSessionId && !isTerminalTask && !ensuringThread && !sendingThread;
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
							<span>{activitySummary}</span>
							{task.priority !== 'normal' && (
								<span class="text-xs uppercase tracking-[0.12em] text-gray-500">
									{PRIORITY_LABELS[task.priority]} Priority
								</span>
							)}
						</div>
					</div>
					{showHeaderSessionAction && (
						<button
							type="button"
							onClick={() =>
								agentSessionId
									? navigateToSpaceSession(runtimeSpaceId, agentSessionId)
									: navigateToSpaceAgent(runtimeSpaceId)
							}
							class="flex-shrink-0 px-2 py-1 text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors"
							data-testid={agentSessionId ? 'view-agent-session-btn' : 'open-space-agent-btn'}
						>
							{agentActionLabel}
						</button>
					)}
				</div>
			</div>

			<div class="flex-1 min-h-0 overflow-hidden px-4">
				<div class="h-full flex flex-col">
					<div class="flex-1 min-h-0" data-testid="task-thread-panel">
						{agentSessionId ? (
							<SpaceTaskUnifiedThread taskId={task.id} />
						) : (
							<div class="h-full px-4 py-10 text-center">
								<p class="text-sm text-gray-300">
									{ensuringThread ? 'Starting task thread...' : 'Task thread is not available yet.'}
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
									class="w-full bg-transparent border-0 rounded-none px-0 py-0 text-sm text-gray-100 placeholder-gray-600 focus:outline-none resize-none disabled:opacity-60"
								/>
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

						{!agentSessionId && (
							<p class="text-xs text-gray-500">
								Waiting for task thread before messages can be sent.
							</p>
						)}

						{isTerminalTask && (
							<div class="flex flex-wrap items-center gap-3">
								<p class="text-xs text-gray-500">This task is read-only in its current state.</p>
								{task.status === 'completed' && (
									<button
										type="button"
										onClick={() => void handleReopenTask()}
										disabled={reopeningTask}
										class="px-2 py-1 text-xs font-medium text-gray-300 hover:text-gray-100 transition-colors disabled:opacity-50"
									>
										{reopeningTask ? 'Reopening...' : 'Reopen Task'}
									</button>
								)}
							</div>
						)}

						{threadSendError && <p class="text-xs text-red-300">{threadSendError}</p>}
					</div>
				</div>
			</div>
		</div>
	);
}
