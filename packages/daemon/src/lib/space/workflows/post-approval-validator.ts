/**
 * Post-approval validator
 *
 * PR 1/5 of the task-agent-as-post-approval-executor refactor. See
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §1.5.
 *
 * A workflow's optional `postApproval` route declares which agent should act on
 * the end-node's approval signal. The route's `targetAgent` must resolve to
 * either:
 *   - the literal string `'task-agent'` (the orchestration Task Agent), or
 *   - the `name` of any `WorkflowNodeAgent` declared in the workflow's nodes.
 *
 * Any other value is invalid — typically the result of stale config after a
 * node rename or deletion. This validator is called from:
 *   - `SpaceWorkflowManager.createWorkflow` / `.updateWorkflow` — hard-reject on
 *     an invalid route (surfaced as `WorkflowValidationError`).
 *   - `SpaceWorkflowManager.getWorkflow` — log a warning and disable the route
 *     for the returned workflow, so a stale persisted config cannot break
 *     runtime load.
 *
 * No runtime consumer reads `postApproval` in this PR — PR 2 wires up the
 * `PostApprovalRouter` and the `mark_complete` tool.
 */

import type { PostApprovalRoute, WorkflowNode, WorkflowNodeInput } from '@neokai/shared';

/**
 * Literal target name that always resolves to the orchestration Task Agent.
 * The Task Agent is a virtual node that is never stored in
 * `space_workflow_nodes` — it is injected at runtime — so it cannot match via
 * the node-agent-name path.
 */
export const POST_APPROVAL_TASK_AGENT_TARGET = 'task-agent';

/**
 * Input shape accepted by the validator. Both the persisted `WorkflowNode`
 * shape and the create-time `WorkflowNodeInput` shape are supported so the
 * validator can be called from both the `create` and `update` code paths of
 * `SpaceWorkflowManager` without re-normalising.
 */
export interface PostApprovalValidationInput {
	/** Optional route to validate. Missing or `undefined` means "no route" → valid. */
	postApproval?: PostApprovalRoute;
	/** Workflow nodes — used to collect eligible node-agent target names. */
	nodes: Array<WorkflowNode | WorkflowNodeInput>;
}

/** Discriminated result — cheaper than throwing in hot paths. */
export type PostApprovalValidationResult =
	| { ok: true }
	| { ok: false; error: string; eligibleTargets: string[] };

/**
 * Collect the set of legal `targetAgent` strings for a workflow, in stable
 * iteration order:
 *   1. `'task-agent'` (the virtual Task Agent node), always eligible.
 *   2. Every `WorkflowNodeAgent.name` in document order.
 *
 * Exported because the error reporter (`SpaceWorkflowManager`) and the load-
 * time warning path may want to surface the list to the user/LLM.
 */
export function collectEligiblePostApprovalTargets(
	nodes: Array<WorkflowNode | WorkflowNodeInput>
): string[] {
	const targets: string[] = [POST_APPROVAL_TASK_AGENT_TARGET];
	const seen = new Set<string>(targets);
	for (const node of nodes) {
		const agents = node.agents ?? [];
		for (const agent of agents) {
			const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
			if (!name || seen.has(name)) continue;
			seen.add(name);
			targets.push(name);
		}
	}
	return targets;
}

/**
 * Validate a workflow's `postApproval` route against its node graph.
 *
 *   - `route === undefined` → valid (post-approval is optional).
 *   - `route.targetAgent === 'task-agent'` → valid.
 *   - `route.targetAgent` matches some `nodes[*].agents[*].name` → valid.
 *   - Any other `targetAgent` → invalid; the error message lists every
 *     eligible target so the caller can surface a helpful repair hint.
 *
 * This does NOT validate `route.instructions` — an empty string is a legal
 * no-op template. Template syntax (`{{identifier}}`) is checked lazily at
 * interpolation time by `post-approval-template.ts`; we do not pre-validate it
 * here because unknown tokens are a runtime concern (the runtime context is
 * not known until an approval signal actually fires).
 */
export function validatePostApproval(
	input: PostApprovalValidationInput
): PostApprovalValidationResult {
	const route = input.postApproval;
	if (!route) {
		return { ok: true };
	}

	const targetAgent = typeof route.targetAgent === 'string' ? route.targetAgent.trim() : '';
	const eligible = collectEligiblePostApprovalTargets(input.nodes);

	if (!targetAgent) {
		return {
			ok: false,
			error:
				`postApproval.targetAgent must be a non-empty string; ` +
				`eligible targets: ${eligible.map((t) => `"${t}"`).join(', ')}`,
			eligibleTargets: eligible,
		};
	}

	if (eligible.includes(targetAgent)) {
		return { ok: true };
	}

	return {
		ok: false,
		error:
			`postApproval.targetAgent "${targetAgent}" does not match any node agent or the ` +
			`orchestration Task Agent; eligible targets: ${eligible.map((t) => `"${t}"`).join(', ')}`,
		eligibleTargets: eligible,
	};
}
