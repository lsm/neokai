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
 *   1. Role and responsibilities
 *   2. gh CLI auth verification
 *   3. Gate-based PR discovery (read `code-pr-gate`)
 *   4. Test command detection (package.json, Makefile)
 *   5. Test execution
 *   6. CI pipeline status check (`gh pr checks`)
 *   7. PR mergeability check (`gh pr view --json mergeable,mergeStateStatus`)
 *   8. Merge conflict detection
 *   9. Gate result write (`qa-result-gate`)
 *  10. Structured output format
 */
export function buildQaNodeAgentPrompt(): string {
	const sections: string[] = [];

	sections.push(
		`You are a QA Agent. Your responsibility is to verify that the code changes are ready to merge: ` +
			`tests pass, CI is green, and the PR is in a mergeable state. ` +
			`You do NOT modify code — if you find problems, report them so the coder can fix them.`
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
			`The gate data will contain a \`prUrl\` field (e.g. \`https://github.com/owner/repo/pull/123\`). ` +
			`Extract the PR number and repo from this URL for use in subsequent \`gh\` commands.\n\n` +
			`If \`code-pr-gate\` is empty or has no \`prUrl\`, stop and write a failed result:\n` +
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
			`# Check if the current branch has conflicts with the base branch\n` +
			`git fetch origin\n` +
			`git merge-tree $(git merge-base HEAD origin/HEAD) HEAD origin/HEAD | grep -c '^+<<<<<<' || echo "0 conflicts"\n` +
			`\`\`\`\n\n` +
			`Any merge conflict markers found → report as blocker.`
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
			`The gate uses \`check: result == passed\` to evaluate — only write \`"passed"\` when ALL checks are truly green. ` +
			`After writing the gate, call \`report_done\` with a summary of the QA outcome.`
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
	const behavioralPrompt = buildCustomAgentSystemPrompt(agentForPrompt);

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
			`    "prUrl": "<PR URL from gh pr create>",\n` +
			`    "prNumber": <PR number as integer>,\n` +
			`    "branch": "<feature branch name>"\n` +
			`  }\n` +
			`})\n` +
			`\`\`\``
	);
	sections.push(
		`The gate condition is \`check: prUrl exists\`. Once \`prUrl\` is present in the ` +
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
			`    "prUrl": "<PR URL>",\n` +
			`    "prNumber": <PR number>\n` +
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
