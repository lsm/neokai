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
// Template node ID constants (used as stable IDs for workflow nodes and startNodeId)
// ---------------------------------------------------------------------------

const CODING_CODE_NODE = 'tpl-coding-code';
const CODING_REVIEW_NODE = 'tpl-coding-review';

// V2 node IDs
const V2_PLANNING_NODE = 'tpl-v2-planning';
const V2_PLAN_REVIEW_NODE = 'tpl-v2-plan-review';
const V2_CODING_NODE = 'tpl-v2-coding';
const V2_REVIEW_NODE = 'tpl-v2-review';
const V2_QA_NODE = 'tpl-v2-qa';

const FULLSTACK_CODING_NODE = 'tpl-fullstack-coding';
const FULLSTACK_REVIEW_NODE = 'tpl-fullstack-review';
const FULLSTACK_QA_NODE = 'tpl-fullstack-qa';

const PR_READY_BASH_SCRIPT = [
	'# Prefer explicit PR URL from gate data JSON when available; fallback to current branch.',
	'PR_TARGET=$(jq -r \'.pr_url // empty\' <<< "${NEOKAI_GATE_DATA_JSON:-{}}" 2>/dev/null || true)',
	'if [ -n "$PR_TARGET" ]; then',
	'  PR_VIEW_SCOPE="$PR_TARGET"',
	'  if ! PR_JSON=$(gh pr view "$PR_TARGET" --json url,state,mergeable,mergeStateStatus) || [ -z "$PR_JSON" ]; then',
	'    echo "Failed to retrieve PR info for target ${PR_TARGET} (not authenticated, invalid PR URL, or network error)" >&2',
	'    exit 1',
	'  fi',
	'else',
	'  PR_VIEW_SCOPE="current branch"',
	'  if ! PR_JSON=$(gh pr view --json url,state,mergeable,mergeStateStatus) || [ -z "$PR_JSON" ]; then',
	'    echo "Failed to retrieve PR info for current branch (not authenticated, no PR, or network error)" >&2',
	'    exit 1',
	'  fi',
	'fi',
	'PR_URL=$(jq -r \'.url\' <<< "$PR_JSON")',
	'if [ -z "$PR_URL" ] || [ "$PR_URL" = "null" ]; then',
	'  echo "No PR URL found for ${PR_VIEW_SCOPE}" >&2',
	'  exit 1',
	'fi',
	'PR_STATE=$(jq -r \'.state\' <<< "$PR_JSON")',
	'if [ "$PR_STATE" != "OPEN" ]; then',
	'  echo "No open PR found for ${PR_VIEW_SCOPE} (state: ${PR_STATE:-none})" >&2',
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
	'jq -n --arg url "$PR_URL" \'{"pr_url":$url}\'',
].join('\n');

const V2_PLANNING_PROMPT =
	'You are the Planning node in a Full-Cycle Coding Workflow. Your role is to turn the task into a ' +
	'concrete, actionable implementation plan that downstream nodes (Code, Review, QA) can execute ' +
	'without guessing.\n\n' +
	'Your plan must include:\n' +
	'- Scope: what is being changed and what is explicitly out of scope\n' +
	'- Steps: ordered list of implementation steps with file paths where possible\n' +
	'- Dependencies: external libraries, APIs, or prior work required\n' +
	'- Testing strategy: what tests to write, what to verify\n' +
	'- Risk areas: edge cases, backward compatibility, performance concerns\n' +
	'- Open questions: anything you cannot resolve from the codebase alone\n\n' +
	'Write the plan to a file (e.g. `plan.md`), commit it, and open/update a PR. ' +
	'The plan-pr-gate will automatically verify the PR before Plan Review starts.';

const V2_PLAN_REVIEW_PROMPT =
	'You are the Plan Review node in a Full-Cycle Coding Workflow. You receive a plan from the ' +
	'Planning node and must critically evaluate it before coding begins.\n\n' +
	'Evaluate the plan against these criteria:\n' +
	'- Completeness: are all requirements addressed? Are edge cases considered?\n' +
	'- Feasibility: can each step be implemented as described? Are estimates realistic?\n' +
	'- Testing: is the testing strategy sufficient? Are integration tests included?\n' +
	'- Risk: are risks identified and mitigated? Is the rollback strategy clear?\n' +
	'- Scope: is the scope well-bounded? Does it avoid unnecessary changes?\n\n' +
	'If the plan is sound, approve it by writing to plan-approval-gate (field: approved = true). ' +
	'If changes are needed, send specific feedback to the Planning node via the feedback channel ' +
	'explaining what must be revised.';

