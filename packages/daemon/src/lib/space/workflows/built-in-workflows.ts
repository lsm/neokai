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

const CODING_CODE_STEP = 'tpl-coding-code';
const CODING_REVIEW_STEP = 'tpl-coding-review';

// V2 node IDs
const V2_PLANNING_STEP = 'tpl-v2-planning';
const V2_PLAN_REVIEW_STEP = 'tpl-v2-plan-review';
const V2_CODING_STEP = 'tpl-v2-coding';
const V2_REVIEW_STEP = 'tpl-v2-review';
const V2_QA_STEP = 'tpl-v2-qa';
const V2_DONE_STEP = 'tpl-v2-done';

const PR_READY_BASH_SCRIPT = [
	'# Single atomic call to avoid state changing between checks',
	'if ! PR_JSON=$(gh pr view --json url,state,mergeable,mergeStateStatus) || [ -z "$PR_JSON" ]; then',
	'  echo "Failed to retrieve PR info (not authenticated, no PR, or network error)" >&2',
	'  exit 1',
	'fi',
	'PR_URL=$(jq -r \'.url\' <<< "$PR_JSON")',
	'if [ -z "$PR_URL" ] || [ "$PR_URL" = "null" ]; then',
	'  echo "No PR URL found for current branch" >&2',
	'  exit 1',
	'fi',
	'PR_STATE=$(jq -r \'.state\' <<< "$PR_JSON")',
	'if [ "$PR_STATE" != "OPEN" ]; then',
	'  echo "No open PR found for current branch (state: ${PR_STATE:-none})" >&2',
	'  exit 1',
	'fi',
	'PR_MERGEABLE=$(jq -r \'.mergeable\' <<< "$PR_JSON")',
	'# Block on UNKNOWN — orchestrator retries until GitHub resolves mergeability',
	'if [ "$PR_MERGEABLE" != "MERGEABLE" ]; then',
	'  echo "PR is not mergeable (mergeable: ${PR_MERGEABLE:-unknown})" >&2',
	'  exit 1',
	'fi',
	'PR_STATUS=$(jq -r \'.mergeStateStatus\' <<< "$PR_JSON")',
	'# Block on UNKNOWN — orchestrator retries until GitHub resolves status',
	'if [ "$PR_STATUS" != "CLEAN" ] && [ "$PR_STATUS" != "HAS_HOOKS" ]; then',
	'  echo "PR merge checks not satisfied (mergeStateStatus: ${PR_STATUS:-unknown})" >&2',
	'  exit 1',
	'fi',
	'printf \'{"pr_url":"%s"}\\n\' "$PR_URL"',
].join('\n');

const V2_PLANNING_PROMPT =
	'You are the Planning node for this workflow. Turn the task into a concrete implementation plan ' +
	'that downstream nodes can execute without guessing. Surface assumptions, dependencies, sequencing, ' +
	'and open questions explicitly.';

const V2_PLAN_REVIEW_PROMPT =
	'You are the Plan Review node for this workflow. Critically review the proposed plan for scope, ' +
	'correctness, feasibility, testing strategy, and risk. Approve only when the plan is actionable and complete.';

const V2_CODING_PROMPT =
	'You are the Coding node for this workflow. Implement the approved plan in the workspace, keep the ' +
	'changes reviewable, and leave the branch in a state that reviewers and QA can validate directly.';

const V2_CODE_REVIEW_PROMPT =
	'You are part of the Code Review node for this workflow. Review the implementation independently for ' +
	'correctness, regressions, maintainability, and test coverage. Record a clear approve or reject vote with concise reasoning.';

const V2_QA_PROMPT =
	'You are the QA node for this workflow. Validate the implementation from an execution and release-readiness ' +
	'perspective. Run the relevant checks, confirm the reported state, and fail the handoff when issues remain.';

const V2_DONE_PROMPT =
	'You are the Done node for this workflow. Confirm the workflow has reached a completed state and produce ' +
	'a concise final outcome summary without reopening work unless a blocking issue is discovered.';

