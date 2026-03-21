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
 * - Workflows are directed graphs: steps are nodes, transitions are edges.
 *   A step with no outgoing transitions is a terminal step — the run
 *   completes when that step is reached and advance() is called.
 * - At Space creation time, preset SpaceAgent records are seeded for each
 *   BuiltinAgentRole. `seedBuiltInWorkflows` must be called after those agents
 *   exist so that the `agentId` values resolve correctly.
 */

import { generateUUID } from '@neokai/shared';
import type { SpaceWorkflow } from '@neokai/shared';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';

// ---------------------------------------------------------------------------
// Template step ID constants (used to wire up transitions)
// ---------------------------------------------------------------------------

const CODING_PLANNER_STEP = 'tpl-coding-planner';
const CODING_CODER_STEP = 'tpl-coding-coder';
const CODING_VERIFY_STEP = 'tpl-coding-verify';
const CODING_DONE_STEP = 'tpl-coding-done';

const RESEARCH_PLANNER_STEP = 'tpl-research-planner';
const RESEARCH_GENERAL_STEP = 'tpl-research-general';

const REVIEW_CODER_STEP = 'tpl-review-coder';

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

/**
 * Coding Workflow
 *
 * Four-node graph: Plan → Code → Verify → Done (with cycle).
 * - Plan → Code: `human` condition — a human must approve the plan.
 * - Code → Verify: `always` condition — automatically verify after coding.
 * - Verify → Plan: `task_result` condition on 'failed' — loops back (cyclic).
 * - Verify → Done: `task_result` condition on 'passed' — completes the workflow.
 * - `maxIterations: 3` caps the number of Plan→Code→Verify cycles.
 */
export const CODING_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Coding Workflow',
	description:
		'Plan-first coding workflow with verification. A human reviews the plan, code is implemented, then verified. Loops back on failure.',
	maxIterations: 3,
	steps: [
		{
			id: CODING_PLANNER_STEP,
			name: 'Plan',
			agentId: 'planner',
		},
		{
			id: CODING_CODER_STEP,
			name: 'Code',
			agentId: 'coder',
		},
		{
			id: CODING_VERIFY_STEP,
			name: 'Verify & Test',
			agentId: 'general',
			// NOTE: task_result condition uses prefix matching — "failed: reason" matches expression "failed"
			instructions:
				'Review the completed work. Run tests, check for issues. Set result to "passed" if everything looks good, or "failed: <reason>" if problems are found.',
		},
		{
			id: CODING_DONE_STEP,
			name: 'Done',
			agentId: 'general',
		},
	],
	transitions: [
		{
			id: 'tpl-coding-plan-to-code',
			from: CODING_PLANNER_STEP,
			to: CODING_CODER_STEP,
			condition: {
				type: 'human',
				description: 'Review and approve the plan before coding begins',
			},
			order: 0,
		},
		{
			id: 'tpl-coding-code-to-verify',
			from: CODING_CODER_STEP,
			to: CODING_VERIFY_STEP,
			condition: {
				type: 'always',
				description: 'Automatically verify after coding is complete',
			},
			order: 0,
		},
		{
			id: 'tpl-coding-verify-to-plan',
			from: CODING_VERIFY_STEP,
			to: CODING_PLANNER_STEP,
			condition: {
				type: 'task_result',
				expression: 'failed',
				description: 'Loop back to planning when verification fails',
			},
			order: 0,
			isCyclic: true,
		},
		{
			id: 'tpl-coding-verify-to-done',
			from: CODING_VERIFY_STEP,
			to: CODING_DONE_STEP,
			condition: {
				type: 'task_result',
				expression: 'passed',
				description: 'Complete workflow when verification passes',
			},
			order: 1,
		},
	],
	startStepId: CODING_PLANNER_STEP,
	rules: [],
	tags: ['coding', 'default'],
	createdAt: 0,
	updatedAt: 0,
};

/**
 * Research Workflow
 *
 * Two-node graph: Planner → General.
 * Both transitions use `always` conditions — the workflow advances without
 * human intervention, suited for fully autonomous research and summarisation tasks.
 */
export const RESEARCH_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Research Workflow',
	description:
		'Fully automated research workflow. Planner scopes the research; General agent executes and summarises findings.',
	steps: [
		{
			id: RESEARCH_PLANNER_STEP,
			name: 'Plan Research',
			agentId: 'planner',
		},
		{
			id: RESEARCH_GENERAL_STEP,
			name: 'Research',
			agentId: 'general',
		},
	],
	transitions: [
		{
			id: 'tpl-research-plan-to-research',
			from: RESEARCH_PLANNER_STEP,
			to: RESEARCH_GENERAL_STEP,
			condition: {
				type: 'always',
				description: 'Automatically advance after planning is complete',
			},
			order: 0,
		},
	],
	startStepId: RESEARCH_PLANNER_STEP,
	rules: [],
	tags: ['research'],
	createdAt: 0,
	updatedAt: 0,
};

/**
 * Review-Only Workflow
 *
 * Single-node graph: Coder only (terminal step).
 * No planning phase — used when the task is well-defined and only
 * implementation is needed. The run completes immediately when advance()
 * is called from the Coder step.
 */
export const REVIEW_ONLY_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Review-Only Workflow',
	description:
		'Single-step coding workflow with no planning phase. Coder implements directly; the run completes when done.',
	steps: [
		{
			id: REVIEW_CODER_STEP,
			name: 'Code',
			agentId: 'coder',
		},
	],
	transitions: [],
	startStepId: REVIEW_CODER_STEP,
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
 * NOTE: This function must be called after preset SpaceAgent records have been
 * seeded (inside the `space.create` RPC handler).
 *
 * Example call site:
 * ```ts
 * const agents = spaceAgentManager.listBySpaceId(spaceId);
 * seedBuiltInWorkflows(spaceId, workflowManager, (role) =>
 *   agents.find(a => a.role === role)?.id
 * );
 * ```
 */
export function seedBuiltInWorkflows(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	resolveAgentId: (role: string) => string | undefined
): void {
	const existing = workflowManager.listWorkflows(spaceId);
	if (existing.length > 0) {
		// Already seeded — nothing to do.
		return;
	}

	// Pre-validate: resolve every role needed across ALL templates before
	// persisting anything. This guarantees all-or-nothing behaviour.
	const templates = getBuiltInWorkflows();
	const neededRoles = new Set<string>(
		templates
			.flatMap((t) => t.steps.map((s) => s.agentId))
			.filter((r): r is string => r !== undefined)
	);
	const resolvedIds = new Map<string, string>();
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
		// Assign real UUIDs to template step IDs
		const stepIdMap = new Map<string, string>(); // templateId -> realUUID
		for (const step of template.steps) {
			stepIdMap.set(step.id, generateUUID());
		}

		const steps = template.steps.map((s) => ({
			id: stepIdMap.get(s.id)!,
			name: s.name,
			agentId: resolvedIds.get(s.agentId ?? '')!,
			instructions: s.instructions,
		}));

		const transitions = template.transitions.map((t) => ({
			from: stepIdMap.get(t.from)!,
			to: stepIdMap.get(t.to)!,
			condition: t.condition,
			order: t.order,
			isCyclic: t.isCyclic,
		}));

		const startStepId = stepIdMap.get(template.startStepId)!;

		workflowManager.createWorkflow({
			spaceId,
			name: template.name,
			description: template.description,
			steps,
			transitions,
			startStepId,
			rules: [],
			tags: [...template.tags],
			maxIterations: template.maxIterations,
		});
	}
}