const V2_CODING_PROMPT =
	'You are the Coding node in a Full-Cycle Coding Workflow. You receive an approved plan from ' +
	'Plan Review and must implement it faithfully.\n\n' +
	'Implementation guidelines:\n' +
	'- Follow the plan step-by-step; do not deviate without documenting why\n' +
	"- Write clean, well-structured code following the project's existing conventions\n" +
	"- Write tests as specified in the plan's testing strategy\n" +
	'- Make atomic commits with clear messages describing each change\n' +
	'- Ensure all existing tests still pass after your changes\n' +
	'- Open a pull request with a clear title and description summarizing the changes\n\n' +
	'If the plan has gaps or you encounter unexpected issues, send feedback to the Planning node ' +
	'via the Coding→Planning channel before proceeding with assumptions.\n\n' +
	'When implementation is complete, write the PR URL to code-pr-gate (field: pr_url) ' +
	'so Code Review can begin.';

const V2_CODE_REVIEW_PROMPT =
	'You are one of three parallel reviewers in the Code Review node of a Full-Cycle Coding Workflow. ' +
	'You review the implementation independently — do not coordinate with other reviewers.\n\n' +
	'Review criteria:\n' +
	'- Correctness: does the code implement the plan correctly? Are there logic errors?\n' +
	'- Regressions: could these changes break existing functionality?\n' +
	'- Maintainability: is the code readable, well-structured, and documented?\n' +
	'- Test coverage: are new behaviors covered? Are edge cases tested?\n' +
	'- Security: are there injection risks, auth bypasses, or data leaks?\n' +
	'- Performance: are there N+1 queries, unbounded loops, or memory leaks?\n\n' +
	'Record a clear APPROVE or REJECT vote with concise reasoning. Use the read-merge-write ' +
	"pattern for the votes map to avoid overwriting other reviewers' votes.";

const V2_QA_PROMPT =
	'You are the QA node in a Full-Cycle Coding Workflow. You receive code that has passed ' +
	'Code Review (all 3 reviewers approved) and must validate it from an execution and ' +
	'release-readiness perspective.\n\n' +
	'QA checklist:\n' +
	'- Run the full test suite and verify all tests pass\n' +
	'- Check CI pipeline status on the PR\n' +
	'- Verify the PR is mergeable (no conflicts, required checks passing)\n' +
	'- Confirm the changes match what was planned and reviewed\n' +
	'- Spot-check critical paths manually if possible\n\n' +
	'If QA passes, call report_done() with a concise final validation summary. ' +
	'If QA fails, send detailed feedback to Coding so fixes can be made and re-tested.';

const FULLSTACK_CODING_PROMPT =
	'You are the Coder in a Fullstack QA Loop workflow. You implement backend + frontend changes, ' +
	'write tests, and keep one PR updated across review and QA cycles.\n\n' +
	'Workflow context:\n' +
	'- Coding → Review is guarded by code-pr-gate (scripted PR readiness check).\n' +
	'- Review may send you back for fixes.\n' +
	'- QA may also send you back after deep verification (including browser tests).\n\n' +
	'When implementation is ready, ensure the PR is open and mergeable, write code-pr-gate with ' +
	'field pr_url, then call report_done() to mark Coding complete.';

const FULLSTACK_REVIEW_PROMPT =
	'You are the Reviewer in a Fullstack QA Loop workflow. Review the PR for correctness, ' +
	'maintainability, and coverage before QA.\n\n' +
	'If the change is ready for QA, write to review-approval-gate (field: approved = true). ' +
	'If changes are needed, send actionable feedback to Coding via the Review → Coding channel.';

