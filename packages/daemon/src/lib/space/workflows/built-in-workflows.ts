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
 * - Channels use node names (e.g. 'Plan', 'Coding') in `from`/`to` so they
 *   resolve correctly at runtime without UUID translation in the seeder.
 *   `resolveChannels()` matches node names via the `nodeNameToAgents` lookup.
 */

import { generateUUID } from '@neokai/shared';
import type { SpaceWorkflow, CompletionAction } from '@neokai/shared';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import { computeWorkflowHash } from './template-hash.ts';

// ---------------------------------------------------------------------------
// Template node ID constants (used as stable IDs for workflow nodes and startNodeId)
// ---------------------------------------------------------------------------

const CODING_CODE_NODE = 'tpl-coding-code';
const CODING_REVIEW_NODE = 'tpl-coding-review';

// Plan & Decompose node IDs
const PD_PLANNING_NODE = 'tpl-pd-planning';
const PD_PLAN_REVIEW_NODE = 'tpl-pd-plan-review';
const PD_TASK_DISPATCHER_NODE = 'tpl-pd-task-dispatcher';

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

/**
 * Review-posted gate script.
 *
 * Verifies that the Reviewer has actually posted a GitHub review since the
 * workflow run started. This gate guards the Review → Coding feedback channel:
 * the runtime refuses to deliver a "changes requested" message until the review
 * is visible on GitHub, closing the gap where reviewers summarize feedback
 * internally and never call `gh pr review`.
 *
 * Environment variables:
 *   NEOKAI_GATE_DATA_JSON       — current gate data; may contain `pr_url`
 *   NEOKAI_WORKFLOW_START_ISO   — ISO8601 timestamp of workflowRun.createdAt,
 *                                 injected by the gate script runner
 */
const REVIEW_POSTED_BASH_SCRIPT = [
	'PR_URL=$(jq -r \'.pr_url // empty\' <<< "${NEOKAI_GATE_DATA_JSON:-{}}" 2>/dev/null || true)',
	'if [ -z "$PR_URL" ]; then',
	'  PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)',
	'fi',
	'if [ -z "$PR_URL" ]; then',
	'  echo "No PR URL available to verify review" >&2',
	'  exit 1',
	'fi',
	'START_ISO="${NEOKAI_WORKFLOW_START_ISO:-}"',
	'if [ -z "$START_ISO" ]; then',
	'  echo "NEOKAI_WORKFLOW_START_ISO not injected — cannot determine review window" >&2',
	'  exit 1',
	'fi',
	'if ! REVIEW_JSON=$(gh pr view "$PR_URL" --json reviews); then',
	'  echo "Failed to fetch reviews for ${PR_URL}" >&2',
	'  exit 1',
	'fi',
	'REVIEW_COUNT=$(jq --arg since "$START_ISO" \'[.reviews[] | select(.submittedAt > $since)] | length\' <<< "$REVIEW_JSON")',
	'if [ "$REVIEW_COUNT" = "0" ] || [ -z "$REVIEW_COUNT" ]; then',
	'  echo "No review submitted on ${PR_URL} since workflow start (${START_ISO})" >&2',
	'  exit 1',
	'fi',
	'jq -n --arg url "$PR_URL" --argjson n "$REVIEW_COUNT" \'{"pr_url":$url,"review_count":$n}\'',
].join('\n');

/**
 * Merge PR completion action script.
 *
 * Used as a `script` completion action on short workflows (Coding, Research).
 * Resolves the PR URL from the artifact env var or the current branch,
 * then squash-merges with branch deletion. Exits non-zero on failure.
 *
 * Environment variables injected by the completion action executor:
 *   NEOKAI_ARTIFACT_DATA_JSON — artifact data (contains pr_url for 'pr' artifacts)
 *   NEOKAI_WORKSPACE_PATH — workspace root (used as cwd)
 */
