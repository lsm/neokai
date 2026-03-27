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

// V2 node IDs
const V2_PLANNING_STEP = 'tpl-v2-planning';
const V2_PLAN_REVIEW_STEP = 'tpl-v2-plan-review';
const V2_CODING_STEP = 'tpl-v2-coding';
const V2_REVIEWER1_STEP = 'tpl-v2-reviewer1';
const V2_REVIEWER2_STEP = 'tpl-v2-reviewer2';
const V2_REVIEWER3_STEP = 'tpl-v2-reviewer3';
const V2_QA_STEP = 'tpl-v2-qa';
const V2_DONE_STEP = 'tpl-v2-done';

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

/**
 * Coding Workflow V2
 *
 * Eight-node graph with parallel reviewers and QA verification.
 *
 * Main progression:
 *   Planning → Plan Review (plan-pr-gate: planner submits plan)
 *   Plan Review → Coding (plan-approval-gate: reviewer approves)
 *   Coding → Reviewer 1/2/3 in parallel (code-pr-gate: PR opened)
 *   Reviewer 1/2/3 → QA (review-votes-gate: all 3 approve)
 *   QA → Done (qa-result-gate: QA passes)
 *
 * Cyclic paths:
 *   Reviewer 1/2/3 → Coding (review-reject-gate: any reviewer rejects)
 *   QA → Coding (qa-fail-gate: QA finds issues)
 *
 * Ungated feedback channels:
 *   Plan Review → Planning (reviewer requests plan changes)
 *   Coding → Planning (coder asks planner for clarification)
 */
