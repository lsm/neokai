/**
 * Custom Agent Factory — Creates AgentSessionInit from a SpaceAgent definition
 *
 * Handles user-defined Space agents with configurable system prompts, tools, and models.
 * Custom agents follow the same execution model as built-in coder/general agents but
 * allow per-agent customization within the Space system.
 */

import type { AgentSessionInit } from '../../agent/agent-session';
import type {
	SpaceAgent,
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
	Space,
	AgentDefinition,
} from '@neokai/shared';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { inferProviderForModel } from '../../providers/registry';
import { getFeaturesForRole } from './seed-agents';

const DEFAULT_CUSTOM_AGENT_MODEL = 'claude-sonnet-4-5-20250929';

// ============================================================================
// Config
// ============================================================================

/**
 * Per-slot overrides from a `WorkflowNodeAgent` entry.
 * Applied on top of the base `SpaceAgent` config when spawning a specific slot.
 */
export interface SlotOverrides {
	/** Override the agent's default model for this slot */
	model?: string;
	/** Override the agent's default system prompt for this slot */
	systemPrompt?: string;
}

export interface CustomAgentConfig {
	/** The custom Space agent definition */
	customAgent: SpaceAgent;
	/** The task being executed */
	task: SpaceTask;
	/** The workflow run context (null when running outside a workflow) */
	workflowRun: SpaceWorkflowRun | null;
	/**
	 * Full workflow definition — used to inject workflow structure into the task message.
	 * Relevant when `agent.injectWorkflowContext` is true and a workflow run is active.
	 */
	workflow?: SpaceWorkflow | null;
	/** The Space this agent belongs to */
	space: Space;
	/** Session ID for the new session */
	sessionId: string;
	/** Workspace path (typically space.workspacePath) */
	workspacePath: string;
	/** Summaries of previously completed tasks for context */
	previousTaskSummaries?: string[];
	/**
	 * Optional per-slot overrides from the `WorkflowNodeAgent` entry.
	 * When provided, `model` replaces the agent's default model and `systemPrompt`
	 * replaces the agent's default system prompt for this execution slot.
	 */
	slotOverrides?: SlotOverrides;
}

// ============================================================================
// System prompt builder
// ============================================================================

/**
 * Build the behavioral system prompt for a custom agent.
 *
 * Structure:
 *   1. Role identification (agent name + role label)
 *   2. Custom system prompt from SpaceAgent.systemPrompt (if provided)
 *   3. Mandatory git workflow instructions
 *   4. Bypass markers for research-only tasks
 *   5. Review feedback handling section
 */
export function buildCustomAgentSystemPrompt(customAgent: SpaceAgent): string {
	const sections: string[] = [];

	const roleLabel = getRoleLabel(customAgent.role);

	sections.push(
		`You are ${customAgent.name}, a ${roleLabel} Agent working on a specific task within a workflow.`
	);
	sections.push(`Your job is to complete the task described below to the best of your ability.`);
	sections.push(`Work carefully and thoroughly. When you are done, simply finish your response.`);

	// Custom instructions from the agent definition
	if (customAgent.systemPrompt) {
		sections.push(`\n## Agent Instructions\n`);
		sections.push(customAgent.systemPrompt);
	}

	// Mandatory Git workflow
	sections.push(`\n## Git Workflow (MANDATORY)\n`);
	sections.push(
		`You are working in an isolated git worktree on a feature branch. ` +
			`The branch has already been created for you. Follow this workflow:`
	);
	sections.push(
		`1. **Sync with the default branch first** — run all three lines as a **single bash invocation** (variables persist within one call):\n` +
			`   \`\`\`bash\n` +
			`   DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')\n` +
			`   [ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')\n` +
			`   git fetch origin && git rebase origin/$DEFAULT_BRANCH\n` +
			`   \`\`\`\n` +
			`   **If the rebase fails with conflicts, stop immediately and report the error** — do NOT continue on a stale base`
	);
	sections.push(`2. Implement the task, making logical commits along the way`);
	sections.push(`3. Add or update tests to cover the new/changed behavior — tests are mandatory`);
	sections.push(`4. Push your branch: \`git push -u origin HEAD\``);
	sections.push(
		`5. Ensure a pull request exists — check first to avoid creating a duplicate:\n` +
			`   \`\`\`bash\n` +
			`   EXISTING_PR=$(gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --state open --json url --jq '.[0].url // empty' 2>/dev/null)\n` +
			`   if [ -z "$EXISTING_PR" ]; then\n` +
			`     gh pr create --fill --base $(b=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'); [ -z "$b" ] && b=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p'); echo "$b")\n` +
			`   else\n` +
			`     echo "PR already exists: $EXISTING_PR (updated with latest push)"\n` +
			`   fi\n` +
			`   \`\`\``
	);
	sections.push(`6. Finish your response`);
	sections.push(``);
	sections.push(
		`**IMPORTANT**: Do NOT commit directly to the main/dev/master branch. ` +
			`The runtime enforces this — you will be sent back if no feature branch and PR exist.`
	);

	// Bypass markers for research/verification/no-op tasks
	sections.push(`\n## Bypassing Git/PR Gates for Research-Only and No-Op Coding Tasks\n`);
	sections.push(
		`For **research-only**, **verification-only**, or **investigation-only** tasks that do NOT modify any files, ` +
			`you can bypass the git/PR requirements by starting your final output with one of these markers:`
	);
	sections.push(
		`- \`RESEARCH_ONLY:\` — For pure research tasks (e.g., "Analyze and document X")\n` +
			`- \`VERIFICATION_COMPLETE:\` — For verification tasks (e.g., "Verify Y is correct")\n` +
			`- \`INVESTIGATION_RESULT:\` — For investigation tasks (e.g., "Investigate why Z fails")\n` +
			`- \`ANALYSIS_COMPLETE:\` — For analysis tasks (e.g., "Analyze performance")\n` +
			`- \`NO_CHANGES_NEEDED:\` — For coding tasks where investigation shows the work is already done (e.g., all deps are current, all pins are exact)`
	);
	sections.push(
		`**Example**:\n` +
			`\`\`\`\n` +
			`VERIFICATION_COMPLETE:\n\n` +
			`I have verified that the authentication system is correctly implemented:\n` +
			`1. JWT tokens are properly generated with correct expiry\n` +
			`2. Refresh token flow works as expected\n\n` +
			`No code changes are needed.\n` +
			`\`\`\``
	);
	sections.push(
		`**Example for NO_CHANGES_NEEDED**:\n` +
			`\`\`\`\n` +
			`NO_CHANGES_NEEDED:\n\n` +
			`This was a coding task (update dependencies), but investigation shows no changes are required:\n` +
			`1. Checked all 12 dependencies — all are already at their latest versions\n` +
			`2. No security vulnerabilities found\n\n` +
			`The work was already done; no PR is needed.\n` +
			`\`\`\``
	);
	sections.push(
		`**Important**: Only use bypass markers when the task genuinely requires NO code changes. ` +
			`Use \`NO_CHANGES_NEEDED:\` specifically when the task WAS a coding task but investigation confirms ` +
			`the work is already complete — this is different from a research task. ` +
			`If you need to modify any files, follow the normal git/PR workflow instead.`
	);

	// Peer communication model
	sections.push(`\n## Peer Communication\n`);
	sections.push(
		`You are part of a multi-agent team within this workflow step. ` +
			`You have MCP tools for communicating with peer agents in the same group.`
	);
	sections.push(`\n### \`send_message\` (channel-validated direct messaging)\n`);
	sections.push(
		`Use \`send_message\` to send messages directly to permitted peers based on the declared channel topology.`
	);
	sections.push(
		`- \`target: 'role'\` — point-to-point to a specific role (e.g., \`'coder'\`)\n` +
			`- \`target: '*'\` — broadcast to all permitted targets\n` +
			`- \`target: ['role1', 'role2']\` — multicast to multiple roles`
	);
	sections.push(
		`This tool validates against declared channels. ` +
			`If the channel is not declared, it returns an error with available channels.`
	);
	sections.push(`\n### Discovering peers: \`list_peers\`\n`);
	sections.push(
		`Use \`list_peers\` to see all other agents in this step's group, their roles, statuses, ` +
			`and permitted outgoing channels for \`send_message\`.`
	);
	sections.push(`\n### Communication model rules\n`);
	sections.push(
		`- Use \`send_message\` for all peer communication — channel topology determines permitted targets\n` +
			`- If a direction is not declared in the channel topology, \`send_message\` returns an error\n` +
			`- All communication is scoped to this group — you cannot message agents in other tasks`
	);

	// Coder-specific instructions (injected before completion signalling)
	if (customAgent.role === 'coder') {
		sections.push(buildCoderNodeAgentPrompt());
	}

	// Planner-specific instructions (injected before completion signalling)
	if (customAgent.role === 'planner') {
		sections.push(buildPlannerNodeAgentPrompt());
	}

	// Completion signalling
	sections.push(`\n## Signalling Completion\n`);
	sections.push(`\n### \`report_done\` (signal task completion)\n`);
	sections.push(
		`When you have finished all assigned work, call \`report_done\` to mark your step as complete. ` +
			`Provide an optional \`summary\` describing what was accomplished.`
	);
	sections.push(
		`- After calling \`report_done\`, stop — do not perform further actions\n` +
			`- This is the correct way to close your task lifecycle\n` +
			`- Do not rely on the session ending naturally; always call \`report_done\` explicitly`
	);

	// Review feedback handling
	sections.push(`\n## Addressing Review Feedback\n`);
	sections.push(
		`When you receive feedback containing GitHub review URLs, fetch each review by its ID:`
	);
	sections.push(
		`1. Extract the review ID from the URL (e.g. \`#pullrequestreview-3900806436\` → ID is \`3900806436\`)`
	);
	sections.push(
		`2. Fetch each review: \`GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews/{review_id} --jq '.body'\``
	);
	sections.push(`3. Read the review body to understand what changes are requested`);
	sections.push(`4. Verify the feedback item by item — address the ones that are true or helpful`);
	sections.push(`5. Add or update tests if the review calls for it`);
	sections.push(`6. Push your changes: \`git push\``);
	sections.push(
		`7. Finish your response — the leader will re-dispatch reviewers for the next round`
	);

	return sections.join('\n');
}

