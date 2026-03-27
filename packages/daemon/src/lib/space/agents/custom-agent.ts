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

	// Bypass markers for research/verification tasks
	sections.push(`\n## Bypassing Git/PR Gates for Research-Only Tasks\n`);
	sections.push(
		`For **research-only**, **verification-only**, or **investigation-only** tasks that do NOT modify any files, ` +
			`you can bypass the git/PR requirements by starting your final output with one of these markers:`
	);
	sections.push(
		`- \`RESEARCH_ONLY:\` — For pure research tasks (e.g., "Analyze and document X")\n` +
			`- \`VERIFICATION_COMPLETE:\` — For verification tasks (e.g., "Verify Y is correct")\n` +
			`- \`INVESTIGATION_RESULT:\` — For investigation tasks (e.g., "Investigate why Z fails")\n` +
			`- \`ANALYSIS_COMPLETE:\` — For analysis tasks (e.g., "Analyze performance")`
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
		`**Important**: Only use bypass markers when the task genuinely requires NO code changes. ` +
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
 *   3. Review process: find PR URL from gate → read diff → evaluate → post review
 *   4. Severity classification (critical / major / minor)
 *   5. Review posting via GitHub REST API
 *   6. Structured output block (---REVIEW_POSTED---)
 *   7. Gate interaction: read code-pr-gate, write review-votes-gate
 *   8. Edge case: idempotency / re-spawn protection
 *   9. Peer communication
 *  10. Completion signalling
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

	// Review process
	sections.push(`\n## Review Process\n`);
	sections.push(`Follow these steps in order:`);
	sections.push(
		`1. **Find the PR URL** — call \`read_gate\` with \`gateId: "code-pr-gate"\` to retrieve the PR URL from gate data.\n` +
			`   - Expected data shape: \`{ pr: "https://github.com/..." }\`\n` +
			`   - If the gate is empty or \`pr\` is missing, stop and output: \`PR URL not found in code-pr-gate\``
	);
	sections.push(
		`2. **Fetch PR details** — view the PR title, description, and changed files:\n` +
			`   \`\`\`bash\n` +
			`   # Extract owner, repo, and PR number from the URL first\n` +
			`   GH_PAGER=cat gh pr view {pr_number} --repo {owner}/{repo} --json title,body,additions,deletions,files\n` +
			`   \`\`\``
	);
	sections.push(
		`3. **Read the diff** — examine the actual changes:\n` +
			`   \`\`\`bash\n` +
			`   GH_PAGER=cat gh pr diff {pr_number} --repo {owner}/{repo}\n` +
			`   \`\`\``
	);
	sections.push(
		`4. **Evaluate the changes** — assess three dimensions:\n` +
			`   - **Correctness**: Does the code do what it claims? Are there logic errors or missed edge cases?\n` +
			`   - **Completeness**: Are all requirements addressed? Do tests exist and cover the new behavior?\n` +
			`   - **Security**: Are there OWASP-class vulnerabilities (injection, auth bypass, data exposure, etc.)?`
	);
	sections.push(`5. **Post the PR review** — see the "Posting the PR Review" section below.`);
	sections.push(`6. **Write your vote** — see the "Gate Interaction" section below.`);
	sections.push(`7. **Call \`report_done\`** to signal completion.`);

	// Severity classification
	sections.push(`\n## Severity Classification\n`);
	sections.push(`Classify all findings by severity when writing your review body:`);
	sections.push(
		`- **Critical** — security vulnerabilities, data corruption, crash-inducing bugs. Block approval; use \`REQUEST_CHANGES\`.\n` +
			`- **Major** — incorrect behavior, missing test coverage for changed code, logic errors. Block approval; use \`REQUEST_CHANGES\`.\n` +
			`- **Minor** — style issues, non-critical suggestions, nitpicks. Do not block approval; still include in review body.`
	);
	sections.push(`Count each severity level for the structured output block.`);

	// Posting the review
	sections.push(`\n## Posting the PR Review\n`);
	sections.push(
		`Post your review via the GitHub API. Extract \`{owner}\`, \`{repo}\`, and \`{pr_number}\` from the PR URL ` +
			`(e.g., \`https://github.com/owner/repo/pull/42\` → owner=\`owner\`, repo=\`repo\`, pr_number=\`42\`).`
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
		`- Use \`"APPROVE"\` when there are zero critical and zero major issues.\n` +
			`- Use \`"REQUEST_CHANGES"\` when there is one or more critical or major issues.`
	);
	sections.push(
		`The API response JSON contains an \`html_url\` field — capture it for the structured output block.`
	);

	// Structured output
	sections.push(`\n## Structured Output Block\n`);
	sections.push(
		`After posting the review, output the following block **exactly** (no extra whitespace before \`---\`):`
	);
	sections.push(
		`\`\`\`\n` +
			`---REVIEW_POSTED---\n` +
			`{\n` +
			`  "url": "https://github.com/{owner}/{repo}/pull/{pr_number}#pullrequestreview-{review_id}",\n` +
			`  "recommendation": "approve",\n` +
			`  "severityCounts": {\n` +
			`    "critical": 0,\n` +
			`    "major": 0,\n` +
			`    "minor": 0\n` +
			`  }\n` +
			`}\n` +
			`\`\`\``
	);
	sections.push(
		`- \`recommendation\` must be \`"approve"\` or \`"reject"\` (matching your \`event\` field).\n` +
			`- \`url\` must be the \`html_url\` from the GitHub API response.`
	);

	// Gate interaction
	sections.push(`\n## Gate Interaction\n`);
	sections.push(`### Step 1 — Read the PR URL from \`code-pr-gate\`\n`);
	sections.push(
		`Call \`read_gate\` with \`gateId: "code-pr-gate"\`. The response includes a \`nodeId\` field — ` +
			`save this value; you will use it as your vote key.`
	);
	sections.push(`Expected data shape: \`{ pr: "https://github.com/..." }\``);

	sections.push(`\n### Step 2 — Write your vote to \`review-votes-gate\`\n`);
	sections.push(
		`After posting the review, write your vote using the \`nodeId\` you received earlier:`
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
			`Do not wait for the gate to open — write your vote and call \`report_done\`.`
	);

	// Idempotency
	sections.push(`\n## Idempotency — Re-Spawn Protection\n`);
	sections.push(
		`Before writing your vote, verify you have not already voted (you may be re-spawned after a crash):`
	);
	sections.push(
		`1. Call \`read_gate\` with \`gateId: "review-votes-gate"\`.\n` +
			`2. Check whether \`data.votes[nodeId]\` already has a value.\n` +
			`3. **If already voted**: skip the \`write_gate\` call — your vote is already recorded.\n` +
			`4. **If not yet voted**: proceed with \`write_gate\` as described above.`
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
	const { customAgent, space, sessionId, workspacePath, slotOverrides } = config;

	const customTools =
		customAgent.tools && customAgent.tools.length > 0 ? customAgent.tools : undefined;

	// Apply per-slot overrides: slot model takes precedence over agent default.
	const model =
		slotOverrides?.model ?? customAgent.model ?? space.defaultModel ?? DEFAULT_CUSTOM_AGENT_MODEL;
	const provider = inferProviderForModel(model);

	// Apply per-slot systemPrompt override: slot override replaces agent's default system prompt.
	// The override is applied by building the prompt with a modified agent copy.
	const agentForPrompt: SpaceAgent =
		slotOverrides?.systemPrompt !== undefined
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
