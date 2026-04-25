/**
 * Shared task-filter predicates.
 *
 * Single source of truth for which `SpaceTask` rows belong in derived
 * UI groupings (e.g. the "Action" tab and the sidebar Tasks badge).
 * Centralising the rule prevents the badge count from silently drifting
 * out of sync with the list it's supposed to summarise.
 *
 * Pure function, no signals or hub calls — safe to use inside renders,
 * computed signals, and unit tests.
 */

import type { SpaceTask } from '@neokai/shared';

/**
 * Minimum shape needed by `isActionRequired` — a structural subset of
 * `SpaceTask`. Keeps fixtures and callers lightweight while still
 * benefiting from compile-time checks if the schema changes.
 */
export type ActionRequiredTaskInput = Pick<SpaceTask, 'status'>;

/**
 * Returns true when a task currently requires human action.
 *
 * The "Action" tab in `SpaceDetailPanel` and the Tasks-nav badge both
 * call this predicate, so the badge count and the visible list cannot
 * drift apart. A task is considered action-required when its status is
 * either `'review'` (awaiting approval) or `'blocked'` (any reason).
 */
export function isActionRequired(task: ActionRequiredTaskInput): boolean {
	return task.status === 'blocked' || task.status === 'review';
}

/**
 * Returns true when a task is actively progressing — not yet awaiting
 * human action and not yet in a terminal state. Used by the "Active"
 * tab in `SpaceDetailPanel`.
 */
export function isActiveTask(task: ActionRequiredTaskInput): boolean {
	return task.status === 'open' || task.status === 'in_progress';
}
