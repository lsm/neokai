import type { ComponentChildren } from 'preact';
import type { NeoTask, TaskStatus } from '@neokai/shared';
import { useState } from 'preact/hooks';
import { ConfirmModal } from '../../ui/ConfirmModal';

// ─── Shared info box ─────────────────────────────────────────────────────────

function InfoBox({
	variant,
	heading,
	items,
}: {
	variant: 'info' | 'warning' | 'danger';
	heading: string;
	items: ComponentChildren[];
}) {
	const styles = {
		info: { bg: 'bg-dark-800 border-dark-600', text: 'text-gray-300' },
		warning: { bg: 'bg-amber-900/20 border-amber-800/50', text: 'text-amber-400' },
		danger: { bg: 'bg-red-900/20 border-red-800/50', text: 'text-red-400' },
	}[variant];

	return (
		<div class={`${styles.bg} border rounded-lg p-3 text-xs text-gray-400`}>
			<p class={`font-medium ${styles.text} mb-1.5`}>{heading}</p>
			<ul class="list-disc list-inside space-y-1">
				{items.map((item, i) => (
					<li key={i}>{item}</li>
				))}
			</ul>
		</div>
	);
}

// ─── Complete Task Dialog ────────────────────────────────────────────────────

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
		<ConfirmModal
			isOpen={isOpen}
			onClose={handleClose}
			onConfirm={() => void handleConfirm()}
			title="Mark Task as Complete?"
			message={`You are about to mark "${task.title}" as completed.`}
			confirmText="Mark Complete"
			confirmButtonVariant="approve"
			isLoading={loading}
			error={error}
			confirmTestId="complete-task-confirm"
		>
			<InfoBox
				variant="info"
				heading="What happens next:"
				items={[
					<>
						Task status changes to <span class="text-green-400">completed</span>
					</>,
					'Active sessions will be stopped',
					'Worktree and branch are preserved — you can reactivate later',
				]}
			/>
			<div class="mt-3">
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
		</ConfirmModal>
	);
}

// ─── Cancel Task Dialog ──────────────────────────────────────────────────────

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
		<ConfirmModal
			isOpen={isOpen}
			onClose={handleClose}
			onConfirm={() => void handleConfirm()}
			title="Cancel Task?"
			message={`You are about to cancel "${task.title}".`}
			confirmText="Cancel Task"
			confirmButtonVariant="danger"
			cancelText="Keep Task"
			isLoading={loading}
			error={error}
			confirmTestId="cancel-task-confirm"
		>
			<InfoBox
				variant="warning"
				heading="This action is reversible:"
				items={[
					<>
						Task will be marked as <span class="text-gray-300">cancelled</span>
					</>,
					'Active sessions will be stopped',
					'Worktree and branch are preserved — you can reactivate later',
				]}
			/>
		</ConfirmModal>
	);
}

// ─── Archive Task Dialog ─────────────────────────────────────────────────────

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
		<ConfirmModal
			isOpen={isOpen}
			onClose={handleClose}
			onConfirm={() => void handleConfirm()}
			title="Archive Task?"
			message={`You are about to archive "${task.title}".`}
			confirmText="Archive Task"
			confirmButtonVariant="danger"
			cancelText="Keep Task"
			isLoading={loading}
			error={error}
			confirmTestId="archive-task-confirm"
		>
			<InfoBox
				variant="danger"
				heading="This action is permanent:"
				items={[
					<>
						Task will be marked as <span class="text-gray-300">archived</span>
					</>,
					'All sessions will be terminated',
					'Isolated worktree and branch will be cleaned up',
					'The task cannot be reactivated after archiving',
				]}
			/>
		</ConfirmModal>
	);
}

// ─── Set Status Modal ────────────────────────────────────────────────────────

const ALL_TASK_STATUSES: TaskStatus[] = [
	'pending',
	'in_progress',
	'review',
	'completed',
	'needs_attention',
	'cancelled',
	'archived',
	'draft',
	'rate_limited',
	'usage_limited',
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
	rate_limited: 'Rate Limited',
	usage_limited: 'Usage Limited',
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
		<ConfirmModal
			isOpen={isOpen}
			onClose={handleClose}
			onConfirm={() => {
				if (!selectedStatus) {
					setError('Please select a new status.');
					return;
				}
				void handleConfirm();
			}}
			title="Set Task Status"
			message={`Current status: ${STATUS_LABELS[task.status]}`}
			confirmText={isDestructive ? 'Force Set Status' : 'Set Status'}
			confirmButtonVariant={isDestructive ? 'warning' : 'primary'}
			isLoading={loading}
			error={error}
			confirmTestId="set-status-confirm"
		>
			<div class="flex flex-col gap-1.5">
				<label class="text-xs text-gray-500 font-medium uppercase tracking-wide">New Status</label>
				<select
					class="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-600"
					value={selectedStatus ?? ''}
					onInput={(e) => {
						const val = (e.currentTarget as HTMLSelectElement).value;
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
				<div class="flex items-start gap-2 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2.5 mt-3">
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
		</ConfirmModal>
	);
}