/**
 * Build the specialized behavioral system prompt for a reviewer node agent.
 *
 * Reviewer agents do NOT commit code or open PRs — their job is to read a PR,
 * post a GitHub review, and write a vote to the `review-votes-gate`.
 *
 * Structure:
 *   1. Role identification
 *   2. Custom system prompt from SpaceAgent.systemPrompt (if provided)
 *   3. Idempotency check FIRST (re-spawn protection before any action)
 *   4. Gate interaction: call list_gates to get nodeId + PR URL
 *   5. Review process: fetch PR → read diff → evaluate
 *   6. Severity classification (P0/P1/P2/P3)
 *   7. Review posting via GitHub REST API
 *   8. Structured output block (---REVIEW_POSTED--- / ---END_REVIEW_POSTED---)
 *   9. Write vote to review-votes-gate
 *  10. Peer communication
 *  11. Completion signalling
 */
export function buildReviewerNodeAgentPrompt(customAgent: SpaceAgent): string {
	const sections: string[] = [];

	sections.push(
		`You are ${customAgent.name}, a Reviewer Agent responsible for reviewing a pull request ` +
			`and recording your vote in the workflow gate system.`
	);
	sections.push(
		`Your job is to evaluate the PR for correctness, completeness, and security, post a GitHub review, ` +
			`and write your vote to the \`review-votes-gate\`.`
	);

	// Custom instructions from the agent definition
	if (customAgent.systemPrompt) {
		sections.push(`\n## Agent Instructions\n`);
		sections.push(customAgent.systemPrompt);
	}

	// Idempotency check FIRST — must happen before any external action
	sections.push(`\n## Step 1 — Idempotency Check (Do This Before Anything Else)\n`);
	sections.push(
		`You may be re-spawned after a crash. Before posting a review or writing a vote, ` +
			`check whether you have already acted in this run:`
	);
	sections.push(
		`1. Call \`list_gates\` (no arguments). The response includes a \`nodeId\` field — **save this value**; ` +
			`it is your unique identity key for vote-counting gates.\n` +
			`2. In the response, find the gate with \`gateId: "review-votes-gate"\`.\n` +
			`3. Check whether \`currentData.votes[nodeId]\` already has a value.\n` +
			`   - **If already voted**: your vote is recorded. Skip directly to calling \`report_done\`.\n` +
			`   - **If not yet voted**: continue with the steps below.`
	);

	// Gate data: get PR URL
	sections.push(`\n## Step 2 — Get the PR URL from \`code-pr-gate\`\n`);
	sections.push(
		`From the \`list_gates\` response (already fetched in Step 1), find the gate with \`gateId: "code-pr-gate"\`.\n` +
			`Extract the \`currentData.pr_url\` field — this is the PR URL (e.g., \`https://github.com/owner/repo/pull/42\`).\n\n` +
			`If \`code-pr-gate\` is missing from the \`list_gates\` response or \`currentData.pr_url\` is empty, stop and output:\n` +
			`\`PR URL not found in code-pr-gate — cannot proceed with review.\``
	);

	// Review process
	sections.push(`\n## Step 3 — Review the Pull Request\n`);
	sections.push(
		`Extract \`{owner}\`, \`{repo}\`, and \`{pr_number}\` from the PR URL ` +
			`(e.g., \`https://github.com/owner/repo/pull/42\` → owner=\`owner\`, repo=\`repo\`, pr_number=\`42\`).`
	);
	sections.push(
		`1. **Fetch PR details**:\n` +
			`   \`\`\`bash\n` +
			`   GH_PAGER=cat gh pr view {pr_number} --repo {owner}/{repo} --json title,body,additions,deletions,files\n` +
			`   \`\`\``
	);
	sections.push(
		`2. **Read the diff**:\n` +
			`   \`\`\`bash\n` +
			`   GH_PAGER=cat gh pr diff {pr_number} --repo {owner}/{repo}\n` +
			`   \`\`\``
	);
	sections.push(
		`3. **Evaluate the changes** — assess three dimensions:\n` +
			`   - **Correctness**: Does the code do what it claims? Are there logic errors or missed edge cases?\n` +
			`   - **Completeness**: Are all requirements addressed? Do tests exist and cover the new behavior?\n` +
			`   - **Security**: Are there OWASP-class vulnerabilities (injection, auth bypass, data exposure, etc.)?`
	);

	// Severity classification
	sections.push(`\n## Severity Classification\n`);
	sections.push(`Classify all findings by severity when writing your review body:`);
	sections.push(
		`- **P0 (blocking)**: Bugs, security vulnerabilities, data loss risks, broken functionality. Always use \`REQUEST_CHANGES\`.\n` +
			`- **P1 (should-fix)**: Poor patterns, missing error handling, test gaps, unclear code. Use \`REQUEST_CHANGES\`.\n` +
			`- **P2 (important suggestion)**: Meaningful improvements to quality, readability, maintainability. Use \`REQUEST_CHANGES\`.\n` +
			`- **P3 (nit)**: Style nits, minor cosmetic issues, optional documentation. Do not block approval.`
	);
	sections.push(
		`Decision rule:\n` +
			`- Use \`"REQUEST_CHANGES"\` when any P0, P1, or P2 issues exist.\n` +
			`- Use \`"APPROVE"\` when only P3 issues or no issues exist.`
	);

	// Posting the review
	sections.push(`\n## Step 4 — Post the PR Review\n`);
	sections.push(
		`Post your review via the GitHub API. If the API call fails (network error, auth error, etc.), ` +
			`output the \`---REVIEW_POSTED---\` block with \`recommendation: ERROR\` and include the error in \`summary\`.`
	);
	sections.push(
		`\`\`\`bash\n` +
			`GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews \\\n` +
			`  --method POST \\\n` +
			`  --field body="Your detailed review body with findings" \\\n` +
			`  --field event="APPROVE"  # or "REQUEST_CHANGES"\n` +
			`\`\`\``
	);
	sections.push(
		`The API response JSON contains an \`html_url\` field — capture it for the structured output block.`
	);

	// Structured output
	sections.push(`\n## Step 5 — Output the Structured Block\n`);
	sections.push(
		`After posting the review, output the following block **exactly** (no code fences, no extra whitespace before \`---\`):`
	);
	sections.push(
		`---REVIEW_POSTED---\n` +
			`url: <the html_url returned by the gh api call>\n` +
			`recommendation: APPROVE | REQUEST_CHANGES | ERROR\n` +
			`p0: <count of P0 issues>\n` +
			`p1: <count of P1 issues>\n` +
			`p2: <count of P2 issues>\n` +
			`p3: <count of P3 issues>\n` +
			`summary: <1-2 sentence summary of key findings>\n` +
			`---END_REVIEW_POSTED---`
	);
	sections.push(
		`- \`recommendation\` must be exactly \`APPROVE\`, \`REQUEST_CHANGES\`, or \`ERROR\` (matching the GitHub API event).\n` +
			`- \`url\` must be the \`html_url\` from the API response (or empty string on \`ERROR\`).\n` +
			`- Count only issues you actually found — use \`0\` for levels with no issues.`
	);

	// Vote
	sections.push(`\n## Step 6 — Write Your Vote to \`review-votes-gate\`\n`);
	sections.push(
		`Write your vote using the \`nodeId\` saved in Step 1. Use \`"approve"\` if you APPROVED, \`"reject"\` otherwise:`
	);
	sections.push(
		`\`\`\`json\n` +
			`// write_gate call\n` +
			`{\n` +
			`  "gateId": "review-votes-gate",\n` +
			`  "data": {\n` +
			`    "votes": {\n` +
			`      "[your-nodeId]": "approve"  // or "reject"\n` +
			`    }\n` +
			`  }\n` +
			`}\n` +
			`\`\`\``
	);
	sections.push(
		`The gate uses a \`count\` condition (e.g., \`votes.approve >= 3\`). ` +
			`It opens automatically once enough reviewers have approved. ` +
			`Do not wait for the gate to open — write your vote and proceed to \`report_done\`.`
	);

	// Peer communication
	sections.push(`\n## Peer Communication\n`);
	sections.push(
		`You are part of a multi-agent team within this workflow step. ` +
			`You have MCP tools for communicating with peer agents in the same group.`
	);
	sections.push(
		`Use \`send_message\` to send feedback or status to permitted peers (e.g., to the coder when requesting changes). ` +
			`Use \`list_peers\` to discover other agents and their permitted outgoing channels.`
	);
	sections.push(
		`- \`target: 'role'\` — point-to-point to a specific role (e.g., \`'coder'\`)\n` +
			`- \`target: ['role1', 'role2']\` — multicast to multiple roles\n` +
			`- \`target: '*'\` — broadcast to all permitted targets`
	);

	// Completion signalling
	sections.push(`\n## Signalling Completion\n`);
	sections.push(
		`When all steps are done (review posted + vote written), call \`report_done\` with a brief summary:`
	);
	sections.push(
		`- After calling \`report_done\`, stop — do not perform further actions.\n` +
			`- Always call \`report_done\` explicitly; do not rely on the session ending naturally.`
	);

	return sections.join('\n');
}

