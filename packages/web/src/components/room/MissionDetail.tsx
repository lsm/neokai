/**
 * MissionDetail Component
 *
 * Dedicated page for viewing a single mission (goal) in the Room UI.
 * Rendered as an absolute overlay inside Room, following the same
 * pattern as TaskViewToggle.
 *
 * Layout:
 * - Header: back button, title, short ID, status, edit/delete actions
 * - Two-column body: main content (left) + status sidebar (right, 320px)
 * - Status sidebar: priority/type/autonomy badges, quick actions, timestamps
 */

import { useState } from 'preact/hooks';
import type { NeoTask, RoomGoal, TaskStatus } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { navigateToRoom, navigateToRoomTask } from '../../lib/router';
import { currentRoomTabSignal } from '../../lib/signals';
import { useMissionDetailData } from '../../hooks/useMissionDetailData';
import type { AvailableStatusAction } from '../../hooks/useMissionDetailData';
import { Button } from '../ui/Button';
import { MobileMenuButton } from '../ui/MobileMenuButton';
import { ConfirmModal } from '../ui/ConfirmModal';
import { Skeleton } from '../ui/Skeleton';
import { Modal } from '../ui/Modal';
import {
	StatusIndicator,
	PriorityBadge,
	MissionTypeBadge,
	AutonomyBadge,
	GoalShortIdBadge,
	GoalForm,
	ProgressBar,
	MetricProgress,
	RecurringScheduleInfo,
} from './GoalsEditor';
import type { CreateGoalFormData } from './GoalsEditor';

// ─── Task Status Badge (local copy — not exported from GoalsEditor) ────────────

function TaskStatusBadge({ status }: { status: TaskStatus }) {
	const styles: Record<string, string> = {
		pending: 'bg-gray-700 text-gray-300',
		in_progress: 'bg-yellow-900/50 text-yellow-300',
		completed: 'bg-green-900/50 text-green-300',
		needs_attention: 'bg-red-900/50 text-red-300',
		draft: 'bg-dark-600 text-gray-400',
		review: 'bg-purple-900/50 text-purple-300',
		cancelled: 'bg-gray-800 text-gray-400',
		archived: 'bg-gray-900 text-gray-600',
		rate_limited: 'bg-orange-900/50 text-orange-300',
		usage_limited: 'bg-orange-900/50 text-orange-300',
	};
	const label =
		status === 'in_progress'
			? 'active'
			: status === 'needs_attention'
				? 'needs attention'
				: status === 'rate_limited'
					? 'rate limited'
					: status === 'usage_limited'
						? 'usage limited'
						: status;
	return (
		<span
			class={cn(
				'px-1.5 py-0.5 text-[10px] font-medium rounded capitalize',
				styles[status] ?? styles.pending
			)}
		>
			{label}
		</span>
	);
}

// ─── Main Content ──────────────────────────────────────────────────────────────

interface MainContentProps {
	goal: RoomGoal;
	roomId: string;
	linkedTasks: NeoTask[];
	executions: import('@neokai/shared').MissionExecution[] | null;
	isLoadingExecutions: boolean;
	onLinkTask: (taskId: string) => Promise<void>;
}

