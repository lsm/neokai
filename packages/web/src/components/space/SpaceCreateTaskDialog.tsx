/**
 * SpaceCreateTaskDialog — modal form to create a standalone task in a Space.
 */

import { useState } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { connectionManager } from '../../lib/connection-manager';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import type { SpaceTask, SpaceTaskPriority, SpaceTaskType } from '@neokai/shared';

interface SpaceCreateTaskDialogProps {
	isOpen: boolean;
	spaceId: string;
	onClose: () => void;
	onCreated?: (task: SpaceTask) => void;
}

const PRIORITY_OPTIONS: { value: SpaceTaskPriority; label: string }[] = [
	{ value: 'low', label: 'Low' },
	{ value: 'normal', label: 'Normal' },
	{ value: 'high', label: 'High' },
	{ value: 'urgent', label: 'Urgent' },
];

const TASK_TYPE_OPTIONS: { value: SpaceTaskType; label: string }[] = [
	{ value: 'coding', label: 'Coding' },
	{ value: 'planning', label: 'Planning' },
	{ value: 'research', label: 'Research' },
	{ value: 'design', label: 'Design' },
	{ value: 'review', label: 'Review' },
];

export function SpaceCreateTaskDialog({
	isOpen,
	spaceId,
	onClose,
	onCreated,
}: SpaceCreateTaskDialogProps) {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [priority, setPriority] = useState<SpaceTaskPriority>('normal');
	const [taskType, setTaskType] = useState<SpaceTaskType>('coding');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleClose = () => {
		setTitle('');
		setDescription('');
		setPriority('normal');
		setTaskType('coding');
		setError(null);
		onClose();
	};

	const handleSubmit = async (e: Event) => {
		e.preventDefault();

		if (!title.trim()) {
			setError('Task title is required');
			return;
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			setError('Not connected to server');
			return;
		}

		try {
			setSubmitting(true);
			setError(null);

			const task = await hub.request<SpaceTask>('spaceTask.create', {
				spaceId,
				title: title.trim(),
				description: description.trim(),
				priority,
				taskType,
			});

			if (!task) {
				throw new Error('Server returned no data');
			}

			toast.success(`Task "${task.title}" created`);
			onCreated?.(task);
			// Refresh space data so the dashboard shows the new task
			await spaceStore.selectSpace(spaceId).catch(() => {});
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

				{/* Priority + Type row */}
				<div class="grid grid-cols-2 gap-3">
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
					<div>
						<label class="block text-sm font-medium text-gray-300 mb-1.5">Type</label>
						<select
							value={taskType}
							onChange={(e) => setTaskType((e.target as HTMLSelectElement).value as SpaceTaskType)}
							class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100
								focus:outline-none focus:border-blue-500 text-sm"
						>
							{TASK_TYPE_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</div>
				</div>

				<div class="flex gap-3 pt-1">
					<Button type="button" variant="secondary" onClick={handleClose} fullWidth>
						Cancel
					</Button>
					<Button type="submit" loading={submitting} fullWidth>
						Create Task
					</Button>
				</div>
			</form>
		</Modal>
	);
}