const PR_MERGE_BASH_SCRIPT = [
	'# Resolve PR URL from artifact data or current branch',
	'PR_URL=$(jq -r \'.pr_url // .url // empty\' <<< "${NEOKAI_ARTIFACT_DATA_JSON:-{}}" 2>/dev/null || true)',
	'if [ -z "$PR_URL" ]; then',
	'  PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)',
	'fi',
	'if [ -z "$PR_URL" ]; then',
	'  echo "No PR URL found — cannot merge" >&2',
	'  exit 1',
	'fi',
	'# Idempotency guard: skip merge if PR is already merged',
	'PR_STATE=$(gh pr view "$PR_URL" --json state -q .state 2>/dev/null || true)',
	'if [ "$PR_STATE" = "MERGED" ]; then',
	'  echo "PR already merged: $PR_URL"',
	'  BASE_BRANCH=$(gh pr view "$PR_URL" --json baseRefName -q .baseRefName 2>/dev/null || echo "main")',
	'  git checkout "$BASE_BRANCH" 2>/dev/null && git pull --ff-only 2>/dev/null || true',
	'  jq -n --arg url "$PR_URL" \'{"merged_pr_url":$url,"status":"already_merged"}\'',
	'  exit 0',
	'fi',
	'echo "Merging PR: $PR_URL"',
	'if ! gh pr merge "$PR_URL" --squash; then',
	'  echo "Failed to merge PR: $PR_URL" >&2',
	'  exit 1',
	'fi',
	'# Sync worktree with base branch after merge',
	'BASE_BRANCH=$(gh pr view "$PR_URL" --json baseRefName -q .baseRefName 2>/dev/null || echo "main")',
	'git checkout "$BASE_BRANCH" 2>/dev/null && git pull --ff-only 2>/dev/null || true',
	'echo "PR merged and worktree synced"',
	'jq -n --arg url "$PR_URL" \'{"merged_pr_url":$url,"status":"merged"}\'',
].join('\n');

/**
 * Standard "Merge PR" completion action for short workflows.
 * Attached to the end node's completionActions[].
 */
const MERGE_PR_COMPLETION_ACTION: CompletionAction = {
	id: 'merge-pr',
	name: 'Merge PR',
	type: 'script',
	requiredLevel: 4,
	artifactType: 'pr',
	script: PR_MERGE_BASH_SCRIPT,
};

/**
 * Verifies the PR associated with the end-node is actually merged on GitHub.
 * Used by QA workflows where the agent is expected to run `gh pr merge` itself
 * — this action double-checks that the merge actually happened so the agent
 * cannot "lie" about completion.
 *
 * Exits 0 on merged, non-zero with a descriptive message otherwise.
 */
const VERIFY_PR_MERGED_BASH_SCRIPT = [
	'# Resolve PR URL from artifact data or current branch',
	'PR_URL=$(jq -r \'.pr_url // .url // .merged_pr_url // empty\' <<< "${NEOKAI_ARTIFACT_DATA_JSON:-{}}" 2>/dev/null || true)',
	'if [ -z "$PR_URL" ]; then',
	'  PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)',
	'fi',
	'if [ -z "$PR_URL" ]; then',
	'  echo "verify-pr-merged: no PR URL found — cannot verify merge" >&2',
	'  exit 1',
	'fi',
	'PR_STATE=$(gh pr view "$PR_URL" --json state -q .state 2>/dev/null || true)',
	'if [ "$PR_STATE" != "MERGED" ]; then',
	'  echo "verify-pr-merged: PR $PR_URL is in state \\"$PR_STATE\\", expected MERGED" >&2',
	'  exit 1',
	'fi',
	'echo "verify-pr-merged: PR $PR_URL is merged"',
	'jq -n --arg url "$PR_URL" \'{"verified_pr_url":$url,"status":"merged"}\'',
].join('\n');

/**
 * Completion action for QA-style workflows whose end-node agent is expected to
 * perform the merge itself (e.g. Coding-with-QA). The script exits non-zero if
 * the PR is not actually merged, causing the task to end in `blocked` instead
 * of silently completing.
 */
const VERIFY_PR_MERGED_COMPLETION_ACTION: CompletionAction = {
	id: 'verify-pr-merged',
	name: 'Verify PR merged',
	description:
		'Verifies the PR associated with the task is in state MERGED on GitHub. ' +
		'Fails the task if the agent claims completion without having actually merged.',
	type: 'script',
	requiredLevel: 2,
	artifactType: 'pr',
	script: VERIFY_PR_MERGED_BASH_SCRIPT,
};

/**
 * Script that verifies the PR associated with a Review-Only task has at least
 * one review comment or submitted review posted. Prevents the Reviewer from
 * "claiming reviewed" without actually posting feedback on GitHub.
 */
const VERIFY_REVIEW_POSTED_BASH_SCRIPT = [
	'PR_URL=$(jq -r \'.pr_url // .url // empty\' <<< "${NEOKAI_ARTIFACT_DATA_JSON:-{}}" 2>/dev/null || true)',
	'if [ -z "$PR_URL" ]; then',
	'  PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)',
	'fi',
	'if [ -z "$PR_URL" ]; then',
	'  echo "verify-review-posted: no PR URL found — cannot verify review was posted" >&2',
	'  exit 1',
	'fi',
	'REVIEW_COUNT=$(gh pr view "$PR_URL" --json reviews -q \'.reviews | length\' 2>/dev/null || echo 0)',
	'COMMENT_COUNT=$(gh pr view "$PR_URL" --json comments -q \'.comments | length\' 2>/dev/null || echo 0)',
	'TOTAL=$((REVIEW_COUNT + COMMENT_COUNT))',
	'if [ "$TOTAL" -lt 1 ]; then',
	'  echo "verify-review-posted: PR $PR_URL has no reviews or review comments — reviewer did not post" >&2',
	'  exit 1',
	'fi',
	'echo "verify-review-posted: PR $PR_URL has $REVIEW_COUNT reviews and $COMMENT_COUNT comments"',
	'jq -n --arg url "$PR_URL" --arg reviews "$REVIEW_COUNT" --arg comments "$COMMENT_COUNT" \\',
	'  \'{"pr_url":$url,"review_count":($reviews|tonumber),"comment_count":($comments|tonumber)}\'',
].join('\n');

