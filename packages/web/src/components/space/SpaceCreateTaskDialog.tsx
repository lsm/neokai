/**
 * SpaceCreateTaskDialog — modal form to create a standalone task or scheduled task in a Space.
 */

import { useMemo, useState } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import type { SpaceTask, SpaceTaskPriority, TaskScheduleTriggerType } from '@neokai/shared';

interface SpaceCreateTaskDialogProps {
	isOpen: boolean;
	onClose: () => void;
	onCreated?: (task: SpaceTask) => void;
}

const PRIORITY_OPTIONS: { value: SpaceTaskPriority; label: string }[] = [
	{ value: 'low', label: 'Low' },
	{ value: 'normal', label: 'Normal' },
	{ value: 'high', label: 'High' },
	{ value: 'urgent', label: 'Urgent' },
];

const TRIGGER_OPTIONS: { value: TaskScheduleTriggerType; label: string }[] = [
	{ value: 'at', label: 'One-time' },
	{ value: 'cron', label: 'Recurring' },
];

const CRON_PRESETS: { label: string; value: string }[] = [
	{ label: '@hourly', value: '@hourly' },
	{ label: '@daily', value: '@daily' },
	{ label: '@weekly', value: '@weekly' },
	{ label: '@monthly', value: '@monthly' },
];

const COMMON_TIMEZONES = [
	'UTC',
	'America/New_York',
	'America/Los_Angeles',
	'America/Chicago',
	'Europe/London',
	'Europe/Paris',
	'Europe/Berlin',
	'Asia/Tokyo',
	'Asia/Shanghai',
	'Asia/Singapore',
	'Australia/Sydney',
	'Pacific/Auckland',
];

/**
 * Lightweight frontend cron validation.
 * Supports 5-field cron and named shortcuts (@hourly, @daily, @weekly, @monthly, @yearly).
 * Does not validate every edge case — the daemon validates with croner and returns errors.
 */
function isValidCronExpression(expr: string): boolean {
	const trimmed = expr.trim();
	if (!trimmed) return false;

	// Named shortcuts
	if (/^@(hourly|daily|weekly|monthly|yearly|annually)$/.test(trimmed)) return true;

	// 5-field cron: minute hour day month weekday
	const parts = trimmed.split(/\s+/);
	if (parts.length !== 5) return false;

	const fieldPatterns = [
		/^([0-5]?\d|[*](?:\/[1-9]\d?)?|(?:[0-5]?\d)(?:-[0-5]?\d)?(?:\/[1-9]\d?)?|(?:[0-5]?\d)(?:,(?:[0-5]?\d|-[0-5]?\d|\*))+)$/, // minute
		/^([01]?\d|2[0-3]|[*](?:\/[1-9]\d?)?|(?:[01]?\d|2[0-3])(?:-[01]?\d|2[0-3])?(?:\/[1-9]\d?)?|(?:[01]?\d|2[0-3])(?:,(?:[01]?\d|2[0-3]|-[01]?\d|2[0-3]|\*))+)$/, // hour
		/^([1-9]|[12]\d|3[01]|[*?](?:\/[1-9]\d?)?|(?:[1-9]|[12]\d|3[01])(?:-[1-9]|[12]\d|3[01])?(?:\/[1-9]\d?)?|(?:[1-9]|[12]\d|3[01])(?:,(?:[1-9]|[12]\d|3[01]|-[1-9]|[12]\d|3[01]|\*))+)$/, // day
		/^([1-9]|1[0-2]|[*](?:\/[1-9]\d?)?|(?:[1-9]|1[0-2])(?:-[1-9]|1[0-2])?(?:\/[1-9]\d?)?|(?:[1-9]|1[0-2])(?:,(?:[1-9]|1[0-2]|-[1-9]|1[0-2]|\*))+)$/, // month
		/^([0-6]|[*](?:\/[1-9]\d?)?|(?:[0-6])(?:-[0-6])?(?:\/[1-9]\d?)?|(?:[0-6])(?:,(?:[0-6]|-[0-6]|\*))+|MON|TUE|WED|THU|FRI|SAT|SUN)$/, // weekday
	];

	for (let i = 0; i < 5; i++) {
		if (!fieldPatterns[i].test(parts[i])) return false;
	}
	return true;
}

