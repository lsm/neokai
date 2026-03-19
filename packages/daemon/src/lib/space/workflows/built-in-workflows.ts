/**
 * Built-in Workflow Templates
 *
 * Defines the canonical workflow templates bundled with NeoKai.
 * These serve as defaults and examples for Space users.
 *
 * Design notes:
 * - Leader is always implicit in SpaceRuntime — never a workflow step.
 * - Templates use placeholder `id` / `spaceId` (empty strings); the seeding
 *   utility stamps in the real spaceId at creation time.
 * - Steps carry stable template-scoped IDs so that the in-memory template
 *   objects satisfy the `SpaceWorkflow` shape.
 */

import type { SpaceWorkflow, WorkflowStepInput } from '@neokai/shared';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

/**
 * Converts SpaceWorkflow steps to WorkflowStepInput[] (drops id/order)
 * so they can be passed to SpaceWorkflowManager.createWorkflow().
 */
function stepsToInputs(steps: SpaceWorkflow['steps']): WorkflowStepInput[] {
	return steps.map((s): WorkflowStepInput => {
		if (s.agentRefType === 'custom') {
			return {
				name: s.name,
				agentRefType: 'custom',
				agentRef: s.agentRef,
				entryGate: s.entryGate,
				exitGate: s.exitGate,
				instructions: s.instructions,
			};
		}
		return {
			name: s.name,
			agentRefType: 'builtin',
			agentRef: s.agentRef,
			entryGate: s.entryGate,
			exitGate: s.exitGate,
			instructions: s.instructions,
		};
	});
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

/**
 * Coding Workflow
 *
 * Two-step workflow: Planner → Coder.
 * - Planner produces a plan; human must approve before coding begins.
 * - Coder implements the plan; a PR review is required before the run completes.
 *
 * Leader is implicit per group — not modelled as a step.
 */
export const CODING_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Coding Workflow',
	description:
		'Plan-first coding workflow. A human reviews the plan before implementation starts, and a PR review gates completion.',
	steps: [
		{
			id: 'tpl-coding-planner',
			name: 'Plan',
			agentRefType: 'builtin',
			agentRef: 'planner',
			exitGate: {
				type: 'human_approval',
				description: 'Review and approve the plan before coding begins',
			},
			order: 0,
		},
		{
			id: 'tpl-coding-coder',
			name: 'Code',
			agentRefType: 'builtin',
			agentRef: 'coder',
			exitGate: {
				type: 'pr_review',
				description: 'Wait for PR review and approval before completing',
			},
			order: 1,
		},
	],
	rules: [],
	tags: ['coding', 'default'],
	createdAt: 0,
	updatedAt: 0,
};

/**
 * Research Workflow
 *
 * Two-step workflow: Planner → General.
 * Both steps use automatic gates — the workflow advances without human intervention,
 * suited for fully autonomous research and summarisation tasks.
 */
export const RESEARCH_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Research Workflow',
	description:
		'Fully automated research workflow. Planner scopes the research; General agent executes and summarises findings.',
	steps: [
		{
			id: 'tpl-research-planner',
			name: 'Plan Research',
			agentRefType: 'builtin',
			agentRef: 'planner',
			exitGate: {
				type: 'auto',
				description: 'Automatically advance after planning is complete',
			},
			order: 0,
		},
		{
			id: 'tpl-research-general',
			name: 'Research',
			agentRefType: 'builtin',
			agentRef: 'general',
			exitGate: {
				type: 'auto',
				description: 'Automatically complete after research is done',
			},
			order: 1,
		},
	],
	rules: [],
	tags: ['research'],
	createdAt: 0,
	updatedAt: 0,
};

/**
 * Review-Only Workflow
 *
 * Single-step workflow: Coder only.
 * No planning phase — used when the task is well-defined and only
 * implementation + PR review are needed.
 */
export const REVIEW_ONLY_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Review-Only Workflow',
	description:
		'Single-step coding workflow with no planning phase. Coder implements directly; a PR review gates completion.',
	steps: [
		{
			id: 'tpl-review-coder',
			name: 'Code',
			agentRefType: 'builtin',
			agentRef: 'coder',
			exitGate: {
				type: 'pr_review',
				description: 'Wait for PR review and approval before completing',
			},
			order: 0,
		},
	],
	rules: [],
	tags: ['coding', 'review'],
	createdAt: 0,
	updatedAt: 0,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns all built-in workflow templates.
 *
 * The returned objects have empty `id` and `spaceId` fields — they are
 * templates, not persisted entities. Callers that need real workflows must
 * seed them into a Space via `seedDefaultWorkflow` or `createWorkflow`.
 */
export function getBuiltInWorkflows(): SpaceWorkflow[] {
	return [CODING_WORKFLOW, RESEARCH_WORKFLOW, REVIEW_ONLY_WORKFLOW];
}

/**
 * Seeds `CODING_WORKFLOW` as the default workflow for the given space.
 *
 * Idempotent: if the space already has at least one workflow, this is a no-op.
 * (The assumption is that any existing workflow was intentionally created,
 * either by a prior seed or by the user.)
 *
 * NOTE: This function is NOT wired to a call site yet — that happens in
 * Task 4.2 (inside the `space.create` RPC handler).
 */
export async function seedDefaultWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager
): Promise<void> {
	const existing = workflowManager.listWorkflows(spaceId);
	if (existing.length > 0) {
		// Already seeded — nothing to do.
		return;
	}

	workflowManager.createWorkflow({
		spaceId,
		name: CODING_WORKFLOW.name,
		description: CODING_WORKFLOW.description,
		steps: stepsToInputs(CODING_WORKFLOW.steps),
		rules: [],
		tags: [...CODING_WORKFLOW.tags],
	});
}