/**
 * Completion action for Review-Only workflows. The reviewer is expected to
 * post their findings on the PR; this script verifies at least one
 * review/comment was posted before the task is allowed to close as done.
 */
const VERIFY_REVIEW_POSTED_COMPLETION_ACTION: CompletionAction = {
	id: 'verify-review-posted',
	name: 'Verify review posted',
	description:
		'Verifies the Reviewer actually posted review feedback on the PR (review or review-comment). ' +
		'Fails the task if the agent reports completion without having posted anything.',
	type: 'script',
	requiredLevel: 2,
	artifactType: 'pr',
	script: VERIFY_REVIEW_POSTED_BASH_SCRIPT,
};

const PD_PLANNING_PROMPT =
	'You are the Planning node in a Plan & Decompose Workflow. Your role is to turn the user goal ' +
	'into a concrete, decomposable plan that a Task Dispatcher can fan out into standalone tasks.\n\n' +
	'Your plan must include:\n' +
	'- Goal summary: what is being built, migrated, or delivered, in one paragraph\n' +
	'- Work items: a numbered list of actionable items — each a unit small enough for one task, ' +
	'with a clear title, 2-4 sentence description, and suggested priority (low/normal/high/urgent)\n' +
	'- Dependencies: between work items (item B depends on item A)\n' +
	'- Out of scope: what is intentionally not included\n' +
	'- Open questions: anything that needs clarification before tasks are dispatched\n\n' +
	'Write the plan to `plan.md` at the repo root, commit it, and open/update a PR targeting the ' +
	'default branch. The plan-pr-gate will automatically verify the PR before Plan Review starts.';

const PD_PLAN_REVIEW_PROMPT =
	'You are one of four parallel Reviewers in the Plan Review node of a Plan & Decompose Workflow. ' +
	'You receive a plan from the Planning node and must evaluate it through your specific lens ' +
	'before tasks are dispatched. You do not coordinate with other reviewers; vote independently.\n\n' +
	'Steps:\n' +
	'1. Read the plan file in the PR (`gh pr diff` and `gh pr view`).\n' +
	'2. Evaluate the plan against your lens criteria (described below).\n' +
	'3. Post your review to the PR with `gh pr review <url> --comment --body "<your review>"` so ' +
	'the Planner and peer reviewers can see your feedback in the PR thread.\n' +
	'4. Vote by writing to plan-approval-gate: call send_message to the "Task Dispatcher" node ' +
	'with `data: { reviewer_name: "<your lens>", approved: true|false, comments_url: "<pr url>" }`. ' +
	'The vote counts toward the 4-of-4 approval threshold.\n' +
	'5. If you reject, also send a message to the Planning node via the feedback channel ' +
	'describing what needs to change, so the Planner can revise and re-open.';

const PD_TASK_DISPATCHER_PROMPT =
	'You are the Task Dispatcher in a Plan & Decompose Workflow. You are the end node. ' +
	'All four Plan Reviewers have approved the plan — your job is to fan the plan out into ' +
	'standalone follow-up tasks using the `create_standalone_task` MCP tool.\n\n' +
	'**You MUST call `report_result` as your final action.** It is the only signal the runtime ' +
	'accepts as completion — finishing without it leaves the workflow stuck. Do all task ' +
	'creation BEFORE calling `report_result`.\n\n' +
	'Steps:\n' +
	'1. Read the approved plan from the plan PR (`gh pr diff` or `gh pr view --json files`). ' +
	'Identify each actionable work item.\n' +
	'2. For each item, call `create_standalone_task({ title, description, priority })`. Use a ' +
	'clear, imperative title and a description that gives the downstream worker everything they ' +
	'need (context, acceptance criteria, references to the plan).\n' +
	'3. Collect the returned task IDs.\n' +
	'4. Call `report_result(status="done", summary="Created N tasks from plan: <short list>", ' +
	'evidence={ created_task_ids: [<ids>] })` as your last tool call.\n\n' +
	'Do NOT implement the work items yourself. Do NOT create fewer tasks than the plan requires. ' +
	'If the plan is empty or ambiguous, send feedback to Planning before calling report_result.';