const FULLSTACK_QA_PROMPT =
	'You are the QA node in a Fullstack QA Loop workflow. Run thorough validation, including backend tests, ' +
	'frontend tests, and browser-based checks for critical flows.\n\n' +
	'If everything passes, call report_done() with the QA evidence summary. ' +
	'If issues are found, send a detailed fix list to Coding via the QA → Coding channel.';

const RESEARCH_RESEARCH_NODE = 'tpl-research-research';
const RESEARCH_REVIEW_NODE = 'tpl-research-review';

const REVIEW_REVIEW_NODE = 'tpl-review-review';

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
			id: CODING_CODE_NODE,
			name: 'Code',
			agents: [
				{
					agentId: 'Coder',
					name: 'coder',
					customPrompt: {
						value:
							'You are the Coder in a Coder→Reviewer iterative workflow. Your job is to implement the ' +
							'task, write tests, commit all changes, and open a pull request.\n\n' +
							'Workflow context:\n' +
							'- You are in the Code node. After you open a PR, the code-ready-gate verifies it is ' +
							'open and mergeable before the Reviewer sees it.\n' +
							'- If the Reviewer requests changes, you will be re-activated with their feedback. ' +
							'Address all feedback, push new commits, and the gate re-checks automatically.\n' +
							'- This cycle can repeat up to 5 times before the workflow fails.\n\n' +
							'Expected inputs: Task description from the workflow trigger.\n' +
							'Expected outputs: A clean, mergeable PR with passing tests.\n\n' +
							'Steps:\n' +
							'1. Read and understand the task requirements\n' +
							'2. Implement the changes with atomic, well-described commits\n' +
							'3. Write or update tests to cover new behavior\n' +
							'4. Run the test suite and fix any failures\n' +
							'5. Open a PR with `gh pr create` — include a clear title and description\n\n' +
							'If re-activated after review feedback: read the feedback carefully, address each ' +
							'point, push fixes, and verify tests still pass.',
					},
				},
			],
		},
		{
			id: CODING_REVIEW_NODE,
			name: 'Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'reviewer',
					customPrompt: {
						value:
							'You are the Reviewer in a Coder→Reviewer iterative workflow. You review the open PR ' +
							'and either approve it or send it back for changes.\n\n' +
							'Workflow context:\n' +
							'- The Coder has already implemented and opened a PR (verified by code-ready-gate).\n' +
							'- If you request changes, the Coder is automatically re-activated with your feedback.\n' +
							'- When you are satisfied, call report_done() to complete the entire workflow.\n' +
							'- This node is the endNodeId — your report_done() signals workflow completion.\n\n' +
							'Expected inputs: An open, mergeable PR from the Coder.\n' +
							'Expected outputs: Either approval (report_done) or specific change requests.\n\n' +
							'Review checklist:\n' +
							'1. Read the PR diff thoroughly\n' +
							'2. Check for correctness, style, and test coverage\n' +
							'3. Verify the PR description accurately describes the changes\n' +
							'4. If changes needed: provide specific, actionable feedback (the Coder will be sent back)\n' +
							'5. If satisfied: call report_done() with a brief summary of your review',
					},
				},
			],
		},
	],
	startNodeId: CODING_CODE_NODE,
	endNodeId: CODING_REVIEW_NODE,
	tags: ['coding', 'default'],
	createdAt: 0,
	updatedAt: 0,
	gates: [
		{
			id: 'code-ready-gate',
			label: 'PR Ready',
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
			gateId: 'code-ready-gate',
			label: 'Code → Review',
		},
		{
			from: 'Review',
			to: 'Code',
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
			id: RESEARCH_RESEARCH_NODE,
			name: 'Research',
			agents: [
				{
					agentId: 'Research',
					name: 'research',
					customPrompt: {
						value:
							'You are the Research agent in a Research→Reviewer iterative workflow. Your job is to ' +
							'investigate the topic thoroughly, document findings, and open a PR.\n\n' +
							'Workflow context:\n' +
							'- You are in the Research node. After you open a PR, the research-ready-gate verifies ' +
							'it is open and mergeable before the Reviewer sees it.\n' +
							'- If the Reviewer requests more research, you will be re-activated with their feedback.\n' +
							'- This cycle can repeat up to 5 times.\n\n' +
							'Expected inputs: Research topic/question from the workflow trigger.\n' +
							'Expected outputs: Well-structured markdown document(s) with findings, committed and PR opened.\n\n' +
							'Steps:\n' +
							'1. Understand the research question and scope\n' +
							'2. Investigate using web search, code exploration, and available documentation\n' +
							'3. Write findings to well-structured markdown file(s)\n' +
							'4. Include sources, evidence, and clear conclusions\n' +
							'5. Commit findings and open a PR with `gh pr create`\n\n' +
							'If re-activated after review feedback: address each point, expand research where requested, ' +
							'update the documents, and push new commits.',
					},
				},
			],
		},
		{
			id: RESEARCH_REVIEW_NODE,
			name: 'Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'reviewer',
					customPrompt: {
						value:
							'You are the Reviewer in a Research→Reviewer iterative workflow. You review the ' +
							'research findings for completeness, accuracy, and quality.\n\n' +
							'Workflow context:\n' +
							'- The Research agent has investigated and opened a PR (verified by research-ready-gate).\n' +
							'- If you request more research, the Research agent is automatically re-activated.\n' +
							'- When satisfied, call report_done() to complete the entire workflow.\n' +
							'- This node is the endNodeId — your report_done() signals workflow completion.\n\n' +
							'Expected inputs: A PR containing research findings from the Research agent.\n' +
							'Expected outputs: Either approval (report_done) or specific feedback for more research.\n\n' +
							'Review checklist:\n' +
							'1. Read all research documents in the PR\n' +
							'2. Check completeness: does the research answer the original question?\n' +
							'3. Check accuracy: are claims supported by evidence or sources?\n' +
							'4. Check clarity: are findings well-organized and easy to follow?\n' +
							'5. If more research needed: provide specific areas to investigate further\n' +
							'6. If satisfied: call report_done() with a brief summary',
					},
				},
			],
		},
	],
	startNodeId: RESEARCH_RESEARCH_NODE,
	endNodeId: RESEARCH_REVIEW_NODE,
	tags: ['research'],
	createdAt: 0,
	updatedAt: 0,
	gates: [
		{
			id: 'research-ready-gate',
			label: 'PR Ready',
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
			gateId: 'research-ready-gate',
			label: 'Research → Review',
		},
		{
			from: 'Review',
			to: 'Research',
			maxCycles: 5,
			label: 'Review → Research (more research needed)',
		},
	],
};
/**
 * Review-Only Workflow
 *
 * Single-node graph: Reviewer only (terminal node).
 * No planning phase — used when the task is well-defined and only
 * review is needed. The run completes immediately when advance()
 * is called from the Review node.
 *
 * startNodeId and endNodeId point to the same node (single-node workflow).
 */