const RESEARCH_STEP = 'tpl-research-research';
const RESEARCH_REVIEW_STEP = 'tpl-research-review';

const REVIEW_REVIEW_STEP = 'tpl-review-review';

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

/**
 * Coding Workflow
 *
 * Two-node iterative graph: Code ↔ Review (with cycle).
 * - Code → Review: gated by `code-ready-gate` — a bash script verifies that an
 *   open, mergeable PR exists and emits its URL as `{"pr_url":"..."}`.
 * - Review → Code: ungated — Reviewer sends back for changes without any gate.
 *   When satisfied, Reviewer calls `report_done()` on the Review node (endNodeId)
 *   which signals workflow completion.
 */
export const CODING_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Coding Workflow',
	description:
		'Iterative coding workflow with Code ↔ Review loop. Coder implements and opens a PR; Reviewer reviews and either requests changes or signals completion.',
	nodes: [
		{
			id: CODING_CODE_STEP,
			name: 'Code',
			agents: [
				{
					agentId: 'Coder',
					name: 'coder',
					systemPrompt: {
						mode: 'expand',
						value:
							'You are working on a coding task in a Coder→Reviewer iterative workflow. Write code, run tests, ' +
							'commit all changes, and open a PR. The gate will verify the PR is open and mergeable ' +
							'before passing to the Reviewer.',
					},
				},
			],
			instructions:
				'Implement the task. When done, create a pull request with `gh pr create` ' +
				'and ensure the PR URL is available from `gh pr view`. The code-ready-gate ' +
				'will verify this automatically before advancing to Review.',
		},
		{
			id: CODING_REVIEW_STEP,
			name: 'Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'reviewer',
					systemPrompt: {
						mode: 'expand',
						value:
							'You are the final reviewer in a Coder→Reviewer iterative workflow. Review the open PR. Call report_done() ' +
							'when satisfied. If changes are needed, provide specific feedback — the Coder will be sent back automatically.',
					},
				},
			],
			instructions:
				'Review the pull request for correctness and quality. If changes are needed, send feedback to Code. ' +
				'When satisfied, call report_done() to complete the workflow.',
		},
	],
	startNodeId: CODING_CODE_STEP,
	endNodeId: CODING_REVIEW_STEP,
	tags: ['coding', 'default'],
	createdAt: 0,
	updatedAt: 0,
	gates: [
		{
			id: 'code-ready-gate',
			description: 'Coder has opened an active, mergeable pull request',
			fields: [
				{
					name: 'pr_url',
					type: 'string',
					writers: ['*'],
					check: { op: 'exists' },
				},
			],
			script: {
				interpreter: 'bash',
				source: PR_READY_BASH_SCRIPT,
				timeoutMs: 30000,
			},
			resetOnCycle: true,
		},
	],
	channels: [
		{
			from: 'Code',
			to: 'Review',
			direction: 'one-way',
			gateId: 'code-ready-gate',
			label: 'Code → Review',
		},
		{
			from: 'Review',
			to: 'Code',
			direction: 'one-way',
			maxCycles: 5,
			label: 'Review → Code (changes requested)',
		},
	],
};

/**
 * Research Workflow
 *
 * Two-node iterative graph:
 *   Research → Review (gated by research-ready-gate: PR opened and mergeable)
 *   Review → Research (ungated back-channel, max 5 cycles)
 *
 * Research agent researches thoroughly, commits findings, opens a PR.
 * Reviewer agent reviews the research PR; calls report_done() if satisfied,
 * or sends back for more research via the back-channel.
 */