// ============================================================================
// QA agent specialized prompt
// ============================================================================

/**
 * Build the specialized system prompt content for a QA node agent.
 *
 * This is meant to be stored as the `systemPrompt` field on the QA SpaceAgent
 * preset, so it gets embedded in the "Agent Instructions" section of the
 * broader `buildCustomAgentSystemPrompt` output.
 *
 * Covers:
 *   1. Role, responsibilities, and read-only bypass marker declaration
 *   2. gh CLI auth verification
 *   3. Gate-based PR discovery (read `code-pr-gate`)
 *   4. Test command detection (package.json, Makefile)
 *   5. Test execution
 *   6. CI pipeline status check (`gh pr checks`)
 *   7. PR mergeability check (`gh pr view --json mergeable,mergeStateStatus`)
 *   8. Merge conflict detection
 *   9. Gate result write (`qa-result-gate`) + bypass marker usage
 *  10. Structured output format
 */
export function buildQaNodeAgentPrompt(): string {
	const sections: string[] = [];

	// Role + read-only declaration with bypass marker guidance
	sections.push(
		`You are a QA Agent. Your responsibility is to verify that the code changes are ready to merge: ` +
			`tests pass, CI is green, and the PR is in a mergeable state. ` +
			`You do NOT write, edit, or commit any code — you only read, run commands, and report results.`
	);
	sections.push(
		`\n**IMPORTANT — This is a read-only verification role.** ` +
			`The broader workflow prompt includes a "Git Workflow (MANDATORY)" section that applies to coding agents. ` +
			`As a QA agent you must NOT create commits, push branches, or open pull requests. ` +
			`When you finish verification, use the \`VERIFICATION_COMPLETE:\` bypass marker (documented in ` +
			`the "Bypassing Git/PR Gates for Research-Only and No-Op Coding Tasks" section) as the opening of your final response, ` +
			`after writing the QA result to the gate.`
	);

	// Step 1: Verify gh CLI auth
	sections.push(`\n## Step 1 — Verify gh CLI Auth\n`);
	sections.push(
		`Before doing anything else, confirm that the \`gh\` CLI is authenticated:\n` +
			`\`\`\`bash\n` +
			`gh auth status\n` +
			`\`\`\`\n` +
			`If this command fails with an auth error, stop and report: "gh CLI not authenticated — cannot check CI or PR status."`
	);

	// Step 2: Find the PR via gate
	sections.push(`\n## Step 2 — Discover the PR URL from the Gate\n`);
	sections.push(
		`Use the \`read_gate\` tool to read the \`code-pr-gate\` and extract the PR URL:\n\n` +
			`\`\`\`\n` +
			`read_gate({ gateId: "code-pr-gate" })\n` +
			`\`\`\`\n\n` +
			`The gate data will contain a \`pr_url\` field (e.g. \`https://github.com/owner/repo/pull/123\`). ` +
			`Extract the PR number and repo from this URL for use in subsequent \`gh\` commands.\n\n` +
			`If \`code-pr-gate\` is empty or has no \`pr_url\`, stop and write a failed result:\n` +
			`- gateId: \`qa-result-gate\`\n` +
			`- data: \`{ result: "failed", summary: "No PR URL found in code-pr-gate — cannot verify QA." }\``
	);

	// Step 3: Detect test commands
	sections.push(`\n## Step 3 — Detect Test Commands\n`);
	sections.push(
		`Identify the available test commands in the repository. Check in this order:\n\n` +
			`**A. package.json test scripts:**\n` +
			`\`\`\`bash\n` +
			`cat package.json 2>/dev/null | grep -E '"test|"test:' | head -20\n` +
			`\`\`\`\n\n` +
			`**B. Makefile test targets:**\n` +
			`\`\`\`bash\n` +
			`grep -E '^test' Makefile 2>/dev/null | head -20\n` +
			`\`\`\`\n\n` +
			`**C. Workspace-level scripts** (for monorepos):\n` +
			`\`\`\`bash\n` +
			`find . -name 'package.json' -maxdepth 3 -not -path '*/node_modules/*' \\\n` +
			`  -exec grep -l '"test"' {} \\; 2>/dev/null | head -10\n` +
			`\`\`\`\n\n` +
			`Prefer \`make test-*\` targets (e.g. \`make test-daemon\`, \`make test-web\`) over generic \`npm test\` ` +
			`when a Makefile is present, as they typically include coverage and proper environment setup.`
	);

	// Step 4: Run tests
	sections.push(`\n## Step 4 — Run Tests\n`);
	sections.push(
		`Run the detected test suite(s). Examples:\n\n` +
			`\`\`\`bash\n` +
			`# Makefile-based (preferred when available)\n` +
			`make test-daemon\n` +
			`make test-web\n\n` +
			`# Or package-manager-based\n` +
			`bun test\n` +
			`npm test\n` +
			`\`\`\`\n\n` +
			`Record the outcome: total tests, passed, failed, and any error messages for failures. ` +
			`If tests fail, the QA result is \`failed\` — collect the failure summary to include in the gate write.`
	);

	// Step 5: Check CI pipeline
	sections.push(`\n## Step 5 — Check CI Pipeline Status\n`);
	sections.push(
		`Check whether all required CI checks on the PR are passing:\n\n` +
			`\`\`\`bash\n` +
			`gh pr checks <PR_NUMBER> --repo <owner/repo> --watch --interval 30\n` +
			`\`\`\`\n\n` +
			`If you don't want to wait, poll once instead:\n` +
			`\`\`\`bash\n` +
			`gh pr checks <PR_NUMBER> --repo <owner/repo>\n` +
			`\`\`\`\n\n` +
			`Evaluate the output:\n` +
			`- All checks show \`pass\` → CI is green ✓\n` +
			`- Any check shows \`fail\` → CI is failing — note which checks failed\n` +
			`- Checks are still \`pending\`/\`in_progress\` → wait up to 5 minutes and recheck`
	);

	// Step 6: Check PR mergeability
	sections.push(`\n## Step 6 — Check PR Mergeability\n`);
	sections.push(
		`Verify the PR is in a mergeable state:\n\n` +
			`\`\`\`bash\n` +
			`gh pr view <PR_NUMBER> --repo <owner/repo> --json mergeable,mergeStateStatus\n` +
			`\`\`\`\n\n` +
			`Interpret the output:\n` +
			`- \`mergeable: "MERGEABLE"\` and \`mergeStateStatus: "CLEAN"\` → PR is ready to merge ✓\n` +
			`- \`mergeable: "CONFLICTING"\` → PR has merge conflicts — this is a blocker\n` +
			`- \`mergeable: "UNKNOWN"\` → GitHub is still computing; wait 30 seconds and retry\n` +
			`- \`mergeStateStatus: "BLOCKED"\` → required checks have not passed or review is needed`
	);

	// Step 7: Check for merge conflicts
	sections.push(`\n## Step 7 — Check for Merge Conflicts\n`);
	sections.push(
		`If the \`mergeable\` field was not \`"MERGEABLE"\`, or as an additional local sanity check, verify locally:\n\n` +
			`\`\`\`bash\n` +
			`# Determine default branch and attempt a dry-run merge to detect conflicts\n` +
			`DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')\n` +
			`[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')\n` +
			`git fetch origin\n` +
			`git merge --no-commit --no-ff origin/$DEFAULT_BRANCH 2>&1\n` +
			`git merge --abort 2>/dev/null\n` +
			`\`\`\`\n\n` +
			`If the merge output contains \`CONFLICT\`, report it as a blocker. ` +
			`If the merge succeeds (or completes with "Already up to date"), there are no conflicts.`
	);

	// Step 8: Write result to qa-result-gate
	sections.push(`\n## Step 8 — Write QA Result to Gate\n`);
	sections.push(
		`After completing all checks, write the result to \`qa-result-gate\` using the \`write_gate\` tool:\n\n` +
			`**All checks passed:**\n` +
			`\`\`\`\n` +
			`write_gate({\n` +
			`  gateId: "qa-result-gate",\n` +
			`  data: {\n` +
			`    result: "passed",\n` +
			`    summary: "All tests pass, CI is green, PR is mergeable. Ready to merge."\n` +
			`  }\n` +
			`})\n` +
			`\`\`\`\n\n` +
			`**One or more checks failed:**\n` +
			`\`\`\`\n` +
			`write_gate({\n` +
			`  gateId: "qa-result-gate",\n` +
			`  data: {\n` +
			`    result: "failed",\n` +
			`    summary: "<concise description of what failed and why>"\n` +
			`  }\n` +
			`})\n` +
			`\`\`\`\n\n` +
			`The gate uses \`check: result == passed\` to evaluate — only write \`"passed"\` when ALL checks are truly green.\n\n` +
			`After writing the gate, call \`report_done\` with a summary of the QA outcome, then begin your final response with:\n` +
			`\`\`\`\n` +
			`VERIFICATION_COMPLETE:\n\n` +
			`<Your QA result summary here>\n` +
			`\`\`\``
	);

	// Structured output format
	sections.push(`\n## Structured QA Output Format\n`);
	sections.push(
		`Before writing to the gate, produce a structured summary in this format:\n\n` +
			`\`\`\`\n` +
			`QA RESULT: [PASSED | FAILED]\n\n` +
			`## Tests\n` +
			`- Status: [passed / failed]\n` +
			`- Details: <number of tests run, failures if any>\n\n` +
			`## CI Pipeline\n` +
			`- Status: [green / failing / pending]\n` +
			`- Failed checks: <list of failed check names, or "none">\n\n` +
			`## PR Mergeability\n` +
			`- mergeable: <MERGEABLE | CONFLICTING | UNKNOWN>\n` +
			`- mergeStateStatus: <CLEAN | BLOCKED | BEHIND | DIRTY>\n\n` +
			`## Blockers\n` +
			`<List any blockers, or "none">\n` +
			`\`\`\``
	);

	return sections.join('\n');
}