export const REVIEW_ONLY_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Review-Only Workflow',
	description:
		'Single-node review workflow with no planning phase. Reviewer evaluates directly; the run completes when done.',
	nodes: [
		{
			id: REVIEW_REVIEW_NODE,
			name: 'Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'reviewer',
					customPrompt: {
						value:
							'You are the sole Reviewer in a single-node Review-Only workflow. There is no planning ' +
							'or coding phase — you are reviewing an existing PR or codebase directly.\n\n' +
							'Workflow context:\n' +
							'- This is both the start and end node — the workflow completes when you call report_done().\n' +
							'- There are no other agents in this workflow; your review is the only node.\n\n' +
							'Expected inputs: A PR or code to review (specified in the task description).\n' +
							'Expected outputs: A thorough review summary with actionable findings.\n\n' +
							'Review checklist:\n' +
							'1. Read the PR diff or specified code thoroughly\n' +
							'2. Check for correctness, security, performance, and style issues\n' +
							'3. Verify test coverage is adequate\n' +
							'4. Summarize your findings clearly\n' +
							'5. Call report_done() with your review summary to complete the workflow',
					},
				},
			],
		},
	],
	startNodeId: REVIEW_REVIEW_NODE,
	endNodeId: REVIEW_REVIEW_NODE,
	tags: ['review'],
	createdAt: 0,
	updatedAt: 0,
};