export const RESEARCH_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Research Workflow',
	description:
		'Iterative research workflow with gated PR verification. Research agent investigates and opens a PR; Reviewer evaluates findings and requests revisions if needed.',
	nodes: [
		{
			id: RESEARCH_STEP,
			name: 'Research',
			agents: [
				{
					agentId: 'Research',
					name: 'research',
					systemPrompt: {
						mode: 'expand',
						value:
							'You are conducting research in a Research→Reviewer iterative workflow. Investigate thoroughly, write findings ' +
							'to markdown docs, commit, and open a PR. The gate will verify the PR is open and mergeable.',
					},
				},
			],
			instructions:
				'Research the topic thoroughly. When done, commit all findings and open a pull request with `gh pr create`. ' +
				'The research-ready-gate will verify the PR automatically before advancing to Review.',
		},
		{
			id: RESEARCH_REVIEW_STEP,
			name: 'Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'reviewer',
					systemPrompt: {
						mode: 'expand',
						value:
							'You are the reviewer in a Research→Reviewer iterative workflow. Review the research PR for ' +
							'completeness and accuracy. Call report_done() when satisfied. If more research is needed, ' +
							'provide specific feedback.',
					},
				},
			],
			instructions:
				'Review the research pull request for completeness and quality. If more research is needed, send feedback to Research. ' +
				'When satisfied, call report_done() to complete the workflow.',
		},
	],
	startNodeId: RESEARCH_STEP,
	endNodeId: RESEARCH_REVIEW_STEP,
	tags: ['research'],
	createdAt: 0,
	updatedAt: 0,
	gates: [
		{
			id: 'research-ready-gate',
			description: 'Research agent has opened an active, mergeable pull request',
			fields: [
				{
					name: 'pr_url',
					type: 'string',
					writers: ['*'],
					check: { op: 'exists' },
				},
			],
			script: {
				interpreter: 'bash',
				source: PR_READY_BASH_SCRIPT,
				timeoutMs: 30000,
			},
			resetOnCycle: true,
		},
	],
	channels: [
		{
			from: 'Research',
			to: 'Review',
			direction: 'one-way',
			gateId: 'research-ready-gate',
			label: 'Research → Review',
		},
		{
			from: 'Review',
			to: 'Research',
			direction: 'one-way',
			maxCycles: 5,
			label: 'Review → Research (more research needed)',
		},
	],
};
/**
 * Review-Only Workflow
 *
 * Single-node graph: Reviewer only (terminal step).
 * No planning phase — used when the task is well-defined and only
 * review is needed. The run completes immediately when advance()
 * is called from the Review step.
 *
 * startNodeId and endNodeId point to the same node (single-node workflow).
 */
export const REVIEW_ONLY_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Review-Only Workflow',
	description:
		'Single-step review workflow with no planning phase. Reviewer evaluates directly; the run completes when done.',
	nodes: [
		{
			id: REVIEW_REVIEW_STEP,
			name: 'Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'reviewer',
					systemPrompt: {
						mode: 'expand',
						value:
							'You are the sole reviewer in a single-node review workflow. Review the open PR thoroughly. ' +
							'Call report_done() when satisfied.',
					},
				},
			],
		},
	],
	startNodeId: REVIEW_REVIEW_STEP,
	endNodeId: REVIEW_REVIEW_STEP,
	tags: ['review'],
	createdAt: 0,
	updatedAt: 0,
};

/**
 * Full-Cycle Coding Workflow
 *
 * Six-node graph with a single code-review node that runs three reviewers
 * in parallel (via `node.agents[]`) and a QA verification gate.
 *
 * Main progression:
 *   Planning → Plan Review (plan-pr-gate: planner submits plan)
 *   Plan Review → Coding (plan-approval-gate: reviewer approves)
 *   Coding → Code Review (code-pr-gate: PR opened; node contains Reviewer 1/2/3 slots)
 *   Code Review → QA (review-votes-gate: all 3 approve)
 *   QA → Done (qa-result-gate: QA passes)
 *
 * Cyclic paths:
 *   Code Review → Coding (review-reject-gate: any reviewer rejects)
 *   QA → Coding (qa-fail-gate: QA finds issues)
 *
 * Ungated feedback channels:
 *   Plan Review → Planning (reviewer requests plan changes)
 *   Coding → Planning (coder asks planner for clarification)
 */
