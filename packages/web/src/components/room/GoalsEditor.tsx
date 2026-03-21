/**
 * GoalsEditor Component
 *
 * Provides CRUD operations for room missions with progress tracking.
 * Features:
 * - Create, edit, and delete missions
 * - Mission type selector (one-shot, measurable, recurring)
 * - Conditional fields for measurable (metrics) and recurring (schedule)
 * - Autonomy level selector with descriptions
 * - Type-specific detail views
 * - Status and priority badges with visual indicators
 * - Progress bar with color-coded completion
 * - Link/unlink tasks to missions
 * - Expandable mission details view
 * - Notification feed for auto-completed tasks
 */

import { useState, useEffect } from 'preact/hooks';
import type {
	RoomGoal,
	GoalPriority,
	GoalStatus,
	TaskSummary,
	TaskStatus,
	MissionType,
	AutonomyLevel,
	MissionMetric,
	CronSchedule,
	MissionExecution,
} from '@neokai/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Modal } from '../ui/Modal';
import { ConfirmModal } from '../ui/ConfirmModal';
import { Skeleton } from '../ui/Skeleton';

// ─── Create Form Types ────────────────────────────────────────────────────────

export interface CreateGoalFormData {
	title: string;
	description?: string;
	priority: GoalPriority;
	missionType: MissionType;
	autonomyLevel: AutonomyLevel;
	structuredMetrics?: MissionMetric[];
	schedule?: CronSchedule;
}

export interface AutoCompletedNotification {
	taskId: string;
	taskTitle: string;
	goalId: string;
	prUrl: string;
	timestamp: number;
}

export interface GoalsEditorProps {
	/** Room ID (for context, may be used for future features) */
	roomId?: string;
	/** List of goals to display */
	goals: RoomGoal[];
	/** Tasks for resolving linked task titles */
	tasks?: TaskSummary[];
	/** Handler for clicking a linked task */
	onTaskClick?: (taskId: string) => void;
	/** Handler for creating a new goal */
	onCreateGoal: (goal: CreateGoalFormData) => Promise<void>;
	/** Handler for updating an existing goal */
	onUpdateGoal: (goalId: string, updates: Partial<RoomGoal>) => Promise<void>;
	/** Handler for deleting a goal */
	onDeleteGoal: (goalId: string) => Promise<void>;
	/** Handler for linking a task to a goal */
	onLinkTask: (goalId: string, taskId: string) => Promise<void>;
	/** Whether the editor is in a loading state */
	isLoading?: boolean;
	/** Notification items from auto-completed tasks */
	autoCompletedNotifications?: AutoCompletedNotification[];
	/** Dismiss a notification */
	onDismissNotification?: (taskId: string) => void;
	/** Fetch execution history for a recurring mission (optional) */
	onListExecutions?: (goalId: string) => Promise<MissionExecution[]>;
}

// ─── Common Schedule Presets ──────────────────────────────────────────────────

const SCHEDULE_PRESETS = [
	{ label: 'Hourly', value: '@hourly' },
	{ label: 'Daily', value: '@daily' },
	{ label: 'Weekly', value: '@weekly' },
	{ label: 'Monthly', value: '@monthly' },
	{ label: 'Custom', value: 'custom' },
] as const;

const COMMON_TIMEZONES = [
	'UTC',
	'America/New_York',
	'America/Chicago',
	'America/Denver',
	'America/Los_Angeles',
	'Europe/London',
	'Europe/Paris',
	'Europe/Berlin',
	'Asia/Tokyo',
	'Asia/Shanghai',
	'Asia/Kolkata',
	'Australia/Sydney',
];

// ─── Status Icon ──────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: GoalStatus }) {
	switch (status) {
		case 'active':
			return (
				<div class="w-5 h-5 flex-shrink-0" title="Active">
					<Spinner size="xs" color="border-blue-400" />
				</div>
			);
		case 'needs_human':
			return (
				<div
					class="w-5 h-5 rounded-full bg-yellow-500 flex items-center justify-center flex-shrink-0"
					title="Needs Human"
				>
					<svg class="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={3}
							d="M12 9v2m0 4h.01"
						/>
					</svg>
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
		case 'archived':
			return (
				<div
					class="w-5 h-5 rounded-full bg-gray-600 flex items-center justify-center flex-shrink-0"
					title="Archived"
				>
					<svg class="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8"
						/>
					</svg>
				</div>
			);
	}
}

