/**
 * TaskView Component
 *
 * Shows the task detail view with:
 * - Task header (title, status, progress, group state)
 * - Unified conversation timeline (Worker + Leader messages in sub-agent blocks)
 * - Human input area (context-sensitive based on group.state)
 *
 * Uses session group messages for a single merged timeline.
 *
 * Subscribes to room.task.update events to refresh group info when status changes.
 */

import { useEffect, useState } from 'preact/hooks';
import type { NeoTask } from '@neokai/shared';
import { useMessageHub } from '../../hooks/useMessageHub';
import { navigateToRoom, navigateToRoomTask } from '../../lib/router';
import { TaskConversationRenderer } from './TaskConversationRenderer';

interface TaskGroupInfo {
	id: string;
	taskId: string;
	workerSessionId: string;
	leaderSessionId: string;
	workerRole: string;
	state: string;
	feedbackIteration: number;
	createdAt: number;
	completedAt: number | null;
}

interface TaskViewProps {
	roomId: string;
	taskId: string;
}

const GROUP_STATE_LABELS: Record<string, string> = {
	awaiting_worker: 'Worker active…',
	awaiting_leader: 'Leader reviewing…',
	awaiting_human: 'Needs human review',
	completed: 'Completed',
	failed: 'Failed',
	// Backward compat
	awaiting_craft: 'Worker active…',
	awaiting_lead: 'Leader reviewing…',
};

const TASK_STATUS_COLORS: Record<string, string> = {
	pending: 'text-gray-400',
	in_progress: 'text-yellow-400',
	completed: 'text-green-400',
	failed: 'text-red-400',
	review: 'text-purple-400',
	draft: 'text-gray-500',
};

interface HumanInputAreaProps {
	groupState: string;
	roomId: string;
	taskId: string;
	onMessageSent: () => void;
}

