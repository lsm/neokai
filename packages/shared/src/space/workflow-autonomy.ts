/**
 * Workflow autonomy helpers.
 *
 * Determines whether a `SpaceWorkflow` will run end-to-end without human
 * approval at a given Space autonomy level. The UI uses these helpers to
 * show users — at a glance — how many of a Space's workflows are "autonomous"
 * at the currently-selected level.
 *
 * Rules:
 *   - A workflow is "autonomous at level N" iff **every completion action on
 *     every node** has `requiredLevel <= N`.
 *   - Workflows with zero completion actions (e.g. Review-Only templates) fall
 *     back to the Space runtime's binary autonomy check: `level >= 2` runs to
 *     `done`, `level < 2` pauses at `review`. The constant
 *     `EMPTY_ACTIONS_AUTONOMY_THRESHOLD` is the single source of truth for
 *     this threshold; `space-runtime.ts` imports `isAutonomousWithoutActions`
 *     from this module so the two surfaces cannot drift.
 *
 * These are pure functions with no DB or runtime dependencies — safe to use
 * from both the daemon and the web bundle.
 */

import type { SpaceWorkflow } from '../types/space.ts';

/**
 * Space autonomy level at (and above) which workflows with no completion
 * actions auto-complete to `done`. Below this threshold, they pause at
 * `review` for human sign-off.
 *
 * Mirrors the runtime's binary autonomy check at
 * `space-runtime.ts` (`spaceLevel >= 2 ? 'done' : 'review'`). The runtime
 * consumes this constant via `isAutonomousWithoutActions()` so there is
 * exactly one source of truth.
 */
export const EMPTY_ACTIONS_AUTONOMY_THRESHOLD = 2;

/**
 * Returns `true` when a workflow with zero completion actions would run to
 * `done` at the given Space autonomy level.
 *
 * Intended for runtime use — the web UI usually reaches this through
 * `isWorkflowAutonomousAtLevel`, which folds this fallback in.
 */
export function isAutonomousWithoutActions(level: number): boolean {
	return level >= EMPTY_ACTIONS_AUTONOMY_THRESHOLD;
}

/**
 * A single completion action that blocks a workflow from running
 * autonomously at a given level.
 */
export interface BlockingAction {
	/** Name of the node the action belongs to. */
	nodeName: string;
	/** `CompletionAction.id` */
	actionId: string;
	/** `CompletionAction.name` — user-facing action label (e.g. "Merge PR"). */
	actionName: string;
	/** `CompletionAction.requiredLevel` — the minimum Space autonomy level to auto-run it. */
	requiredLevel: number;
}

/**
 * A workflow that is *not* fully autonomous at the evaluated level, along
 * with the completion actions that would still pause it.
 */
export interface BlockingWorkflow {
	workflowId: string;
	workflowName: string;
	blockedBy: BlockingAction[];
}

/**
 * Aggregate count of autonomous vs. blocking workflows at a given level.
 */
export interface AutonomousWorkflowCount {
	/** How many workflows in `workflows` run end-to-end without approval at `level`. */
	autonomous: number;
	/** Total number of workflows evaluated (equals `workflows.length`). */
	total: number;
	/** Per-workflow breakdown of the actions that still require approval. */
	blocking: BlockingWorkflow[];
}

/**
 * Returns `true` when `wf` would run end-to-end without approval at the
 * given Space autonomy `level`.
 *
 * See module docstring for the exact rules (including the runtime fallback
 * for workflows with zero completion actions).
 */
export function isWorkflowAutonomousAtLevel(wf: SpaceWorkflow, level: number): boolean {
	const actions = collectCompletionActions(wf);
	if (actions.length === 0) {
		return isAutonomousWithoutActions(level);
	}
	return actions.every((a) => a.requiredLevel <= level);
}

/**
 * Counts how many workflows are autonomous at `level` and lists the
 * completion actions blocking the rest.
 *
 * The `blocking` array only includes workflows that are **not** autonomous
 * at `level`. For workflows whose non-autonomy stems from the
 * zero-actions-runtime fallback, `blockedBy` is an empty array (the UI can
 * render a generic "requires level 2" message).
 */
export function countAutonomousWorkflows(
	workflows: SpaceWorkflow[],
	level: number
): AutonomousWorkflowCount {
	const blocking: BlockingWorkflow[] = [];
	let autonomous = 0;

	for (const wf of workflows) {
		const actions = collectCompletionActions(wf);

		if (actions.length === 0) {
			if (isAutonomousWithoutActions(level)) {
				autonomous += 1;
			} else {
				blocking.push({
					workflowId: wf.id,
					workflowName: wf.name,
					blockedBy: [],
				});
			}
			continue;
		}

		const blockedBy = actions
			.filter((a) => a.requiredLevel > level)
			.map((a) => ({
				nodeName: a.nodeName,
				actionId: a.actionId,
				actionName: a.actionName,
				requiredLevel: a.requiredLevel,
			}));

		if (blockedBy.length === 0) {
			autonomous += 1;
		} else {
			blocking.push({
				workflowId: wf.id,
				workflowName: wf.name,
				blockedBy,
			});
		}
	}

	return { autonomous, total: workflows.length, blocking };
}

// ── Internal helpers ──────────────────────────────────────────────────────

interface FlatAction {
	nodeName: string;
	actionId: string;
	actionName: string;
	requiredLevel: number;
}

/**
 * Flattens every completion action across every node into a single list,
 * tagged with the owning node's name so callers can render a useful
 * "blocked by X on node Y" message.
 */
function collectCompletionActions(wf: SpaceWorkflow): FlatAction[] {
	const out: FlatAction[] = [];
	for (const node of wf.nodes) {
		const actions = node.completionActions;
		if (!actions) continue;
		for (const action of actions) {
			out.push({
				nodeName: node.name,
				actionId: action.id,
				actionName: action.name,
				requiredLevel: action.requiredLevel,
			});
		}
	}
	return out;
}
