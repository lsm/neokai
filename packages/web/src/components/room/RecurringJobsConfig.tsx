/**
 * RecurringJobsConfig Component
 *
 * Manages recurring jobs for a room. Provides UI for:
 * - Creating new recurring jobs with schedule and task template configuration
 * - Viewing and managing existing recurring jobs
 * - Enabling/disabling, triggering, editing, and deleting jobs
 */

import { useState } from 'preact/hooks';
import type {
	RecurringJob,
	RecurringJobSchedule,
	RecurringTaskTemplate,
	TaskPriority,
	TaskExecutionMode,
} from '@neokai/shared';
import { Button } from '../ui/Button.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { Modal } from '../ui/Modal.tsx';
import { cn } from '../../lib/utils.ts';
import { borderColors } from '../../lib/design-tokens.ts';

// ============================================================================
// Types
// ============================================================================

export interface CreateJobParams {
	name: string;
	description?: string;
	schedule: RecurringJobSchedule;
	taskTemplate: RecurringTaskTemplate;
	enabled?: boolean;
	maxRuns?: number;
}

export interface RecurringJobsConfigProps {
	roomId: string;
	jobs: RecurringJob[];
	onCreateJob: (job: CreateJobParams) => Promise<void>;
	onUpdateJob: (jobId: string, updates: Partial<RecurringJob>) => Promise<void>;
	onDeleteJob: (jobId: string) => Promise<void>;
	onTriggerJob: (jobId: string) => Promise<void>;
	isLoading?: boolean;
}

interface JobFormData {
	name: string;
	description: string;
	scheduleType: 'interval' | 'daily' | 'weekly';
	intervalMinutes: number;
	dailyHour: number;
	dailyMinute: number;
	weeklyDay: number;
	weeklyHour: number;
	weeklyMinute: number;
	taskTitle: string;
	taskDescription: string;
	taskPriority: TaskPriority;
	taskExecutionMode: TaskExecutionMode;
	maxRuns: string;
}

const DEFAULT_FORM_DATA: JobFormData = {
	name: '',
	description: '',
	scheduleType: 'interval',
	intervalMinutes: 30,
	dailyHour: 9,
	dailyMinute: 0,
	weeklyDay: 1,
	weeklyHour: 9,
	weeklyMinute: 0,
	taskTitle: '',
	taskDescription: '',
	taskPriority: 'normal',
	taskExecutionMode: 'single',
	maxRuns: '',
};

// ============================================================================
// Helper Functions
// ============================================================================

function formatSchedule(schedule: RecurringJobSchedule): string {
	switch (schedule.type) {
		case 'interval':
			return `Every ${schedule.minutes} min`;
		case 'daily':
			return `Daily at ${schedule.hour}:${String(schedule.minute).padStart(2, '0')}`;
		case 'weekly': {
			const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
			return `Weekly on ${days[schedule.dayOfWeek]} at ${schedule.hour}:${String(schedule.minute).padStart(2, '0')}`;
		}
		case 'cron':
			return `Cron: ${schedule.expression}`;
	}
}

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) {
		return 'Just now';
	} else if (minutes < 60) {
		return `${minutes}m ago`;
	} else if (hours < 24) {
		return `${hours}h ago`;
	} else if (days === 1) {
		return 'Yesterday';
	} else if (days < 7) {
		return `${days}d ago`;
	} else {
		return new Date(timestamp).toLocaleDateString();
	}
}

function formatNextRun(timestamp: number): string {
	const now = Date.now();
	const diff = timestamp - now;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) {
		return 'In less than a minute';
	} else if (minutes < 60) {
		return `In ${minutes}m`;
	} else if (hours < 24) {
		return `In ${hours}h ${minutes % 60}m`;
	} else {
		return `In ${days}d ${hours % 24}h`;
	}
}