const FULLSTACK_CODING_PROMPT =
	'You are the Coder in a Fullstack QA Loop workflow. You implement backend + frontend changes, ' +
	'write tests, and keep one PR updated across review and QA cycles.\n\n' +
	'When implementation is ready, ensure the PR is open and mergeable, write code-pr-gate with ' +
	'field pr_url, then call report_result() to mark Coding complete.';

const FULLSTACK_REVIEW_PROMPT =
	'You are the Reviewer in a Fullstack QA Loop workflow. Review the PR for correctness, ' +
	'maintainability, and coverage before QA.\n\n' +
	'If the change is ready for QA, write to review-approval-gate (field: approved = true). ' +
	'If changes are needed, send actionable feedback to Coding.';

const FULLSTACK_QA_PROMPT =
	'You are the QA node in a Fullstack QA Loop workflow. Run thorough validation, including backend tests, ' +
	'frontend tests, and browser-based checks for critical flows.\n\n' +
	'If everything passes, call report_result() with the QA evidence summary. ' +
	'If issues are found, send a detailed fix list to Coding.';

const RESEARCH_RESEARCH_NODE = 'tpl-research-research';
const RESEARCH_REVIEW_NODE = 'tpl-research-review';

const REVIEW_REVIEW_NODE = 'tpl-review-review';

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

/**
 * Coding Workflow
 *
 * Two-node iterative graph: Coding ↔ Review (with cycle).
 * - Coding → Review: gated by `code-ready-gate` — a bash script verifies that an
 *   open, mergeable PR exists and emits its URL as `{"pr_url":"..."}`.
 * - Review → Coding: ungated — Reviewer sends back for changes without any gate.
 *   When satisfied, Reviewer calls `report_result()` on the Review node (endNodeId)
 *   which signals workflow completion.
 */