function HumanInputArea({ groupState, roomId, taskId, onMessageSent }: HumanInputAreaProps) {
	const { request } = useMessageHub();
	const [feedbackText, setFeedbackText] = useState('');
	const [leaderText, setLeaderText] = useState('');
	const [sending, setSending] = useState(false);
	const [inputError, setInputError] = useState<string | null>(null);

	const sendMessage = async (message: string, clearInput: () => void) => {
		if (!message.trim() || sending) return;
		setSending(true);
		setInputError(null);
		try {
			await request('task.sendHumanMessage', { roomId, taskId, message: message.trim() });
			clearInput();
			onMessageSent();
		} catch (err) {
			setInputError(err instanceof Error ? err.message : 'Failed to send message');
		} finally {
			setSending(false);
		}
	};

	const approveTask = async () => {
		if (sending) return;
		setSending(true);
		setInputError(null);
		try {
			await request('goal.approveTask', { roomId, taskId });
			onMessageSent();
		} catch (err) {
			setInputError(err instanceof Error ? err.message : 'Failed to approve task');
		} finally {
			setSending(false);
		}
	};

	if (groupState === 'awaiting_human') {
		return (
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0">
				{/* Prominent banner */}
				<div class="px-4 py-2 bg-amber-900/20 border-b border-amber-800/30 flex items-center gap-2">
					<span class="text-amber-400 text-sm font-medium">⏳ Awaiting your review</span>
					<span class="text-xs text-amber-500/70 ml-auto">
						Review the PR and approve or provide feedback
					</span>
				</div>
				<div class="px-4 py-3 space-y-2">
					{/* Approve button */}
					<button
						class="w-full py-2 px-4 rounded bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
						onClick={approveTask}
						disabled={sending}
					>
						{sending ? 'Approving…' : '✓ Approve'}
					</button>
					{/* Feedback input */}
					<div class="space-y-1">
						<textarea
							class="w-full bg-dark-800 border border-dark-600 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-500 resize-none focus:outline-none focus:border-dark-500 focus:ring-1 focus:ring-dark-500"
							placeholder="Or send feedback to request changes… (⌘↵ to send)"
							rows={2}
							value={feedbackText}
							onInput={(e) => setFeedbackText((e.target as HTMLTextAreaElement).value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									void sendMessage(feedbackText, () => setFeedbackText(''));
								}
							}}
							disabled={sending}
						/>
						<div class="flex justify-end">
							<button
								class="py-1.5 px-3 rounded bg-dark-700 hover:bg-dark-600 disabled:opacity-50 disabled:cursor-not-allowed text-gray-200 text-xs transition-colors"
								onClick={() => void sendMessage(feedbackText, () => setFeedbackText(''))}
								disabled={sending || !feedbackText.trim()}
							>
								{sending ? 'Sending…' : 'Send Feedback'}
							</button>
						</div>
					</div>
					{inputError && <p class="text-xs text-red-400">{inputError}</p>}
				</div>
			</div>
		);
	}

	if (groupState === 'awaiting_leader') {
		return (
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-3 space-y-2">
				<textarea
					class="w-full bg-dark-800 border border-dark-600 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-500 resize-none focus:outline-none focus:border-dark-500 focus:ring-1 focus:ring-dark-500"
					placeholder="Send a message to the leader… (⌘↵ to send)"
					rows={2}
					value={leaderText}
					onInput={(e) => setLeaderText((e.target as HTMLTextAreaElement).value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							void sendMessage(leaderText, () => setLeaderText(''));
						}
					}}
					disabled={sending}
				/>
				<div class="flex justify-end">
					<button
						class="py-1.5 px-3 rounded bg-dark-700 hover:bg-dark-600 disabled:opacity-50 disabled:cursor-not-allowed text-gray-200 text-xs transition-colors"
						onClick={() => void sendMessage(leaderText, () => setLeaderText(''))}
						disabled={sending || !leaderText.trim()}
					>
						{sending ? 'Sending…' : 'Send to Leader'}
					</button>
				</div>
				{inputError && <p class="text-xs text-red-400">{inputError}</p>}
			</div>
		);
	}

	if (groupState === 'awaiting_worker') {
		return (
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-3">
				<div title="Worker is running — wait for leader review">
					<textarea
						class="w-full bg-dark-800 border border-dark-600/50 rounded px-3 py-2 text-sm text-gray-600 placeholder-gray-600 resize-none cursor-not-allowed"
						placeholder="Worker is running — wait for leader review"
						rows={2}
						disabled
					/>
				</div>
			</div>
		);
	}

	return null;
}

