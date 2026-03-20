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
	SessionFeatures,
	AgentDefinition,
} from '@neokai/shared';
import type { SpaceAgentManager } from '../managers/space-agent-manager';

const DEFAULT_CUSTOM_AGENT_MODEL = 'claude-sonnet-4-5-20250929';

const CUSTOM_AGENT_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

// ============================================================================
// Config
// ============================================================================

export interface CustomAgentConfig {
	/** The custom Space agent definition */
	customAgent: SpaceAgent;
	/** The task being executed */
	task: SpaceTask;
	/** The workflow run context (null when running outside a workflow) */
	workflowRun: SpaceWorkflowRun | null;
	/**
	 * Full workflow definition — used to inject workflow structure into the
	 * planner's context so it can create tasks aligned with the current step.
	 * Only relevant when the agent role is 'planner' and a workflow run is active.
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
	sections.push(`## Task\n`);
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
		if (workflowRun.currentStepId) {
			sections.push(`**Current Step ID:** ${workflowRun.currentStepId}`);
		}
	}

	// Planner-specific: inject full workflow structure so the planner can
	// create tasks aligned with the workflow's steps and rules.
	if (customAgent.role === 'planner' && workflow && workflowRun) {
		sections.push(`\n## Workflow Structure\n`);
		sections.push(
			`You are planning work within the **${workflow.name}** workflow. ` +
				`Your plan should produce tasks that align with the workflow's steps.`
		);
		if (workflow.description) {
			sections.push(`\n**Workflow description:** ${workflow.description}`);
		}

		if (workflow.steps.length > 0) {
			sections.push(`\n**Steps:**`);
			for (const step of workflow.steps) {
				const isCurrent = step.id === workflowRun.currentStepId;
				const marker = isCurrent ? ' ← current step' : '';
				sections.push(`- **${step.name}** (id: \`${step.id}\`)${marker}`);
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
	const { customAgent, space, sessionId, workspacePath } = config;

	const customTools =
		customAgent.tools && customAgent.tools.length > 0 ? customAgent.tools : undefined;

	const model = customAgent.model ?? space.defaultModel ?? DEFAULT_CUSTOM_AGENT_MODEL;

	const behavioralPrompt = buildCustomAgentSystemPrompt(customAgent);

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
			features: CUSTOM_AGENT_FEATURES,
			context: { spaceId: space.id },
			type: 'worker',
			model,
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
		features: CUSTOM_AGENT_FEATURES,
		context: { spaceId: space.id },
		type: 'worker',
		model,
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
	 * Full workflow definition — forwarded to `buildCustomAgentTaskMessage` so
	 * planner agents receive the "Workflow Structure" context section.
	 * Required when the agent role is 'planner' and a workflow run is active;
	 * ignored for all other agent roles.
	 */
	workflow?: SpaceWorkflow | null;
	/** Summaries of previously completed tasks */
	previousTaskSummaries?: string[];
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