export const CODING_WORKFLOW_V2: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Coding Workflow V2',
	description:
		'Full-cycle coding workflow with plan review, parallel code reviewers, and QA gate. ' +
		'Supports rejection cycles at both review and QA stages.',
	maxIterations: 5,
	nodes: [
		{
			id: V2_PLANNING_STEP,
			name: 'Planning',
			agentId: 'planner',
			instructions:
				'Break down the task into an actionable implementation plan. ' +
				'When the plan is ready, write it to the plan-pr-gate (field: plan_submitted) to notify reviewers.',
		},
		{
			id: V2_PLAN_REVIEW_STEP,
			name: 'Plan Review',
			agentId: 'reviewer',
			instructions:
				'Review the implementation plan for feasibility and completeness. ' +
				'Write to plan-approval-gate with field "approved: true" to approve, or send feedback to Planning.',
		},
		{
			id: V2_CODING_STEP,
			name: 'Coding',
			agentId: 'coder',
			instructions:
				'Implement the approved plan. Open a pull request when done. ' +
				'Write the PR URL to code-pr-gate (field: pr_url) to notify reviewers.',
		},
		{
			id: V2_REVIEWER1_STEP,
			name: 'Reviewer 1',
			agentId: 'reviewer',
			instructions:
				'Review the pull request for correctness, style, and test coverage. ' +
				'To record your vote: (1) use read_gate to fetch the current votes map from review-votes-gate, ' +
				'(2) add your entry (key: "Reviewer 1", value: "approved" or "rejected") to the map, ' +
				'(3) write the complete updated map back via write_gate on both review-votes-gate and review-reject-gate ' +
				'(field: votes). Never write only your own entry — always include all existing votes to avoid overwriting peers.',
		},
		{
			id: V2_REVIEWER2_STEP,
			name: 'Reviewer 2',
			agentId: 'reviewer',
			instructions:
				'Review the pull request for correctness, style, and test coverage. ' +
				'To record your vote: (1) use read_gate to fetch the current votes map from review-votes-gate, ' +
				'(2) add your entry (key: "Reviewer 2", value: "approved" or "rejected") to the map, ' +
				'(3) write the complete updated map back via write_gate on both review-votes-gate and review-reject-gate ' +
				'(field: votes). Never write only your own entry — always include all existing votes to avoid overwriting peers.',
		},
		{
			id: V2_REVIEWER3_STEP,
			name: 'Reviewer 3',
			agentId: 'reviewer',
			instructions:
				'Review the pull request for correctness, style, and test coverage. ' +
				'To record your vote: (1) use read_gate to fetch the current votes map from review-votes-gate, ' +
				'(2) add your entry (key: "Reviewer 3", value: "approved" or "rejected") to the map, ' +
				'(3) write the complete updated map back via write_gate on both review-votes-gate and review-reject-gate ' +
				'(field: votes). Never write only your own entry — always include all existing votes to avoid overwriting peers.',
		},
		{
			id: V2_QA_STEP,
			name: 'QA',
			agentId: 'qa',
			instructions:
				'Verify test coverage, run the CI pipeline, and confirm the PR is mergeable. ' +
				'Always write an explicit result to qa-result-gate on every QA pass — do not assume the gate was reset. ' +
				'Write "result: passed" if everything is green, or "result: failed" with details if issues are found. ' +
				'Writing is required on every pass because qa-result-gate retains its previous value across cycles.',
		},
		{
			id: V2_DONE_STEP,
			name: 'Done',
			agentId: 'general',
		},
	],
	startNodeId: V2_PLANNING_STEP,
	rules: [],
	tags: ['coding', 'v2', 'parallel-review', 'default'],
	createdAt: 0,
	updatedAt: 0,
	// Gates — independent entities referenced by channels via gateId
	gates: [
		{
			id: 'plan-pr-gate',
			description: 'Planning agent has submitted a plan for review',
			condition: { type: 'check', field: 'plan_submitted', op: 'exists' },
			data: {},
			allowedWriterRoles: ['planner'],
			resetOnCycle: false,
		},
		{
			id: 'plan-approval-gate',
			description: 'Plan has been reviewed and approved by the plan reviewer',
			condition: { type: 'check', field: 'approved', op: '==', value: true },
			data: {},
			allowedWriterRoles: ['reviewer'],
			resetOnCycle: true,
		},
		{
			id: 'code-pr-gate',
			description: 'Code has been implemented and a pull request has been opened',
			condition: { type: 'check', field: 'pr_url', op: 'exists' },
			data: {},
			allowedWriterRoles: ['coder'],
			resetOnCycle: true,
		},
		{
			id: 'review-votes-gate',
			description:
				'All three reviewers have approved the code changes. ' +
				'Agents must read the current votes map first, add their entry, then write the full map back ' +
				'(read-merge-write) — write_gate performs a shallow merge so writing only your own entry ' +
				"would overwrite all other reviewers' votes.",
			condition: { type: 'count', field: 'votes', matchValue: 'approved', min: 3 },
			data: {},
			allowedWriterRoles: ['reviewer'],
			resetOnCycle: true,
		},
		{
			id: 'review-reject-gate',
			description:
				'At least one reviewer has rejected the code changes. ' +
				'Agents must read the current votes map first, add their entry, then write the full map back ' +
				'(read-merge-write) — write_gate performs a shallow merge so writing only your own entry ' +
				"would overwrite all other reviewers' votes.",
			condition: { type: 'count', field: 'votes', matchValue: 'rejected', min: 1 },
			data: {},
			allowedWriterRoles: ['reviewer'],
			resetOnCycle: true,
		},
		{
			id: 'qa-result-gate',
			description:
				'QA verification has passed — tests, CI, and PR are green. ' +
				'resetOnCycle is intentionally false: this gate is only referenced by the non-cyclic QA→Done ' +
				'channel, so it never auto-resets. QA must write an explicit "result" on every pass.',
			condition: { type: 'check', field: 'result', op: '==', value: 'passed' },
			data: {},
			allowedWriterRoles: ['qa'],
			resetOnCycle: false,
		},
		{
			id: 'qa-fail-gate',
			description: 'QA found issues — needs another coding and review cycle',
			condition: { type: 'check', field: 'result', op: '==', value: 'failed' },
			data: {},
			allowedWriterRoles: ['qa'],
			resetOnCycle: true,
		},
	],
	// Channels — simple unidirectional pipes, gated via gateId references
	channels: [
		// Main progression: Planning → Plan Review → Coding
		{
			from: 'Planning',
			to: 'Plan Review',
			direction: 'one-way',
			gateId: 'plan-pr-gate',
			label: 'Planning → Plan Review',
		},
		{
			from: 'Plan Review',
			to: 'Coding',
			direction: 'one-way',
			gateId: 'plan-approval-gate',
			label: 'Plan Review → Coding',
		},
		// Coding → Reviewers (fan-out, shared code-pr-gate)
		{
			from: 'Coding',
			to: 'Reviewer 1',
			direction: 'one-way',
			gateId: 'code-pr-gate',
			label: 'Coding → Reviewer 1',
		},
		{
			from: 'Coding',
			to: 'Reviewer 2',
			direction: 'one-way',
			gateId: 'code-pr-gate',
			label: 'Coding → Reviewer 2',
		},
		{
			from: 'Coding',
			to: 'Reviewer 3',
			direction: 'one-way',
			gateId: 'code-pr-gate',
			label: 'Coding → Reviewer 3',
		},
		// Reviewers → QA (fan-in, shared review-votes-gate: all 3 must approve)
		{
			from: 'Reviewer 1',
			to: 'QA',
			direction: 'one-way',
			gateId: 'review-votes-gate',
			label: 'Reviewer 1 → QA',
		},
		{
			from: 'Reviewer 2',
			to: 'QA',
			direction: 'one-way',
			gateId: 'review-votes-gate',
			label: 'Reviewer 2 → QA',
		},
		{
			from: 'Reviewer 3',
			to: 'QA',
			direction: 'one-way',
			gateId: 'review-votes-gate',
			label: 'Reviewer 3 → QA',
		},
		// QA → Done (success path)
		{
			from: 'QA',
			to: 'Done',
			direction: 'one-way',
			gateId: 'qa-result-gate',
			label: 'QA → Done',
		},
		// Cyclic: QA → Coding (QA found issues)
		{
			from: 'QA',
			to: 'Coding',
			direction: 'one-way',
			gateId: 'qa-fail-gate',
			isCyclic: true,
			label: 'QA → Coding (on fail)',
		},
		// Cyclic: Reviewer 1/2/3 → Coding (reviewer rejected changes)
		{
			from: 'Reviewer 1',
			to: 'Coding',
			direction: 'one-way',
			gateId: 'review-reject-gate',
			isCyclic: true,
			label: 'Reviewer 1 → Coding (on reject)',
		},
		{
			from: 'Reviewer 2',
			to: 'Coding',
			direction: 'one-way',
			gateId: 'review-reject-gate',
			isCyclic: true,
			label: 'Reviewer 2 → Coding (on reject)',
		},
		{
			from: 'Reviewer 3',
			to: 'Coding',
			direction: 'one-way',
			gateId: 'review-reject-gate',
			isCyclic: true,
			label: 'Reviewer 3 → Coding (on reject)',
		},
		// Ungated feedback: Plan Review ↔ Planning, Coding → Planning
		{
			from: 'Plan Review',
			to: 'Planning',
			direction: 'one-way',
			label: 'Plan Review → Planning (feedback)',
		},
		{
			from: 'Coding',
			to: 'Planning',
			direction: 'one-way',
			label: 'Coding → Planning (feedback)',
		},
	],
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
	return [CODING_WORKFLOW, CODING_WORKFLOW_V2, RESEARCH_WORKFLOW, REVIEW_ONLY_WORKFLOW];
}

/**
 * Seeds all four built-in workflow templates into the given space.
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
			gates: template.gates ? [...template.gates] : undefined,
		});
	}
}