// ─── Priority Badge ───────────────────────────────────────────────────────────

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

// ─── Mission Type Badge ───────────────────────────────────────────────────────

function MissionTypeBadge({ type }: { type: MissionType }) {
	const config: Record<MissionType, { label: string; style: string }> = {
		one_shot: { label: 'One-Shot', style: 'bg-gray-700 text-gray-300' },
		measurable: { label: 'Measurable', style: 'bg-purple-900/50 text-purple-300' },
		recurring: { label: 'Recurring', style: 'bg-teal-900/50 text-teal-300' },
	};
	const { label, style } = config[type] ?? config.one_shot;
	return (
		<span
			class={cn('px-2 py-0.5 text-xs font-medium rounded', style)}
			data-testid="mission-type-badge"
		>
			{label}
		</span>
	);
}

// ─── Autonomy Level Badge ─────────────────────────────────────────────────────

function AutonomyBadge({ level }: { level: AutonomyLevel }) {
	const config: Record<AutonomyLevel, { label: string; style: string; title: string }> = {
		supervised: {
			label: 'Supervised',
			style: 'bg-blue-900/40 text-blue-300 border border-blue-700/50',
			title: 'Requires human approval at each step',
		},
		semi_autonomous: {
			label: 'Semi-Autonomous',
			style: 'bg-green-900/40 text-green-300 border border-green-700/50',
			title: 'Tasks auto-approve; planners still require human approval',
		},
	};
	const { label, style, title } = config[level] ?? config.supervised;
	return (
		<span
			class={cn('px-2 py-0.5 text-xs font-medium rounded', style)}
			title={title}
			data-testid="autonomy-badge"
		>
			{label}
		</span>
	);
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────

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

// ─── Task Status Badge ────────────────────────────────────────────────────────

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
	};
	const label =
		status === 'in_progress' ? 'active' : status === 'needs_attention' ? 'needs attention' : status;
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

// ─── Metric Row (form) ────────────────────────────────────────────────────────

interface MetricRowProps {
	metric: MissionMetric;
	index: number;
	onChange: (index: number, metric: MissionMetric) => void;
	onRemove: (index: number) => void;
}

function MetricRow({ metric, index, onChange, onRemove }: MetricRowProps) {
	return (
		<div class="flex items-center gap-2 bg-dark-700 rounded-lg px-3 py-2">
			<input
				type="text"
				value={metric.name}
				onInput={(e) => onChange(index, { ...metric, name: (e.target as HTMLInputElement).value })}
				placeholder="Metric name"
				class="flex-1 min-w-0 px-2 py-1 bg-dark-800 border border-dark-600 rounded text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
				aria-label={`Metric ${index + 1} name`}
			/>
			<input
				type="number"
				value={metric.target}
				onInput={(e) =>
					onChange(index, {
						...metric,
						target: parseFloat((e.target as HTMLInputElement).value) || 0,
					})
				}
				placeholder="Target"
				class="w-20 px-2 py-1 bg-dark-800 border border-dark-600 rounded text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
				aria-label={`Metric ${index + 1} target`}
				min={0}
			/>
			<input
				type="text"
				value={metric.unit ?? ''}
				onInput={(e) =>
					onChange(index, {
						...metric,
						unit: (e.target as HTMLInputElement).value || undefined,
					})
				}
				placeholder="Unit"
				class="w-16 px-2 py-1 bg-dark-800 border border-dark-600 rounded text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
				aria-label={`Metric ${index + 1} unit`}
			/>
			<button
				type="button"
				onClick={() => onRemove(index)}
				class="p-1 text-gray-500 hover:text-red-400 transition-colors"
				aria-label={`Remove metric ${index + 1}`}
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
		</div>
	);
}

// ─── Create/Edit Mission Form ─────────────────────────────────────────────────

/** Derives the schedule preset string from a stored CronSchedule. */
function scheduleToPreset(schedule?: CronSchedule): string {
	if (!schedule) return '@daily';
	const knownValues = SCHEDULE_PRESETS.filter((p) => p.value !== 'custom').map((p) => p.value);
	return knownValues.includes(schedule.expression as (typeof knownValues)[number])
		? schedule.expression
		: 'custom';
}

