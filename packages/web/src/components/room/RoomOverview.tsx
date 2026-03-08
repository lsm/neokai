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
	Room,
	RoomGoal,
	GoalPriority,
	GoalStatus,
	TaskSummary,
	TaskStatus,
	RuntimeState,
} from '@neokai/shared';
import { roomStore } from '../../lib/room-store';
import { navigateToRoomTask } from '../../lib/router';
import { ConfirmModal } from '../ui/ConfirmModal';
import { Skeleton } from '../ui/Skeleton';
import { cn } from '../../lib/utils';
import { t } from '../../lib/i18n';
import { toast } from '../../lib/toast';
import { CheckIcon, ChevronRightIcon } from '../icons/index';

// ─── Priority cycle helper ────────────────────────────────────────────────────

const PRIORITY_ORDER: GoalPriority[] = ['low', 'normal', 'high', 'urgent'];

// ─── Room Context Block (inline-editable) ────────────────────────────────────

function RoomContextBlock({ room }: { room: Room }) {
	const [editingField, setEditingField] = useState<'background' | 'instructions' | null>(null);
	const [draft, setDraft] = useState('');
	const [saving, setSaving] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (editingField && textareaRef.current) {
			textareaRef.current.focus();
			// Move cursor to end
			const len = textareaRef.current.value.length;
			textareaRef.current.setSelectionRange(len, len);
		}
	}, [editingField]);

	const startEdit = (field: 'background' | 'instructions') => {
		setEditingField(field);
		setDraft(field === 'background' ? room.background || '' : room.instructions || '');
	};

	const saveEdit = async () => {
		if (!editingField) return;
		const field = editingField;
		const trimmed = draft.trim();
		const original = field === 'background' ? room.background || '' : room.instructions || '';

		setEditingField(null);
		if (trimmed === original) return;

		setSaving(true);
		try {
			if (field === 'background') {
				await roomStore.updateContext(trimmed || undefined, room.instructions || undefined);
			} else {
				await roomStore.updateContext(room.background || undefined, trimmed || undefined);
			}
			toast.success(t('toast.contextSaved'));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t('toast.saveFailed'));
		} finally {
			setSaving(false);
		}
	};

	const cancelEdit = () => {
		setEditingField(null);
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			cancelEdit();
		}
	};

	const bg = room.background || '';
	const instr = room.instructions || '';

	const renderField = (
		field: 'background' | 'instructions',
		label: string,
		value: string,
		placeholder: string,
		rows: number
	) => (
		<div>
			<h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">{label}</h2>
			{editingField === field ? (
				<textarea
					ref={textareaRef}
					value={draft}
					onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
					onBlur={saveEdit}
					onKeyDown={handleKeyDown}
					class="w-full bg-dark-800 border border-blue-500/50 rounded-lg px-3 py-2 text-sm text-gray-200
						placeholder-gray-600 focus:outline-none resize-y font-mono"
					rows={rows}
					placeholder={placeholder}
				/>
			) : (
				<button
					onClick={() => startEdit(field)}
					class={cn(
						'w-full text-left px-3 py-2 rounded-lg transition-colors text-sm',
						value
							? 'text-gray-300 hover:bg-dark-800/50 line-clamp-3 font-mono'
							: 'text-gray-600 italic hover:bg-dark-800/50 hover:text-gray-500'
					)}
					disabled={saving}
				>
					{value || placeholder}
				</button>
			)}
		</div>
	);

	return (
		<div class="space-y-4">
			{renderField(
				'background',
				t('createRoom.backgroundLabel'),
				bg,
				t('roomContext.contextPlaceholder'),
				4
			)}
			{renderField(
				'instructions',
				t('roomContext.instructions'),
				instr,
				t('roomContext.instructionsPlaceholder'),
				3
			)}
		</div>
	);
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
					class={cn('w-2 h-2 rounded-full', colors[state], state === 'running' && 'animate-pulse')}
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
	const statusConfig: Record<TaskStatus, { dot: string; label: string; animate?: boolean }> = {
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
				class={cn(
					'w-2 h-2 rounded-full flex-shrink-0',
					config.dot,
					config.animate && 'animate-pulse'
				)}
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
					{task.retryCount && task.maxRetries
						? `${t('tasks.failed')} (${task.retryCount}/${task.maxRetries})`
						: t('tasks.failed')}
				</span>
			)}
			{task.status === 'pending' && task.nextRetryAt && (
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-400 flex-shrink-0">
					{t('task.retrying')}
					{task.retryCount && task.maxRetries ? ` ${task.retryCount}/${task.maxRetries}` : ''}
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
	onRetryTask,
	onUpdate,
	onDelete,
}: {
	goal: RoomGoal;
	tasks: TaskSummary[];
	allTasks: TaskSummary[];
	onTaskClick?: (taskId: string) => void;
	onApprove?: (taskId: string) => void;
	onRetryTask?: (taskId: string) => void;
	onUpdate: (updates: Partial<RoomGoal>) => Promise<void>;
	onDelete: () => Promise<void>;
}) {
	const [showActions, setShowActions] = useState(false);
	const [editingTitle, setEditingTitle] = useState(false);
	const [editingDesc, setEditingDesc] = useState(false);
	const [titleDraft, setTitleDraft] = useState(goal.title);
	const [descDraft, setDescDraft] = useState(goal.description ?? '');
	const [tasksExpanded, setTasksExpanded] = useState(false);
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

	const [showPriorityMenu, setShowPriorityMenu] = useState(false);

	const handlePrioritySelect = (p: GoalPriority) => {
		setShowPriorityMenu(false);
		if (p !== goal.priority) {
			onUpdate({ priority: p });
		}
	};

	const linkedTasks = goal.linkedTaskIds
		.map((id) => tasks.find((t) => t.id === id))
		.filter((t): t is TaskSummary => t !== undefined);

	// Split tasks into "attention-needed" (always visible) and "rest" (collapsible)
	const attentionStatuses = new Set<TaskStatus>(['in_progress', 'review', 'failed']);
	const attentionTasks = linkedTasks.filter((t) => attentionStatuses.has(t.status));
	const restTasks = linkedTasks.filter((t) => !attentionStatuses.has(t.status));

	const activeTasks = linkedTasks.filter(
		(t) => t.status === 'in_progress' || t.status === 'review'
	);
	const completedTasks = linkedTasks.filter((t) => t.status === 'completed');
	const failedTasks = linkedTasks.filter((t) => t.status === 'failed');

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
		urgent: {
			text: t('goals.priority.urgent'),
			class: 'text-red-400 bg-red-900/20 hover:bg-red-900/30',
		},
		high: {
			text: t('goals.priority.high'),
			class: 'text-orange-400 bg-orange-900/20 hover:bg-orange-900/30',
		},
		normal: {
			text: t('goals.priority.normal'),
			class: 'text-gray-400 bg-dark-700 hover:bg-dark-600',
		},
		low: { text: t('goals.priority.low'), class: 'text-gray-500 bg-dark-700 hover:bg-dark-600' },
	};
	const priority = priorityConfig[goal.priority];

	return (
		<div class={cn('bg-dark-850 border rounded-xl transition-colors', style.border)}>
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
						<span
							class={cn('text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0', style.badge)}
						>
							{style.badgeText}
						</span>
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
									{failedTasks.length > 0 && onRetryTask && (
										<button
											class="w-full px-3 py-1.5 text-sm text-left text-amber-400 hover:bg-dark-800 transition-colors"
											onClick={() => {
												setShowActions(false);
												for (const task of failedTasks) {
													onRetryTask(task.id);
												}
											}}
										>
											{t('goals.retryFailed', { count: failedTasks.length })}
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
						<span class="text-xs text-gray-500 w-8 text-right flex-shrink-0">{goal.progress}%</span>
					</div>
				)}

				{/* Task summary + priority line */}
				<div class="flex items-center gap-3 text-xs text-gray-500 mt-2">
					{linkedTasks.length > 0 && (
						<>
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
						</>
					)}
					{/* Priority dropdown — right-aligned in summary row */}
					{priority && (
						<div class="relative flex items-center ml-auto">
							<button
								onClick={(e) => {
									e.stopPropagation();
									setShowPriorityMenu(!showPriorityMenu);
								}}
								class={cn(
									'text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors cursor-pointer inline-flex items-center gap-0.5',
									priority.class
								)}
							>
								{priority.text}
								<svg
									class="w-2.5 h-2.5 opacity-60"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2.5"
										d="M19 9l-7 7-7-7"
									/>
								</svg>
							</button>
							{showPriorityMenu && (
								<>
									<div class="fixed inset-0 z-10" onClick={() => setShowPriorityMenu(false)} />
									<div class="absolute right-0 top-full mt-1 z-20 bg-dark-900 border border-dark-700 rounded-lg shadow-2xl py-1 min-w-[80px]">
										{PRIORITY_ORDER.map((p) => {
											const cfg = priorityConfig[p];
											if (!cfg) return null;
											return (
												<button
													key={p}
													class={cn(
														'w-full px-3 py-1.5 text-xs text-left transition-colors hover:bg-dark-800',
														p === goal.priority ? 'font-semibold' : '',
														cfg.class.split(' ').find((c) => c.startsWith('text-')) ??
															'text-gray-300'
													)}
													onClick={(e) => {
														e.stopPropagation();
														handlePrioritySelect(p);
													}}
												>
													{cfg.text}
												</button>
											);
										})}
									</div>
								</>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Task list — attention tasks always visible, rest collapsible */}
			{linkedTasks.length > 0 && (
				<div class="border-t border-dark-700/50">
					{/* Attention tasks: in_progress, review, failed — always shown */}
					{attentionTasks.length > 0 && (
						<div class="px-1 py-1">
							{attentionTasks.map((task) => (
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

					{/* Expand/collapse toggle for remaining tasks */}
					{restTasks.length > 0 && (
						<>
							{tasksExpanded && (
								<div
									class={cn(
										'px-1 py-1',
										attentionTasks.length > 0 && 'border-t border-dark-700/30'
									)}
								>
									{restTasks.map((task) => (
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
							<button
								onClick={() => setTasksExpanded(!tasksExpanded)}
								class={cn(
									'w-full px-4 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-dark-800/50 transition-colors flex items-center justify-center gap-1.5',
									(attentionTasks.length > 0 || tasksExpanded) && 'border-t border-dark-700/30'
								)}
							>
								<svg
									class={cn('w-3 h-3 transition-transform', tasksExpanded && 'rotate-180')}
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M19 9l-7 7-7-7"
									/>
								</svg>
								{tasksExpanded
									? t('goals.tasks.hide')
									: t('goals.tasks.showMore', { count: restTasks.length })}
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Inline Create Goal Card ──────────────────────────────────────────────────

function FloatingGoalInput({
	onSubmit,
}: {
	onSubmit: (data: {
		title: string;
		description?: string;
		priority?: GoalPriority;
	}) => Promise<void>;
}) {
	const [title, setTitle] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async () => {
		const trimmed = title.trim();
		if (!trimmed || submitting) return;
		setSubmitting(true);
		try {
			await onSubmit({ title: trimmed });
			setTitle('');
		} catch {
			// handled upstream
		} finally {
			setSubmitting(false);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div class="border-t border-dark-700 bg-dark-900/80 backdrop-blur-sm px-4 py-3 flex-shrink-0">
			<div class="max-w-3xl mx-auto flex items-center gap-3">
				<input
					type="text"
					value={title}
					onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
					onKeyDown={handleKeyDown}
					placeholder={t('goals.form.titlePlaceholder')}
					disabled={submitting}
					class="flex-1 text-sm text-gray-100 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 outline-none placeholder:text-gray-600 focus:border-blue-600 transition-colors"
				/>
				<button
					onClick={handleSubmit}
					disabled={!title.trim() || submitting}
					class="px-3 py-2 text-sm font-medium text-blue-400 hover:text-blue-300 bg-blue-900/20 hover:bg-blue-900/30 border border-blue-700/50 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
				>
					{t('goals.addGoal')}
				</button>
			</div>
		</div>
	);
}

// ─── Main RoomOverview ────────────────────────────────────────────────────────

export function RoomOverview({
	roomId,
	room,
	onCreateGoal,
	onUpdateGoal,
	onDeleteGoal,
	onLinkTask: _onLinkTask,
}: {
	roomId: string;
	room: Room;
	onCreateGoal: (goal: {
		title: string;
		description?: string;
		priority?: GoalPriority;
	}) => Promise<void>;
	onUpdateGoal: (goalId: string, updates: Partial<RoomGoal>) => Promise<void>;
	onDeleteGoal: (goalId: string) => Promise<void>;
	onLinkTask: (goalId: string, taskId: string) => Promise<void>;
}) {
	const [actionLoading, setActionLoading] = useState(false);
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
		const statusOrder: Record<GoalStatus, number> = {
			active: 0,
			needs_human: 1,
			completed: 2,
			archived: 3,
		};
		if (statusOrder[a.status] !== statusOrder[b.status])
			return statusOrder[a.status] - statusOrder[b.status];
		const priorityOrder: Record<GoalPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
		if (priorityOrder[a.priority] !== priorityOrder[b.priority])
			return priorityOrder[a.priority] - priorityOrder[b.priority];
		return b.createdAt - a.createdAt;
	});

	// Tasks not linked to any goal
	const linkedTaskIds = new Set(goals.flatMap((g) => g.linkedTaskIds));
	const unlinkedTasks = tasks.filter((t) => !linkedTaskIds.has(t.id));

	// Runtime actions
	const handlePause = async () => {
		setActionLoading(true);
		try {
			await roomStore.pauseRuntime();
		} catch {
			/* store handles */
		} finally {
			setActionLoading(false);
			setShowPauseConfirm(false);
		}
	};
	const handleResume = async () => {
		setActionLoading(true);
		try {
			await roomStore.resumeRuntime();
		} catch {
			/* store handles */
		} finally {
			setActionLoading(false);
		}
	};
	const handleStop = async () => {
		setActionLoading(true);
		try {
			await roomStore.stopRuntime();
		} catch {
			/* store handles */
		} finally {
			setActionLoading(false);
			setShowStopConfirm(false);
		}
	};
	const handleStart = async () => {
		setActionLoading(true);
		try {
			await roomStore.startRuntime();
		} catch {
			/* store handles */
		} finally {
			setActionLoading(false);
		}
	};
	const handleApprove = async () => {
		const taskId = showApproveConfirm;
		if (!taskId) return;
		setApprovalLoading(true);
		try {
			await roomStore.approveTask(taskId);
		} catch {
			/* store handles */
		} finally {
			setApprovalLoading(false);
			setShowApproveConfirm(null);
		}
	};

	return (
		<div class="h-full flex flex-col overflow-hidden">
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-3xl mx-auto px-4 py-5 space-y-6">
					{/* Room context (background + instructions) */}
					<RoomContextBlock room={room} />

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
						<h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
							{t('goals.title')}
						</h2>

						{goalsLoading ? (
							<div class="space-y-3">
								{[1, 2].map((i) => (
									<div key={i} class="bg-dark-850 border border-dark-700 rounded-xl p-4">
										<Skeleton width="50%" height={18} class="mb-2" />
										<Skeleton width="100%" height={6} />
									</div>
								))}
							</div>
						) : sortedGoals.length === 0 ? (
							<div class="bg-dark-850 border border-dark-700 border-dashed rounded-xl p-8 text-center">
								<CheckIcon className="w-10 h-10 text-gray-700 mx-auto mb-3" />
								<p class="text-sm font-medium text-gray-300 mb-1">{t('goals.empty.title')}</p>
								<p class="text-xs text-gray-500">{t('goals.empty.desc')}</p>
							</div>
						) : (
							<div class="space-y-3">
								{sortedGoals.map((goal) => (
									<GoalCard
										key={goal.id}
										goal={goal}
										tasks={tasks}
										allTasks={tasks}
										onTaskClick={
											roomId ? (taskId) => navigateToRoomTask(roomId, taskId) : undefined
										}
										onApprove={(taskId) => setShowApproveConfirm(taskId)}
										onRetryTask={(taskId) => void roomStore.retryTask(taskId)}
										onUpdate={(updates) => onUpdateGoal(goal.id, updates)}
										onDelete={() => onDeleteGoal(goal.id)}
									/>
								))}
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
			</div>

			{/* Floating goal input */}
			<FloatingGoalInput onSubmit={onCreateGoal} />

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