function buildScheduleFromFormData(formData: JobFormData): RecurringJobSchedule {
	switch (formData.scheduleType) {
		case 'interval':
			return { type: 'interval', minutes: formData.intervalMinutes };
		case 'daily':
			return { type: 'daily', hour: formData.dailyHour, minute: formData.dailyMinute };
		case 'weekly':
			return {
				type: 'weekly',
				dayOfWeek: formData.weeklyDay,
				hour: formData.weeklyHour,
				minute: formData.weeklyMinute,
			};
	}
}

// ============================================================================
// Components
// ============================================================================

export function RecurringJobsConfig({
	roomId: _roomId,
	jobs,
	onCreateJob,
	onUpdateJob,
	onDeleteJob,
	onTriggerJob,
	isLoading = false,
}: RecurringJobsConfigProps) {
	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [editingJob, setEditingJob] = useState<RecurringJob | null>(null);
	const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
	const [formData, setFormData] = useState<JobFormData>(DEFAULT_FORM_DATA);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
	const [triggeringJobId, setTriggeringJobId] = useState<string | null>(null);

	const resetForm = () => {
		setFormData(DEFAULT_FORM_DATA);
	};

	const handleOpenCreate = () => {
		resetForm();
		setEditingJob(null);
		setIsCreateModalOpen(true);
	};

	const handleOpenEdit = (job: RecurringJob) => {
		const scheduleType =
			job.schedule.type === 'interval'
				? 'interval'
				: job.schedule.type === 'daily'
					? 'daily'
					: 'weekly';

		setFormData({
			name: job.name,
			description: job.description,
			scheduleType,
			intervalMinutes: job.schedule.type === 'interval' ? job.schedule.minutes : 30,
			dailyHour: job.schedule.type === 'daily' ? job.schedule.hour : 9,
			dailyMinute: job.schedule.type === 'daily' ? job.schedule.minute : 0,
			weeklyDay: job.schedule.type === 'weekly' ? job.schedule.dayOfWeek : 1,
			weeklyHour: job.schedule.type === 'weekly' ? job.schedule.hour : 9,
			weeklyMinute: job.schedule.type === 'weekly' ? job.schedule.minute : 0,
			taskTitle: job.taskTemplate.title,
			taskDescription: job.taskTemplate.description,
			taskPriority: job.taskTemplate.priority,
			taskExecutionMode: job.taskTemplate.executionMode || 'single',
			maxRuns: job.maxRuns?.toString() || '',
		});
		setEditingJob(job);
		setIsCreateModalOpen(true);
	};

	const handleCloseModal = () => {
		setIsCreateModalOpen(false);
		setEditingJob(null);
		resetForm();
	};

	const handleSubmit = async () => {
		if (!formData.name.trim() || !formData.taskTitle.trim()) {
			return;
		}

		setIsSubmitting(true);
		try {
			const schedule = buildScheduleFromFormData(formData);
			const taskTemplate: RecurringTaskTemplate = {
				title: formData.taskTitle,
				description: formData.taskDescription,
				priority: formData.taskPriority,
				executionMode: formData.taskExecutionMode,
			};

			if (editingJob) {
				await onUpdateJob(editingJob.id, {
					name: formData.name,
					description: formData.description,
					schedule,
					taskTemplate,
					maxRuns: formData.maxRuns ? parseInt(formData.maxRuns, 10) : undefined,
				});
			} else {
				await onCreateJob({
					name: formData.name,
					description: formData.description,
					schedule,
					taskTemplate,
					enabled: true,
					maxRuns: formData.maxRuns ? parseInt(formData.maxRuns, 10) : undefined,
				});
			}
			handleCloseModal();
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleToggleEnabled = async (job: RecurringJob) => {
		await onUpdateJob(job.id, { enabled: !job.enabled });
	};

	const handleDelete = async (jobId: string) => {
		setDeletingJobId(jobId);
		try {
			await onDeleteJob(jobId);
		} finally {
			setDeletingJobId(null);
		}
	};

	const handleTrigger = async (jobId: string) => {
		setTriggeringJobId(jobId);
		try {
			await onTriggerJob(jobId);
		} finally {
			setTriggeringJobId(null);
		}
	};

	const handleToggleExpand = (jobId: string) => {
		setExpandedJobId(expandedJobId === jobId ? null : jobId);
	};

	return (
		<div class="space-y-4">
			{/* Header */}
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					<h3 class="text-lg font-semibold text-gray-100">Recurring Jobs</h3>
					{jobs.length > 0 && (
						<span class="px-2 py-0.5 text-xs font-medium bg-dark-700 text-gray-300 rounded-full">
							{jobs.length}
						</span>
					)}
				</div>
				<Button variant="primary" size="sm" onClick={handleOpenCreate} disabled={isLoading}>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M12 4v16m8-8H4"
						/>
					</svg>
					Create Job
				</Button>
			</div>

			{/* Job List */}
			{jobs.length === 0 ? (
				<div class="bg-dark-850 border border-dark-700 rounded-lg p-8 text-center">
					<svg
						class="w-12 h-12 mx-auto text-gray-500 mb-3"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={1.5}
							d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
					<p class="text-gray-400">No recurring jobs</p>
					<p class="text-sm text-gray-500 mt-1">Schedule automated tasks to run periodically.</p>
				</div>
			) : (
				<div class="space-y-3">
					{jobs.map((job) => (
						<JobCard
							key={job.id}
							job={job}
							isExpanded={expandedJobId === job.id}
							isDeleting={deletingJobId === job.id}
							isTriggering={triggeringJobId === job.id}
							onToggleExpand={() => handleToggleExpand(job.id)}
							onToggleEnabled={() => handleToggleEnabled(job)}
							onEdit={() => handleOpenEdit(job)}
							onDelete={() => handleDelete(job.id)}
							onTrigger={() => handleTrigger(job.id)}
						/>
					))}
				</div>
			)}

			{/* Create/Edit Modal */}
			<Modal
				isOpen={isCreateModalOpen}
				onClose={handleCloseModal}
				title={editingJob ? 'Edit Recurring Job' : 'Create Recurring Job'}
				size="lg"
			>
				<div class="space-y-6">
					{/* Basic Info */}
					<div class="space-y-4">
						<h4 class="text-sm font-medium text-gray-300 uppercase tracking-wide">Basic Info</h4>
						<div class="space-y-3">
							<div>
								<label class="block text-sm font-medium text-gray-300 mb-1">
									Name <span class="text-red-400">*</span>
								</label>
								<input
									type="text"
									value={formData.name}
									onInput={(e) =>
										setFormData({ ...formData, name: (e.target as HTMLInputElement).value })
									}
									class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
									placeholder="e.g., Daily Code Review"
								/>
							</div>
							<div>
								<label class="block text-sm font-medium text-gray-300 mb-1">Description</label>
								<textarea
									value={formData.description}
									onInput={(e) =>
										setFormData({
											...formData,
											description: (e.target as HTMLTextAreaElement).value,
										})
									}
									rows={2}
									class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
									placeholder="What this job does..."
								/>
							</div>
						</div>
					</div>

					{/* Schedule Configuration */}
					<div class="space-y-4">
						<h4 class="text-sm font-medium text-gray-300 uppercase tracking-wide">Schedule</h4>
						<div class="space-y-3">
							<div>
								<label class="block text-sm font-medium text-gray-300 mb-1">Schedule Type</label>
								<select
									value={formData.scheduleType}
									onChange={(e) =>
										setFormData({
											...formData,
											scheduleType: (e.target as HTMLSelectElement)
												.value as JobFormData['scheduleType'],
										})
									}
									class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
								>
									<option value="interval">Interval (every X minutes)</option>
									<option value="daily">Daily (at specific time)</option>
									<option value="weekly">Weekly (on specific day)</option>
								</select>
							</div>

							{/* Interval Config */}
							{formData.scheduleType === 'interval' && (
								<div>
									<label class="block text-sm font-medium text-gray-300 mb-1">Minutes</label>
									<input
										type="number"
										min={1}
										value={formData.intervalMinutes}
										onInput={(e) =>
											setFormData({
												...formData,
												intervalMinutes: parseInt((e.target as HTMLInputElement).value, 10) || 1,
											})
										}
										class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
									/>
								</div>
							)}

							{/* Daily Config */}
							{formData.scheduleType === 'daily' && (
								<div class="flex gap-3">
									<div class="flex-1">
										<label class="block text-sm font-medium text-gray-300 mb-1">Hour</label>
										<input
											type="number"
											min={0}
											max={23}
											value={formData.dailyHour}
											onInput={(e) =>
												setFormData({
													...formData,
													dailyHour: parseInt((e.target as HTMLInputElement).value, 10) || 0,
												})
											}
											class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
										/>
									</div>
									<div class="flex-1">
										<label class="block text-sm font-medium text-gray-300 mb-1">Minute</label>
										<input
											type="number"
											min={0}
											max={59}
											value={formData.dailyMinute}
											onInput={(e) =>
												setFormData({
													...formData,
													dailyMinute: parseInt((e.target as HTMLInputElement).value, 10) || 0,
												})
											}
											class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
										/>
									</div>
								</div>
							)}

							{/* Weekly Config */}
							{formData.scheduleType === 'weekly' && (
								<div class="space-y-3">
									<div>
										<label class="block text-sm font-medium text-gray-300 mb-1">Day of Week</label>
										<select
											value={formData.weeklyDay}
											onChange={(e) =>
												setFormData({
													...formData,
													weeklyDay: parseInt((e.target as HTMLSelectElement).value, 10),
												})
											}
											class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
										>
											<option value={0}>Sunday</option>
											<option value={1}>Monday</option>
											<option value={2}>Tuesday</option>
											<option value={3}>Wednesday</option>
											<option value={4}>Thursday</option>
											<option value={5}>Friday</option>
											<option value={6}>Saturday</option>
										</select>
									</div>
									<div class="flex gap-3">
										<div class="flex-1">
											<label class="block text-sm font-medium text-gray-300 mb-1">Hour</label>
											<input
												type="number"
												min={0}
												max={23}
												value={formData.weeklyHour}
												onInput={(e) =>
													setFormData({
														...formData,
														weeklyHour: parseInt((e.target as HTMLInputElement).value, 10) || 0,
													})
												}
												class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
											/>
										</div>
										<div class="flex-1">
											<label class="block text-sm font-medium text-gray-300 mb-1">Minute</label>
											<input
												type="number"
												min={0}
												max={59}
												value={formData.weeklyMinute}
												onInput={(e) =>
													setFormData({
														...formData,
														weeklyMinute: parseInt((e.target as HTMLInputElement).value, 10) || 0,
													})
												}
												class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
											/>
										</div>
									</div>
								</div>
							)}
						</div>
					</div>

					{/* Task Template */}
					<div class="space-y-4">
						<h4 class="text-sm font-medium text-gray-300 uppercase tracking-wide">Task Template</h4>
						<div class="space-y-3">
							<div>
								<label class="block text-sm font-medium text-gray-300 mb-1">
									Task Title <span class="text-red-400">*</span>
								</label>
								<input
									type="text"
									value={formData.taskTitle}
									onInput={(e) =>
										setFormData({ ...formData, taskTitle: (e.target as HTMLInputElement).value })
									}
									class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
									placeholder="e.g., Review pending pull requests"
								/>
							</div>
							<div>
								<label class="block text-sm font-medium text-gray-300 mb-1">Task Description</label>
								<textarea
									value={formData.taskDescription}
									onInput={(e) =>
										setFormData({
											...formData,
											taskDescription: (e.target as HTMLTextAreaElement).value,
										})
									}
									rows={3}
									class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
									placeholder="Detailed instructions for the task..."
								/>
							</div>
							<div class="flex gap-3">
								<div class="flex-1">
									<label class="block text-sm font-medium text-gray-300 mb-1">Priority</label>
									<select
										value={formData.taskPriority}
										onChange={(e) =>
											setFormData({
												...formData,
												taskPriority: (e.target as HTMLSelectElement).value as TaskPriority,
											})
										}
										class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
									>
										<option value="low">Low</option>
										<option value="normal">Normal</option>
										<option value="high">High</option>
										<option value="urgent">Urgent</option>
									</select>
								</div>
								<div class="flex-1">
									<label class="block text-sm font-medium text-gray-300 mb-1">Execution Mode</label>
									<select
										value={formData.taskExecutionMode}
										onChange={(e) =>
											setFormData({
												...formData,
												taskExecutionMode: (e.target as HTMLSelectElement)
													.value as TaskExecutionMode,
											})
										}
										class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
									>
										<option value="single">Single Session</option>
										<option value="parallel">Parallel</option>
										<option value="serial">Serial</option>
										<option value="parallel_then_merge">Parallel then Merge</option>
									</select>
								</div>
							</div>
						</div>
					</div>

					{/* Limits */}
					<div>
						<label class="block text-sm font-medium text-gray-300 mb-1">Max Runs (optional)</label>
						<input
							type="number"
							min={1}
							value={formData.maxRuns}
							onInput={(e) =>
								setFormData({ ...formData, maxRuns: (e.target as HTMLInputElement).value })
							}
							class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
							placeholder="Leave empty for unlimited"
						/>
					</div>

					{/* Actions */}
					<div class="flex justify-end gap-3 pt-4 border-t border-dark-700">
						<Button variant="ghost" onClick={handleCloseModal}>
							Cancel
						</Button>
						<Button
							variant="primary"
							onClick={handleSubmit}
							loading={isSubmitting}
							disabled={!formData.name.trim() || !formData.taskTitle.trim()}
						>
							{editingJob ? 'Save Changes' : 'Create Job'}
						</Button>
					</div>
				</div>
			</Modal>
		</div>
	);
}

// ============================================================================
// Job Card Component
// ============================================================================

interface JobCardProps {
	job: RecurringJob;
	isExpanded: boolean;
	isDeleting: boolean;
	isTriggering: boolean;
	onToggleExpand: () => void;
	onToggleEnabled: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onTrigger: () => void;
}

function JobCard({
	job,
	isExpanded,
	isDeleting,
	isTriggering,
	onToggleExpand,
	onToggleEnabled,
	onEdit,
	onDelete,
	onTrigger,
}: JobCardProps) {
	const priorityColors: Record<TaskPriority, string> = {
		low: 'text-gray-400',
		normal: 'text-blue-400',
		high: 'text-orange-400',
		urgent: 'text-red-400',
	};

	return (
		<div
			class={cn(
				'bg-dark-850 border rounded-lg overflow-hidden transition-all',
				job.enabled ? borderColors.ui.default : 'border-dark-700/50'
			)}
		>
			{/* Main Row */}
			<div
				class="px-4 py-3 cursor-pointer hover:bg-dark-800/50 transition-colors"
				onClick={onToggleExpand}
			>
				<div class="flex items-center gap-3">
					{/* Enable/Disable Toggle */}
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onToggleEnabled();
						}}
						class={cn(
							'relative w-10 h-5 rounded-full transition-colors flex-shrink-0',
							job.enabled ? 'bg-blue-600' : 'bg-dark-600'
						)}
						title={job.enabled ? 'Disable job' : 'Enable job'}
					>
						<span
							class={cn(
								'absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform',
								job.enabled ? 'left-5' : 'left-0.5'
							)}
						/>
					</button>

					{/* Job Info */}
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<h4
								class={cn(
									'text-sm font-medium truncate',
									job.enabled ? 'text-gray-100' : 'text-gray-400'
								)}
							>
								{job.name}
							</h4>
							<span class="text-xs text-gray-500">{formatSchedule(job.schedule)}</span>
						</div>
						<div class="flex items-center gap-3 mt-1">
							{job.enabled && job.nextRunAt && (
								<span class="text-xs text-blue-400">{formatNextRun(job.nextRunAt)}</span>
							)}
							{!job.enabled && <span class="text-xs text-gray-500">Disabled</span>}
						</div>
					</div>

					{/* Run Count Badge */}
					<span class="px-2 py-0.5 text-xs font-medium bg-dark-700 text-gray-300 rounded-full flex-shrink-0">
						{job.runCount} runs
					</span>

					{/* Expand Icon */}
					<svg
						class={cn(
							'w-5 h-5 text-gray-400 transition-transform flex-shrink-0',
							isExpanded && 'rotate-180'
						)}
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M19 9l-7 7-7-7"
						/>
					</svg>
				</div>
			</div>

			{/* Expanded View */}
			{isExpanded && (
				<div class="border-t border-dark-700 px-4 py-4 space-y-4">
					{/* Description */}
					{job.description && (
						<div>
							<h5 class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
								Description
							</h5>
							<p class="text-sm text-gray-300">{job.description}</p>
						</div>
					)}

					{/* Task Template */}
					<div>
						<h5 class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
							Task Template
						</h5>
						<div class="bg-dark-800 rounded-lg p-3 space-y-2">
							<div>
								<span class="text-xs text-gray-500">Title:</span>
								<p class="text-sm text-gray-200">{job.taskTemplate.title}</p>
							</div>
							{job.taskTemplate.description && (
								<div>
									<span class="text-xs text-gray-500">Description:</span>
									<p class="text-sm text-gray-300">{job.taskTemplate.description}</p>
								</div>
							)}
							<div class="flex gap-4 text-xs">
								<span class="text-gray-500">
									Priority:{' '}
									<span class={priorityColors[job.taskTemplate.priority]}>
										{job.taskTemplate.priority}
									</span>
								</span>
								{job.taskTemplate.executionMode && (
									<span class="text-gray-500">
										Mode: <span class="text-gray-300">{job.taskTemplate.executionMode}</span>
									</span>
								)}
							</div>
						</div>
					</div>

					{/* Statistics */}
					<div class="grid grid-cols-2 gap-4">
						<div>
							<h5 class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
								Last Run
							</h5>
							<p class="text-sm text-gray-300">
								{job.lastRunAt ? formatRelativeTime(job.lastRunAt) : 'Never'}
							</p>
						</div>
						<div>
							<h5 class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
								Total Runs
							</h5>
							<p class="text-sm text-gray-300">
								{job.runCount}
								{job.maxRuns && ` / ${job.maxRuns}`}
							</p>
						</div>
					</div>

					{/* Actions */}
					<div class="flex items-center gap-2 pt-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={onTrigger}
							loading={isTriggering}
							disabled={!job.enabled}
						>
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
								/>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							Trigger Now
						</Button>
						<Button variant="ghost" size="sm" onClick={onEdit}>
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
								/>
							</svg>
							Edit
						</Button>
						<IconButton
							variant="ghost"
							size="sm"
							onClick={onDelete}
							disabled={isDeleting}
							title="Delete job"
						>
							{isDeleting ? (
								<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
									<circle
										class="opacity-25"
										cx="12"
										cy="12"
										r="10"
										stroke="currentColor"
										stroke-width="4"
									/>
									<path
										class="opacity-75"
										fill="currentColor"
										d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
									/>
								</svg>
							) : (
								<svg
									class="w-4 h-4 text-red-400"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
									/>
								</svg>
							)}
						</IconButton>
					</div>
				</div>
			)}
		</div>
	);
}