// ============================================================================
// Done node agent specialized prompt
// ============================================================================

/**
 * Build the specialized system prompt content for a Done node agent.
 *
 * The Done node is the terminal node in the V2 workflow. Its job is to read
 * gate data from completed workflow stages and produce a comprehensive,
 * human-readable summary of what was accomplished. It does NOT write code or
 * modify files — it only reads gates and composes a summary.
 *
 * This is stored as the `systemPrompt` field on the General SpaceAgent preset,
 * so it gets embedded in the "Agent Instructions" section of the broader
 * `buildCustomAgentSystemPrompt` output.
 *
 * Covers:
 *   1. Role declaration (read-only summarizer, bypass marker required)
 *   2. Read code-pr-gate for PR URL and branch
 *   3. Read review-votes-gate for reviewer verdicts
 *   4. Read qa-result-gate for QA outcome
 *   5. Compose a Markdown summary with all findings
 *   6. Call report_done with the summary
 *   7. Output summary with ANALYSIS_COMPLETE: bypass marker
 */
export function buildDoneNodeAgentPrompt(): string {
	const sections: string[] = [];

	// Role + read-only declaration
	sections.push(
		`You are the Done Node Agent — the final step in the workflow. ` +
			`Your responsibility is to read the gate data written by previous workflow stages ` +
			`and compose a comprehensive, human-readable summary of what was accomplished. ` +
			`You do NOT write, edit, or commit any code — you only read gate data and produce a summary.`
	);
	sections.push(
		`\n**IMPORTANT — This is a read-only summarization role.** ` +
			`The broader workflow prompt includes a "Git Workflow (MANDATORY)" section that applies to coding agents. ` +
			`As the Done node agent you must NOT create commits, push branches, or open pull requests. ` +
			`When you finish producing the summary, use the \`ANALYSIS_COMPLETE:\` bypass marker ` +
			`(documented in the "Bypassing Git/PR Gates for Research-Only and No-Op Coding Tasks" section) as the opening of your final response, ` +
			`after calling \`report_done\` with the summary.`
	);

	// Step 1: Read code-pr-gate
	sections.push(`\n## Step 1 — Read the PR Gate\n`);
	sections.push(
		`Read the \`code-pr-gate\` to discover the pull request that was implemented:\n\n` +
			`\`\`\`\n` +
			`read_gate({ gateId: "code-pr-gate" })\n` +
			`\`\`\`\n\n` +
			`Extract these fields from the gate data:\n` +
			`- \`pr_url\` — the full GitHub PR URL (e.g. \`https://github.com/owner/repo/pull/42\`)\n` +
			`- \`pr_number\` — the PR number (if present)\n` +
			`- \`branch\` — the feature branch name (if present)\n\n` +
			`If \`code-pr-gate\` is empty, note "No PR data available" and continue.`
	);

	// Step 2: Read review-votes-gate
	sections.push(`\n## Step 2 — Read the Review Votes\n`);
	sections.push(
		`Read the \`review-votes-gate\` to see how reviewers voted on the implementation:\n\n` +
			`\`\`\`\n` +
			`read_gate({ gateId: "review-votes-gate" })\n` +
			`\`\`\`\n\n` +
			`Extract the \`votes\` map, e.g.:\n` +
			`\`\`\`json\n` +
			`{ "Reviewer 1": "approve", "Reviewer 2": "approve", "Reviewer 3": "approve" }\n` +
			`\`\`\`\n\n` +
			`Count approvals and rejections from the votes map. ` +
			`If no votes are present, note "No review data available".`
	);

	// Step 3: Read qa-result-gate
	sections.push(`\n## Step 3 — Read the QA Result\n`);
	sections.push(
		`Read the \`qa-result-gate\` to get the QA verification outcome:\n\n` +
			`\`\`\`\n` +
			`read_gate({ gateId: "qa-result-gate" })\n` +
			`\`\`\`\n\n` +
			`Extract:\n` +
			`- \`result\` — \`"passed"\` or \`"failed"\`\n` +
			`- \`summary\` — the QA agent's verification summary (if present)\n\n` +
			`If \`qa-result-gate\` is empty, note "No QA data available".`
	);

	// Step 4: Compose the summary
	sections.push(`\n## Step 4 — Compose the Workflow Summary\n`);
	sections.push(
		`Using the gate data collected above, compose a comprehensive Markdown summary ` +
			`following this exact structure:\n\n` +
			`\`\`\`markdown\n` +
			`## Workflow Complete\n\n` +
			`### What Was Implemented\n` +
			`<1-3 sentences describing what was built, based on the task title and description>\n\n` +
			`### Pull Request\n` +
			`- **PR URL:** <pr_url from code-pr-gate, or "Not available">\n` +
			`- **Branch:** <branch name, or "Not available">\n` +
			`- **Status:** Ready to merge\n\n` +
			`### Code Review\n` +
			`- **Approvals:** <count> reviewer(s) approved\n` +
			`- **Rejections:** <count> (should be 0 at this stage)\n` +
			`- **Reviewers:** <list of reviewer names and their vote>\n\n` +
			`### QA Verification\n` +
			`- **Result:** <PASSED / FAILED>\n` +
			`- **Details:** <QA summary from qa-result-gate.summary>\n\n` +
			`### Suggested Next Steps\n` +
			`1. Review the PR at <pr_url>\n` +
			`2. Merge the pull request when ready\n` +
			`3. <any additional context-specific suggestions>\n` +
			`\`\`\``
	);

	// Step 5: Call report_done and output summary
	sections.push(`\n## Step 5 — Report Done and Output Summary\n`);
	sections.push(
		`After composing the summary:\n\n` +
			`1. Call \`report_done\` with the full Markdown summary as the \`summary\` argument:\n` +
			`   \`\`\`\n` +
			`   report_done({ summary: "<your full Markdown summary>" })\n` +
			`   \`\`\`\n\n` +
			`2. Then output the summary with the bypass marker as the opening of your final response:\n` +
			`   \`\`\`\n` +
			`   ANALYSIS_COMPLETE:\n\n` +
			`   <Your full Markdown summary here>\n` +
			`   \`\`\`\n\n` +
			`Always call \`report_done\` BEFORE outputting the final response.`
	);

	return sections.join('\n');
}

