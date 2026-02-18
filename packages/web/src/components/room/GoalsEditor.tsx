/**
 * GoalsEditor Component
 *
 * Provides CRUD operations for room goals with progress tracking.
 * Features:
 * - Create, edit, and delete goals
 * - Status and priority badges with visual indicators
 * - Progress bar with color-coded completion
 * - Link/unlink tasks to goals
 * - Expandable goal details view
 */

import { useState } from 'preact/hooks';
import type { RoomGoal, GoalPriority, GoalStatus } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Modal } from '../ui/Modal';
import { ConfirmModal } from '../ui/ConfirmModal';
import { Skeleton } from '../ui/Skeleton';

export interface GoalsEditorProps {
	/** Room ID (for context, may be used for future features) */
	roomId?: string;
	/** List of goals to display */
	goals: RoomGoal[];
	/** Handler for creating a new goal */
	onCreateGoal: (goal: {
		title: string;
		description?: string;
		priority?: GoalPriority;
	}) => Promise<void>;
	/** Handler for updating an existing goal */
	onUpdateGoal: (goalId: string, updates: Partial<RoomGoal>) => Promise<void>;
	/** Handler for deleting a goal */
	onDeleteGoal: (goalId: string) => Promise<void>;
	/** Handler for linking a task to a goal */
	onLinkTask: (goalId: string, taskId: string) => Promise<void>;
	/** Whether the editor is in a loading state */
	isLoading?: boolean;
}

// Status icon components
function StatusIcon({ status }: { status: GoalStatus }) {
	switch (status) {
		case 'pending':
			return (
				<div class="w-5 h-5 rounded-full border-2 border-gray-500 flex-shrink-0" title="Pending" />
			);
		case 'in_progress':
			return (
				<div class="w-5 h-5 flex-shrink-0" title="In Progress">
					<Spinner size="xs" color="border-blue-400" />
				</div>
			);
		case 'completed':
			return (
				<div
					class="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0"
					title="Completed"
				>
					<svg class="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={3}
							d="M5 13l4 4L19 7"
						/>
					</svg>
				</div>
			);
		case 'blocked':
			return (
				<div
					class="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center flex-shrink-0"
					title="Blocked"
				>
					<svg class="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={3}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</div>
			);
	}
}

// Priority badge component
function PriorityBadge({ priority }: { priority: GoalPriority }) {
	const styles: Record<GoalPriority, string> = {
		low: 'bg-gray-700 text-gray-300',
		normal: 'bg-blue-900/50 text-blue-300',
		high: 'bg-orange-900/50 text-orange-300',
		urgent: 'bg-red-900/50 text-red-300',
	};

	return (
		<span class={cn('px-2 py-0.5 text-xs font-medium rounded capitalize', styles[priority])}>
			{priority}
		</span>
	);
}

// Progress bar component
function ProgressBar({ progress }: { progress: number }) {
	const getColor = (prog: number): string => {
		if (prog < 30) return 'bg-red-500';
		if (prog < 70) return 'bg-yellow-500';
		return 'bg-green-500';
	};

	return (
		<div class="flex items-center gap-2">
			<div class="flex-1 h-2 bg-dark-700 rounded-full overflow-hidden">
				<div
					class={cn('h-full transition-all duration-300', getColor(progress))}
					style={{ width: `${progress}%` }}
				/>
			</div>
			<span class="text-xs text-gray-400 w-8 text-right">{progress}%</span>
		</div>
	);
}

// Create/Edit Goal Form
interface GoalFormProps {
	initialTitle?: string;
	initialDescription?: string;
	initialPriority?: GoalPriority;
	onSubmit: (data: {
		title: string;
		description?: string;
		priority: GoalPriority;
	}) => Promise<void>;
	onCancel: () => void;
	isLoading?: boolean;
	submitLabel?: string;
}

