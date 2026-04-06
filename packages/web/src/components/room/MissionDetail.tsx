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
import type { RoomGoal } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { navigateToRoom } from '../../lib/router';
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
} from './GoalsEditor';
import type { CreateGoalFormData } from './GoalsEditor';

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
		availableStatusActions,
		isUpdating,
		isTriggering,
		isDeleting,
		updateGoal,
		deleteGoal,
		triggerNow,
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
			structuredMetrics: data.structuredMetrics,
			schedule: data.schedule,
		});
		setIsEditOpen(false);
	};

	const handleDelete = async () => {
		await deleteGoal();
		setIsDeleteOpen(false);
	};

	// ── Loading state ──────────────────────────────────────────────────────────
	if (goal === null) {
		// Distinguish between "still loading" (goalId provided) and "not found":
		// roomStore.goals starts empty and populates asynchronously. Show skeleton
		// first, then "not found" is shown only if goalId has no match once goals
		// are populated (i.e., the store has items but none match).
		return <MissionDetailSkeleton />;
	}

	// ── Not found state ────────────────────────────────────────────────────────
	// (unreachable in practice — we return skeleton above; kept for type safety)

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
					{/* Main content — placeholder for next task */}
					<div
						class="bg-dark-850 border border-dark-700 rounded-lg p-4 min-h-[200px] flex items-center justify-center text-gray-500 text-sm"
						data-testid="mission-detail-main-content"
					>
						<span>Mission content coming soon…</span>
					</div>

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
