/**
 * TaskView Component
 *
 * Shows the task detail view with:
 * - Task header (title, status, progress, pair state)
 * - Unified conversation timeline (Craft + Lead messages in sub-agent blocks)
 *
 * Uses the conversation session (conv:*) for a single merged timeline
 * instead of two separate ChatContainer panels.
 *
 * Subscribes to room.task.update events to refresh pair info when status changes.
 */

import { useEffect, useState } from 'preact/hooks';
import type { NeoTask } from '@neokai/shared';
import { useMessageHub } from '../../hooks/useMessageHub';
import { navigateToRoom } from '../../lib/router';
import { TaskConversationRenderer } from './TaskConversationRenderer';

interface TaskPairInfo {
	id: string;
	taskId: string;
	craftSessionId: string;
	leadSessionId: string;
	conversationSessionId: string | null;
	pairState: string;
	feedbackIteration: number;
	createdAt: number;
	completedAt: number | null;
}

interface TaskViewProps {
	roomId: string;
	taskId: string;
}

const PAIR_STATE_LABELS: Record<string, string> = {
	awaiting_craft: 'Craft working…',
	awaiting_lead: 'Lead reviewing…',
	awaiting_human: 'Needs human review',
	hibernated: 'Hibernated',
	completed: 'Completed',
	failed: 'Failed',
};

const TASK_STATUS_COLORS: Record<string, string> = {
	pending: 'text-gray-400',
	in_progress: 'text-yellow-400',
	completed: 'text-green-400',
	failed: 'text-red-400',
	escalated: 'text-orange-400',
	draft: 'text-gray-500',
};

export function TaskView({ roomId, taskId }: TaskViewProps) {
	const { request, onEvent, joinRoom, leaveRoom } = useMessageHub();
	const [task, setTask] = useState<NeoTask | null>(null);
	const [pair, setPair] = useState<TaskPairInfo | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchPair = async () => {
		try {
			const res = await request<{ pair: TaskPairInfo | null }>('task.getPair', {
				roomId,
				taskId,
			});
			setPair(res.pair);
		} catch {
			// Pair fetch failure is non-fatal — task may just not have a pair yet
		}
	};

	useEffect(() => {
		const channel = `room:${roomId}`;
		joinRoom(channel);

		const load = async () => {
			try {
				const taskRes = await request<{ task: NeoTask }>('task.get', { roomId, taskId });
				setTask(taskRes.task);
				await fetchPair();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to load task');
			} finally {
				setLoading(false);
			}
		};

		load();

		// Re-fetch pair whenever the task status changes (e.g. pair spawned or completed)
		const unsub = onEvent<{ roomId: string; task: NeoTask }>('room.task.update', (event) => {
			if (event.task.id === taskId) {
				setTask(event.task);
				fetchPair();
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
					{pair && (
						<p class="text-xs text-gray-500 mt-0.5">
							{PAIR_STATE_LABELS[pair.pairState] ?? pair.pairState}
							{pair.feedbackIteration > 0 && ` · iteration ${pair.feedbackIteration}`}
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

			{/* Conversation timeline */}
			{pair?.conversationSessionId ? (
				<TaskConversationRenderer
					key={pair.conversationSessionId}
					conversationSessionId={pair.conversationSessionId}
				/>
			) : (
				<div class="flex-1 flex items-center justify-center text-center p-8">
					<div>
						<p class="text-gray-400 mb-1">
							{pair ? 'No conversation session' : 'No active agent pair'}
						</p>
						<p class="text-sm text-gray-500">
							{task.status === 'pending'
								? 'Waiting for the runtime to pick up this task.'
								: task.status === 'completed'
									? 'This task has been completed.'
									: task.status === 'failed'
										? 'This task has failed.'
										: 'No Craft/Lead pair has been spawned yet.'}
						</p>
					</div>
				</div>
			)}
		</div>
	);
}