function toLocalDatetimeInputValue(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetimeInputValue(value: string): number {
	return new Date(value).getTime();
}

function getSchedulePreview(
	triggerType: TaskScheduleTriggerType,
	cronExpression: string,
	runAt: number | null,
	timezone: string
): string | null {
	if (triggerType === 'at' && runAt) {
		return `One-time run at ${new Date(runAt).toLocaleString()} (${timezone})`;
	}
	if (triggerType === 'cron' && cronExpression) {
		const preset = CRON_PRESETS.find((p) => p.value === cronExpression);
		if (preset) return `${preset.label} in ${timezone}`;
		return `Recurring: ${cronExpression} (${timezone})`;
	}
	return null;
}

export function SpaceCreateTaskDialog({ isOpen, onClose, onCreated }: SpaceCreateTaskDialogProps) {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [priority, setPriority] = useState<SpaceTaskPriority>('normal');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Schedule fields
	const [scheduleEnabled, setScheduleEnabled] = useState(false);
	const [triggerType, setTriggerType] = useState<TaskScheduleTriggerType>('at');
	const [cronExpression, setCronExpression] = useState('');
	const [runAt, setRunAt] = useState<number | null>(null);
	const [timezone, setTimezone] = useState('UTC');

	const handleClose = () => {
		setTitle('');
		setDescription('');
		setPriority('normal');
		setError(null);
		setScheduleEnabled(false);
		setTriggerType('at');
		setCronExpression('');
		setRunAt(null);
		setTimezone('UTC');
		onClose();
	};

	const validationError = useMemo(() => {
		if (!scheduleEnabled) return null;
		if (triggerType === 'cron') {
			if (!cronExpression.trim()) return 'Cron expression is required';
			if (!isValidCronExpression(cronExpression)) return 'Invalid cron expression';
		}
		if (triggerType === 'at') {
			if (!runAt) return 'Run date/time is required';
			if (runAt <= Date.now()) return 'Run time must be in the future';
		}
		return null;
	}, [scheduleEnabled, triggerType, cronExpression, runAt]);

	const preview = useMemo(() => {
		if (!scheduleEnabled) return null;
		return getSchedulePreview(triggerType, cronExpression, runAt, timezone);
	}, [scheduleEnabled, triggerType, cronExpression, runAt, timezone]);

	const handleSubmit = async (e: Event) => {
		e.preventDefault();

		if (!title.trim()) {
			setError('Task title is required');
			return;
		}

		if (scheduleEnabled && validationError) {
			setError(validationError);
			return;
		}

		try {
			setSubmitting(true);
			setError(null);

			if (scheduleEnabled) {
				const schedule = await spaceStore.createSchedule({
					title: title.trim(),
					description: description.trim(),
					priority,
					triggerType,
					cronExpression: triggerType === 'cron' ? cronExpression.trim() : null,
					runAt: triggerType === 'at' ? runAt : null,
					timezone,
				});
				toast.success(`Scheduled task "${schedule.title}" created`);
			} else {
				const task = await spaceStore.createTask({
					title: title.trim(),
					description: description.trim(),
					priority,
				});
				toast.success(`Task "${task.title}" created`);
				onCreated?.(task);
			}
			handleClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create task');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="Create Task" size="md">
			<form onSubmit={handleSubmit} class="space-y-4">
				{error && (
					<div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
						{error}
					</div>
				)}

				{/* Title */}
				<div>
					<label class="block text-sm font-medium text-gray-200 mb-1.5">
						Title
						<span class="text-red-400 ml-1">*</span>
					</label>
					<input
						type="text"
						value={title}
						onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
						placeholder="e.g., Implement authentication module"
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
							placeholder-gray-600 focus:outline-none focus:border-blue-500 text-sm"
						autoFocus
					/>
				</div>

				{/* Description */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						Description
						<span class="text-gray-500 text-xs ml-2">(optional)</span>
					</label>
					<textarea
						value={description}
						onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
						placeholder="Describe what this task should accomplish..."
						rows={3}
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
							placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none text-sm"
					/>
				</div>

				{/* Priority row */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">Priority</label>
					<select
						value={priority}
						onChange={(e) =>
							setPriority((e.target as HTMLSelectElement).value as SpaceTaskPriority)
						}
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100
							focus:outline-none focus:border-blue-500 text-sm"
					>
						{PRIORITY_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				</div>

				{/* Schedule toggle */}
				<div class="border-t border-dark-700 pt-4">
					<label class="flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							checked={scheduleEnabled}
							onChange={(e) => setScheduleEnabled((e.target as HTMLInputElement).checked)}
							class="w-4 h-4 rounded border-dark-600 bg-dark-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-dark-900"
						/>
						<span class="text-sm font-medium text-gray-200">Schedule this task</span>
					</label>
				</div>

				{/* Schedule options */}
				{scheduleEnabled && (
					<div class="space-y-4 rounded-lg border border-dark-700 bg-dark-800/50 p-4">
						{/* Trigger type */}
						<div>
							<label class="block text-sm font-medium text-gray-300 mb-1.5">Trigger</label>
							<div class="flex gap-3">
								{TRIGGER_OPTIONS.map((opt) => (
									<label
										key={opt.value}
										class={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm transition-colors ${
											triggerType === opt.value
												? 'border-blue-500 bg-blue-900/20 text-blue-300'
												: 'border-dark-600 text-gray-400 hover:border-dark-500'
										}`}
									>
										<input
											type="radio"
											name="triggerType"
											value={opt.value}
											checked={triggerType === opt.value}
											onChange={() => setTriggerType(opt.value)}
											class="sr-only"
										/>
										<span>{opt.label}</span>
									</label>
								))}
							</div>
						</div>

						{/* One-time: datetime picker */}
						{triggerType === 'at' && (
							<div>
								<label class="block text-sm font-medium text-gray-300 mb-1.5">
									Run at
									<span class="text-red-400 ml-1">*</span>
								</label>
								<input
									type="datetime-local"
									value={runAt ? toLocalDatetimeInputValue(runAt) : ''}
									onInput={(e) => {
										const val = (e.target as HTMLInputElement).value;
										setRunAt(val ? fromLocalDatetimeInputValue(val) : null);
									}}
									class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
										focus:outline-none focus:border-blue-500 text-sm"
								/>
							</div>
						)}

						{/* Recurring: cron input + presets */}
						{triggerType === 'cron' && (
							<div class="space-y-3">
								<div>
									<label class="block text-sm font-medium text-gray-300 mb-1.5">
										Cron expression
										<span class="text-red-400 ml-1">*</span>
									</label>
									<div class="flex gap-2 flex-wrap mb-2">
										{CRON_PRESETS.map((preset) => (
											<button
												key={preset.value}
												type="button"
												onClick={() => setCronExpression(preset.value)}
												class={`px-2.5 py-1 text-xs rounded border transition-colors ${
													cronExpression === preset.value
														? 'border-blue-500 bg-blue-900/20 text-blue-300'
														: 'border-dark-600 text-gray-400 hover:border-dark-500 hover:text-gray-300'
												}`}
											>
												{preset.label}
											</button>
										))}
									</div>
									<input
										type="text"
										value={cronExpression}
										onInput={(e) => setCronExpression((e.target as HTMLInputElement).value)}
										placeholder="0 9 * * 1"
										class={`w-full bg-dark-800 border rounded-lg px-4 py-2.5 text-gray-100
											placeholder-gray-600 focus:outline-none focus:border-blue-500 text-sm ${
												cronExpression && !isValidCronExpression(cronExpression)
													? 'border-red-700 focus:border-red-500'
													: 'border-dark-600'
											}`}
									/>
									{cronExpression && !isValidCronExpression(cronExpression) && (
										<p class="mt-1 text-xs text-red-400">Invalid cron expression</p>
									)}
								</div>
							</div>
						)}

						{/* Timezone */}
						<div>
							<label class="block text-sm font-medium text-gray-300 mb-1.5">Timezone</label>
							<select
								value={timezone}
								onChange={(e) => setTimezone((e.target as HTMLSelectElement).value)}
								class="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-gray-100
									focus:outline-none focus:border-blue-500 text-sm"
							>
								{COMMON_TIMEZONES.map((tz) => (
									<option key={tz} value={tz}>
										{tz}
									</option>
								))}
							</select>
						</div>

						{/* Preview */}
						{preview && (
							<div class="text-xs text-gray-500 bg-dark-900/50 rounded px-3 py-2 border border-dark-700">
								{preview}
							</div>
						)}
					</div>
				)}

				<div class="flex gap-3 pt-1">
					<Button type="button" variant="secondary" onClick={handleClose} fullWidth>
						Cancel
					</Button>
					<Button type="submit" loading={submitting} fullWidth>
						{scheduleEnabled ? 'Create Schedule' : 'Create Task'}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