export const FULL_CYCLE_CODING_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Full-Cycle Coding Workflow',
	description:
		'Full-cycle coding workflow with plan review, parallel code reviewers, and QA gate. ' +
		'Supports rejection cycles at both review and QA stages.',
	nodes: [
		{
			id: V2_PLANNING_STEP,
			name: 'Planning',
			agents: [
				{
					agentId: 'Planner',
					name: 'planner',
					systemPrompt: { mode: 'override', value: V2_PLANNING_PROMPT },
				},
			],
			instructions:
				'Break down the task into an actionable implementation plan. ' +
				'When the plan is ready, write it to the plan-pr-gate (field: plan_submitted) to notify reviewers.',
		},
		{
			id: V2_PLAN_REVIEW_STEP,
			name: 'Plan Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'reviewer',
					systemPrompt: { mode: 'override', value: V2_PLAN_REVIEW_PROMPT },
				},
			],
			instructions:
				'Review the implementation plan for feasibility and completeness. ' +
				'Write to plan-approval-gate with field "approved: true" to approve, or send feedback to Planning.',
		},
		{
			id: V2_CODING_STEP,
			name: 'Coding',
			agents: [
				{
					agentId: 'Coder',
					name: 'coder',
					systemPrompt: { mode: 'override', value: V2_CODING_PROMPT },
				},
			],
			instructions:
				'Implement the approved plan. Open a pull request when done. ' +
				'Write the PR URL to code-pr-gate (field: pr_url) to notify reviewers.',
		},
		{
			id: V2_REVIEW_STEP,
			name: 'Code Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'Reviewer 1',
					systemPrompt: { mode: 'override', value: V2_CODE_REVIEW_PROMPT },
					instructions: {
						mode: 'override',
						value:
							'Review the pull request for correctness, style, and test coverage. ' +
							'To record your vote: (1) use read_gate to fetch the current votes map from review-votes-gate, ' +
							'(2) add your entry (key: "Reviewer 1", value: "approved" or "rejected") to the map, ' +
							'(3) write the complete updated map back via write_gate on both review-votes-gate and review-reject-gate ' +
							'(field: votes). Never write only your own entry — always include all existing votes to avoid overwriting peers.',
					},
				},
				{
					agentId: 'Reviewer',
					name: 'Reviewer 2',
					systemPrompt: { mode: 'override', value: V2_CODE_REVIEW_PROMPT },
					instructions: {
						mode: 'override',
						value:
							'Review the pull request for correctness, style, and test coverage. ' +
							'To record your vote: (1) use read_gate to fetch the current votes map from review-votes-gate, ' +
							'(2) add your entry (key: "Reviewer 2", value: "approved" or "rejected") to the map, ' +
							'(3) write the complete updated map back via write_gate on both review-votes-gate and review-reject-gate ' +
							'(field: votes). Never write only your own entry — always include all existing votes to avoid overwriting peers.',
					},
				},
				{
					agentId: 'Reviewer',
					name: 'Reviewer 3',
					systemPrompt: { mode: 'override', value: V2_CODE_REVIEW_PROMPT },
					instructions: {
						mode: 'override',
						value:
							'Review the pull request for correctness, style, and test coverage. ' +
							'To record your vote: (1) use read_gate to fetch the current votes map from review-votes-gate, ' +
							'(2) add your entry (key: "Reviewer 3", value: "approved" or "rejected") to the map, ' +
							'(3) write the complete updated map back via write_gate on both review-votes-gate and review-reject-gate ' +
							'(field: votes). Never write only your own entry — always include all existing votes to avoid overwriting peers.',
					},
				},
			],
		},
		{
			id: V2_QA_STEP,
			name: 'QA',
			agents: [
				{
					agentId: 'QA',
					name: 'qa',
					systemPrompt: { mode: 'override', value: V2_QA_PROMPT },
				},
			],
			instructions:
				'Verify test coverage, run the CI pipeline, and confirm the PR is mergeable. ' +
				'Write "result: passed" to qa-result-gate if everything is green, or ' +
				'"result: failed" with a summary to qa-fail-gate if issues are found. ' +
				'If QA fails, the coder will fix the issues and all reviewers must re-vote before QA runs again.',
		},
		{
			id: V2_DONE_STEP,
			name: 'Done',
			agents: [
				{
					agentId: 'General',
					name: 'general',
					systemPrompt: { mode: 'override', value: V2_DONE_PROMPT },
				},
			],
		},
	],
	startNodeId: V2_PLANNING_STEP,
	endNodeId: V2_DONE_STEP,
	tags: ['coding', 'v2', 'parallel-review', 'default'],
	createdAt: 0,
	updatedAt: 0,
	// Gates — independent entities referenced by channels via gateId
	gates: [
		{
			id: 'plan-pr-gate',
			description: 'Planning agent has submitted a plan for review',
			fields: [
				{ name: 'plan_submitted', type: 'boolean', writers: ['planner'], check: { op: 'exists' } },
			],
			resetOnCycle: false,
		},
		{
			id: 'plan-approval-gate',
			description: 'Plan has been reviewed and approved by the plan reviewer',
			fields: [
				{
					name: 'approved',
					type: 'boolean',
					writers: ['reviewer'],
					check: { op: '==', value: true },
				},
			],
			resetOnCycle: true,
		},
		{
			id: 'code-pr-gate',
			description:
				'Code has been implemented and a pull request has been opened. ' +
				'resetOnCycle is false: the same PR is updated across fix cycles — coder pushes ' +
				'new commits to the existing branch rather than opening a new PR each time.',
			fields: [{ name: 'pr_url', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
			resetOnCycle: false,
		},
		{
			id: 'review-votes-gate',
			description:
				'All three reviewers have approved the code changes. ' +
				'Agents must read the current votes map first, add their entry, then write the full map back ' +
				'(read-merge-write) — write_gate performs a shallow merge so writing only your own entry ' +
				"would overwrite all other reviewers' votes.",
			fields: [
				{
					name: 'votes',
					type: 'map',
					writers: ['reviewer'],
					check: { op: 'count', match: 'approved', min: 3 },
				},
			],
			resetOnCycle: true,
		},
		{
			id: 'review-reject-gate',
			description:
				'At least one reviewer has rejected the code changes. ' +
				'Agents must read the current votes map first, add their entry, then write the full map back ' +
				'(read-merge-write) — write_gate performs a shallow merge so writing only your own entry ' +
				"would overwrite all other reviewers' votes.",
			fields: [
				{
					name: 'votes',
					type: 'map',
					writers: ['reviewer'],
					check: { op: 'count', match: 'rejected', min: 1 },
				},
			],
			resetOnCycle: true,
		},
		{
			id: 'qa-result-gate',
			description:
				'QA verification has passed — tests, CI, and PR are green. ' +
				'Resets on each QA→Coding cycle so QA always starts from a clean state.',
			fields: [
				{ name: 'result', type: 'string', writers: ['qa'], check: { op: '==', value: 'passed' } },
			],
			resetOnCycle: true,
		},
		{
			id: 'qa-fail-gate',
			description: 'QA found issues — needs another coding and review cycle',
			fields: [
				{ name: 'result', type: 'string', writers: ['qa'], check: { op: '==', value: 'failed' } },
			],
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
		// Coding → Code Review (fan-out to the 3 reviewer slots in the node)
		{
			from: 'Coding',
			to: 'Code Review',
			direction: 'one-way',
			gateId: 'code-pr-gate',
			label: 'Coding → Code Review',
		},
		// Code Review → QA (fan-in, shared review-votes-gate: all 3 must approve)
		{
			from: 'Code Review',
			to: 'QA',
			direction: 'one-way',
			gateId: 'review-votes-gate',
			label: 'Code Review → QA',
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
			maxCycles: 5,
			label: 'QA → Coding (on fail)',
		},
		// Cyclic: Code Review → Coding (reviewer rejected changes)
		{
			from: 'Code Review',
			to: 'Coding',
			direction: 'one-way',
			gateId: 'review-reject-gate',
			maxCycles: 5,
			label: 'Code Review → Coding (on reject)',
		},
		// Ungated feedback: Plan Review ↔ Planning, Coding → Planning
		{
			from: 'Plan Review',
			to: 'Planning',
			direction: 'one-way',
			maxCycles: 5,
			label: 'Plan Review → Planning (feedback)',
		},
		{
			from: 'Coding',
			to: 'Planning',
			direction: 'one-way',
			maxCycles: 5,
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
	return [CODING_WORKFLOW, FULL_CYCLE_CODING_WORKFLOW, RESEARCH_WORKFLOW, REVIEW_ONLY_WORKFLOW];
}

/**
 * Seeds all four built-in workflow templates into the given space.
 *
 * Each template node agent's `agentId` placeholder (e.g., `'Planner'`, `'Coder'`,
 * `'General'`) is resolved to a real SpaceAgent UUID via `resolveAgentId`.
 * If any name cannot be resolved, this function throws — persisting a
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
 * seedBuiltInWorkflows(spaceId, workflowManager, (name) =>
 *   agents.find(a => a.name.toLowerCase() === name.toLowerCase())?.id
 * );
 * ```
 */
export function seedBuiltInWorkflows(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	resolveAgentId: (name: string) => string | undefined
): void {
	const existing = workflowManager.listWorkflows(spaceId);
	if (existing.length > 0) {
		// Already seeded — nothing to do.
		return;
	}

	// Pre-validate: resolve every agent name needed across ALL templates before
	// persisting anything. This guarantees all-or-nothing behaviour.
	const templates = getBuiltInWorkflows();
	const neededNames = new Set<string>();
	for (const template of templates) {
		for (const node of template.nodes) {
			for (const agent of node.agents) {
				if (agent.agentId) neededNames.add(agent.agentId);
			}
		}
	}
	const resolvedIds = new Map<string, string>();
	for (const agentName of neededNames) {
		const agentId = resolveAgentId(agentName);
		if (!agentId) {
			throw new Error(
				`seedBuiltInWorkflows: no SpaceAgent found with name '${agentName}' in space '${spaceId}'. ` +
					`Preset agents must be seeded before calling seedBuiltInWorkflows.`
			);
		}
		resolvedIds.set(agentName, agentId);
	}

	// All names resolved — safe to persist.
	for (const template of templates) {
		// Assign real UUIDs to template node IDs
		const nodeIdMap = new Map<string, string>(); // templateId -> realUUID
		for (const node of template.nodes) {
			nodeIdMap.set(node.id, generateUUID());
		}

		const nodes = template.nodes.map((s) => ({
			id: nodeIdMap.get(s.id)!,
			name: s.name,
			agents: s.agents.map((a) => ({
				...a,
				agentId: resolvedIds.get(a.agentId)!,
			})),
			instructions: s.instructions,
		}));

		const startNodeId = nodeIdMap.get(template.startNodeId);
		if (!startNodeId) {
			throw new Error(
				`seedBuiltInWorkflows: template '${template.name}' has invalid startNodeId '${template.startNodeId}'.`
			);
		}

		if (!template.endNodeId) {
			throw new Error(
				`seedBuiltInWorkflows: template '${template.name}' is missing required endNodeId.`
			);
		}
		const endNodeId = nodeIdMap.get(template.endNodeId);
		if (!endNodeId) {
			throw new Error(
				`seedBuiltInWorkflows: template '${template.name}' has invalid endNodeId '${template.endNodeId}'.`
			);
		}

		workflowManager.createWorkflow({
			spaceId,
			name: template.name,
			description: template.description,
			nodes,
			startNodeId,
			endNodeId,
			tags: [...template.tags],
			channels: template.channels ? [...template.channels] : undefined,
			gates: template.gates ? [...template.gates] : undefined,
		});
	}
}