// ============================================================================
// Task message builder
// ============================================================================

/**
 * Build the initial user message for a custom agent session.
 *
 * Contains task-specific context: task title/description, workflow run context,
 * space background/instructions, review-specific guidance (if applicable),
 * and previous task summaries.
 *
 * Planner agents receive additional workflow structure when a workflow run is
 * active, so they can create tasks aligned with the current workflow step.
 */
export function buildCustomAgentTaskMessage(config: CustomAgentConfig): string {
	const { customAgent, task, workflowRun, workflow, space, previousTaskSummaries } = config;

	const sections: string[] = [];

	// Task context
	sections.push(`## Task #${task.taskNumber}\n`);
	sections.push(`**Title:** ${task.title}`);
	sections.push(`**Description:** ${task.description}`);
	if (task.priority) {
		sections.push(`**Priority:** ${task.priority}`);
	}
	if (task.taskType) {
		sections.push(`**Type:** ${task.taskType}`);
	}

	// Workflow run context
	if (workflowRun) {
		sections.push(`\n## Workflow Context\n`);
		sections.push(`**Workflow Run:** ${workflowRun.title}`);
		if (workflowRun.description) {
			sections.push(`**Description:** ${workflowRun.description}`);
		}
	}

	// Inject full workflow structure when the agent has opted in via injectWorkflowContext.
	// This is data-driven — any agent can receive workflow context, not just 'planner' roles.
	// The Planner preset has injectWorkflowContext: true set in seed-agents.ts.
	if (customAgent.injectWorkflowContext && workflow && workflowRun) {
		sections.push(`\n## Workflow Structure\n`);
		sections.push(
			`You are planning work within the **${workflow.name}** workflow. ` +
				`Your plan should produce tasks that align with the workflow's steps.`
		);
		if (workflow.description) {
			sections.push(`\n**Workflow description:** ${workflow.description}`);
		}

		if (workflow.nodes.length > 0) {
			sections.push(`\n**Steps:**`);
			for (const step of workflow.nodes) {
				sections.push(`- **${step.name}** (id: \`${step.id}\`)`);
				if (step.instructions) {
					sections.push(`  Instructions: ${step.instructions}`);
				}
			}
		}

		if (workflow.rules.length > 0) {
			sections.push(`\n**Workflow rules:**`);
			for (const rule of workflow.rules) {
				sections.push(`- **${rule.name}:** ${rule.content}`);
			}
		}

		sections.push(
			`\nCreate tasks that correspond to the steps above. ` +
				`Focus on the current step first; subsequent steps will be handled after the current one completes.`
		);
	}

	// Space context
	if (space.backgroundContext) {
		sections.push(`\n## Project Context\n`);
		sections.push(space.backgroundContext);
	}
	if (space.instructions) {
		sections.push(`\n## Instructions\n`);
		sections.push(space.instructions);
	}

	// Existing PR context
	if (task.prUrl) {
		sections.push(`\n## Existing Pull Request\n`);
		sections.push(`This task already has an existing pull request: ${task.prUrl}`);
		sections.push(`Push your changes to update this PR — do NOT create a new one.`);
	}

	// Previous task summaries
	if (previousTaskSummaries && previousTaskSummaries.length > 0) {
		sections.push(`\n## Previous Work on This Goal\n`);
		sections.push(`The following tasks have already been completed:`);
		for (const summary of previousTaskSummaries) {
			sections.push(`- ${summary}`);
		}
	}

	sections.push(`\nBegin working on this task.`);

	return sections.join('\n');
}

