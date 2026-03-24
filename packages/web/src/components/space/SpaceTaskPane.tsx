/**
 * SpaceTaskPane Component
 *
 * Right column task detail pane for the Space layout.
 * Shows task details, status, and human input area when needed.
 */

import { useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';
import type {
	SpaceTask,
	SpaceTaskStatus,
	SpaceTaskPriority,
	SpaceAgent,
	SpaceSessionGroup,
	SpaceSessionGroupMember,
} from '@neokai/shared';

interface SpaceTaskPaneProps {
	taskId: string | null;
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
};

const PRIORITY_LABELS: Record<SpaceTaskPriority, string> = {
	low: 'Low',
	normal: 'Normal',
	high: 'High',
	urgent: 'Urgent',
};

const PRIORITY_CLASSES: Record<SpaceTaskPriority, string> = {
	low: 'text-gray-500',
	normal: 'text-gray-400',
	high: 'text-orange-400',
	urgent: 'text-red-400',
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

// ============================================================================
// Working Agents Section
// ============================================================================

const MEMBER_STATUS_CLASSES: Record<SpaceSessionGroupMember['status'], string> = {
	active: 'bg-blue-900/30 text-blue-300 border-blue-700/50',
	completed: 'bg-green-900/30 text-green-300 border-green-700/50',
	failed: 'bg-red-900/30 text-red-400 border-red-700/50',
};

function MemberStatusBadge({ status }: { status: SpaceSessionGroupMember['status'] }) {
	return (
		<span
			data-testid={`member-status-badge-${status}`}
			class={cn(
				'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium border',
				MEMBER_STATUS_CLASSES[status]
			)}
		>
			{status === 'active' && (
				<span class="relative flex h-1.5 w-1.5">
					<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
					<span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" />
				</span>
			)}
			{status === 'completed' && (
				<svg
					data-testid="member-status-icon-completed"
					class="w-2.5 h-2.5"
					viewBox="0 0 20 20"
					fill="currentColor"
				>
					<path
						fillRule="evenodd"
						d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
						clipRule="evenodd"
					/>
				</svg>
			)}
			{status === 'failed' && (
				<svg
					data-testid="member-status-icon-failed"
					class="w-2.5 h-2.5"
					viewBox="0 0 20 20"
					fill="currentColor"
				>
					<path
						fillRule="evenodd"
						d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
						clipRule="evenodd"
					/>
				</svg>
			)}
			<span class="capitalize">{status}</span>
		</span>
	);
}

interface WorkingAgentsProps {
	groups: SpaceSessionGroup[];
	agents: SpaceAgent[];
}

function WorkingAgents({ groups, agents }: WorkingAgentsProps) {
	// Show the most recent group first; if there are multiple, show them all
	const sortedGroups = [...groups].sort((a, b) => b.createdAt - a.createdAt);

	return (
		<div>
			<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
				Working Agents
			</h3>
			<div class="space-y-2">
				{sortedGroups.map((group) => {
					const createdDate = new Date(group.createdAt);
					const timeStr = createdDate.toLocaleTimeString(undefined, {
						hour: '2-digit',
						minute: '2-digit',
					});

					return (
						<div
							key={group.id}
							class="border border-dark-700 rounded-lg p-2.5 bg-dark-800/50 space-y-2"
						>
							{/* Group header */}
							<div class="flex items-center justify-between">
								<span class="text-xs font-medium text-gray-300">{group.name}</span>
								<span class="text-xs text-gray-600">{timeStr}</span>
							</div>

							{/* Members */}
							{group.members.length === 0 ? (
								<p class="text-xs text-gray-600 italic">No members yet</p>
							) : (
								<ul class="space-y-1.5">
									{group.members.map((member) => {
										const agent = member.agentId
											? agents.find((a) => a.id === member.agentId)
											: null;
										const agentName =
											agent?.name ?? (member.role === 'task-agent' ? 'Task Agent' : null);

										return (
											<li key={member.id} class="flex items-center gap-2 min-w-0">
												<MemberStatusBadge status={member.status} />
												<span class="text-xs text-gray-300 capitalize flex-1 truncate">
													{agentName ?? member.role}
												</span>
												{agentName && agentName !== member.role && (
													<span class="text-xs text-gray-600 truncate max-w-[5rem] capitalize">
														{member.role}
													</span>
												)}
											</li>
										);
									})}
								</ul>
							)}
						</div>
					);
				})}
			</div>
		</div>
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

export function SpaceTaskPane({ taskId, onClose }: SpaceTaskPaneProps) {
	const tasks = spaceStore.tasks.value;
	const agents = spaceStore.agents.value;
	const sessionGroupsByTask = spaceStore.sessionGroupsByTask.value;

	if (!taskId) {
		return (
			<div class="flex items-center justify-center h-full p-6">
				<p class="text-sm text-gray-600 text-center">Select a task to view details</p>
			</div>
		);
	}

	const task = tasks.find((t) => t.id === taskId);
	const taskGroups = sessionGroupsByTask.get(taskId) ?? [];

	if (!task) {
		return (
			<div class="flex items-center justify-center h-full p-6">
				<p class="text-sm text-gray-600 text-center">Task not found</p>
			</div>
		);
	}

	return (
		<div class="flex flex-col h-full overflow-y-auto">
			{/* Header */}
			<div class="flex items-start justify-between px-4 py-3 border-b border-dark-700">
				<h2 class="text-sm font-semibold text-gray-100 flex-1 mr-2 leading-snug">{task.title}</h2>
				{onClose && (
					<button
						onClick={onClose}
						class="text-gray-600 hover:text-gray-400 transition-colors flex-shrink-0 mt-0.5"
						aria-label="Close task pane"
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				)}
			</div>

			{/* Body */}
			<div class="flex-1 px-4 py-4 space-y-4">
				{/* Status + Priority row */}
				<div class="flex items-center gap-3 flex-wrap">
					<StatusBadge status={task.status} />
					<span class={cn('text-xs font-medium', PRIORITY_CLASSES[task.priority])}>
						{PRIORITY_LABELS[task.priority]} priority
					</span>
					{task.taskType && <span class="text-xs text-gray-600 capitalize">{task.taskType}</span>}
				</div>

				{/* Workflow step indicator */}
				{task.workflowRunId && (
					<div class="flex items-center gap-2 text-xs text-gray-500">
						<svg
							class="w-3.5 h-3.5 flex-shrink-0"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M4 6h16M4 10h16M4 14h16M4 18h16"
							/>
						</svg>
						<span>
							Workflow Step
							{task.workflowNodeId && (
								<span class="ml-1 font-mono text-gray-600">{task.workflowNodeId.slice(0, 8)}</span>
							)}
						</span>
					</div>
				)}

				{/* Description */}
				{task.description && (
					<div>
						<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
							Description
						</h3>
						<p class="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
							{task.description}
						</p>
					</div>
				)}

				{/* Current step */}
				{task.currentStep && (
					<div>
						<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
							Current Step
						</h3>
						<p class="text-xs text-gray-400">{task.currentStep}</p>
					</div>
				)}

				{/* Progress */}
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

				{/* Working Agents */}
				{taskGroups.length > 0 && <WorkingAgents groups={taskGroups} agents={agents} />}

				{/* Result */}
				{task.result && (
					<div>
						<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
							Result
						</h3>
						<p class="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{task.result}</p>
					</div>
				)}

				{/* Error */}
				{task.error && (
					<div>
						<h3 class="text-xs font-semibold text-red-500 uppercase tracking-wider mb-1.5">
							Error
						</h3>
						<p class="text-sm text-red-400 leading-relaxed whitespace-pre-wrap">{task.error}</p>
					</div>
				)}

				{/* PR link */}
				{task.prUrl && (
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
				)}

				{/* Human input area */}
				{task.status === 'needs_attention' && <HumanInputArea task={task} />}
			</div>
		</div>
	);
}