function GoalForm({
	initialTitle = '',
	initialDescription = '',
	initialPriority = 'normal',
	onSubmit,
	onCancel,
	isLoading,
	submitLabel = 'Create',
}: GoalFormProps) {
	const [title, setTitle] = useState(initialTitle);
	const [description, setDescription] = useState(initialDescription);
	const [priority, setPriority] = useState<GoalPriority>(initialPriority);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		if (!title.trim()) return;

		setIsSubmitting(true);
		try {
			await onSubmit({
				title: title.trim(),
				description: description.trim() || undefined,
				priority,
			});
			onCancel();
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} class="space-y-4">
			<div>
				<label for="goal-title" class="block text-sm font-medium text-gray-300 mb-1">
					Title <span class="text-red-400">*</span>
				</label>
				<input
					id="goal-title"
					type="text"
					value={title}
					onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
					class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					placeholder="Enter goal title..."
					required
				/>
			</div>

			<div>
				<label for="goal-description" class="block text-sm font-medium text-gray-300 mb-1">
					Description
				</label>
				<textarea
					id="goal-description"
					value={description}
					onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
					class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
					placeholder="Describe the goal..."
					rows={3}
				/>
			</div>

			<div>
				<label for="goal-priority" class="block text-sm font-medium text-gray-300 mb-1">
					Priority
				</label>
				<select
					id="goal-priority"
					value={priority}
					onChange={(e) => setPriority((e.target as HTMLSelectElement).value as GoalPriority)}
					class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
				>
					<option value="low">Low</option>
					<option value="normal">Normal</option>
					<option value="high">High</option>
					<option value="urgent">Urgent</option>
				</select>
			</div>

			<div class="flex items-center justify-end gap-3 pt-2">
				<Button variant="ghost" onClick={onCancel} disabled={isSubmitting || isLoading}>
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={!title.trim() || isSubmitting || isLoading}
					loading={isSubmitting || isLoading}
				>
					{submitLabel}
				</Button>
			</div>
		</form>
	);
}

// Goal Item Component
interface GoalItemProps {
	goal: RoomGoal;
	onUpdate: (updates: Partial<RoomGoal>) => Promise<void>;
	onDelete: () => Promise<void>;
	onLinkTask: (taskId: string) => Promise<void>;
	isExpanded: boolean;
	onToggleExpand: () => void;
}