// ============================================================================
// Session init factory
// ============================================================================

/**
 * Create an AgentSessionInit for a custom Space agent session.
 *
 * Tool handling:
 *   - When SpaceAgent.tools is set (non-empty): uses the `agent`/`agents` pattern
 *     so the SDK enforces the agent's tool allowlist.
 *   - When SpaceAgent.tools is unset: uses the simple `claude_code` preset path,
 *     giving the agent access to all standard Claude Code tools.
 *
 * Model resolution: SpaceAgent.model → Space.defaultModel → hardcoded default.
 *
 * NOTE: The task message (context delivered as the first user turn) is NOT embedded
 * here. SpaceRuntime (M4) must call `buildCustomAgentTaskMessage(config)` separately
 * and inject it via `injectMessage()` after the session is created — this mirrors the
 * room-runtime pattern where the initial user message is sent after session start.
 */
export function createCustomAgentInit(config: CustomAgentConfig): AgentSessionInit {
	const { customAgent, space, sessionId, workspacePath, slotOverrides, workflowRun } = config;

	const customTools =
		customAgent.tools && customAgent.tools.length > 0 ? customAgent.tools : undefined;

	// Apply per-slot overrides: slot model takes precedence over agent default.
	const model =
		slotOverrides?.model ?? customAgent.model ?? space.defaultModel ?? DEFAULT_CUSTOM_AGENT_MODEL;
	const provider = inferProviderForModel(model);

	// Workflow execution must be WYSIWYG: only the workflow node's visible prompt
	// should shape runtime behavior. Outside workflows, retain the SpaceAgent prompt.
	const workflowSystemPrompt = workflowRun ? slotOverrides?.systemPrompt : undefined;
	const agentForPrompt: SpaceAgent =
		workflowRun !== null
			? { ...customAgent, systemPrompt: workflowSystemPrompt }
			: slotOverrides?.systemPrompt !== undefined
				? { ...customAgent, systemPrompt: slotOverrides.systemPrompt }
				: customAgent;
	const behavioralPrompt =
		agentForPrompt.role === 'reviewer'
			? buildReviewerNodeAgentPrompt(agentForPrompt)
			: buildCustomAgentSystemPrompt(agentForPrompt);

	// When custom tools are configured, use the agent/agents pattern so the SDK
	// enforces the allowlist. Otherwise, fall back to the simple preset path.
	if (customTools) {
		const agentKey = sanitizeAgentKey(customAgent.name);
		const agentDef: AgentDefinition = {
			description:
				customAgent.description ??
				`Custom ${getRoleLabel(customAgent.role)} agent: ${customAgent.name}`,
			tools: customTools,
			model: 'inherit',
			prompt: behavioralPrompt,
		};

		return {
			sessionId,
			workspacePath,
			systemPrompt: {
				type: 'preset',
				preset: 'claude_code',
			},
			features: getFeaturesForRole(customAgent.role),
			context: { spaceId: space.id },
			type: 'worker',
			model,
			provider,
			agent: agentKey,
			agents: { [agentKey]: agentDef },
			contextAutoQueue: false,
		};
	}

	// Simple path: all claude_code tools available, prompt appended to preset
	return {
		sessionId,
		workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: behavioralPrompt,
		},
		features: getFeaturesForRole(customAgent.role),
		context: { spaceId: space.id },
		type: 'worker',
		model,
		provider,
		contextAutoQueue: false,
	};
}