function MainContent({
	goal,
	roomId,
	linkedTasks,
	executions,
	isLoadingExecutions,
	onLinkTask,
}: MainContentProps) {
	const [linkTaskInput, setLinkTaskInput] = useState('');
	const [isLinking, setIsLinking] = useState(false);

	const missionType = goal.missionType ?? 'one_shot';

	const handleLinkTask = async () => {
		const trimmed = linkTaskInput.trim();
		if (!trimmed) return;
		setIsLinking(true);
		try {
			await onLinkTask(trimmed);
			setLinkTaskInput('');
		} finally {
			setIsLinking(false);
		}
	};

	const handleLinkKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			handleLinkTask();
		}
	};

	return (
		<div class="space-y-5" data-testid="mission-detail-main-content">
			{/* ── Description ── */}
			<section
				class="bg-dark-850 border border-dark-700 rounded-lg p-4"
				data-testid="mission-description-section"
			>
				<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
					Description
				</h3>
				{goal.description ? (
					<p class="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
						{goal.description}
					</p>
				) : (
					<p class="text-sm text-gray-500 italic">No description provided</p>
				)}
			</section>

			{/* ── Progress (one-shot) ── */}
			{missionType === 'one_shot' && (
				<section
					class="bg-dark-850 border border-dark-700 rounded-lg p-4"
					data-testid="mission-progress-section"
				>
					<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
						Progress
					</h3>
					<ProgressBar progress={goal.progress} />
				</section>
			)}

			{/* ── Metrics (measurable) ── */}
			{missionType === 'measurable' && (
				<section
					class="bg-dark-850 border border-dark-700 rounded-lg p-4"
					data-testid="mission-metrics-section"
				>
					<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Metrics</h3>
					{goal.structuredMetrics && goal.structuredMetrics.length > 0 ? (
						<MetricProgress metrics={goal.structuredMetrics} />
					) : (
						<p class="text-sm text-gray-500 italic">No metrics configured</p>
					)}
				</section>
			)}

			{/* ── Linked Tasks ── */}
			<section
				class="bg-dark-850 border border-dark-700 rounded-lg p-4"
				data-testid="mission-linked-tasks-section"
			>
				<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
					Linked Tasks
				</h3>
				{linkedTasks.length === 0 ? (
					<p class="text-sm text-gray-500 italic mb-3">No tasks linked</p>
				) : (
					<div class="space-y-1.5 mb-3" data-testid="linked-tasks-list">
						{linkedTasks.map((task) => (
							<button
								key={task.id}
								type="button"
								class="w-full flex items-center gap-2 px-3 py-2 bg-dark-700 hover:bg-dark-600 border border-dark-600 hover:border-dark-500 rounded-lg transition-colors text-left"
								onClick={() => navigateToRoomTask(roomId, task.id)}
								data-testid={`linked-task-${task.id}`}
							>
								<span class="flex-1 min-w-0 text-sm text-gray-200 truncate">{task.title}</span>
								<TaskStatusBadge status={task.status} />
								{task.shortId && (
									<span class="text-xs font-mono text-gray-500 flex-shrink-0">#{task.shortId}</span>
								)}
							</button>
						))}
					</div>
				)}
				{/* Link Task input */}
				<div class="flex gap-2" data-testid="link-task-input-row">
					<input
						type="text"
						value={linkTaskInput}
						onInput={(e) => setLinkTaskInput((e.target as HTMLInputElement).value)}
						onKeyDown={handleLinkKeyDown}
						placeholder="Task ID or short ID…"
						class="flex-1 min-w-0 px-3 py-1.5 bg-dark-700 border border-dark-600 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
						data-testid="link-task-input"
					/>
					<Button
						variant="ghost"
						size="sm"
						onClick={handleLinkTask}
						disabled={isLinking || !linkTaskInput.trim()}
						data-testid="link-task-button"
					>
						{isLinking ? 'Linking…' : 'Link Task'}
					</Button>
				</div>
			</section>

			{/* ── Schedule + Execution History (recurring only) ── */}
			{missionType === 'recurring' && (
				<>
					<section
						class="bg-dark-850 border border-dark-700 rounded-lg p-4"
						data-testid="mission-schedule-section"
					>
						<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
							Schedule
						</h3>
						<RecurringScheduleInfo goal={goal} />
					</section>

					<section
						class="bg-dark-850 border border-dark-700 rounded-lg p-4"
						data-testid="mission-execution-history-section"
					>
						<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
							Execution History
						</h3>
						{isLoadingExecutions ? (
							<div class="space-y-1.5" data-testid="execution-history-skeleton">
								<Skeleton class="h-8 w-full" />
								<Skeleton class="h-8 w-full" />
								<Skeleton class="h-8 w-4/5" />
							</div>
						) : !executions || executions.length === 0 ? (
							<p class="text-sm text-gray-500 italic" data-testid="no-executions-message">
								No executions yet
							</p>
						) : (
							<div class="space-y-1.5" data-testid="execution-history-list">
								{executions.map((ex) => (
									<div
										key={ex.id}
										class="flex items-center gap-3 text-xs bg-dark-700 rounded-lg px-3 py-2"
										data-testid={`execution-item-${ex.executionNumber}`}
									>
										<span
											class={cn(
												'w-2 h-2 rounded-full flex-shrink-0',
												ex.status === 'completed'
													? 'bg-green-500'
													: ex.status === 'failed'
														? 'bg-red-500'
														: 'bg-yellow-500'
											)}
										/>
										<span class="text-gray-400 font-mono">#{ex.executionNumber}</span>
										<span class="text-gray-300 capitalize">{ex.status}</span>
										{ex.startedAt && (
											<span class="text-gray-500 ml-auto flex-shrink-0">
												{new Date(ex.startedAt * 1000).toLocaleDateString()}
											</span>
										)}
										{ex.resultSummary && (
											<span class="text-gray-400 truncate max-w-[200px]" title={ex.resultSummary}>
												{ex.resultSummary}
											</span>
										)}
									</div>
								))}
							</div>
						)}
					</section>
				</>
			)}
		</div>
	);
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface MissionDetailProps {
	roomId: string;
	goalId: string;
}