export const CODING_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Coding Workflow',
	description:
		'Iterative coding workflow with Coding ↔ Review loop. Engineer implements and opens a PR; Reviewer reviews and either requests changes or signals completion.',
	nodes: [
		{
			id: CODING_CODE_NODE,
			name: 'Coding',
			agents: [
				{
					agentId: 'Coder',
					name: 'coder',
					customPrompt: {
						value:
							'You are a software engineer in a Coding→Review iterative workflow. Your job is to ' +
							'implement the task, write tests, commit your changes, and open a pull request.\n\n' +
							'Steps:\n' +
							'1. Read and understand the task requirements\n' +
							'2. Implement the changes with logical, well-described commits\n' +
							'3. Write or update tests to cover new behavior\n' +
							'4. Run the test suite and fix any failures\n' +
							'5. Open a PR with `gh pr create` — include a clear title and description\n' +
							'6. Hand off by sending a message to Review with ' +
							'`data: { pr_url: "<url>" }`. The gate script verifies the PR is open and ' +
							'mergeable, so make sure it actually is before sending. ' +
							'**Always include `data: { pr_url }` on every send_message to Review** — the gate ' +
							'data resets each cycle, so even on round 2+ you must re-supply it.\n\n' +
							'If re-activated after review:\n' +
							'1. Read the incoming message `data` — you should find `review_url` and ' +
							'`comment_urls` (an array of comment thread URLs). Open each one; do not rely on ' +
							'a summary.\n' +
							'2. For each comment: evaluate critically — do not blindly accept feedback. Verify ' +
							'against the code and the task requirements. The Reviewer can be wrong.\n' +
							'3. For valid items: make the fix, then reply to that specific thread via ' +
							'`gh api repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies -f body="<ack>"` ' +
							'explaining what changed. One reply per comment creates a visible audit trail.\n' +
							'4. For items you disagree with: reply on the same thread explaining why, with ' +
							'evidence from the code or tests. Do not change code you believe is correct.\n' +
							'5. Push fixes, verify tests still pass, then send_message to Review again ' +
							'(again with `data: { pr_url }`) to re-trigger the review cycle',
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
							'You are the Reviewer in a Coding→Review iterative workflow. You review the work ' +
							'and either approve it or request changes.\n\n' +
							'You share the same worktree as the engineer — review the codebase as a whole, ' +
							'not just the PR diff. Read related files, run tests, check for issues the diff ' +
							'might not surface (e.g. callers of changed functions, integration points).\n' +
							'- All feedback MUST be posted to the PR on GitHub — not just summarized in your ' +
							'response. Use `gh pr review <pr-url> --request-changes --body-file <file>` for ' +
							'the summary, and `gh api repos/{owner}/{repo}/pulls/{n}/comments` for line-level ' +
							'comments (one per issue, anchored to the exact path and line).\n' +
							'- The Review → Coding channel is gated by `review-posted-gate` — the runtime ' +
							'checks GitHub for a fresh review before releasing your message. If you skip ' +
							'`gh pr review`, the gate will block and the coder will never hear from you.\n\n' +
							'**You MUST call `report_result` to end this workflow.** It is the only signal ' +
							'the runtime accepts as completion — finishing your turn without it leaves the ' +
							'workflow stuck. Do all your review work — read files, run tests, post comments ' +
							'to GitHub, send messages to Coding — BEFORE calling `report_result`. After it ' +
							'returns, do not invoke any other tools.\n\n' +
							'Review checklist:\n' +
							'1. Read the PR diff (`gh pr diff`) AND explore the worktree for context\n' +
							'2. Check for correctness, style, test coverage, and integration impact\n' +
							'3. Run the relevant tests yourself if uncertain\n' +
							'4. If changes needed:\n' +
							'   a. Post a summary review: `gh pr review <pr-url> --request-changes ' +
							'--body-file /tmp/review.md`. Capture the returned review URL.\n' +
							'   b. For each issue, post a line-level comment: `gh api ' +
							'repos/{owner}/{repo}/pulls/{n}/comments -f body=... -f commit_id=... ' +
							'-f path=... -F line=...`. Capture each response `html_url`.\n' +
							'   c. send_message(target="Coding", message="<short request summary>", ' +
							'data={ pr_url: "<url>", review_url: "<gh pr review url>", ' +
							'comment_urls: ["<comment #1 url>", "<comment #2 url>"] }). The `data` payload ' +
							'satisfies the review-posted-gate and gives the coder direct links to each ' +
							'thread. Do NOT call `report_result` — leave the workflow open for the next round.\n' +
							'5. If satisfied: post an approval review with `gh pr review <pr-url> --approve ' +
							'--body-file <file>`, verify the PR is open and mergeable, then call ' +
							'`report_result({ summary, evidence: { prUrl } })` as your final action. ' +
							'Do NOT pass a `status` — the runtime decides the terminal state via completion actions.',
					},
				},
			],
			completionActions: [MERGE_PR_COMPLETION_ACTION],
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
					writers: ['Coding'],
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
		{
			id: 'review-posted-gate',
			label: 'Review Posted',
			description:
				'Reviewer has posted a GitHub review (via `gh pr review`) since the workflow ' +
				'started. Blocks the Review → Coding feedback channel until a real review is ' +
				'visible on the PR.',
			fields: [
				{
					name: 'review_url',
					type: 'string',
					writers: ['reviewer'],
					check: { op: 'exists' },
				},
			],
			script: {
				interpreter: 'bash',
				source: REVIEW_POSTED_BASH_SCRIPT,
				timeoutMs: 30000,
			},
			resetOnCycle: true,
		},
	],
	channels: [
		{
			from: 'Coding',
			to: 'Review',
			gateId: 'code-ready-gate',
			label: 'Coding → Review',
		},
		{
			from: 'Review',
			to: 'Coding',
			gateId: 'review-posted-gate',
			maxCycles: 5,
			label: 'Review → Coding (changes requested)',
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
 * Reviewer agent reviews the research PR; calls report_result() if satisfied,
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
							'**You MUST call `report_result` to end this workflow.** It is the only signal the ' +
							'runtime accepts as completion — finishing your turn without it leaves the workflow ' +
							'stuck. Do all your review work BEFORE calling `report_result`; it must be your last ' +
							'tool call. Do not call it when requesting more research — leave the workflow open ' +
							'for the next round in that case.\n\n' +
							'Review checklist:\n' +
							'1. Read all research documents in the PR (`gh pr diff`)\n' +
							'2. Check completeness: does the research answer the original question?\n' +
							'3. Check accuracy: are claims supported by evidence or sources?\n' +
							'4. Check clarity: are findings well-organized and easy to follow?\n' +
							'5. If more research needed: send_message back to Research with specific areas to ' +
							'investigate (do NOT call `report_result`)\n' +
							'6. If satisfied: verify the PR is still open and mergeable, then call ' +
							'`report_result({ summary, evidence: { prUrl } })` as your final action. ' +
							'Do NOT pass a `status` — the runtime decides the terminal state via completion actions.',
					},
				},
			],
			completionActions: [MERGE_PR_COMPLETION_ACTION],
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
							'**You MUST call `report_result` to end this workflow.** It is the only signal the ' +
							'runtime accepts as completion — finishing your turn without it leaves the workflow ' +
							'stuck. Do all review work BEFORE calling `report_result`; it must be your last tool ' +
							'call.\n\n' +
							'**You MUST post your review to the PR via `gh pr review` BEFORE calling ' +
							'`report_result`.** An internal summary is not enough — the author must be able to see ' +
							'your feedback on GitHub. Use:\n' +
							'- `gh pr review <pr-url> --body-file <file>` with `--approve`, `--request-changes`, or ' +
							'`--comment`.\n' +
							'- `gh api repos/{owner}/{repo}/pulls/{n}/comments` for line-level comments anchored to ' +
							'specific files/lines.\n\n' +
							'Review checklist:\n' +
							'1. Read the PR diff or specified code thoroughly (`gh pr diff`)\n' +
							'2. Check for correctness, security, performance, and style issues\n' +
							'3. Verify test coverage is adequate\n' +
							'4. Post your review to the PR via `gh pr review` (+ inline comments via `gh api` ' +
							'where relevant) — this is required, not optional, and the runtime verifies at ' +
							'least one review/comment exists before accepting completion\n' +
							'5. Summarize your findings clearly for the task record\n' +
							'6. Call `report_result({ summary, evidence: { prUrl } })` as your final action. ' +
							'Do NOT pass a `status` — the runtime decides the terminal state via completion actions.',
					},
				},
			],
			completionActions: [VERIFY_REVIEW_POSTED_COMPLETION_ACTION],
		},
	],
	startNodeId: REVIEW_REVIEW_NODE,
	endNodeId: REVIEW_REVIEW_NODE,
	tags: ['review'],
	createdAt: 0,
	updatedAt: 0,
};

