import type { NeoTask, TaskStatus } from '@neokai/shared';
import { useState } from 'preact/hooks';
import { Modal } from '../../ui/Modal';

export interface CompleteTaskDialogProps {
	task: NeoTask;
	isOpen: boolean;
	onClose: () => void;
	onConfirm: (summary: string) => Promise<void>;
}

export function CompleteTaskDialog({ task, isOpen, onClose, onConfirm }: CompleteTaskDialogProps) {
	const [summary, setSummary] = useState('');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleClose = () => {
		setSummary('');
		setError(null);
		onClose();
	};

	const handleConfirm = async () => {
		setLoading(true);
		setError(null);
		try {
			await onConfirm(summary);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to complete task');
		} finally {
			setLoading(false);
		}
	};

	return (
		<Modal
			isOpen={isOpen}
			onClose={handleClose}
			title="Mark Task as Complete?"
			size="md"
			showCloseButton
		>
			<div class="space-y-4">
				<p class="text-sm text-gray-300">
					You are about to mark <strong class="text-gray-100">{task.title}</strong> as completed.
				</p>

				<div class="bg-dark-800 border border-dark-600 rounded-lg p-3 text-xs text-gray-400">
					<p class="font-medium text-gray-300 mb-1.5">What happens next:</p>
					<ul class="list-disc list-inside space-y-1">
						<li>
							Task status changes to <span class="text-green-400">completed</span>
						</li>
						<li>Active sessions will be stopped</li>
						<li>Worktree and branch are preserved — you can reactivate later</li>
					</ul>
				</div>

				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						Completion Summary <span class="text-gray-500 font-normal">(optional)</span>
					</label>
					<textarea
						class="w-full h-24 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
						placeholder="Briefly describe what was accomplished..."
						value={summary}
						onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)}
						disabled={loading}
					/>
				</div>

				{error && (
					<p class="text-sm text-red-400 bg-red-900/20 border border-red-800/50 rounded px-3 py-2">
						{error}
					</p>
				)}

				<div class="flex items-center justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={handleClose}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => void handleConfirm()}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed bg-green-600 hover:bg-green-700 text-white disabled:bg-green-600/50 flex items-center gap-1.5"
						data-testid="complete-task-confirm"
					>
						{loading ? (
							'Completing…'
						) : (
							<>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M5 13l4 4L19 7"
									/>
								</svg>
								Mark Complete
							</>
						)}
					</button>
				</div>
			</div>
		</Modal>
	);
}

export interface CancelTaskDialogProps {
	task: NeoTask;
	isOpen: boolean;
	onClose: () => void;
	onConfirm: () => Promise<void>;
}

export function CancelTaskDialog({ task, isOpen, onClose, onConfirm }: CancelTaskDialogProps) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleClose = () => {
		setError(null);
		onClose();
	};

	const handleConfirm = async () => {
		setLoading(true);
		setError(null);
		try {
			await onConfirm();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to cancel task');
		} finally {
			setLoading(false);
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="Cancel Task?" size="sm" showCloseButton>
			<div class="space-y-4">
				<p class="text-sm text-gray-300">
					You are about to cancel <strong class="text-gray-100">{task.title}</strong>.
				</p>

				<div class="bg-amber-900/20 border border-amber-800/50 rounded-lg p-3 text-xs text-gray-400">
					<p class="font-medium text-amber-400 mb-1.5">This action is reversible:</p>
					<ul class="list-disc list-inside space-y-1">
						<li>
							Task will be marked as <span class="text-gray-300">cancelled</span>
						</li>
						<li>Active sessions will be stopped</li>
						<li>Worktree and branch are preserved — you can reactivate later</li>
					</ul>
				</div>

				{error && (
					<p class="text-sm text-red-400 bg-red-900/20 border border-red-800/50 rounded px-3 py-2">
						{error}
					</p>
				)}

				<div class="flex items-center justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={handleClose}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Keep Task
					</button>
					<button
						type="button"
						onClick={() => void handleConfirm()}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed bg-red-600 hover:bg-red-700 text-white disabled:bg-red-600/50 flex items-center gap-1.5"
						data-testid="cancel-task-confirm"
					>
						{loading ? (
							'Cancelling…'
						) : (
							<>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
								Cancel Task
							</>
						)}
					</button>
				</div>
			</div>
		</Modal>
	);
}

export interface ArchiveTaskDialogProps {
	task: NeoTask;
	isOpen: boolean;
	onClose: () => void;
	onConfirm: () => Promise<void>;
}

