/**
 * RoomOverview Component — Apple-inspired Room Dashboard
 *
 * Design philosophy:
 * - Goals are the primary unit of work (center stage)
 * - Tasks are inline under their parent Goal (progressive disclosure)
 * - Runtime status is a compact bar (not a hero element)
 * - Unlinked tasks surface in a dedicated "Activity" section
 * - Inline editing: click title/description to edit in-place, auto-save on blur
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type {
	RoomGoal,
	GoalPriority,
	GoalStatus,
	TaskSummary,
	TaskStatus,
	RuntimeState,
} from '@neokai/shared';
import { roomStore } from '../../lib/room-store';
import { navigateToRoomTask } from '../../lib/router';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { Skeleton } from '../ui/Skeleton';
import { cn } from '../../lib/utils';
import { t } from '../../lib/i18n';
import { PlusIcon, CheckIcon, ChevronRightIcon } from '../icons/index';

// ─── Priority cycle helper ────────────────────────────────────────────────────

const PRIORITY_ORDER: GoalPriority[] = ['low', 'normal', 'high', 'urgent'];

function nextPriority(current: GoalPriority): GoalPriority {
	const idx = PRIORITY_ORDER.indexOf(current);
	return PRIORITY_ORDER[(idx + 1) % PRIORITY_ORDER.length];
}

// ─── Runtime Status Bar ───────────────────────────────────────────────────────

function RuntimeBar({
	state,
	onPause,
	onResume,
	onStop,
	onStart,
	loading,
}: {
	state: RuntimeState | null;
	onPause: () => void;
	onResume: () => void;
	onStop: () => void;
	onStart: () => void;
	loading: boolean;
}) {
	if (!state) return null;

	const colors: Record<RuntimeState, string> = {
		running: 'bg-green-500',
		paused: 'bg-yellow-500',
		stopped: 'bg-gray-500',
	};

	return (
		<div class="flex items-center justify-between px-4 py-2.5 bg-dark-850 border border-dark-700 rounded-xl">
			<div class="flex items-center gap-2">
				<div
					class={cn(
						'w-2 h-2 rounded-full',
						colors[state],
						state === 'running' && 'animate-pulse'
					)}
				/>
				<span class="text-sm text-gray-300 capitalize">{state}</span>
			</div>
			<div class="flex items-center gap-1.5">
				{state === 'running' && (
					<button
						onClick={onPause}
						disabled={loading}
						class="px-2.5 py-1 text-xs font-medium text-yellow-400 hover:bg-yellow-900/20 rounded-md transition-colors disabled:opacity-50"
					>
						{t('room.runtime.pause')}
					</button>
				)}
				{state === 'paused' && (
					<button
						onClick={onResume}
						disabled={loading}
						class="px-2.5 py-1 text-xs font-medium text-green-400 hover:bg-green-900/20 rounded-md transition-colors disabled:opacity-50"
					>
						{t('room.runtime.resume')}
					</button>
				)}
				{state !== 'stopped' && (
					<button
						onClick={onStop}
						disabled={loading}
						class="px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-900/20 rounded-md transition-colors disabled:opacity-50"
					>
						{t('room.runtime.stop')}
					</button>
				)}
				{state === 'stopped' && (
					<button
						onClick={onStart}
						disabled={loading}
						class="px-2.5 py-1 text-xs font-medium text-green-400 hover:bg-green-900/20 rounded-md transition-colors disabled:opacity-50"
					>
						{t('room.runtime.start')}
					</button>
				)}
			</div>
		</div>
	);
}

// ─── Inline Task Row ──────────────────────────────────────────────────────────

function TaskRow({
	task,
	allTasks,
	onClick,
	onApprove,
}: {
	task: TaskSummary;
	allTasks: TaskSummary[];
	onClick?: (taskId: string) => void;
	onApprove?: (taskId: string) => void;
}) {
	const statusConfig: Record<
		TaskStatus,
		{ dot: string; label: string; animate?: boolean }
	> = {
		in_progress: { dot: 'bg-yellow-500', label: t('tasks.status.inProgress'), animate: true },
		review: { dot: 'bg-purple-500', label: t('tasks.status.review') },
		pending: { dot: 'bg-gray-400', label: t('tasks.status.pending') },
		draft: { dot: 'bg-gray-600', label: t('tasks.status.draft') },
		completed: { dot: 'bg-green-500', label: t('tasks.status.completed') },
		failed: { dot: 'bg-red-500', label: t('tasks.status.failed') },
		cancelled: { dot: 'bg-gray-600', label: t('tasks.status.cancelled') },
	};

	const config = statusConfig[task.status] ?? statusConfig.pending;
	const isClickable = !!onClick;
	const isBlocked =
		task.status === 'pending' &&
		task.dependsOn?.some((depId) => {
			const dep = allTasks.find((t) => t.id === depId);
			return !dep || dep.status !== 'completed';
		});

	return (
		<div
			class={cn(
				'flex items-center gap-3 px-3 py-2 rounded-lg group',
				isClickable && 'hover:bg-dark-700/50 transition-colors cursor-pointer'
			)}
			onClick={isClickable ? () => onClick(task.id) : undefined}
		>
			{/* Status dot */}
			<div
				class={cn('w-2 h-2 rounded-full flex-shrink-0', config.dot, config.animate && 'animate-pulse')}
				title={config.label}
			/>

			{/* Title */}
			<span class="text-sm text-gray-200 truncate flex-1">{task.title}</span>

			{/* Badges */}
			{isBlocked && (
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/30 text-orange-400 flex-shrink-0">
					{t('tasks.blocked')}
				</span>
			)}
			{task.status === 'failed' && (
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-400 flex-shrink-0">
					{t('tasks.failed')}
				</span>
			)}

			{/* Progress */}
			{task.progress !== undefined && task.status === 'in_progress' && (
				<span class="text-xs text-gray-500 flex-shrink-0">{task.progress}%</span>
			)}

			{/* Approve button */}
			{task.status === 'review' && onApprove && (
				<button
					onClick={(e) => {
						e.stopPropagation();
						onApprove(task.id);
					}}
					class="px-2 py-0.5 text-xs font-medium text-green-400 bg-green-900/20 hover:bg-green-900/40 rounded transition-colors flex-shrink-0"
				>
					{t('tasks.approve')}
				</button>
			)}

			{/* Arrow */}
			{isClickable && (
				<ChevronRightIcon className="w-3.5 h-3.5 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
			)}
		</div>
	);
}

