/**
 * Built-in Workflow Templates
 *
 * Defines the canonical workflow templates bundled with NeoKai.
 * These serve as defaults and examples for Space users.
 *
 * Design notes:
 * - Leader is always implicit in SpaceRuntime — never a workflow step.
 * - Templates use placeholder `id` / `spaceId` (empty strings) and role names
 *   as `agentId` placeholders ('planner', 'coder', 'general'). These are
 *   replaced with real SpaceAgent UUIDs by `seedBuiltInWorkflows`.
 * - At Space creation time, preset SpaceAgent records are seeded for each
 *   BuiltinAgentRole. `seedBuiltInWorkflows` must be called after those agents
 *   exist so that the `agentId` values resolve correctly.
 */

import type { BuiltinAgentRole, SpaceWorkflow, WorkflowStepInput } from '@neokai/shared';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';

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
 * Steps use role names as `agentId` placeholders. Call `seedBuiltInWorkflows`
 * to persist the workflow with real SpaceAgent IDs.
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
			agentId: 'planner',
			exitGate: {
				type: 'human_approval',
				description: 'Review and approve the plan before coding begins',
			},
			order: 0,
		},
		{
			id: 'tpl-coding-coder',
			name: 'Code',
			agentId: 'coder',
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
			agentId: 'planner',
			exitGate: {
				type: 'auto',
				description: 'Automatically advance after planning is complete',
			},
			order: 0,
		},
		{
			id: 'tpl-research-general',
			name: 'Research',
			agentId: 'general',
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
			agentId: 'coder',
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
 * The returned objects have empty `id` and `spaceId` fields and use role names
 * (e.g., `'planner'`, `'coder'`, `'general'`) as `agentId` placeholders.
 * They are templates, not persisted entities. Call `seedBuiltInWorkflows`
 * to persist them with real SpaceAgent IDs for a given space.
 */
export function getBuiltInWorkflows(): SpaceWorkflow[] {
	return [CODING_WORKFLOW, RESEARCH_WORKFLOW, REVIEW_ONLY_WORKFLOW];
}

/**
 * Seeds all three built-in workflow templates into the given space.
 *
 * Each template step's `agentId` placeholder (e.g., `'planner'`, `'coder'`,
 * `'general'`) is resolved to a real SpaceAgent UUID via `resolveAgentId`.
 * If any role cannot be resolved, this function throws — persisting a
 * placeholder string as an `agentId` would create broken workflow data.
 *
 * Idempotent: if the space already has at least one workflow, this is a no-op.
 *
 * NOTE: This function is NOT wired to a call site yet — that happens in
 * Task 4.2 (inside the `space.create` RPC handler, after preset agents are
 * seeded). The resolver should map BuiltinAgentRole → real SpaceAgent ID.
 *
 * Example call site:
 * ```ts
 * const agents = spaceAgentManager.listBySpaceId(spaceId);
 * await seedBuiltInWorkflows(spaceId, workflowManager, (role) =>
 *   agents.find(a => a.role === role)?.id
 * );
 * ```
 */
export async function seedBuiltInWorkflows(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	resolveAgentId: (role: BuiltinAgentRole) => string | undefined
): Promise<void> {
	const existing = workflowManager.listWorkflows(spaceId);
	if (existing.length > 0) {
		// Already seeded — nothing to do.
		return;
	}

	// Pre-validate: resolve every role needed across ALL templates before
	// persisting anything. This guarantees all-or-nothing behaviour — a failure
	// on any role will throw before a single workflow is created.
	const templates = getBuiltInWorkflows();
	const neededRoles = new Set<BuiltinAgentRole>(
		templates.flatMap((t) => t.steps.map((s) => s.agentId as BuiltinAgentRole))
	);
	const resolvedIds = new Map<BuiltinAgentRole, string>();
	for (const role of neededRoles) {
		const agentId = resolveAgentId(role);
		if (!agentId) {
			throw new Error(
				`seedBuiltInWorkflows: no SpaceAgent found for role '${role}' in space '${spaceId}'. ` +
					`Preset agents must be seeded before calling seedBuiltInWorkflows.`
			);
		}
		resolvedIds.set(role, agentId);
	}

	// All roles resolved — safe to persist.
	for (const template of templates) {
		const steps: WorkflowStepInput[] = template.steps.map((s) => ({
			name: s.name,
			agentId: resolvedIds.get(s.agentId as BuiltinAgentRole)!,
			entryGate: s.entryGate,
			exitGate: s.exitGate,
			instructions: s.instructions,
		}));

		workflowManager.createWorkflow({
			spaceId,
			name: template.name,
			description: template.description,
			steps,
			rules: [],
			tags: [...template.tags],
		});
	}
}
