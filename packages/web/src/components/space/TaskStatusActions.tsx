import type { SpaceTaskStatus } from '@neokai/shared';

/**
 * Valid status transitions mirroring the daemon's VALID_SPACE_TASK_TRANSITIONS.
 * Kept in sync manually — the shared package doesn't export this constant.
 */
export const VALID_TASK_TRANSITIONS: Record<SpaceTaskStatus, SpaceTaskStatus[]> = {
	open: ['in_progress', 'blocked', 'done', 'cancelled'],
	in_progress: ['open', 'done', 'blocked', 'cancelled'],
	done: ['in_progress', 'archived'],
	blocked: ['open', 'in_progress', 'archived'],
	cancelled: ['open', 'in_progress', 'done', 'archived'],
	archived: [],
};

/**
 * Human-readable labels for each transition, keyed by `from -> to`.
 */
export const TRANSITION_LABELS: Record<string, string> = {
	'open->in_progress': 'Start',
	'open->blocked': 'Block',
	'open->done': 'Mark Done',
	'open->cancelled': 'Cancel',
	'in_progress->open': 'Pause',
	'in_progress->done': 'Mark Done',
	'in_progress->blocked': 'Block',
	'in_progress->cancelled': 'Cancel',
	'done->in_progress': 'Reopen',
	'done->archived': 'Archive',
	'blocked->open': 'Reopen',
	'blocked->in_progress': 'Resume',
	'blocked->archived': 'Archive',
	'cancelled->open': 'Reopen',
	'cancelled->in_progress': 'Resume',
	'cancelled->done': 'Mark Done',
	'cancelled->archived': 'Archive',
};

/**
 * Tailwind color classes per transition target for visual distinction.
 */
const TRANSITION_STYLES: Record<string, string> = {
	in_progress: 'text-blue-300 hover:text-blue-200',
	done: 'text-green-300 hover:text-green-200',
	blocked: 'text-amber-300 hover:text-amber-200',
	cancelled: 'text-red-300 hover:text-red-200',
	open: 'text-gray-300 hover:text-gray-100',
	archived: 'text-gray-400 hover:text-gray-300',
};

/**
 * Returns the list of valid transition actions from a given status.
 */
export function getTransitionActions(
	currentStatus: SpaceTaskStatus
): Array<{ target: SpaceTaskStatus; label: string }> {
	const targets = VALID_TASK_TRANSITIONS[currentStatus] ?? [];
	return targets.map((target) => ({
		target,
		label: TRANSITION_LABELS[`${currentStatus}->${target}`] ?? target,
	}));
}

interface TaskStatusActionsProps {
	status: SpaceTaskStatus;
	onTransition: (newStatus: SpaceTaskStatus) => void;
	disabled?: boolean;
}

export function TaskStatusActions({ status, onTransition, disabled }: TaskStatusActionsProps) {
	const actions = getTransitionActions(status);

	if (actions.length === 0) {
		return (
			<p class="text-xs text-gray-500" data-testid="task-status-no-actions">
				No status actions available.
			</p>
		);
	}

	return (
		<div class="flex flex-wrap items-center gap-2" data-testid="task-status-actions">
			{actions.map(({ target, label }) => (
				<button
					key={target}
					type="button"
					onClick={() => onTransition(target)}
					disabled={disabled}
					class={`px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${TRANSITION_STYLES[target] ?? 'text-gray-300 hover:text-gray-100'}`}
					data-testid={`task-action-${target}`}
				>
					{label}
				</button>
			))}
		</div>
	);
}