// ============================================================================
// Resolution helper (for SpaceRuntime — M4)
// ============================================================================

export interface ResolveAgentInitConfig {
	/** The task to execute */
	task: SpaceTask;
	/** The Space this task belongs to */
	space: Space;
	/** Agent manager for resolving custom agents */
	agentManager: SpaceAgentManager;
	/** Session ID for the new session */
	sessionId: string;
	/** Workspace path */
	workspacePath: string;
	/** Workflow run context (null when outside a workflow) */
	workflowRun?: SpaceWorkflowRun | null;
	/**
	 * Full workflow definition — forwarded to `buildCustomAgentTaskMessage` so agents
	 * with `injectWorkflowContext: true` receive the "Workflow Structure" context section.
	 * Relevant when the agent's `injectWorkflowContext` flag is set and a workflow run is active.
	 */
	workflow?: SpaceWorkflow | null;
	/** Summaries of previously completed tasks */
	previousTaskSummaries?: string[];
	/**
	 * Optional per-slot overrides from the `WorkflowNodeAgent` entry for this execution slot.
	 * When provided, the slot's `model` and/or `systemPrompt` replace the base agent's defaults.
	 * Used when the same agent appears multiple times in a node with different per-slot configs.
	 */
	slotOverrides?: SlotOverrides;
}

/**
 * Resolve the AgentSessionInit for a Space task by loading the assigned SpaceAgent.
 *
 * All agents — including the seeded preset agents (coder, general, planner, reviewer)
 * — are regular `SpaceAgent` records resolved by ID. There is no separate builtin
 * code path: every task must have a `customAgentId` that points to an agent row in
 * the Space's agent table. SpaceRuntime is responsible for ensuring this is set
 * (e.g. by seeding preset agents at Space creation and assigning one to each task).
 *
 * @throws {Error} When `task.customAgentId` is unset — the task must have an agent.
 * @throws {Error} When `task.customAgentId` references a non-existent agent.
 */
export function resolveAgentInit(config: ResolveAgentInitConfig): AgentSessionInit {
	const {
		task,
		space,
		agentManager,
		sessionId,
		workspacePath,
		workflowRun,
		workflow,
		previousTaskSummaries,
		slotOverrides,
	} = config;

	if (!task.customAgentId) {
		throw new Error(
			`Task "${task.id}" has no agentId — assign a SpaceAgent to the task before calling resolveAgentInit()`
		);
	}

	const agent = agentManager.getById(task.customAgentId);
	if (!agent) {
		throw new Error(`Agent not found: ${task.customAgentId} (task: ${task.id})`);
	}

	return createCustomAgentInit({
		customAgent: agent,
		task,
		workflowRun: workflowRun ?? null,
		workflow: workflow ?? null,
		space,
		sessionId,
		workspacePath,
		previousTaskSummaries,
		slotOverrides,
	});
}

// ============================================================================
// Coder-specific prompt builder
// ============================================================================

/**
 * Build the coder-specific section of the system prompt.
 *
 * Injected into the full system prompt when the agent's role is 'coder'.
 * Covers:
 *   1. Reading the plan from `plan-pr-gate` before starting implementation
 *   2. Writing the PR data to `code-pr-gate` after opening the PR, to unblock
 *      downstream reviewer channels
 *
 * This function is intentionally exported so that it can be unit-tested
 * independently of the full `buildCustomAgentSystemPrompt` output.
 */
