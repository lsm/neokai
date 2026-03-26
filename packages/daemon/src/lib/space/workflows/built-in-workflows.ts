/**
 * Built-in Workflow Templates
 *
 * Defines the canonical workflow templates bundled with NeoKai.
 * These serve as defaults and examples for Space users.
 *
 * Design notes:
 * - Leader is always implicit in SpaceRuntime — never a workflow node.
 * - Templates use placeholder `id` / `spaceId` (empty strings) and role names
 *   as `agentId` placeholders ('planner', 'coder', 'general'). These are
 *   replaced with real SpaceAgent UUIDs by `seedBuiltInWorkflows`.
 * - Workflows use gated channels for inter-agent communication (agent-centric
 *   model). Transitions are empty for agent-centric workflows; completion is
 *   detected when all agents report done.
 * - At Space creation time, preset SpaceAgent records are seeded for each
 *   BuiltinAgentRole. `seedBuiltInWorkflows` must be called after those agents
 *   exist so that the `agentId` values resolve correctly.
 * - Channels use node names (e.g. 'Plan', 'Code') in `from`/`to` so they
 *   resolve correctly at runtime without UUID translation in the seeder.
 *   `resolveChannels()` matches node names via the `nodeNameToAgents` lookup.
 */

import { generateUUID } from '@neokai/shared';
import type { SpaceWorkflow } from '@neokai/shared';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';

// ---------------------------------------------------------------------------
// Template node ID constants (used as stable IDs for nodes and startNodeId)
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
 * Routing is channel-based (agent-centric model); routing is channel-based.
 * - Plan → Code: `human` gate — a human must approve the plan.
 * - Code → Verify: `always` gate — automatically verify after coding.
 * - Verify → Plan: `task_result` gate on 'failed' — loops back (cyclic).
 * - Verify → Done: `task_result` gate on 'passed' — completes the workflow.
 * - `maxIterations: 3` caps the number of Plan→Code→Verify cycles.
 */
export const CODING_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Coding Workflow',
	description:
		'Plan-first coding workflow with verification. A human reviews the plan, code is implemented, then verified. Loops back on failure.',
	maxIterations: 3,
	nodes: [
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
	startNodeId: CODING_PLANNER_STEP,
	rules: [],
	tags: ['coding', 'default'],
	createdAt: 0,
	updatedAt: 0,
	channels: [
		{
			from: 'Plan',
			to: 'Code',
			direction: 'one-way',
			gate: {
				type: 'human',
				description: 'Review and approve the plan before coding begins',
			},
			label: 'Plan → Code',
		},
		{
			from: 'Code',
			to: 'Verify & Test',
			direction: 'one-way',
			gate: {
				type: 'always',
				description: 'Automatically verify after coding is complete',
			},
			label: 'Code → Verify',
		},
		{
			from: 'Verify & Test',
			to: 'Plan',
			direction: 'one-way',
			isCyclic: true,
			gate: {
				type: 'task_result',
				expression: 'failed',
				description: 'Loop back to planning when verification fails',
			},
			label: 'Verify → Plan (on fail)',
		},
		{
			from: 'Verify & Test',
			to: 'Done',
			direction: 'one-way',
			gate: {
				type: 'task_result',
				expression: 'passed',
				description: 'Complete workflow when verification passes',
			},
			label: 'Verify → Done (on pass)',
		},
	],
};

/**
 * Research Workflow
 *
 * Two-node graph: Planner → General.
 * Routing is channel-based (agent-centric model); routing is channel-based.
 * - Plan Research → Research: `always` gate — advances without human intervention.
 */
export const RESEARCH_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Research Workflow',
	description:
		'Fully automated research workflow. Planner scopes the research; General agent executes and summarises findings.',
	nodes: [
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
	startNodeId: RESEARCH_PLANNER_STEP,
	rules: [],
	tags: ['research'],
	createdAt: 0,
	updatedAt: 0,
	channels: [
		{
			from: 'Plan Research',
			to: 'Research',
			direction: 'one-way',
			gate: {
				type: 'always',
				description: 'Automatically advance after planning is complete',
			},
			label: 'Plan → Research',
		},
	],
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
	nodes: [
		{
			id: REVIEW_CODER_STEP,
			name: 'Code',
			agentId: 'coder',
		},
	],
	startNodeId: REVIEW_CODER_STEP,
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
			.flatMap((t) => t.nodes.map((s) => s.agentId))
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
		// Assign real UUIDs to template node IDs
		const nodeIdMap = new Map<string, string>(); // templateId -> realUUID
		for (const node of template.nodes) {
			nodeIdMap.set(node.id, generateUUID());
		}

		const nodes = template.nodes.map((s) => ({
			id: nodeIdMap.get(s.id)!,
			name: s.name,
			agentId: resolvedIds.get(s.agentId ?? '')!,
			instructions: s.instructions,
		}));

		const startNodeId = nodeIdMap.get(template.startNodeId)!;

		workflowManager.createWorkflow({
			spaceId,
			name: template.name,
			description: template.description,
			nodes,
			startNodeId,
			rules: [],
			tags: [...template.tags],
			maxIterations: template.maxIterations,
			channels: template.channels ? [...template.channels] : undefined,
		});
	}
}