/**
 * Bash script for the Plan & Decompose end-node completion action.
 *
 * Verifies that the Task Dispatcher actually fanned the plan out into at least
 * one standalone task during this workflow run. Without this guard, a Task
 * Dispatcher that ran report_result() without creating tasks would look
 * successful on the surface but leave the user with zero follow-up work.
 *
 * Environment variables required (injected by the completion-action executor):
 *   NEOKAI_DB_PATH            — absolute path to the SQLite database file
 *   NEOKAI_SPACE_ID           — the owning space ID
 *   NEOKAI_WORKFLOW_START_ISO — ISO-8601 timestamp marking the run's start
 */
const PLAN_AND_DECOMPOSE_VERIFY_SCRIPT = [
	'# Verify at least one follow-up task was created during this workflow run.',
	'if [ -z "$NEOKAI_DB_PATH" ] || [ -z "$NEOKAI_SPACE_ID" ] || [ -z "$NEOKAI_WORKFLOW_START_ISO" ]; then',
	'  echo "Missing NEOKAI_DB_PATH, NEOKAI_SPACE_ID, or NEOKAI_WORKFLOW_START_ISO" >&2',
	'  exit 1',
	'fi',
	'# Portable ISO → epoch-seconds conversion (BSD date on macOS lacks -d).',
	'if command -v gdate >/dev/null 2>&1; then',
	'  CREATED_AT=$(gdate -d "$NEOKAI_WORKFLOW_START_ISO" +%s)',
	'elif date -d "$NEOKAI_WORKFLOW_START_ISO" +%s >/dev/null 2>&1; then',
	'  CREATED_AT=$(date -d "$NEOKAI_WORKFLOW_START_ISO" +%s)',
	'else',
	'  # BSD date (-j -f) fallback',
	'  CREATED_AT=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${NEOKAI_WORKFLOW_START_ISO%%.*}" +%s 2>/dev/null || echo 0)',
	'fi',
	'if [ -z "$CREATED_AT" ] || [ "$CREATED_AT" = "0" ]; then',
	'  echo "Could not parse NEOKAI_WORKFLOW_START_ISO=$NEOKAI_WORKFLOW_START_ISO" >&2',
	'  exit 1',
	'fi',
	'CREATED_AT_MS=$((CREATED_AT * 1000))',
	'COUNT=$(sqlite3 "$NEOKAI_DB_PATH" "SELECT COUNT(*) FROM space_tasks WHERE space_id=\'$NEOKAI_SPACE_ID\' AND created_at > $CREATED_AT_MS;")',
	'if [ -z "$COUNT" ] || [ "$COUNT" -lt 1 ]; then',
	'  echo "No tasks created in this run (count=$COUNT)" >&2',
	'  exit 1',
	'fi',
	'jq -n --argjson n "$COUNT" \'{"status":"verified","created_count":$n}\'',
].join('\n');

const PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION: CompletionAction = {
	id: 'verify-tasks-created',
	name: 'Verify tasks created',
	description:
		'Checks that the Task Dispatcher created at least one standalone task during this workflow run.',
	type: 'script',
	// Match the highest non-destructive autonomy tier — verification is safe to
	// run automatically even at conservative autonomy levels.
	requiredLevel: 1,
	script: PLAN_AND_DECOMPOSE_VERIFY_SCRIPT,
};