// ─── Loading Skeleton ──────────────────────────────────────────────────────────

function MissionDetailSkeleton() {
	return (
		<div class="flex flex-col h-full bg-dark-900">
			{/* Header skeleton */}
			<div class="border-b border-dark-700 bg-dark-850 px-3 sm:px-4 py-2.5 sm:py-3 flex-shrink-0">
				<div class="flex items-center gap-2 sm:gap-3">
					<Skeleton variant="text" width={28} height={20} />
					<div class="flex-1 min-w-0">
						<Skeleton variant="text" width="60%" height={22} />
					</div>
					<Skeleton variant="text" width={64} height={32} />
					<Skeleton variant="text" width={64} height={32} />
				</div>
				<div class="flex items-center gap-2 mt-2">
					<Skeleton variant="text" width={60} height={18} />
					<Skeleton variant="text" width={48} height={18} />
					<Skeleton variant="text" width={72} height={18} />
				</div>
			</div>
			{/* Body skeleton */}
			<div class="flex-1 overflow-auto p-4 sm:p-6">
				<div class="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-6 h-full">
					<div class="space-y-4">
						<Skeleton variant="text" width="80%" height={16} />
						<Skeleton variant="text" width="60%" height={16} />
					</div>
					<div class="space-y-3">
						<Skeleton variant="text" width="100%" height={20} />
						<Skeleton variant="text" width="100%" height={20} />
						<Skeleton variant="text" width="70%" height={20} />
					</div>
				</div>
			</div>
		</div>
	);
}

// ─── Quick Action Button ───────────────────────────────────────────────────────

interface QuickActionButtonProps {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	loading?: boolean;
	variant?: 'default' | 'success' | 'warning' | 'danger';
}

function QuickActionButton({
	label,
	onClick,
	disabled = false,
	loading = false,
	variant = 'default',
}: QuickActionButtonProps) {
	const variantClasses: Record<string, string> = {
		default:
			'bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-white border border-dark-600 hover:border-dark-500',
		success:
			'bg-green-900/30 hover:bg-green-900/50 text-green-400 hover:text-green-300 border border-green-800/40',
		warning:
			'bg-amber-900/30 hover:bg-amber-900/50 text-amber-400 hover:text-amber-300 border border-amber-800/40',
		danger:
			'bg-red-900/30 hover:bg-red-900/50 text-red-400 hover:text-red-300 border border-red-800/40',
	};
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled || loading}
			class={cn(
				'w-full px-3 py-2 text-sm rounded-lg transition-colors text-left font-medium',
				'disabled:opacity-50 disabled:cursor-not-allowed',
				variantClasses[variant]
			)}
		>
			{loading ? 'Working…' : label}
		</button>
	);
}

// ─── Status Sidebar ────────────────────────────────────────────────────────────

interface StatusSidebarProps {
	goal: RoomGoal;
	availableStatusActions: AvailableStatusAction[];
	isTriggering: boolean;
	isUpdating: boolean;
	onRunNow: () => void;
	onChangeStatus: (action: AvailableStatusAction) => Promise<void>;
}