// ─── Goal Card (inline editing) ───────────────────────────────────────────────

function GoalCard({
	goal,
	tasks,
	allTasks,
	onTaskClick,
	onApprove,
	onUpdate,
	onDelete,
}: {
	goal: RoomGoal;
	tasks: TaskSummary[];
	allTasks: TaskSummary[];
	onTaskClick?: (taskId: string) => void;
	onApprove?: (taskId: string) => void;
	onUpdate: (updates: Partial<RoomGoal>) => Promise<void>;
	onDelete: () => Promise<void>;
}) {
	const [showActions, setShowActions] = useState(false);
	const [editingTitle, setEditingTitle] = useState(false);
	const [editingDesc, setEditingDesc] = useState(false);
	const [titleDraft, setTitleDraft] = useState(goal.title);
	const [descDraft, setDescDraft] = useState(goal.description ?? '');
	const titleRef = useRef<HTMLInputElement>(null);
	const descRef = useRef<HTMLTextAreaElement>(null);

	// Sync drafts when goal changes externally
	useEffect(() => {
		if (!editingTitle) setTitleDraft(goal.title);
	}, [goal.title, editingTitle]);
	useEffect(() => {
		if (!editingDesc) setDescDraft(goal.description ?? '');
	}, [goal.description, editingDesc]);

	// Auto-focus when entering edit mode
	useEffect(() => {
		if (editingTitle) titleRef.current?.focus();
	}, [editingTitle]);
	useEffect(() => {
		if (editingDesc) descRef.current?.focus();
	}, [editingDesc]);

	const saveTitle = () => {
		setEditingTitle(false);
		const trimmed = titleDraft.trim();
		if (trimmed && trimmed !== goal.title) {
			onUpdate({ title: trimmed });
		} else {
			setTitleDraft(goal.title);
		}
	};

	const saveDesc = () => {
		setEditingDesc(false);
		const trimmed = descDraft.trim();
		if (trimmed !== (goal.description ?? '')) {
			onUpdate({ description: trimmed || undefined });
		}
	};

	const handleTitleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			saveTitle();
		} else if (e.key === 'Escape') {
			setTitleDraft(goal.title);
			setEditingTitle(false);
		}
	};

	const handleDescKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			setDescDraft(goal.description ?? '');
			setEditingDesc(false);
		}
	};

	const handlePriorityClick = (e: MouseEvent) => {
		e.stopPropagation();
		onUpdate({ priority: nextPriority(goal.priority) });
	};

	const linkedTasks = goal.linkedTaskIds
		.map((id) => tasks.find((t) => t.id === id))
		.filter((t): t is TaskSummary => t !== undefined);

	const activeTasks = linkedTasks.filter(
		(t) => t.status === 'in_progress' || t.status === 'review'
	);
	const completedTasks = linkedTasks.filter((t) => t.status === 'completed');

	const statusStyles: Record<GoalStatus, { border: string; badge: string; badgeText: string }> = {
		active: {
			border: 'border-blue-800/40',
			badge: 'bg-blue-900/30 text-blue-400',
			badgeText: t('goals.status.active'),
		},
		needs_human: {
			border: 'border-yellow-800/40',
			badge: 'bg-yellow-900/30 text-yellow-400',
			badgeText: t('goals.status.needsInput'),
		},
		completed: {
			border: 'border-green-800/40',
			badge: 'bg-green-900/30 text-green-400',
			badgeText: t('goals.status.completed'),
		},
		archived: {
			border: 'border-dark-600',
			badge: 'bg-dark-700 text-gray-500',
			badgeText: t('goals.status.archived'),
		},
	};

	const style = statusStyles[goal.status];

	const priorityConfig: Record<GoalPriority, { text: string; class: string } | null> = {
		urgent: { text: t('goals.priority.urgent'), class: 'text-red-400 bg-red-900/20 hover:bg-red-900/30' },
		high: { text: t('goals.priority.high'), class: 'text-orange-400 bg-orange-900/20 hover:bg-orange-900/30' },
		normal: { text: t('goals.priority.normal'), class: 'text-gray-400 bg-dark-700 hover:bg-dark-600' },
		low: { text: t('goals.priority.low'), class: 'text-gray-500 bg-dark-700 hover:bg-dark-600' },
	};
	const priority = priorityConfig[goal.priority];

	return (
		<div
			class={cn(
				'bg-dark-850 border rounded-xl transition-colors',
				style.border
			)}
		>
			{/* Card header */}
			<div class="px-4 pt-4 pb-3">
				<div class="flex items-start justify-between gap-2 mb-1">
					<div class="flex items-center gap-2 min-w-0 flex-1">
						{/* Inline-editable title */}
						{editingTitle ? (
							<input
								ref={titleRef}
								type="text"
								value={titleDraft}
								onInput={(e) => setTitleDraft((e.target as HTMLInputElement).value)}
								onBlur={saveTitle}
								onKeyDown={handleTitleKeyDown}
								class="text-base font-semibold text-gray-100 bg-transparent border-b border-blue-500 outline-none min-w-0 flex-1 py-0"
							/>
						) : (
							<h3
								class="text-base font-semibold text-gray-100 truncate cursor-text hover:text-white transition-colors"
								onClick={() => setEditingTitle(true)}
								title={t('goals.clickToEdit')}
							>
								{goal.title}
							</h3>
						)}
						<span class={cn('text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0', style.badge)}>
							{style.badgeText}
						</span>
						{/* Clickable priority badge */}
						{priority && (
							<button
								onClick={handlePriorityClick}
								class={cn(
									'text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 transition-colors cursor-pointer',
									priority.class
								)}
								title={t('goals.clickToChangePriority')}
							>
								{priority.text}
							</button>
						)}
					</div>
					<div class="relative flex-shrink-0">
						<button
							onClick={() => setShowActions(!showActions)}
							class="p-1 text-gray-500 hover:text-gray-300 hover:bg-dark-700 rounded transition-colors"
						>
							<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
								<path d="M3 9.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
							</svg>
						</button>
						{showActions && (
							<>
								<div class="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
								<div class="absolute right-0 top-full mt-1 z-20 bg-dark-900 border border-dark-700 rounded-lg shadow-2xl py-1 min-w-[120px]">
									{goal.status === 'active' && (
										<button
											class="w-full px-3 py-1.5 text-sm text-left text-green-400 hover:bg-dark-800 transition-colors"
											onClick={() => {
												setShowActions(false);
												onUpdate({ status: 'completed' });
											}}
										>
											{t('goals.complete')}
										</button>
									)}
									{goal.status !== 'active' && goal.status !== 'archived' && (
										<button
											class="w-full px-3 py-1.5 text-sm text-left text-blue-400 hover:bg-dark-800 transition-colors"
											onClick={() => {
												setShowActions(false);
												onUpdate({ status: 'active' });
											}}
										>
											{t('goals.reactivate')}
										</button>
									)}
									<button
										class="w-full px-3 py-1.5 text-sm text-left text-red-400 hover:bg-dark-800 transition-colors"
										onClick={() => {
											setShowActions(false);
											onDelete();
										}}
									>
										{t('common.delete')}
									</button>
								</div>
							</>
						)}
					</div>
				</div>

				{/* Inline-editable description */}
				{editingDesc ? (
					<textarea
						ref={descRef}
						value={descDraft}
						onInput={(e) => setDescDraft((e.target as HTMLTextAreaElement).value)}
						onBlur={saveDesc}
						onKeyDown={handleDescKeyDown}
						class="w-full text-sm text-gray-300 bg-transparent border-b border-blue-500 outline-none resize-none mb-3"
						rows={2}
						placeholder={t('goals.form.descriptionPlaceholder')}
					/>
				) : (
					<p
						class={cn(
							'text-sm mb-3 cursor-text transition-colors',
							goal.description
								? 'text-gray-400 line-clamp-2 hover:text-gray-300'
								: 'text-gray-600 italic hover:text-gray-500'
						)}
						onClick={() => setEditingDesc(true)}
					>
						{goal.description || t('goals.addDescription')}
					</p>
				)}

				{/* Progress bar */}
				{goal.progress > 0 && (
					<div class="flex items-center gap-2.5 mb-1">
						<div class="flex-1 h-1.5 bg-dark-700 rounded-full overflow-hidden">
							<div
								class={cn(
									'h-full rounded-full transition-all duration-500',
									goal.progress >= 100 ? 'bg-green-500' : 'bg-blue-500'
								)}
								style={{ width: `${Math.min(goal.progress, 100)}%` }}
							/>
						</div>
						<span class="text-xs text-gray-500 w-8 text-right flex-shrink-0">
							{goal.progress}%
						</span>
					</div>
				)}

				{/* Task summary line */}
				{linkedTasks.length > 0 && (
					<div class="flex items-center gap-3 text-xs text-gray-500 mt-2">
						{activeTasks.length > 0 && (
							<span class="flex items-center gap-1">
								<span class="w-1.5 h-1.5 rounded-full bg-yellow-500" />
								{t('tasks.taskSummary.active', { count: activeTasks.length })}
							</span>
						)}
						{completedTasks.length > 0 && (
							<span class="flex items-center gap-1">
								<span class="w-1.5 h-1.5 rounded-full bg-green-500" />
								{t('tasks.taskSummary.done', { count: completedTasks.length })}
							</span>
						)}
						<span>{t('tasks.taskSummary.total', { count: linkedTasks.length })}</span>
					</div>
				)}
			</div>

			{/* Inline task list */}
			{linkedTasks.length > 0 && (
				<div class="border-t border-dark-700/50 px-1 py-1">
					{linkedTasks.map((task) => (
						<TaskRow
							key={task.id}
							task={task}
							allTasks={allTasks}
							onClick={onTaskClick}
							onApprove={onApprove}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ─── Inline Create Goal Card ──────────────────────────────────────────────────

function InlineCreateGoal({
	onSubmit,
	onCancel,
}: {
	onSubmit: (data: { title: string; description?: string; priority?: GoalPriority }) => Promise<void>;
	onCancel: () => void;
}) {
	const [title, setTitle] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSubmit = async () => {
		const trimmed = title.trim();
		if (!trimmed || submitting) return;
		setSubmitting(true);
		try {
			await onSubmit({ title: trimmed });
		} catch {
			// handled upstream
		} finally {
			setSubmitting(false);
			onCancel();
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleSubmit();
		} else if (e.key === 'Escape') {
			onCancel();
		}
	};

	return (
		<div class="bg-dark-850 border border-blue-800/40 rounded-xl px-4 py-3">
			<input
				ref={inputRef}
				type="text"
				value={title}
				onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
				onKeyDown={handleKeyDown}
				onBlur={() => {
					if (!title.trim()) onCancel();
				}}
				placeholder={t('goals.form.titlePlaceholder')}
				disabled={submitting}
				class="w-full text-base font-semibold text-gray-100 bg-transparent outline-none placeholder:text-gray-600"
			/>
			<p class="text-xs text-gray-600 mt-1.5">
				{t('goals.inlineCreateHint')}
			</p>
		</div>
	);
}

// ─── Main RoomOverview ────────────────────────────────────────────────────────

export function RoomOverview({
	roomId,
	onCreateGoal,
	onUpdateGoal,
	onDeleteGoal,
	onLinkTask: _onLinkTask,
}: {
	roomId: string;
	onCreateGoal: (goal: { title: string; description?: string; priority?: GoalPriority }) => Promise<void>;
	onUpdateGoal: (goalId: string, updates: Partial<RoomGoal>) => Promise<void>;
	onDeleteGoal: (goalId: string) => Promise<void>;
	onLinkTask: (goalId: string, taskId: string) => Promise<void>;
}) {
	const [actionLoading, setActionLoading] = useState(false);
	const [showInlineCreate, setShowInlineCreate] = useState(false);
	const [showPauseConfirm, setShowPauseConfirm] = useState(false);
	const [showStopConfirm, setShowStopConfirm] = useState(false);
	const [showApproveConfirm, setShowApproveConfirm] = useState<string | null>(null);
	const [approvalLoading, setApprovalLoading] = useState(false);

	const goals = roomStore.goals.value;
	const tasks = roomStore.tasks.value;
	const runtimeState = roomStore.runtimeState.value;
	const goalsLoading = roomStore.goalsLoading.value;

	// Sort goals: active > needs_human > completed > archived, then priority, then newest
	const sortedGoals = [...goals].sort((a, b) => {
		const statusOrder: Record<GoalStatus, number> = { active: 0, needs_human: 1, completed: 2, archived: 3 };
		if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
		const priorityOrder: Record<GoalPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
		if (priorityOrder[a.priority] !== priorityOrder[b.priority]) return priorityOrder[a.priority] - priorityOrder[b.priority];
		return b.createdAt - a.createdAt;
	});

	// Tasks not linked to any goal
	const linkedTaskIds = new Set(goals.flatMap((g) => g.linkedTaskIds));
	const unlinkedTasks = tasks.filter((t) => !linkedTaskIds.has(t.id));

	// Runtime actions
	const handlePause = async () => {
		setActionLoading(true);
		try { await roomStore.pauseRuntime(); } catch { /* store handles */ } finally { setActionLoading(false); setShowPauseConfirm(false); }
	};
	const handleResume = async () => {
		setActionLoading(true);
		try { await roomStore.resumeRuntime(); } catch { /* store handles */ } finally { setActionLoading(false); }
	};
	const handleStop = async () => {
		setActionLoading(true);
		try { await roomStore.stopRuntime(); } catch { /* store handles */ } finally { setActionLoading(false); setShowStopConfirm(false); }
	};
	const handleStart = async () => {
		setActionLoading(true);
		try { await roomStore.startRuntime(); } catch { /* store handles */ } finally { setActionLoading(false); }
	};
	const handleApprove = async () => {
		const taskId = showApproveConfirm;
		if (!taskId) return;
		setApprovalLoading(true);
		try { await roomStore.approveTask(taskId); } catch { /* store handles */ } finally { setApprovalLoading(false); setShowApproveConfirm(null); }
	};

	return (
		<div class="h-full overflow-y-auto">
			<div class="max-w-3xl mx-auto px-4 py-5 space-y-4">
				{/* Runtime status bar */}
				<RuntimeBar
					state={runtimeState}
					onPause={() => setShowPauseConfirm(true)}
					onResume={handleResume}
					onStop={() => setShowStopConfirm(true)}
					onStart={handleStart}
					loading={actionLoading}
				/>

				{/* Goals section */}
				<div>
					<div class="flex items-center justify-between mb-3">
						<h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide">{t('goals.title')}</h2>
						<button
							onClick={() => setShowInlineCreate(true)}
							class="flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
						>
							<PlusIcon className="w-3.5 h-3.5" />
							{t('goals.addGoal')}
						</button>
					</div>

					{goalsLoading ? (
						<div class="space-y-3">
							{[1, 2].map((i) => (
								<div key={i} class="bg-dark-850 border border-dark-700 rounded-xl p-4">
									<Skeleton width="50%" height={18} class="mb-2" />
									<Skeleton width="100%" height={6} />
								</div>
							))}
						</div>
					) : sortedGoals.length === 0 && !showInlineCreate ? (
						<div class="bg-dark-850 border border-dark-700 border-dashed rounded-xl p-8 text-center">
							<CheckIcon className="w-10 h-10 text-gray-700 mx-auto mb-3" />
							<p class="text-sm font-medium text-gray-300 mb-1">{t('goals.empty.title')}</p>
							<p class="text-xs text-gray-500 mb-4">
								{t('goals.empty.desc')}
							</p>
							<Button size="sm" onClick={() => setShowInlineCreate(true)}>
								{t('goals.createFirst')}
							</Button>
						</div>
					) : (
						<div class="space-y-3">
							{sortedGoals.map((goal) => (
								<GoalCard
									key={goal.id}
									goal={goal}
									tasks={tasks}
									allTasks={tasks}
									onTaskClick={roomId ? (taskId) => navigateToRoomTask(roomId, taskId) : undefined}
									onApprove={(taskId) => setShowApproveConfirm(taskId)}
									onUpdate={(updates) => onUpdateGoal(goal.id, updates)}
									onDelete={() => onDeleteGoal(goal.id)}
								/>
							))}
							{showInlineCreate && (
								<InlineCreateGoal
									onSubmit={onCreateGoal}
									onCancel={() => setShowInlineCreate(false)}
								/>
							)}
						</div>
					)}
				</div>

				{/* Unlinked tasks (activity outside of goals) */}
				{unlinkedTasks.length > 0 && (
					<div>
						<h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
							{t('tasks.activity')}
						</h2>
						<div class="bg-dark-850 border border-dark-700 rounded-xl px-1 py-1">
							{unlinkedTasks.map((task) => (
								<TaskRow
									key={task.id}
									task={task}
									allTasks={tasks}
									onClick={roomId ? (taskId) => navigateToRoomTask(roomId, taskId) : undefined}
									onApprove={(taskId) => setShowApproveConfirm(taskId)}
								/>
							))}
						</div>
					</div>
				)}

			</div>

			{/* Pause Confirmation */}
			<ConfirmModal
				isOpen={showPauseConfirm}
				onClose={() => setShowPauseConfirm(false)}
				onConfirm={handlePause}
				title={t('room.runtime.pauseTitle')}
				message={t('room.runtime.pauseMessage')}
				confirmText={t('room.runtime.pause')}
				confirmButtonVariant="primary"
				isLoading={actionLoading}
			/>

			{/* Stop Confirmation */}
			<ConfirmModal
				isOpen={showStopConfirm}
				onClose={() => setShowStopConfirm(false)}
				onConfirm={handleStop}
				title={t('room.runtime.stopTitle')}
				message={t('room.runtime.stopMessage')}
				confirmText={t('room.runtime.stop')}
				isLoading={actionLoading}
			/>

			{/* Approve Task Confirmation */}
			<ConfirmModal
				isOpen={showApproveConfirm !== null}
				onClose={() => setShowApproveConfirm(null)}
				onConfirm={handleApprove}
				title={t('tasks.approveTitle')}
				message={t('tasks.approveMessage')}
				confirmText={t('tasks.approve')}
				confirmButtonVariant="primary"
				isLoading={approvalLoading}
			/>
		</div>
	);
}
