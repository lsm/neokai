import type { SpaceTaskStatus } from '@neokai/shared';

/**
 * Valid status transitions mirroring the daemon's VALID_SPACE_TASK_TRANSITIONS.
 * Kept in sync manually — the shared package doesn't export this constant.
 */
export const VALID_TASK_TRANSITIONS: Record<SpaceTaskStatus, SpaceTaskStatus[]> = {
	open: ['in_progress', 'blocked', 'done', 'cancelled'],
	in_progress: ['open', 'review', 'done', 'blocked', 'cancelled'],
	review: ['done', 'in_progress', 'cancelled', 'archived'],
	// `approved` is the post-approval staging status added in PR 1/5 of the
	// task-agent-as-post-approval-executor refactor. No runtime consumer
	// produces this status yet — PR 2 wires it in. Listed here with a
	// conservative transition set (escape hatches to `done`/`in_progress`/
	// `archived`) so that manually-set `approved` rows can still be moved
	// along, and so `Record<SpaceTaskStatus, SpaceTaskStatus[]>` typechecks.
	// Deliberately NOT reachable from `review` yet — PR 2 adds that edge.
	approved: ['done', 'in_progress', 'archived'],
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
	'in_progress->review': 'Submit for Review',
	'in_progress->done': 'Mark Done',
	'in_progress->blocked': 'Block',
	'in_progress->cancelled': 'Cancel',
	'review->done': 'Approve',
	'review->in_progress': 'Reopen',
	'review->cancelled': 'Cancel',
	'review->archived': 'Archive',
	// PR 1/5 schema-only: `approved` has no user-facing enter edge yet. Labels
	// for `approved -> X` are defined here so that if the status is manually
	// set (e.g. tests) the Task pane still renders readable action buttons.
	'approved->done': 'Mark Done',
	'approved->in_progress': 'Reopen',
	'approved->archived': 'Archive',
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
	review: 'text-purple-300 hover:text-purple-200',
	approved: 'text-emerald-300 hover:text-emerald-200',
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
	/**
	 * Type of checkpoint the task is paused at, if any. When set to
	 * `task_completion`, the generic Approve/Reject transitions are hidden and
	 * routed through `PendingTaskCompletionBanner` instead — that banner shows
	 * what the approval actually does, which the generic buttons can't.
	 */
	pendingCheckpointType?: 'gate' | 'task_completion' | null;
}

export function TaskStatusActions({
	status,
	onTransition,
	disabled,
	pendingCheckpointType,
}: TaskStatusActionsProps) {
	const allActions = getTransitionActions(status);
	// When a task is paused at a submit_for_approval checkpoint or a channel
	// gate awaiting human approval, hide the generic Approve (review → done)
	// and Cancel (review → cancelled) buttons. The dedicated banner owns those
	// transitions. For gate-pending tasks the PendingGateBanner provides the
	// Approve/Reject UX; bypassing it via the generic button would mark the task
	// done without opening the gate. Non-checkpoint transitions (e.g. Reopen →
	// in_progress, Archive) stay visible.
	const actions =
		pendingCheckpointType === 'task_completion' || pendingCheckpointType === 'gate'
			? allActions.filter(({ target }) => target !== 'done' && target !== 'cancelled')
			: allActions;

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