function StatusSidebar({
	goal,
	availableStatusActions,
	isTriggering,
	isUpdating,
	onRunNow,
	onChangeStatus,
}: StatusSidebarProps) {
	const [isChangingStatus, setIsChangingStatus] = useState(false);

	const handleStatusAction = async (action: AvailableStatusAction) => {
		setIsChangingStatus(true);
		try {
			await onChangeStatus(action);
		} finally {
			setIsChangingStatus(false);
		}
	};

	const formatDate = (ts: number) =>
		new Date(ts).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});

	return (
		<aside class="bg-dark-850 border border-dark-700 rounded-lg p-4 space-y-5 self-start">
			{/* Badges section */}
			<div class="space-y-2">
				<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Details</h3>
				<div class="flex flex-wrap gap-1.5">
					<PriorityBadge priority={goal.priority} />
					<MissionTypeBadge type={goal.missionType ?? 'one_shot'} />
					<AutonomyBadge level={goal.autonomyLevel ?? 'supervised'} />
				</div>
			</div>

			{/* Quick actions section */}
			{(goal.missionType === 'recurring' || availableStatusActions.length > 0) && (
				<div class="space-y-2">
					<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">
						Quick Actions
					</h3>
					<div class="space-y-1.5">
						{/* Recurring-only: Run Now */}
						{goal.missionType === 'recurring' && (
							<QuickActionButton
								label="▶ Run Now"
								onClick={onRunNow}
								loading={isTriggering}
								disabled={isTriggering || isChangingStatus}
								variant="default"
							/>
						)}

						{/* Status-dependent actions */}
						{availableStatusActions.includes('reactivate') && (
							<QuickActionButton
								label="↺ Reactivate"
								onClick={() => handleStatusAction('reactivate')}
								loading={isChangingStatus}
								disabled={isChangingStatus || isUpdating}
								variant="success"
							/>
						)}
						{availableStatusActions.includes('needs_human') && (
							<QuickActionButton
								label="⚑ Needs Review"
								onClick={() => handleStatusAction('needs_human')}
								loading={isChangingStatus}
								disabled={isChangingStatus || isUpdating}
								variant="warning"
							/>
						)}
						{availableStatusActions.includes('complete') && (
							<QuickActionButton
								label="✓ Mark Complete"
								onClick={() => handleStatusAction('complete')}
								loading={isChangingStatus}
								disabled={isChangingStatus || isUpdating}
								variant="success"
							/>
						)}
						{availableStatusActions.includes('archive') && (
							<QuickActionButton
								label="Archive"
								onClick={() => handleStatusAction('archive')}
								loading={isChangingStatus}
								disabled={isChangingStatus || isUpdating}
								variant="danger"
							/>
						)}
					</div>
				</div>
			)}

			{/* Timestamps section */}
			<div class="space-y-1.5">
				<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Timeline</h3>
				<div class="space-y-1">
					<div class="flex items-center justify-between text-xs">
						<span class="text-gray-500">Created</span>
						<span class="text-gray-400">{formatDate(goal.createdAt)}</span>
					</div>
					<div class="flex items-center justify-between text-xs">
						<span class="text-gray-500">Updated</span>
						<span class="text-gray-400">{formatDate(goal.updatedAt)}</span>
					</div>
				</div>
			</div>
		</aside>
	);
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function MissionDetail({ roomId, goalId }: MissionDetailProps) {
	const {
		goal,
		goalsLoading,
		linkedTasks,
		executions,
		isLoadingExecutions,
		availableStatusActions,
		isUpdating,
		isTriggering,
		isDeleting,
		updateGoal,
		deleteGoal,
		triggerNow,
		linkTask,
		changeStatus,
	} = useMissionDetailData(roomId, goalId);

	const [isEditOpen, setIsEditOpen] = useState(false);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);

	function handleBack() {
		navigateToRoom(roomId);
		currentRoomTabSignal.value = 'goals';
	}

	const handleEditSubmit = async (data: CreateGoalFormData) => {
		await updateGoal({
			title: data.title,
			description: data.description,
			priority: data.priority,
			missionType: data.missionType,
			autonomyLevel: data.autonomyLevel,
			// Only carry structured metrics for measurable missions; clear otherwise.
			structuredMetrics: data.missionType === 'measurable' ? data.structuredMetrics : undefined,
			// Only carry schedule for recurring missions; clear otherwise to avoid
			// orphaned schedule data when a mission type is changed during edit.
			schedule: data.missionType === 'recurring' ? data.schedule : undefined,
		});
		setIsEditOpen(false);
	};

	const handleDelete = async () => {
		await deleteGoal().catch(() => {
			/* toast already shown by hook */
		});
		setIsDeleteOpen(false);
	};

	// ── Loading state ──────────────────────────────────────────────────────────
	if (goal === null) {
		// goalsLoading=true means the LiveQuery snapshot is in flight — show skeleton.
		// goalsLoading=false means goals have loaded but none matched goalId — show error.
		if (goalsLoading) {
			return <MissionDetailSkeleton />;
		}

		// ── Not found state ────────────────────────────────────────────────────
		return (
			<div class="flex flex-col h-full bg-dark-900" data-testid="mission-not-found">
				<div class="flex items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-dark-700 bg-dark-850 flex-shrink-0">
					<MobileMenuButton />
					<button
						type="button"
						class="text-gray-400 hover:text-gray-200 transition-colors text-sm p-1 flex items-center justify-center"
						onClick={handleBack}
						data-testid="mission-not-found-back-button"
					>
						←
					</button>
				</div>
				<div class="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
					<div class="text-4xl text-gray-600">⚑</div>
					<h2 class="text-lg font-semibold text-gray-300">Mission not found</h2>
					<p class="text-sm text-gray-500 max-w-xs">
						The mission you're looking for doesn't exist or may have been deleted.
					</p>
					<button
						type="button"
						onClick={handleBack}
						class="px-4 py-2 text-sm font-medium text-gray-300 bg-dark-700 hover:bg-dark-600 rounded-lg transition-colors"
					>
						← Back to Missions
					</button>
				</div>
			</div>
		);
	}

	return (
		<div class="flex flex-col h-full bg-dark-900" data-testid="mission-detail">
			{/* ── Header ── */}
			<div
				class="border-b border-dark-700 bg-dark-850 px-3 sm:px-4 py-2.5 sm:py-3 flex-shrink-0"
				data-testid="mission-detail-header"
			>
				{/* Row 1: Back, title, action buttons */}
				<div class="flex items-center gap-2 sm:gap-3">
					<MobileMenuButton />

					<button
						type="button"
						class="text-gray-400 hover:text-gray-200 transition-colors text-sm p-1 min-w-[28px] min-h-[28px] sm:min-w-0 sm:min-h-0 sm:p-0 flex items-center justify-center flex-shrink-0"
						onClick={handleBack}
						title="Back to missions"
						data-testid="mission-detail-back-button"
					>
						←
					</button>

					<div class="flex-1 min-w-0">
						<h2
							class="text-base font-semibold text-gray-100 truncate leading-tight"
							data-testid="mission-detail-title"
						>
							{goal.title}
						</h2>
					</div>

					{/* Edit button */}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setIsEditOpen(true)}
						disabled={isUpdating}
						title="Edit mission"
						data-testid="mission-detail-edit-button"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="15"
							height="15"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
							<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
						</svg>
					</Button>

					{/* Delete button */}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setIsDeleteOpen(true)}
						disabled={isDeleting}
						title="Delete mission"
						data-testid="mission-detail-delete-button"
						class="text-red-400 hover:text-red-300 hover:bg-red-900/20"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="15"
							height="15"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<polyline points="3 6 5 6 21 6" />
							<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
							<path d="M10 11v6" />
							<path d="M14 11v6" />
							<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
						</svg>
					</Button>
				</div>

				{/* Row 2: Badges */}
				<div class="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 mt-1.5 sm:mt-0">
					{/* Spacer: aligns badges under the title on desktop */}
					<div class="hidden sm:block flex-shrink-0" style="width: 28px;" aria-hidden="true" />
					<div class="flex items-center gap-1.5 flex-wrap">
						<StatusIndicator status={goal.status} />
						{goal.shortId && <GoalShortIdBadge shortId={goal.shortId} />}
					</div>
				</div>
			</div>

			{/* ── Body: two-column layout ── */}
			<div class="flex-1 overflow-auto p-4 sm:p-6">
				<div class="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-6 items-start">
					{/* Main content */}
					<MainContent
						goal={goal}
						roomId={roomId}
						linkedTasks={linkedTasks}
						executions={executions}
						isLoadingExecutions={isLoadingExecutions}
						onLinkTask={linkTask}
					/>

					{/* Status sidebar */}
					<StatusSidebar
						goal={goal}
						availableStatusActions={availableStatusActions}
						isTriggering={isTriggering}
						isUpdating={isUpdating}
						onRunNow={triggerNow}
						onChangeStatus={changeStatus}
					/>
				</div>
			</div>

			{/* ── Edit Modal ── */}
			<Modal
				isOpen={isEditOpen}
				onClose={() => setIsEditOpen(false)}
				title="Edit Mission"
				size="lg"
			>
				<GoalForm
					initialTitle={goal.title}
					initialDescription={goal.description ?? ''}
					initialPriority={goal.priority}
					initialMissionType={goal.missionType ?? 'one_shot'}
					initialAutonomyLevel={goal.autonomyLevel ?? 'supervised'}
					initialMetrics={goal.structuredMetrics ?? []}
					initialSchedule={goal.schedule}
					onSubmit={handleEditSubmit}
					onCancel={() => setIsEditOpen(false)}
					isLoading={isUpdating}
					submitLabel="Save Changes"
				/>
			</Modal>

			{/* ── Delete Confirm Modal ── */}
			<ConfirmModal
				isOpen={isDeleteOpen}
				onClose={() => setIsDeleteOpen(false)}
				onConfirm={handleDelete}
				title="Delete Mission"
				message={`Are you sure you want to delete "${goal.title}"? This action cannot be undone.`}
				confirmText="Delete Mission"
				confirmButtonVariant="danger"
				isLoading={isDeleting}
				confirmTestId="mission-detail-delete-confirm"
			/>
		</div>
	);
}