/**
 * Full-Cycle Coding Workflow
 *
 * Five-node graph with planning, plan review, coding, parallel code review, and QA.
 * QA is the terminal node and calls report_done() on success.
 *
 * Main progression:
 *   Planning → Plan Review (plan-pr-gate: script verifies plan PR is open/mergeable)
 *   Plan Review → Coding (plan-approval-gate: reviewer approves)
 *   Coding → Code Review (code-pr-gate: coder publishes PR URL)
 *   Code Review → QA (review-votes-gate: all 3 approve)
 *
 * Cyclic feedback paths (ungated):
 *   Code Review → Coding (review feedback)
 *   QA → Coding (QA feedback)
 *
 * Additional feedback channels:
 *   Plan Review → Planning (plan revision requests)
 *   Coding → Planning (clarification requests)
 */
export const FULL_CYCLE_CODING_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Full-Cycle Coding Workflow',
	description:
		'Full-cycle coding workflow with planning, plan review, parallel code review, and QA. ' +
		'QA is the terminal node; feedback from review or QA loops back to Coding.',
	nodes: [
		{
			id: V2_PLANNING_NODE,
			name: 'Planning',
			agents: [
				{
					agentId: 'Planner',
					name: 'planner',
					customPrompt: {
						value:
							V2_PLANNING_PROMPT +
							'\n\n' +
							'Expected inputs: Task description from the workflow trigger.\n' +
							'Expected outputs: A committed plan file in an open, mergeable PR.\n\n' +
							'Steps:\n' +
							'1. Analyze the task requirements and explore the relevant codebase\n' +
							'2. Identify affected files, dependencies, and potential risks\n' +
							'3. Write a structured plan (scope, steps, testing strategy, risks)\n' +
							'4. Commit the plan file to the branch\n' +
							'5. Open or update the PR so plan-pr-gate can verify it\n\n' +
							'If re-activated after Plan Review feedback: revise the plan based on the reviewer comments, ' +
							'commit updates, and push to the same PR branch.',
					},
				},
			],
		},
		{
			id: V2_PLAN_REVIEW_NODE,
			name: 'Plan Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'reviewer',
					customPrompt: {
						value:
							V2_PLAN_REVIEW_PROMPT +
							'\n\n' +
							'Expected inputs: A committed plan from the Planning node (plan-pr-gate satisfied).\n' +
							'Expected outputs: Approval signal or specific revision feedback.\n\n' +
							'Steps:\n' +
							'1. Read the plan file committed by the Planner\n' +
							'2. Evaluate completeness, feasibility, testing strategy, and risks\n' +
							'3. If approved: write to plan-approval-gate (field: approved = true)\n' +
							'4. If revisions needed: send specific feedback to Planning via the feedback channel\n\n' +
							'Do NOT approve plans that lack a testing strategy or have unbounded scope.',
					},
				},
			],
		},
		{
			id: V2_CODING_NODE,
			name: 'Coding',
			agents: [
				{
					agentId: 'Coder',
					name: 'coder',
					customPrompt: {
						value:
							V2_CODING_PROMPT +
							'\n\n' +
							'Expected inputs: An approved plan from Plan Review (plan-approval-gate satisfied).\n' +
							'Expected outputs: Implementation with PR opened and code-pr-gate signaled.\n\n' +
							'Steps:\n' +
							'1. Read the approved plan and follow it step-by-step\n' +
							'2. Implement changes with atomic, well-described commits\n' +
							"3. Write tests as specified in the plan's testing strategy\n" +
							'4. Run the test suite and fix any failures\n' +
							'5. Open a PR with `gh pr create` — clear title and description\n' +
							'6. Write the PR URL to code-pr-gate (field: pr_url) to start Code Review\n\n' +
							'If re-activated after review or QA feedback: address each issue, push fixes, and re-run tests.',
					},
				},
			],
		},
		{
			id: V2_REVIEW_NODE,
			name: 'Code Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'Reviewer 1',
					customPrompt: {
						value:
							V2_CODE_REVIEW_PROMPT +
							'\n\n' +
							'Review the pull request for correctness, style, and test coverage. ' +
							'To record your vote: (1) use read_gate to fetch the current votes map from review-votes-gate, ' +
							'(2) add your entry (key: "Reviewer 1", value: "approved" or "rejected") to the map, ' +
							'(3) write the complete updated map back via write_gate on review-votes-gate (field: votes). ' +
							'Never write only your own entry — always include all existing votes to avoid overwriting peers. ' +
							'If you reject, send actionable feedback to Coding.',
					},
				},
				{
					agentId: 'Reviewer',
					name: 'Reviewer 2',
					customPrompt: {
						value:
							V2_CODE_REVIEW_PROMPT +
							'\n\n' +
							'Review the pull request for correctness, style, and test coverage. ' +
							'To record your vote: (1) use read_gate to fetch the current votes map from review-votes-gate, ' +
							'(2) add your entry (key: "Reviewer 2", value: "approved" or "rejected") to the map, ' +
							'(3) write the complete updated map back via write_gate on review-votes-gate (field: votes). ' +
							'Never write only your own entry — always include all existing votes to avoid overwriting peers. ' +
							'If you reject, send actionable feedback to Coding.',
					},
				},
				{
					agentId: 'Reviewer',
					name: 'Reviewer 3',
					customPrompt: {
						value:
							V2_CODE_REVIEW_PROMPT +
							'\n\n' +
							'Review the pull request for correctness, style, and test coverage. ' +
							'To record your vote: (1) use read_gate to fetch the current votes map from review-votes-gate, ' +
							'(2) add your entry (key: "Reviewer 3", value: "approved" or "rejected") to the map, ' +
							'(3) write the complete updated map back via write_gate on review-votes-gate (field: votes). ' +
							'Never write only your own entry — always include all existing votes to avoid overwriting peers. ' +
							'If you reject, send actionable feedback to Coding.',
					},
				},
			],
		},
		{
			id: V2_QA_NODE,
			name: 'QA',
			agents: [
				{
					agentId: 'QA',
					name: 'qa',
					customPrompt: {
						value:
							V2_QA_PROMPT +
							'\n\n' +
							'Expected inputs: Code Review approved (review-votes-gate: 3 approvals).\n' +
							'Expected outputs: report_done() on pass, or detailed feedback to Coding on fail.\n\n' +
							'Steps:\n' +
							'1. Run the full test suite and record results\n' +
							'2. Check CI pipeline status on the PR\n' +
							'3. Verify the PR is mergeable (no conflicts)\n' +
							'4. Confirm changes match the approved plan\n' +
							'5. If all green: call report_done() with validation summary\n' +
							'6. If issues found: send detailed feedback to Coding via QA → Coding channel\n\n' +
							'On failure, Coding fixes issues and reviewers re-vote before QA runs again.',
					},
				},
			],
		},
	],
	startNodeId: V2_PLANNING_NODE,
	endNodeId: V2_QA_NODE,
	tags: ['coding', 'v2', 'parallel-review', 'default'],
	createdAt: 0,
	updatedAt: 0,
	gates: [
		{
			id: 'plan-pr-gate',
			label: 'PR Ready',
			description: 'Planning PR is open and mergeable so plan review can start.',
			fields: [{ name: 'pr_url', type: 'string', writers: ['*'], check: { op: 'exists' } }],
			script: {
				interpreter: 'bash',
				source: PR_READY_BASH_SCRIPT,
				timeoutMs: 30000,
			},
			resetOnCycle: false,
		},
		{
			id: 'plan-approval-gate',
			label: 'Human',
			description: 'Plan has been reviewed and approved by a human.',
			fields: [
				{
					name: 'approved',
					type: 'boolean',
					// 'human' is a reserved writer keyword — makes this a human-approval gate
					// (UI shows waiting_human state and the Approve/Reject buttons).
					// Human approval gates must use writers: ['human'] exclusively.
					writers: ['human'],
					check: { op: '==', value: true },
				},
			],
			resetOnCycle: true,
		},
		{
			id: 'code-pr-gate',
			label: 'PR Ready',
			description:
				'Code has been implemented and a pull request has been opened. ' +
				'resetOnCycle is false: the same PR is updated across fix cycles — coder pushes ' +
				'new commits to the existing branch rather than opening a new PR each time.',
			fields: [{ name: 'pr_url', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
			resetOnCycle: false,
		},
		{
			id: 'review-votes-gate',
			label: 'Votes',
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
	],
	channels: [
		{
			from: 'Planning',
			to: 'Plan Review',
			gateId: 'plan-pr-gate',
			label: 'Planning → Plan Review',
		},
		{
			from: 'Plan Review',
			to: 'Coding',
			gateId: 'plan-approval-gate',
			label: 'Plan Review → Coding',
		},
		{
			from: 'Coding',
			to: 'Code Review',
			gateId: 'code-pr-gate',
			label: 'Coding → Code Review',
		},
		{
			from: 'Code Review',
			to: 'QA',
			gateId: 'review-votes-gate',
			label: 'Code Review → QA',
		},
		{
			from: 'Code Review',
			to: 'Coding',
			maxCycles: 5,
			label: 'Code Review → Coding (feedback)',
		},
		{
			from: 'QA',
			to: 'Coding',
			maxCycles: 5,
			label: 'QA → Coding (issues found)',
		},
		{
			from: 'Plan Review',
			to: 'Planning',
			maxCycles: 5,
			label: 'Plan Review → Planning (feedback)',
		},
		{
			from: 'Coding',
			to: 'Planning',
			maxCycles: 5,
			label: 'Coding → Planning (feedback)',
		},
	],
};

/**
 * Coding with QA Workflow
 *
 * Three-node workflow for backend+frontend tasks that need explicit code review
 * and deeper QA validation (including browser-based checks).
 *
 * Main progression:
 *   Coding → Review (code-pr-gate: script verifies PR is open/mergeable)
 *   Review → QA (review-approval-gate: reviewer approves)
 *
 * Feedback cycles:
 *   Review → Coding (changes requested)
 *   QA → Coding (test failures/regressions)
 *
 * QA is the end node. QA calls report_done() on success.
 */
export const FULLSTACK_QA_LOOP_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Coding with QA Workflow',
	description:
		'Coder ↔ Reviewer loop with explicit QA validation before completion. ' +
		'Designed for backend+frontend changes that require thorough test coverage, including browser tests.',
	nodes: [
		{
			id: FULLSTACK_CODING_NODE,
			name: 'Coding',
			agents: [
				{
					agentId: 'Coder',
					name: 'coder',
					customPrompt: {
						value:
							FULLSTACK_CODING_PROMPT +
							'\n\n' +
							'Expected inputs: Task description and review/QA feedback from prior loops.\n' +
							'Expected outputs: Updated implementation in an open, mergeable PR.\n\n' +
							'Steps:\n' +
							'1. Implement backend and frontend changes with focused commits\n' +
							'2. Add/update unit, integration, and UI tests as needed\n' +
							'3. Open or update the PR and ensure it remains mergeable\n' +
							'4. Write code-pr-gate with field pr_url so Review can activate\n' +
							'5. Call report_done() with a concise coding handoff summary\n' +
							'6. Share blockers clearly with Reviewer/QA when needed',
					},
				},
			],
		},
		{
			id: FULLSTACK_REVIEW_NODE,
			name: 'Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'reviewer',
					customPrompt: {
						value:
							FULLSTACK_REVIEW_PROMPT +
							'\n\n' +
							'Expected inputs: Open PR from Coding.\n' +
							'Expected outputs: Approval gate write or actionable feedback.\n\n' +
							'Steps:\n' +
							'1. Review diff quality, correctness, and test coverage\n' +
							'2. If approved: write to review-approval-gate (field: approved = true)\n' +
							'3. If changes needed: send clear feedback to Coding',
					},
				},
			],
		},
		{
			id: FULLSTACK_QA_NODE,
			name: 'QA',
			agents: [
				{
					agentId: 'QA',
					name: 'qa',
					customPrompt: {
						value:
							FULLSTACK_QA_PROMPT +
							'\n\n' +
							'Expected inputs: Reviewer-approved PR.\n' +
							'Expected outputs: report_done() on pass or QA feedback to Coding.\n\n' +
							'Steps:\n' +
							'1. Run backend and frontend test suites\n' +
							'2. Run browser-based critical-path validation\n' +
							'3. Validate CI and mergeability\n' +
							'4. If pass: call report_done() with QA summary\n' +
							'5. If fail: send detailed failures and repro steps to Coding',
					},
				},
			],
		},
	],
	startNodeId: FULLSTACK_CODING_NODE,
	endNodeId: FULLSTACK_QA_NODE,
	tags: ['fullstack', 'qa', 'browser-testing'],
	createdAt: 0,
	updatedAt: 0,
	gates: [
		{
			id: 'code-pr-gate',
			label: 'PR Ready',
			description: 'Coding PR is open and mergeable for review.',
			fields: [{ name: 'pr_url', type: 'string', writers: ['*'], check: { op: 'exists' } }],
			script: {
				interpreter: 'bash',
				source: PR_READY_BASH_SCRIPT,
				timeoutMs: 30000,
			},
			resetOnCycle: true,
		},
		{
			id: 'review-approval-gate',
			label: 'Review',
			description: 'Reviewer approved the PR for QA.',
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
	],
	channels: [
		{
			from: 'Coding',
			to: 'Review',
			gateId: 'code-pr-gate',
			label: 'Coding → Review',
		},
		{
			from: 'Review',
			to: 'QA',
			gateId: 'review-approval-gate',
			label: 'Review → QA',
		},
		{
			from: 'Review',
			to: 'Coding',
			maxCycles: 6,
			label: 'Review → Coding (feedback)',
		},
		{
			from: 'QA',
			to: 'Coding',
			maxCycles: 6,
			label: 'QA → Coding (issues found)',
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
	// FULL_CYCLE_CODING_WORKFLOW is first so it becomes the default workflow selected by
	// spaceWorkflowRun.start (which picks workflows[0] ordered by created_at ASC).
	// The full-cycle workflow is the primary/comprehensive default. Additional templates
	// provide lighter loops or specialized flows (research, review-only, fullstack QA loop).
	//
	// Note: this ordering only affects *newly created* spaces. seedBuiltInWorkflows is
	// insert-only (it skips if any workflows already exist), so existing spaces keep
	// whatever ordering was seeded when they were first created.
	return [
		FULL_CYCLE_CODING_WORKFLOW,
		CODING_WORKFLOW,
		FULLSTACK_QA_LOOP_WORKFLOW,
		RESEARCH_WORKFLOW,
		REVIEW_ONLY_WORKFLOW,
	];
}

export interface SeedBuiltInWorkflowsResult {
	/** Workflows that were successfully created */
	seeded: string[];
	/** Errors for workflows that failed to seed */
	errors: Array<{ name: string; error: string }>;
	/** True if seeding was skipped because workflows already exist */
	skipped: boolean;
}

/**
 * Seeds all built-in workflow templates into the given space.
 *
 * Each template node agent's `agentId` placeholder (e.g., `'Planner'`, `'Coder'`,
 * `'General'`) is resolved to a real SpaceAgent UUID via `resolveAgentId`.
 * If any name cannot be resolved, this function throws — persisting a
 * placeholder string as an `agentId` would create broken workflow data.
 *
 * Idempotent: if the space already has at least one workflow, this is a no-op
 * (returns `{ seeded: [], errors: [], skipped: true }`).
 *
 * Individual workflow creation errors are captured per-workflow and do not
 * abort the remaining seeds.
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
): SeedBuiltInWorkflowsResult {
	const existing = workflowManager.listWorkflows(spaceId);
	if (existing.length > 0) {
		// Already seeded — nothing to do.
		return { seeded: [], errors: [], skipped: true };
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
	const seeded: string[] = [];
	const errors: Array<{ name: string; error: string }> = [];

	for (const template of templates) {
		try {
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
				// Assign UUIDs to channels that don't have IDs — WorkflowCanvas filters
				// channels without an id (ch.id must be truthy) so they would be invisible.
				channels: template.channels
					? template.channels.map((ch) => ({ ...ch, id: ch.id ?? generateUUID() }))
					: undefined,
				gates: template.gates ? [...template.gates] : undefined,
			});

			seeded.push(template.name);
		} catch (err) {
			errors.push({
				name: template.name,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { seeded, errors, skipped: false };
}