interface GoalFormProps {
	initialTitle?: string;
	initialDescription?: string;
	initialPriority?: GoalPriority;
	initialMissionType?: MissionType;
	initialAutonomyLevel?: AutonomyLevel;
	initialMetrics?: MissionMetric[];
	initialSchedule?: CronSchedule;
	onSubmit: (data: CreateGoalFormData) => Promise<void>;
	onCancel: () => void;
	isLoading?: boolean;
	submitLabel?: string;
}

/** Stable-keyed metric entry used internally to avoid index-as-key issues. */
type MetricEntry = { id: string; metric: MissionMetric };

let _metricKeyCounter = 0;
function newMetricEntry(metric: MissionMetric): MetricEntry {
	return { id: `m-${++_metricKeyCounter}`, metric };
}

function GoalForm({
	initialTitle = '',
	initialDescription = '',
	initialPriority = 'normal',
	initialMissionType = 'one_shot',
	initialAutonomyLevel = 'supervised',
	initialMetrics,
	initialSchedule,
	onSubmit,
	onCancel,
	isLoading,
	submitLabel = 'Create',
}: GoalFormProps) {
	const [title, setTitle] = useState(initialTitle);
	const [description, setDescription] = useState(initialDescription);
	const [priority, setPriority] = useState<GoalPriority>(initialPriority);
	const [missionType, setMissionType] = useState<MissionType>(initialMissionType);
	const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>(initialAutonomyLevel);
	const [metricEntries, setMetricEntries] = useState<MetricEntry[]>(() =>
		(initialMetrics ?? []).map(newMetricEntry)
	);
	const [schedulePreset, setSchedulePreset] = useState<string>(() =>
		scheduleToPreset(initialSchedule)
	);
	const [customCron, setCustomCron] = useState(() => {
		if (!initialSchedule) return '';
		return scheduleToPreset(initialSchedule) === 'custom' ? initialSchedule.expression : '';
	});
	const [timezone, setTimezone] = useState(initialSchedule?.timezone ?? 'UTC');
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleMetricChange = (index: number, metric: MissionMetric) => {
		setMetricEntries((prev) => prev.map((e, i) => (i === index ? { ...e, metric } : e)));
	};

	const handleMetricRemove = (index: number) => {
		setMetricEntries((prev) => prev.filter((_, i) => i !== index));
	};

	const handleAddMetric = () => {
		setMetricEntries((prev) => [...prev, newMetricEntry({ name: '', target: 100, current: 0 })]);
	};

	const buildSchedule = (): CronSchedule | undefined => {
		if (missionType !== 'recurring') return undefined;
		const expression = schedulePreset === 'custom' ? customCron.trim() : schedulePreset;
		if (!expression) return undefined;
		return { expression, timezone };
	};

	const isCustomCronEmpty =
		missionType === 'recurring' && schedulePreset === 'custom' && !customCron.trim();

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		if (!title.trim() || isCustomCronEmpty) return;

		setIsSubmitting(true);
		try {
			await onSubmit({
				title: title.trim(),
				description: description.trim() || undefined,
				priority,
				missionType,
				autonomyLevel,
				structuredMetrics:
					missionType === 'measurable' ? metricEntries.map((e) => e.metric) : undefined,
				schedule: buildSchedule(),
			});
			onCancel(); // only close on success
		} catch {
			// Leave modal open so user can retry
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} class="space-y-4">
			{/* Title */}
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
					placeholder="Enter mission title..."
					required
				/>
			</div>

			{/* Description */}
			<div>
				<label for="goal-description" class="block text-sm font-medium text-gray-300 mb-1">
					Description
				</label>
				<textarea
					id="goal-description"
					value={description}
					onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
					class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
					placeholder="Describe the mission..."
					rows={2}
				/>
			</div>

			{/* Mission Type */}
			<div>
				<label class="block text-sm font-medium text-gray-300 mb-2">Mission Type</label>
				<div class="grid grid-cols-3 gap-2">
					{(
						[
							{ value: 'one_shot', label: 'One-Shot', desc: 'Discrete objective' },
							{ value: 'measurable', label: 'Measurable', desc: 'KPI-targeted' },
							{ value: 'recurring', label: 'Recurring', desc: 'Cron-scheduled' },
						] as const
					).map(({ value, label, desc }) => (
						<button
							key={value}
							type="button"
							onClick={() => setMissionType(value)}
							class={cn(
								'px-3 py-2 rounded-lg border text-left transition-colors',
								missionType === value
									? 'border-blue-500 bg-blue-900/20 text-blue-300'
									: 'border-dark-600 bg-dark-800 text-gray-400 hover:border-dark-500'
							)}
							data-testid={`mission-type-${value}`}
						>
							<div class="text-xs font-medium">{label}</div>
							<div class="text-[10px] opacity-70 mt-0.5">{desc}</div>
						</button>
					))}
				</div>
			</div>

			{/* Measurable: Metrics */}
			{missionType === 'measurable' && (
				<div data-testid="metrics-section">
					<div class="flex items-center justify-between mb-2">
						<label class="text-sm font-medium text-gray-300">Metrics</label>
						<button
							type="button"
							onClick={handleAddMetric}
							class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
							data-testid="add-metric-btn"
						>
							+ Add Metric
						</button>
					</div>
					{metricEntries.length === 0 ? (
						<p class="text-xs text-gray-500 italic">
							No metrics yet — click "Add Metric" to track KPIs.
						</p>
					) : (
						<div class="space-y-2">
							<div class="grid grid-cols-[1fr_5rem_4rem_1.5rem] gap-2 px-3">
								<span class="text-[10px] text-gray-500 uppercase">Name</span>
								<span class="text-[10px] text-gray-500 uppercase">Target</span>
								<span class="text-[10px] text-gray-500 uppercase">Unit</span>
								<span />
							</div>
							{metricEntries.map(({ id, metric }, i) => (
								<MetricRow
									key={id}
									metric={metric}
									index={i}
									onChange={handleMetricChange}
									onRemove={handleMetricRemove}
								/>
							))}
						</div>
					)}
				</div>
			)}

			{/* Recurring: Schedule */}
			{missionType === 'recurring' && (
				<div data-testid="schedule-section">
					<label class="block text-sm font-medium text-gray-300 mb-2">Schedule</label>
					<div class="space-y-3">
						<div class="flex gap-2">
							<select
								value={schedulePreset}
								onChange={(e) => setSchedulePreset((e.target as HTMLSelectElement).value)}
								class="flex-1 px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
								data-testid="schedule-preset"
							>
								{SCHEDULE_PRESETS.map(({ label, value }) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
							<select
								value={timezone}
								onChange={(e) => setTimezone((e.target as HTMLSelectElement).value)}
								class="flex-1 px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
								data-testid="timezone-select"
							>
								{COMMON_TIMEZONES.map((tz) => (
									<option key={tz} value={tz}>
										{tz}
									</option>
								))}
							</select>
						</div>
						{schedulePreset === 'custom' && (
							<input
								type="text"
								value={customCron}
								onInput={(e) => setCustomCron((e.target as HTMLInputElement).value)}
								placeholder="e.g. 0 9 * * 1 (Mon 9am)"
								class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
								data-testid="custom-cron"
							/>
						)}
						{schedulePreset !== 'custom' && (
							<p class="text-xs text-gray-500">
								Cron: <code class="text-gray-400">{schedulePreset}</code> · Timezone:{' '}
								<span class="text-gray-400">{timezone}</span>
							</p>
						)}
					</div>
				</div>
			)}

			{/* Priority */}
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

			{/* Autonomy Level */}
			<div>
				<label class="block text-sm font-medium text-gray-300 mb-2">Autonomy Level</label>
				<div class="grid grid-cols-2 gap-2">
					{[
						{
							value: 'supervised' as const,
							label: 'Supervised',
							desc: 'Human approves every step',
						},
						{
							value: 'semi_autonomous' as const,
							label: 'Semi-Autonomous',
							desc: 'Tasks auto-approve; planners need review',
						},
					].map(({ value, label, desc }) => (
						<button
							key={value}
							type="button"
							onClick={() => setAutonomyLevel(value)}
							class={cn(
								'px-3 py-2 rounded-lg border text-left transition-colors',
								autonomyLevel === value
									? 'border-blue-500 bg-blue-900/20 text-blue-300'
									: 'border-dark-600 bg-dark-800 text-gray-400 hover:border-dark-500'
							)}
							data-testid={`autonomy-${value}`}
						>
							<div class="text-xs font-medium">{label}</div>
							<div class="text-[10px] opacity-70 mt-0.5">{desc}</div>
						</button>
					))}
				</div>
			</div>

			<div class="flex items-center justify-end gap-3 pt-2">
				<Button variant="ghost" onClick={onCancel} disabled={isSubmitting || isLoading}>
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={!title.trim() || isCustomCronEmpty || isSubmitting || isLoading}
					loading={isSubmitting || isLoading}
				>
					{submitLabel}
				</Button>
			</div>
		</form>
	);
}

// ─── Metric Progress Display ──────────────────────────────────────────────────

function MetricProgress({ metrics }: { metrics: MissionMetric[] }) {
	if (metrics.length === 0) return null;
	return (
		<div class="space-y-2">
			{metrics.map((m) => {
				const pct = m.target > 0 ? Math.min(100, Math.round((m.current / m.target) * 100)) : 0;
				const color = pct >= 100 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500';
				return (
					<div key={m.name}>
						<div class="flex items-center justify-between text-xs mb-1">
							<span class="text-gray-400">{m.name}</span>
							<span class="text-gray-300 font-mono">
								{m.current}
								{m.unit ? ` ${m.unit}` : ''} / {m.target}
								{m.unit ? ` ${m.unit}` : ''} ({pct}%)
							</span>
						</div>
						<div class="h-1.5 bg-dark-700 rounded-full overflow-hidden">
							<div
								class={cn('h-full rounded-full transition-all', color)}
								style={{ width: `${pct}%` }}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}

// ─── Recurring Schedule Display ───────────────────────────────────────────────

function RecurringScheduleInfo({ goal }: { goal: RoomGoal }) {
	return (
		<div class="space-y-2 text-sm">
			{goal.schedule && (
				<div class="flex items-start gap-2">
					<svg
						class="w-4 h-4 text-teal-400 mt-0.5 flex-shrink-0"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
					<div>
						<div class="text-gray-300 font-mono text-xs">{goal.schedule.expression}</div>
						<div class="text-gray-500 text-xs">{goal.schedule.timezone}</div>
					</div>
				</div>
			)}
			{goal.schedulePaused && (
				<span class="inline-block px-2 py-0.5 text-xs bg-yellow-900/40 text-yellow-400 rounded border border-yellow-700/50">
					Paused
				</span>
			)}
			{goal.nextRunAt && !goal.schedulePaused ? (
				<div class="text-xs text-gray-400">
					Next run:{' '}
					<span class="text-gray-300">{new Date(goal.nextRunAt * 1000).toLocaleString()}</span>
				</div>
			) : null}
		</div>
	);
}

// ─── Goal Item Component ──────────────────────────────────────────────────────

interface GoalItemProps {
	goal: RoomGoal;
	tasks?: TaskSummary[];
	onTaskClick?: (taskId: string) => void;
	onUpdate: (updates: Partial<RoomGoal>) => Promise<void>;
	onDelete: () => Promise<void>;
	onLinkTask: (taskId: string) => Promise<void>;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onListExecutions?: (goalId: string) => Promise<MissionExecution[]>;
}

function GoalItem({
	goal,
	tasks,
	onTaskClick,
	onUpdate,
	onDelete,
	onLinkTask,
	isExpanded,
	onToggleExpand,
	onListExecutions,
}: GoalItemProps) {
	const [isEditing, setIsEditing] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [linkTaskId, setLinkTaskId] = useState('');
	const [isUpdating, setIsUpdating] = useState(false);
	const [executions, setExecutions] = useState<MissionExecution[] | null>(null);

	const missionType: MissionType = goal.missionType ?? 'one_shot';

	// Load execution history when recurring mission is expanded
	useEffect(() => {
		if (isExpanded && missionType === 'recurring' && onListExecutions && executions === null) {
			onListExecutions(goal.id)
				.then(setExecutions)
				.catch(() => setExecutions([]));
		}
	}, [isExpanded, missionType, onListExecutions, goal.id, executions]);

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

	const getAvailableActions = (): { label: string; status: GoalStatus }[] => {
		switch (goal.status) {
			case 'active':
				return [
					{ label: 'Complete', status: 'completed' },
					{ label: 'Needs Human', status: 'needs_human' },
					{ label: 'Archive', status: 'archived' },
				];
			case 'needs_human':
				return [
					{ label: 'Reactivate', status: 'active' },
					{ label: 'Complete', status: 'completed' },
				];
			case 'completed':
				return [{ label: 'Reactivate', status: 'active' }];
			case 'archived':
				return [{ label: 'Reactivate', status: 'active' }];
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
					initialMissionType={goal.missionType ?? 'one_shot'}
					initialAutonomyLevel={goal.autonomyLevel ?? 'supervised'}
					initialMetrics={goal.structuredMetrics ?? []}
					initialSchedule={goal.schedule ?? undefined}
					onSubmit={async (data) => {
						setIsUpdating(true);
						try {
							await onUpdate(data);
						} finally {
							setIsUpdating(false);
						}
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
					data-testid="goal-item-header"
					class="px-4 py-3 cursor-pointer hover:bg-dark-800 transition-colors"
					onClick={onToggleExpand}
				>
					<div class="flex items-center gap-3">
						<StatusIcon status={goal.status} />
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 mb-1 flex-wrap">
								<h4 class="text-sm font-medium text-gray-100 truncate">{goal.title}</h4>
								<PriorityBadge priority={goal.priority} />
								{missionType !== 'one_shot' && <MissionTypeBadge type={missionType} />}
								{goal.autonomyLevel && goal.autonomyLevel !== 'supervised' && (
									<AutonomyBadge level={goal.autonomyLevel} />
								)}
							</div>
							{/* Type-specific summary in header */}
							{missionType === 'measurable' &&
							goal.structuredMetrics &&
							goal.structuredMetrics.length > 0 ? (
								<MetricProgress metrics={goal.structuredMetrics} />
							) : missionType === 'recurring' && goal.schedule ? (
								<div class="flex items-center gap-2 text-xs text-gray-500">
									<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
										/>
									</svg>
									<span class="font-mono">{goal.schedule.expression}</span>
									{goal.schedulePaused && <span class="text-yellow-500">· Paused</span>}
									{goal.nextRunAt && !goal.schedulePaused && (
										<span>· Next: {new Date(goal.nextRunAt * 1000).toLocaleDateString()}</span>
									)}
								</div>
							) : (
								<ProgressBar progress={goal.progress} />
							)}
						</div>
						{goal.linkedTaskIds.length > 0 && (
							<span class="px-2 py-0.5 text-xs bg-dark-700 text-gray-300 rounded flex-shrink-0">
								{goal.linkedTaskIds.length} task{goal.linkedTaskIds.length !== 1 ? 's' : ''}
							</span>
						)}
						<div class="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
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
					<div class="px-4 py-3 border-t border-dark-700 bg-dark-800/50 space-y-4">
						{/* Description */}
						{goal.description && (
							<div>
								<h5 class="text-xs font-medium text-gray-400 uppercase mb-1">Description</h5>
								<p class="text-sm text-gray-300">{goal.description}</p>
							</div>
						)}

						{/* Autonomy level */}
						{goal.autonomyLevel && (
							<div>
								<h5 class="text-xs font-medium text-gray-400 uppercase mb-1">Autonomy</h5>
								<AutonomyBadge level={goal.autonomyLevel} />
							</div>
						)}

						{/* Type-specific detail sections */}
						{missionType === 'measurable' && (
							<div>
								<h5 class="text-xs font-medium text-gray-400 uppercase mb-2">Metric Progress</h5>
								{goal.structuredMetrics && goal.structuredMetrics.length > 0 ? (
									<MetricProgress metrics={goal.structuredMetrics} />
								) : (
									<p class="text-xs text-gray-500">No metrics configured.</p>
								)}
							</div>
						)}

						{missionType === 'recurring' && (
							<div>
								<h5 class="text-xs font-medium text-gray-400 uppercase mb-2">Schedule</h5>
								<RecurringScheduleInfo goal={goal} />
							</div>
						)}

						{missionType === 'recurring' && onListExecutions && (
							<div data-testid="execution-history-section">
								<h5 class="text-xs font-medium text-gray-400 uppercase mb-2">Execution History</h5>
								{executions === null ? (
									<Skeleton class="h-10 w-full" />
								) : executions.length === 0 ? (
									<p class="text-xs text-gray-500">No executions yet.</p>
								) : (
									<div class="space-y-1" data-testid="execution-history-list">
										{executions.map((ex) => (
											<div
												key={ex.id}
												class="flex items-center gap-3 text-xs bg-dark-700 rounded px-3 py-2"
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
												<span class="text-gray-400">#{ex.executionNumber}</span>
												<span class="text-gray-300 capitalize">{ex.status}</span>
												{ex.startedAt && (
													<span class="text-gray-500 ml-auto">
														{new Date(ex.startedAt * 1000).toLocaleDateString()}
													</span>
												)}
												{ex.resultSummary && (
													<span
														class="text-gray-400 truncate max-w-[160px]"
														title={ex.resultSummary}
													>
														{ex.resultSummary}
													</span>
												)}
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{missionType === 'one_shot' && (
							<div>
								<h5 class="text-xs font-medium text-gray-400 uppercase mb-1">Progress</h5>
								<ProgressBar progress={goal.progress} />
							</div>
						)}

						{/* Legacy metrics */}
						{goal.metrics && Object.keys(goal.metrics).length > 0 && (
							<div>
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
						<div>
							<h5 class="text-xs font-medium text-gray-400 uppercase mb-2">Linked Tasks</h5>
							{goal.linkedTaskIds.length > 0 ? (
								<div class="space-y-1">
									{goal.linkedTaskIds.map((taskId) => {
										const task = tasks?.find((t) => t.id === taskId);
										const title = task?.title ?? taskId;
										const isClickable = !!onTaskClick;
										return (
											<div
												key={taskId}
												class={cn(
													'flex items-center gap-2 text-sm bg-dark-700 rounded px-3 py-1.5',
													isClickable && 'cursor-pointer hover:bg-dark-600 transition-colors'
												)}
												onClick={isClickable ? () => onTaskClick(taskId) : undefined}
											>
												<svg
													class="w-4 h-4 text-gray-500 flex-shrink-0"
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
												<span class="text-gray-300 truncate flex-1">{title}</span>
												{task?.status && <TaskStatusBadge status={task.status} />}
												{isClickable && <span class="text-xs text-gray-600">&rarr;</span>}
											</div>
										);
									})}
								</div>
							) : (
								<p class="text-sm text-gray-500">No tasks linked</p>
							)}
						</div>

						{/* Link Task Input */}
						<div>
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
				title="Delete Mission"
				message={`Are you sure you want to delete "${goal.title}"? This action cannot be undone.`}
				confirmText="Delete"
				isLoading={isUpdating}
			/>
		</>
	);
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

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

// ─── Empty State ──────────────────────────────────────────────────────────────

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
			<h3 class="text-lg font-medium text-gray-200 mb-2">No missions yet</h3>
			<p class="text-sm text-gray-400 mb-4">Create your first mission to get started.</p>
			<Button onClick={onCreateClick}>Create Mission</Button>
		</div>
	);
}

// ─── Auto-Completed Notification Feed ────────────────────────────────────────

function AutoCompletedFeed({
	notifications,
	onDismiss,
}: {
	notifications: AutoCompletedNotification[];
	onDismiss?: (taskId: string) => void;
}) {
	if (notifications.length === 0) return null;
	return (
		<div class="space-y-2" data-testid="auto-completed-feed">
			<h3 class="text-xs font-medium text-gray-400 uppercase">Auto-Completed</h3>
			{notifications.map((n) => (
				<div
					key={n.taskId}
					class="flex items-center gap-3 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-2"
				>
					<svg
						class="w-4 h-4 text-green-400 flex-shrink-0"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M5 13l4 4L19 7"
						/>
					</svg>
					<div class="flex-1 min-w-0">
						<p class="text-sm text-gray-200 truncate">{n.taskTitle}</p>
						{n.prUrl && (
							<a
								href={n.prUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="text-xs text-blue-400 hover:underline"
							>
								View PR
							</a>
						)}
					</div>
					{onDismiss && (
						<button
							type="button"
							onClick={() => onDismiss(n.taskId)}
							class="p-1 text-gray-500 hover:text-gray-300 transition-colors"
							aria-label="Dismiss notification"
						>
							<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
			))}
		</div>
	);
}

// ─── Mission Type Filter ──────────────────────────────────────────────────────

type TypeFilter = 'all' | MissionType;

function MissionTypeFilter({
	value,
	onChange,
	counts,
}: {
	value: TypeFilter;
	onChange: (v: TypeFilter) => void;
	counts: Record<TypeFilter, number>;
}) {
	const options: { label: string; value: TypeFilter }[] = [
		{ label: 'All', value: 'all' },
		{ label: 'One-Shot', value: 'one_shot' },
		{ label: 'Measurable', value: 'measurable' },
		{ label: 'Recurring', value: 'recurring' },
	];
	return (
		<div class="flex items-center gap-1 flex-wrap">
			{options.map((opt) => (
				<button
					key={opt.value}
					type="button"
					onClick={() => onChange(opt.value)}
					class={cn(
						'px-2.5 py-1 text-xs rounded-full transition-colors',
						value === opt.value
							? 'bg-blue-600 text-white'
							: 'bg-dark-700 text-gray-400 hover:bg-dark-600'
					)}
					data-testid={`filter-${opt.value}`}
				>
					{opt.label}
					{counts[opt.value] > 0 && <span class="ml-1 opacity-70">{counts[opt.value]}</span>}
				</button>
			))}
		</div>
	);
}

// ─── GoalsEditor (Main) ───────────────────────────────────────────────────────

export function GoalsEditor({
	goals,
	tasks,
	onTaskClick,
	onCreateGoal,
	onUpdateGoal,
	onDeleteGoal,
	onLinkTask,
	isLoading = false,
	autoCompletedNotifications = [],
	onDismissNotification,
	onListExecutions,
}: GoalsEditorProps) {
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);
	const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

	const toggleExpand = (goalId: string) => {
		setExpandedGoalId((current) => (current === goalId ? null : goalId));
	};

	// Count by type
	const counts: Record<TypeFilter, number> = {
		all: goals.length,
		one_shot: goals.filter((g) => !g.missionType || g.missionType === 'one_shot').length,
		measurable: goals.filter((g) => g.missionType === 'measurable').length,
		recurring: goals.filter((g) => g.missionType === 'recurring').length,
	};

	// Filter by type
	const filteredGoals = goals.filter((g) => {
		if (typeFilter === 'all') return true;
		if (typeFilter === 'one_shot') return !g.missionType || g.missionType === 'one_shot';
		return g.missionType === typeFilter;
	});

	// Sort: active > needs_human > completed > archived, then by priority, then newest first
	const sortedGoals = [...filteredGoals].sort((a, b) => {
		const statusOrder: Record<GoalStatus, number> = {
			active: 0,
			needs_human: 1,
			completed: 2,
			archived: 3,
		};
		if (statusOrder[a.status] !== statusOrder[b.status]) {
			return statusOrder[a.status] - statusOrder[b.status];
		}
		const priorityOrder: Record<GoalPriority, number> = {
			urgent: 0,
			high: 1,
			normal: 2,
			low: 3,
		};
		if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
			return priorityOrder[a.priority] - priorityOrder[b.priority];
		}
		return b.createdAt - a.createdAt;
	});

	return (
		<div class="space-y-4">
			{/* Header */}
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					<h2 class="text-lg font-semibold text-gray-100">Missions</h2>
					<span class="px-2 py-0.5 text-xs font-medium bg-dark-700 text-gray-300 rounded">
						{goals.length}
					</span>
				</div>
				<Button onClick={() => setShowCreateModal(true)}>Create Mission</Button>
			</div>

			{/* Type filter (only when there are missions) */}
			{goals.length > 0 && (
				<MissionTypeFilter value={typeFilter} onChange={setTypeFilter} counts={counts} />
			)}

			{/* Auto-completed notifications */}
			<AutoCompletedFeed
				notifications={autoCompletedNotifications}
				onDismiss={onDismissNotification}
			/>

			{/* Content */}
			{isLoading ? (
				<GoalsSkeleton />
			) : sortedGoals.length === 0 && goals.length > 0 ? (
				<div class="text-sm text-gray-500 text-center py-6">
					No missions match the selected filter.
				</div>
			) : goals.length === 0 ? (
				<EmptyState onCreateClick={() => setShowCreateModal(true)} />
			) : (
				<div class="space-y-3">
					{sortedGoals.map((goal) => (
						<GoalItem
							key={goal.id}
							goal={goal}
							tasks={tasks}
							onTaskClick={onTaskClick}
							onUpdate={(updates) => onUpdateGoal(goal.id, updates)}
							onDelete={() => onDeleteGoal(goal.id)}
							onLinkTask={(taskId) => onLinkTask(goal.id, taskId)}
							isExpanded={expandedGoalId === goal.id}
							onToggleExpand={() => toggleExpand(goal.id)}
							onListExecutions={onListExecutions}
						/>
					))}
				</div>
			)}

			{/* Create Mission Modal */}
			<Modal
				isOpen={showCreateModal}
				onClose={() => setShowCreateModal(false)}
				title="Create Mission"
			>
				<GoalForm
					onSubmit={onCreateGoal}
					onCancel={() => setShowCreateModal(false)}
					submitLabel="Create"
				/>
			</Modal>
		</div>
	);
}