function GoalItem({
	goal,
	onUpdate,
	onDelete,
	onLinkTask,
	isExpanded,
	onToggleExpand,
}: GoalItemProps) {
	const [isEditing, setIsEditing] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [linkTaskId, setLinkTaskId] = useState('');
	const [isUpdating, setIsUpdating] = useState(false);

	const handleStatusChange = async (newStatus: GoalStatus) => {
		setIsUpdating(true);
		try {
			await onUpdate({ status: newStatus });
		} finally {
			setIsUpdating(false);
		}
	};

	const handleLinkTask = async () => {
		if (!linkTaskId.trim()) return;
		setIsUpdating(true);
		try {
			await onLinkTask(linkTaskId.trim());
			setLinkTaskId('');
		} finally {
			setIsUpdating(false);
		}
	};

	const handleDelete = async () => {
		setIsUpdating(true);
		try {
			await onDelete();
			setShowDeleteConfirm(false);
		} finally {
			setIsUpdating(false);
		}
	};

	// Get available status transitions based on current status
	const getAvailableActions = (): { label: string; status: GoalStatus }[] => {
		switch (goal.status) {
			case 'pending':
				return [{ label: 'Start', status: 'in_progress' }];
			case 'in_progress':
				return [
					{ label: 'Complete', status: 'completed' },
					{ label: 'Block', status: 'blocked' },
				];
			case 'blocked':
				return [
					{ label: 'Unblock', status: 'in_progress' },
					{ label: 'Complete', status: 'completed' },
				];
			case 'completed':
				return [{ label: 'Reopen', status: 'in_progress' }];
			default:
				return [];
		}
	};

	if (isEditing) {
		return (
			<div class="bg-dark-850 border border-dark-700 rounded-lg p-4">
				<GoalForm
					initialTitle={goal.title}
					initialDescription={goal.description}
					initialPriority={goal.priority}
					onSubmit={async (data) => {
						await onUpdate(data);
						setIsEditing(false);
					}}
					onCancel={() => setIsEditing(false)}
					isLoading={isUpdating}
					submitLabel="Save"
				/>
			</div>
		);
	}

	return (
		<>
			<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
				{/* Header - always visible */}
				<div
					class="px-4 py-3 cursor-pointer hover:bg-dark-800 transition-colors"
					onClick={onToggleExpand}
				>
					<div class="flex items-center gap-3">
						<StatusIcon status={goal.status} />
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 mb-1">
								<h4 class="text-sm font-medium text-gray-100 truncate">{goal.title}</h4>
								<PriorityBadge priority={goal.priority} />
							</div>
							<ProgressBar progress={goal.progress} />
						</div>
						{goal.linkedTaskIds.length > 0 && (
							<span class="px-2 py-0.5 text-xs bg-dark-700 text-gray-300 rounded">
								{goal.linkedTaskIds.length} task{goal.linkedTaskIds.length !== 1 ? 's' : ''}
							</span>
						)}
						<div class="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
							<Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
								Edit
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(true)}>
								Delete
							</Button>
						</div>
					</div>
				</div>

				{/* Expanded content */}
				{isExpanded && (
					<div class="px-4 py-3 border-t border-dark-700 bg-dark-800/50">
						{/* Description */}
						{goal.description && (
							<div class="mb-4">
								<h5 class="text-xs font-medium text-gray-400 uppercase mb-1">Description</h5>
								<p class="text-sm text-gray-300">{goal.description}</p>
							</div>
						)}

						{/* Metrics */}
						{goal.metrics && Object.keys(goal.metrics).length > 0 && (
							<div class="mb-4">
								<h5 class="text-xs font-medium text-gray-400 uppercase mb-2">Metrics</h5>
								<div class="grid grid-cols-2 gap-2">
									{Object.entries(goal.metrics).map(([key, value]) => (
										<div key={key} class="bg-dark-700 rounded px-3 py-2">
											<span class="text-xs text-gray-400">{key}:</span>
											<span class="text-sm text-gray-100 ml-2">{value}</span>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Linked Tasks */}
						<div class="mb-4">
							<h5 class="text-xs font-medium text-gray-400 uppercase mb-2">Linked Tasks</h5>
							{goal.linkedTaskIds.length > 0 ? (
								<div class="space-y-1">
									{goal.linkedTaskIds.map((taskId) => (
										<div
											key={taskId}
											class="flex items-center gap-2 text-sm text-gray-300 bg-dark-700 rounded px-3 py-1.5"
										>
											<svg
												class="w-4 h-4 text-gray-500"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width={2}
													d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
												/>
											</svg>
											<span class="font-mono text-xs">{taskId}</span>
										</div>
									))}
								</div>
							) : (
								<p class="text-sm text-gray-500">No tasks linked</p>
							)}
						</div>

						{/* Link Task Input */}
						<div class="mb-4">
							<div class="flex gap-2">
								<input
									type="text"
									value={linkTaskId}
									onInput={(e) => setLinkTaskId((e.target as HTMLInputElement).value)}
									class="flex-1 px-3 py-1.5 text-sm bg-dark-700 border border-dark-600 rounded text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
									placeholder="Enter task ID to link..."
								/>
								<Button
									size="sm"
									onClick={handleLinkTask}
									disabled={!linkTaskId.trim() || isUpdating}
								>
									Link Task
								</Button>
							</div>
						</div>

						{/* Status Actions */}
						<div>
							<h5 class="text-xs font-medium text-gray-400 uppercase mb-2">Change Status</h5>
							<div class="flex flex-wrap gap-2">
								{getAvailableActions().map((action) => (
									<Button
										key={action.status}
										variant={action.status === 'completed' ? 'primary' : 'secondary'}
										size="sm"
										onClick={() => handleStatusChange(action.status)}
										loading={isUpdating}
									>
										{action.label}
									</Button>
								))}
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Delete Confirmation Modal */}
			<ConfirmModal
				isOpen={showDeleteConfirm}
				onClose={() => setShowDeleteConfirm(false)}
				onConfirm={handleDelete}
				title="Delete Goal"
				message={`Are you sure you want to delete "${goal.title}"? This action cannot be undone.`}
				confirmText="Delete"
				isLoading={isUpdating}
			/>
		</>
	);
}

// Loading skeleton
function GoalsSkeleton() {
	return (
		<div class="space-y-3">
			{[1, 2, 3].map((i) => (
				<div key={i} class="bg-dark-850 border border-dark-700 rounded-lg p-4">
					<div class="flex items-center gap-3">
						<Skeleton variant="circle" width={20} height={20} />
						<div class="flex-1 space-y-2">
							<Skeleton width="40%" height={16} />
							<Skeleton width="100%" height={8} />
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

// Empty state
function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-8 text-center">
			<div class="w-12 h-12 rounded-full bg-dark-700 flex items-center justify-center mx-auto mb-4">
				<svg class="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
					/>
				</svg>
			</div>
			<h3 class="text-lg font-medium text-gray-200 mb-2">No goals yet</h3>
			<p class="text-sm text-gray-400 mb-4">Create your first goal to get started.</p>
			<Button onClick={onCreateClick}>Create Goal</Button>
		</div>
	);
}

export function GoalsEditor({
	goals,
	onCreateGoal,
	onUpdateGoal,
	onDeleteGoal,
	onLinkTask,
	isLoading = false,
}: GoalsEditorProps) {
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);

	const toggleExpand = (goalId: string) => {
		setExpandedGoalId((current) => (current === goalId ? null : goalId));
	};

	// Sort goals: in_progress first, then by priority (urgent > high > normal > low), then by created date
	const sortedGoals = [...goals].sort((a, b) => {
		// Status priority: in_progress > pending > blocked > completed
		const statusOrder: Record<GoalStatus, number> = {
			in_progress: 0,
			pending: 1,
			blocked: 2,
			completed: 3,
		};
		if (statusOrder[a.status] !== statusOrder[b.status]) {
			return statusOrder[a.status] - statusOrder[b.status];
		}

		// Priority order: urgent > high > normal > low
		const priorityOrder: Record<GoalPriority, number> = {
			urgent: 0,
			high: 1,
			normal: 2,
			low: 3,
		};
		if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
			return priorityOrder[a.priority] - priorityOrder[b.priority];
		}

		// Newest first
		return b.createdAt - a.createdAt;
	});

	return (
		<div class="space-y-4">
			{/* Header */}
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					<h2 class="text-lg font-semibold text-gray-100">Goals</h2>
					<span class="px-2 py-0.5 text-xs font-medium bg-dark-700 text-gray-300 rounded">
						{goals.length}
					</span>
				</div>
				<Button onClick={() => setShowCreateModal(true)}>Create Goal</Button>
			</div>

			{/* Content */}
			{isLoading ? (
				<GoalsSkeleton />
			) : goals.length === 0 ? (
				<EmptyState onCreateClick={() => setShowCreateModal(true)} />
			) : (
				<div class="space-y-3">
					{sortedGoals.map((goal) => (
						<GoalItem
							key={goal.id}
							goal={goal}
							onUpdate={(updates) => onUpdateGoal(goal.id, updates)}
							onDelete={() => onDeleteGoal(goal.id)}
							onLinkTask={(taskId) => onLinkTask(goal.id, taskId)}
							isExpanded={expandedGoalId === goal.id}
							onToggleExpand={() => toggleExpand(goal.id)}
						/>
					))}
				</div>
			)}

			{/* Create Goal Modal */}
			<Modal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} title="Create Goal">
				<GoalForm
					onSubmit={onCreateGoal}
					onCancel={() => setShowCreateModal(false)}
					submitLabel="Create"
				/>
			</Modal>
		</div>
	);
}