export function TaskView({ roomId, taskId }: TaskViewProps) {
	const { request, onEvent, joinRoom, leaveRoom } = useMessageHub();
	const [task, setTask] = useState<NeoTask | null>(null);
	const [group, setGroup] = useState<TaskGroupInfo | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [conversationKey, setConversationKey] = useState(0);

	const fetchGroup = async () => {
		try {
			const res = await request<{ group: TaskGroupInfo | null }>('task.getGroup', {
				roomId,
				taskId,
			});
			setGroup(res.group);
		} catch {
			// Group fetch failure is non-fatal — task may not have a group yet
		}
	};

	useEffect(() => {
		const channel = `room:${roomId}`;
		joinRoom(channel);

		const load = async () => {
			try {
				const taskRes = await request<{ task: NeoTask }>('task.get', { roomId, taskId });
				setTask(taskRes.task);
				await fetchGroup();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to load task');
			} finally {
				setLoading(false);
			}
		};

		load();

		// Re-fetch group whenever the task status changes (e.g. group spawned or completed)
		const unsub = onEvent<{ roomId: string; task: NeoTask }>('room.task.update', (event) => {
			if (event.task.id === taskId) {
				setTask(event.task);
				fetchGroup();
			}
		});

		return () => {
			unsub();
			leaveRoom(channel);
		};
	}, [roomId, taskId]);

	if (loading) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<p class="text-gray-400">Loading task…</p>
			</div>
		);
	}

	if (error || !task) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<p class="text-red-400 mb-3">{error ?? 'Task not found'}</p>
					<button
						class="text-sm text-blue-400 hover:text-blue-300"
						onClick={() => navigateToRoom(roomId)}
					>
						← Back to room
					</button>
				</div>
			</div>
		);
	}

	const statusColor = TASK_STATUS_COLORS[task.status] ?? 'text-gray-400';

	// Show input area when group is active and in an interactive state
	const showInput =
		group !== null &&
		(group.state === 'awaiting_human' ||
			group.state === 'awaiting_leader' ||
			group.state === 'awaiting_worker');

	return (
		<div class="flex-1 flex flex-col overflow-hidden bg-dark-900">
			{/* Header */}
			<div class="border-b border-dark-700 bg-dark-850 px-4 py-3 flex items-center gap-3 flex-shrink-0">
				<button
					class="text-gray-400 hover:text-gray-200 transition-colors text-sm"
					onClick={() => navigateToRoom(roomId)}
					title="Back to room"
				>
					←
				</button>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<h2 class="text-base font-semibold text-gray-100 truncate">{task.title}</h2>
						<span class={`text-xs font-medium ${statusColor}`}>
							{task.status.replace('_', ' ')}
						</span>
						{task.taskType && (
							<span class="text-xs text-gray-500 bg-dark-700 px-1.5 py-0.5 rounded">
								{task.taskType}
							</span>
						)}
					</div>
					{group && (
						<p class="text-xs text-gray-500 mt-0.5">
							{GROUP_STATE_LABELS[group.state] ?? group.state}
							{group.feedbackIteration > 0 && ` · iteration ${group.feedbackIteration}`}
						</p>
					)}
				</div>
				{task.progress != null && task.progress > 0 && (
					<div class="flex items-center gap-2 flex-shrink-0">
						<div class="w-24 h-1.5 bg-dark-700 rounded-full overflow-hidden">
							<div
								class="h-full bg-blue-500 transition-all duration-300"
								style={{ width: `${task.progress}%` }}
							/>
						</div>
						<span class="text-xs text-gray-400">{task.progress}%</span>
					</div>
				)}
			</div>

			{/* Dependencies */}
			{task.dependsOn && task.dependsOn.length > 0 && (
				<div class="border-b border-dark-700 bg-dark-850/50 px-4 py-2 flex items-center gap-2 flex-shrink-0 flex-wrap">
					<span class="text-xs text-gray-500">Depends on:</span>
					{task.dependsOn.map((depId) => (
						<button
							key={depId}
							class="text-xs px-1.5 py-0.5 rounded bg-dark-700 text-blue-400 hover:text-blue-300 hover:bg-dark-600 transition-colors"
							onClick={() => navigateToRoomTask(roomId, depId)}
							title={depId}
						>
							{depId.slice(0, 8)}...
						</button>
					))}
				</div>
			)}

			{/* Conversation timeline */}
			{group ? (
				<TaskConversationRenderer key={`${group.id}-${conversationKey}`} groupId={group.id} />
			) : (
				<div class="flex-1 flex items-center justify-center text-center p-8">
					<div>
						<p class="text-gray-400 mb-1">No active agent group</p>
						<p class="text-sm text-gray-500">
							{task.status === 'pending'
								? 'Waiting for the runtime to pick up this task.'
								: task.status === 'completed'
									? 'This task has been completed.'
									: task.status === 'failed'
										? 'This task has failed.'
										: task.status === 'review'
											? 'This task is awaiting human review.'
											: task.status === 'draft'
												? 'This task is a draft and has not been scheduled yet.'
												: 'No agent group has been spawned yet.'}
						</p>
					</div>
				</div>
			)}

			{/* Human input area */}
			{showInput && (
				<HumanInputArea
					groupState={group!.state}
					roomId={roomId}
					taskId={taskId}
					onMessageSent={() => setConversationKey((k) => k + 1)}
				/>
			)}
		</div>
	);
}