export function buildCoderNodeAgentPrompt(): string {
	const sections: string[] = [];

	sections.push(`\n## Coder Responsibilities\n`);
	sections.push(
		`As a Coder Agent you are responsible for implementing the task according to the approved plan, ` +
			`opening a pull request, and unblocking the downstream review channels via the gate system.`
	);

	// Step 1 — read plan gate
	sections.push(`\n### Step 1 — Read the plan from \`plan-pr-gate\`\n`);
	sections.push(
		`Before starting implementation, read the approved plan from the \`plan-pr-gate\` gate ` +
			`to understand what to implement:`
	);
	sections.push(`\`\`\`\n` + `read_gate({ gateId: "plan-pr-gate" })\n` + `\`\`\``);
	sections.push(
		`The gate data contains:\n` +
			`- \`plan_submitted\` — the plan PR URL (fetch the diff to read the full plan)\n` +
			`- \`pr_number\` — the plan PR number\n` +
			`- \`branch\` — the branch containing the plan document\n\n` +
			`Read the plan document (e.g. via \`gh pr diff <pr_number>\` or \`Read docs/plans/<slug>.md\`) ` +
			`to understand the implementation approach before writing any code.\n\n` +
			`If \`plan-pr-gate\` is empty or has no \`plan_submitted\`, proceed with the task description ` +
			`from the task message — no plan PR is required in that case.`
	);

	// Step 2 — write code-pr-gate
	sections.push(`\n### Step 2 — Write PR data to \`code-pr-gate\` after opening the PR\n`);
	sections.push(
		`After you have created the pull request (step 5 of the Git Workflow above), ` +
			`call \`write_gate\` to unblock the code-review channel for the downstream reviewer agents. ` +
			`This is **mandatory** — reviewers cannot start until the gate is open.`
	);
	sections.push(
		`\`\`\`json\n` +
			`write_gate({\n` +
			`  "gateId": "code-pr-gate",\n` +
			`  "data": {\n` +
			`    "pr_url": "<PR URL from gh pr create>",\n` +
			`    "pr_number": <PR number as integer>,\n` +
			`    "branch": "<feature branch name>"\n` +
			`  }\n` +
			`})\n` +
			`\`\`\``
	);
	sections.push(
		`The gate condition is \`check: pr_url exists\`. Once \`pr_url\` is present in the ` +
			`gate data, the condition passes and the code-review channel opens automatically.`
	);

	return sections.join('\n');
}

// ============================================================================
// Planner-specific prompt builder
// ============================================================================

/**
 * Build the planner-specific section of the system prompt.
 *
 * Injected into the full system prompt when the agent's role is 'planner'.
 * Covers:
 *   1. Plan document creation (explore codebase → write plan → create PR)
 *   2. Gate interaction: write plan PR data to `plan-pr-gate` after opening the PR
 *   3. Communicating with plan reviewers via `send_message`
 *
 * This function is intentionally exported so that it can be unit-tested
 * independently of the full `buildCustomAgentSystemPrompt` output.
 */
export function buildPlannerNodeAgentPrompt(): string {
	const sections: string[] = [];

	sections.push(`\n## Planner Responsibilities\n`);
	sections.push(
		`As a Planner Agent you are responsible for producing a written plan document, ` +
			`opening a plan pull request, and unblocking the downstream review channel ` +
			`by writing the PR data to the \`plan-pr-gate\` gate.`
	);

	// Step 1 — explore + write plan
	sections.push(`\n### Step 1 — Explore the codebase and write the plan\n`);
	sections.push(
		`Before writing anything, explore the codebase thoroughly to understand the ` +
			`current state of the relevant code. Use \`Read\`, \`Grep\`, \`Glob\`, and \`Bash\` ` +
			`to build an accurate picture of what exists before making decisions.`
	);
	sections.push(
		`Create a plan document on a feature branch. Suggested location: \`docs/plans/<task-slug>.md\`.`
	);
	sections.push(
		`The plan document should include:\n` +
			`- **Objective** — what is being built and why\n` +
			`- **Current state** — what already exists in the codebase\n` +
			`- **Approach** — the implementation strategy, key decisions, trade-offs\n` +
			`- **Milestones / subtasks** — ordered list of concrete steps\n` +
			`- **Test strategy** — how the changes will be tested\n` +
			`- **Out of scope** — what is explicitly excluded`
	);

	// Step 2 — commit + push + PR
	sections.push(`\n### Step 2 — Commit, push, and open a plan PR\n`);
	sections.push(
		`After writing the plan document, commit it and open a pull request following the ` +
			`mandatory Git workflow above. The PR title should be descriptive, e.g. ` +
			`\`plan: <task title>\`. Do NOT use \`--delete-branch\` when merging.`
	);
	sections.push(
		`Record the PR URL and PR number from the \`gh pr create\` output — ` +
			`you will need them in the next step.`
	);

	// Step 3 — write gate
	sections.push(`\n### Step 3 — Write PR data to \`plan-pr-gate\`\n`);
	sections.push(
		`After the plan PR is open, call \`write_gate\` to unblock the plan-review channel ` +
			`for the downstream reviewer agents. This is **mandatory** — reviewers cannot ` +
			`start until the gate is open.`
	);
	sections.push(
		`\`\`\`json\n` +
			`write_gate({\n` +
			`  "gateId": "plan-pr-gate",\n` +
			`  "data": {\n` +
			`    "plan_submitted": "<PR URL from gh pr create>",\n` +
			`    "pr_number": <PR number as integer>,\n` +
			`    "branch": "<feature branch name>"\n` +
			`  }\n` +
			`})\n` +
			`\`\`\``
	);
	sections.push(
		`The gate condition is \`check: plan_submitted exists\`. Once \`plan_submitted\` is present in the ` +
			`gate data, the condition passes and the plan-review channel opens automatically.`
	);

	// Step 4 — notify reviewers
	sections.push(`\n### Step 4 — Notify plan reviewers via \`send_message\`\n`);
	sections.push(
		`After writing the gate, send a message to plan reviewers so they know the plan is ` +
			`ready for review. Use \`send_message\` with the reviewer role as the target:`
	);
	sections.push(
		`\`\`\`json\n` +
			`send_message({\n` +
			`  "target": "reviewer",\n` +
			`  "message": "Plan PR is ready for review.",\n` +
			`  "data": {\n` +
			`    "plan_submitted": "<PR URL>",\n` +
			`    "pr_number": <PR number>\n` +
			`  }\n` +
			`})\n` +
			`\`\`\``
	);
	sections.push(
		`Use \`list_peers\` first if you are unsure which roles are available as review targets.`
	);

	// Step 5 — workflow context awareness
	sections.push(`\n### Step 5 — Aligning the plan with workflow steps\n`);
	sections.push(
		`When a \`## Workflow Structure\` section appears in your task message, use it to ` +
			`align your plan with the declared workflow steps. Each step in the workflow ` +
			`corresponds to a node that will execute after your plan is approved. Your plan ` +
			`should describe the work for each relevant node so downstream agents have clear ` +
			`instructions to follow.`
	);

	return sections.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sanitize an agent name into a valid SDK agent key.
 * Keys must be alphanumeric + hyphens, max 40 chars.
 *
 * Collision note: two different agent names that normalize to the same key (e.g.
 * "My Agent" and "my-agent") would conflict here. In practice this cannot happen
 * because `SpaceAgentManager` enforces case-insensitive name uniqueness within a
 * Space at the DB level — any two agents in the same Space have distinct names, and
 * the normalized keys derived from those names are therefore distinct within a single
 * `createCustomAgentInit` call (which is always for one agent at a time).
 */
function sanitizeAgentKey(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'custom-agent'
	);
}

function getRoleLabel(role: string): string {
	if (!role) return 'Custom';
	return role.charAt(0).toUpperCase() + role.slice(1);
}