export function ArchiveTaskDialog({ task, isOpen, onClose, onConfirm }: ArchiveTaskDialogProps) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleClose = () => {
		setError(null);
		onClose();
	};

	const handleConfirm = async () => {
		setLoading(true);
		setError(null);
		try {
			await onConfirm();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to archive task');
		} finally {
			setLoading(false);
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="Archive Task?" size="sm" showCloseButton>
			<div class="space-y-4">
				<p class="text-sm text-gray-300">
					You are about to archive <strong class="text-gray-100">{task.title}</strong>.
				</p>

				<div class="bg-red-900/20 border border-red-800/50 rounded-lg p-3 text-xs text-gray-400">
					<p class="font-medium text-red-400 mb-1.5">This action is permanent:</p>
					<ul class="list-disc list-inside space-y-1">
						<li>
							Task will be marked as <span class="text-gray-300">archived</span>
						</li>
						<li>All sessions will be terminated</li>
						<li>Isolated worktree and branch will be cleaned up</li>
						<li>The task cannot be reactivated after archiving</li>
					</ul>
				</div>

				{error && (
					<p class="text-sm text-red-400 bg-red-900/20 border border-red-800/50 rounded px-3 py-2">
						{error}
					</p>
				)}

				<div class="flex items-center justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={handleClose}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Keep Task
					</button>
					<button
						type="button"
						onClick={() => void handleConfirm()}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed bg-red-600 hover:bg-red-700 text-white disabled:bg-red-600/50 flex items-center gap-1.5"
						data-testid="archive-task-confirm"
					>
						{loading ? (
							'Archiving…'
						) : (
							<>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 13a2 2 0 002 2h8a2 2 0 002-2L19 8"
									/>
								</svg>
								Archive Task
							</>
						)}
					</button>
				</div>
			</div>
		</Modal>
	);
}

const ALL_TASK_STATUSES: TaskStatus[] = [
	'pending',
	'in_progress',
	'review',
	'completed',
	'needs_attention',
	'cancelled',
	'archived',
	'draft',
];

const STATUS_LABELS: Record<TaskStatus, string> = {
	pending: 'Pending',
	in_progress: 'In Progress',
	review: 'In Review',
	completed: 'Completed',
	needs_attention: 'Needs Attention',
	cancelled: 'Cancelled',
	archived: 'Archived',
	draft: 'Draft',
};

function isDestructiveTransition(from: TaskStatus, to: TaskStatus): boolean {
	if (from === 'archived') return true;
	if (from === 'completed' && to === 'pending') return true;
	if (from === 'cancelled' && to === 'completed') return true;
	return false;
}

function destructiveTransitionWarning(from: TaskStatus, to: TaskStatus): string | null {
	if (from === 'archived') {
		return "You're restoring an archived task. The archived timestamp will be cleared.";
	}
	if (from === 'completed' && to === 'pending') {
		return 'This will restart the task as pending. Previous results will be cleared.';
	}
	if (from === 'cancelled' && to === 'completed') {
		return 'This will force-complete this cancelled task. Use with caution.';
	}
	return null;
}

export interface SetStatusModalProps {
	task: NeoTask;
	isOpen: boolean;
	onClose: () => void;
	onConfirm: (newStatus: TaskStatus) => Promise<void>;
}

export function SetStatusModal({ task, isOpen, onClose, onConfirm }: SetStatusModalProps) {
	const [selectedStatus, setSelectedStatus] = useState<TaskStatus | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const availableStatuses = ALL_TASK_STATUSES.filter((s) => s !== task.status);

	const handleClose = () => {
		setSelectedStatus(null);
		setError(null);
		onClose();
	};

	const handleConfirm = async () => {
		if (!selectedStatus) return;
		setLoading(true);
		setError(null);
		try {
			await onConfirm(selectedStatus);
			setSelectedStatus(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to update task status');
		} finally {
			setLoading(false);
		}
	};

	const warning = selectedStatus ? destructiveTransitionWarning(task.status, selectedStatus) : null;
	const isDestructive = selectedStatus
		? isDestructiveTransition(task.status, selectedStatus)
		: false;

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="Set Task Status">
			<div class="flex flex-col gap-4">
				<p class="text-sm text-gray-400">
					Current status:{' '}
					<span class="font-medium text-gray-200">{STATUS_LABELS[task.status]}</span>
				</p>

				<div class="flex flex-col gap-1.5">
					<label class="text-xs text-gray-500 font-medium uppercase tracking-wide">
						New Status
					</label>
					<select
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-600"
						value={selectedStatus ?? ''}
						onChange={(e) => {
							const val = (e.target as HTMLSelectElement).value;
							setSelectedStatus((val as TaskStatus) || null);
							setError(null);
						}}
					>
						<option value="">Select a status…</option>
						{availableStatuses.map((s) => (
							<option key={s} value={s}>
								{STATUS_LABELS[s]}
							</option>
						))}
					</select>
				</div>

				{warning && (
					<div class="flex items-start gap-2 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2.5">
						<svg
							class="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
							/>
						</svg>
						<p class="text-sm text-amber-300">{warning}</p>
					</div>
				)}

				{error && (
					<p class="text-sm text-red-400 bg-red-900/20 border border-red-800/50 rounded px-3 py-2">
						{error}
					</p>
				)}

				<div class="flex items-center justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={handleClose}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => void handleConfirm()}
						disabled={loading || !selectedStatus}
						data-testid="set-status-confirm"
						class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-1.5 ${
							isDestructive
								? 'bg-amber-600 hover:bg-amber-700 text-white disabled:bg-amber-600/50'
								: 'bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-600/50'
						}`}
					>
						{loading ? 'Updating…' : isDestructive ? 'Force Set Status' : 'Set Status'}
					</button>
				</div>
			</div>
		</Modal>
	);
}