/**
 * Plan & Decompose Workflow
 *
 * Three-node graph: Planner → 4-Reviewer Plan Review → Task Dispatcher.
 * Useful for multi-task goals ("build X feature", "migrate Y system") that
 * should be broken into smaller standalone tasks before any coding starts.
 *
 * Main progression:
 *   Planning → Plan Review (plan-pr-gate: script verifies plan PR is open/mergeable)
 *   Plan Review → Task Dispatcher (plan-approval-gate: all 4 reviewers approve)
 *
 * Cyclic feedback:
 *   Plan Review → Planning (revision requests, maxCycles: 5)
 *
 * Task Dispatcher (end node) creates follow-up tasks via `create_standalone_task`
 * and calls `report_result(..., evidence={ created_task_ids })`. A script-based
 * completion action then verifies that at least one task was actually created.
 */
export const PLAN_AND_DECOMPOSE_WORKFLOW: SpaceWorkflow = {
	id: '',
	spaceId: '',
	name: 'Plan & Decompose Workflow',
	description:
		'Planning-only workflow that ends by creating follow-up tasks rather than writing code. ' +
		'A Planner drafts a plan PR, four Reviewers review it through different lenses ' +
		'(architecture, security, correctness, UX), and a Task Dispatcher fans the approved plan ' +
		'out into standalone tasks via create_standalone_task. Use for multi-task goals that ' +
		'should be broken down before any coding starts.',
	nodes: [
		{
			id: PD_PLANNING_NODE,
			name: 'Planning',
			agents: [
				{
					agentId: 'Planner',
					name: 'planner',
					customPrompt: {
						value:
							PD_PLANNING_PROMPT +
							'\n\n' +
							'Expected inputs: A high-level goal from the workflow trigger.\n' +
							'Expected outputs: `plan.md` committed to a PR branch, with an open mergeable PR.\n\n' +
							'Steps:\n' +
							'1. Analyze the goal and explore the relevant codebase\n' +
							'2. Decompose the goal into concrete, small-enough work items\n' +
							'3. Write `plan.md` — one section per work item with title, description, priority\n' +
							'4. Commit and open/update a PR against the default branch\n' +
							'5. Wait for plan-pr-gate to verify mergeability\n\n' +
							'If re-activated after Plan Review feedback: address each reviewer comment, ' +
							'update `plan.md`, and push to the same PR branch.',
					},
				},
			],
		},
		{
			id: PD_PLAN_REVIEW_NODE,
			name: 'Plan Review',
			agents: [
				{
					agentId: 'Reviewer',
					name: 'architecture-reviewer',
					customPrompt: {
						value:
							PD_PLAN_REVIEW_PROMPT +
							'\n\n' +
							'Your lens: **Architecture**. Focus on module boundaries, coupling between work ' +
							'items, long-term maintainability, and whether the decomposition will hold up as ' +
							'the system grows. Flag items that smuggle unrelated concerns together or create ' +
							'hidden cross-cutting dependencies.\n\n' +
							'When voting, use `reviewer_name: "architecture"` in the plan-approval-gate data.',
					},
				},
				{
					agentId: 'Reviewer',
					name: 'security-reviewer',
					customPrompt: {
						value:
							PD_PLAN_REVIEW_PROMPT +
							'\n\n' +
							'Your lens: **Security**. Focus on the threat model, input validation, ' +
							'authentication/authorization, secrets handling, and supply-chain risk for any ' +
							'new dependencies. Flag items that expose user data, bypass existing auth checks, ' +
							'or rely on untrusted input without validation.\n\n' +
							'When voting, use `reviewer_name: "security"` in the plan-approval-gate data.',
					},
				},
				{
					agentId: 'Reviewer',
					name: 'correctness-reviewer',
					customPrompt: {
						value:
							PD_PLAN_REVIEW_PROMPT +
							'\n\n' +
							'Your lens: **Correctness**. Focus on edge cases, error handling, data ' +
							'consistency across failures, idempotency, and race conditions. Flag items ' +
							'whose acceptance criteria are vague, whose failure modes are unclear, or ' +
							'whose tests would not catch the obvious regressions.\n\n' +
							'When voting, use `reviewer_name: "correctness"` in the plan-approval-gate data.',
					},
				},
				{
					agentId: 'Reviewer',
					name: 'ux-reviewer',
					customPrompt: {
						value:
							PD_PLAN_REVIEW_PROMPT +
							'\n\n' +
							'Your lens: **UX**. Focus on user-visible behavior, API ergonomics, ' +
							'documentation, error messages, and upgrade/migration experience for ' +
							'existing users. Flag items that change public interfaces without describing ' +
							'what users will see or how docs will be updated.\n\n' +
							'When voting, use `reviewer_name: "ux"` in the plan-approval-gate data.',
					},
				},
			],
		},
		{
			id: PD_TASK_DISPATCHER_NODE,
			name: 'Task Dispatcher',
			agents: [
				{
					agentId: 'General',
					name: 'task-dispatcher',
					customPrompt: {
						value:
							PD_TASK_DISPATCHER_PROMPT +
							'\n\n' +
							'Expected inputs: An approved plan PR (plan-approval-gate satisfied — all 4 ' +
							'reviewers voted `approved: true`).\n' +
							'Expected outputs: One standalone task per actionable work item in the plan, ' +
							'then report_result() with `evidence.created_task_ids`.\n\n' +
							'Tool contract:\n' +
							"- `create_standalone_task` is available from the space's MCP server and " +
							'creates a task owned by the same space as this workflow.',
					},
				},
			],
			completionActions: [PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION],
		},
	],
	startNodeId: PD_PLANNING_NODE,
	endNodeId: PD_TASK_DISPATCHER_NODE,
	tags: ['planning', 'decomposition'],
	createdAt: 0,
	updatedAt: 0,
	gates: [
		{
			id: 'plan-pr-gate',
			label: 'PR Ready',
			description: 'Planning PR is open and mergeable so Plan Review can start.',
			fields: [{ name: 'pr_url', type: 'string', writers: ['*'], check: { op: 'exists' } }],
			script: {
				interpreter: 'bash',
				source: PR_READY_BASH_SCRIPT,
				timeoutMs: 30000,
			},
			resetOnCycle: true,
		},
		{
			id: 'plan-approval-gate',
			label: 'Plan Approvals',
			description:
				'All four Plan Reviewers must approve the plan before Task Dispatcher activates. ' +
				'Each reviewer writes to the `approvals` map with their lens name as the key ' +
				'(architecture, security, correctness, ux) and `approved: true` as the value. ' +
				'Gate passes when ≥ 4 entries are approved.',
			fields: [
				{
					name: 'approvals',
					type: 'map',
					writers: ['reviewer'],
					check: { op: 'count', match: 'approved', min: 4 },
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
			to: 'Task Dispatcher',
			gateId: 'plan-approval-gate',
			label: 'Plan Review → Task Dispatcher',
		},
		{
			from: 'Plan Review',
			to: 'Planning',
			maxCycles: 5,
			label: 'Plan Review → Planning (revision requested)',
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
 * QA is the end node. QA calls report_result() on success.
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
							'5. Call report_result() with a concise coding handoff summary\n' +
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
							'**You MUST call `report_result` to end this workflow.** It is the only signal the ' +
							'runtime accepts as completion — finishing your turn without it leaves the workflow ' +
							'stuck. `report_result` must be your last tool call. Do not call it when sending ' +
							'feedback to Coding — leave the workflow open for the next round in that case.\n\n' +
							'Expected inputs: Reviewer-approved PR.\n' +
							'Expected outputs: PR merged and worktree synced, or QA feedback to Coding.\n\n' +
							'Steps:\n' +
							'1. Run backend and frontend test suites\n' +
							'2. Run browser-based critical-path validation\n' +
							'3. Validate CI and mergeability\n' +
							'4. If fail: send detailed failures and repro steps to Coding (do NOT call ' +
							'`report_result`)\n' +
							'5. If all green: merge the PR with `gh pr merge <URL> --squash`\n' +
							'6. Sync worktree: `git checkout <base-branch> && git pull --ff-only`\n' +
							'7. Call `report_result({ summary, evidence: { prUrl, testOutput } })` confirming ' +
							'merge and sync. Do NOT pass a `status` — the runtime verifies the PR is actually ' +
							'merged before accepting completion.',
					},
				},
			],
			completionActions: [VERIFY_PR_MERGED_COMPLETION_ACTION],
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
					writers: [],
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
	// CODING_WORKFLOW is first so it becomes the default workflow selected by
	// spaceWorkflowRun.start (which picks workflows[0] ordered by created_at ASC).
	// It is tagged `default` and covers the most common case — a single implementation
	// task with one engineer and one reviewer.
	//
	// PLAN_AND_DECOMPOSE_WORKFLOW is tagged `planning` / `decomposition` (NOT `default`)
	// so the LLM picks it explicitly for multi-task goals that should be broken down
	// before coding starts.
	//
	// Note: this ordering only affects *newly created* spaces. seedBuiltInWorkflows is
	// insert-only (it skips if any workflows already exist), so existing spaces keep
	// whatever ordering was seeded when they were first created.
	return [
		CODING_WORKFLOW,
		PLAN_AND_DECOMPOSE_WORKFLOW,
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
				// Thread completionActions through to persisted nodes. Without this,
				// end-node actions like MERGE_PR_COMPLETION_ACTION are silently dropped
				// so report_result() completes the workflow but the PR never merges.
				...(s.completionActions ? { completionActions: s.completionActions } : {}),
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
				templateName: template.name,
				templateHash: computeWorkflowHash(template),
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
