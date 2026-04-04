/**
 * Coder Agent Factory - Creates AgentSessionInit for Coder (worker) sessions
 *
 * The Coder agent is the implementation worker in a session group. It receives a task
 * with context from the goal and room, then works using standard coding tools
 * (bash, edit, read, write, glob, grep) until it reaches a terminal state.
 *
 * The Coder always uses the agent/agents pattern with built-in sub-agents:
 * - coder-explorer: read-only codebase exploration before implementation
 * - coder-tester: writes and runs tests for changes just implemented
 *
 * When worker sub-agents are additionally configured via room.config.agentSubagents.worker,
 * those helpers are also included in the agents map for delegating heavy subtasks.
 */

import type { AgentSessionInit } from '../../agent/agent-session';
import type {
	Room,
	RoomGoal,
	NeoTask,
	SessionFeatures,
	AgentDefinition,
	SubagentConfig,
} from '@neokai/shared';

const DEFAULT_CODER_MODEL = 'claude-sonnet-4-5-20250929';

const CODER_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export interface CoderAgentConfig {
	task: NeoTask;
	goal: RoomGoal | null;
	room: Room;
	sessionId: string;
	workspacePath: string;
	model?: string;
	/** Provider ID for this session — auto-detected from model if omitted */
	provider?: string;
	/** Summaries of previously completed tasks in the same goal */
	previousTaskSummaries?: string[];
}

/**
 * Read worker sub-agent configs from room config.
 * Path: room.config.agentSubagents.worker
 */
export function getWorkerSubagents(
	roomConfig: Record<string, unknown>
): SubagentConfig[] | undefined {
	const agentSubagents = roomConfig.agentSubagents as Record<string, SubagentConfig[]> | undefined;
	if (agentSubagents?.worker && agentSubagents.worker.length > 0) {
		return agentSubagents.worker;
	}
	return undefined;
}

/**
 * Derive a short agent model tier from a model ID for the SDK.
 * SDK accepts: 'sonnet' | 'opus' | 'haiku' | 'inherit'
 */
function toHelperAgentModel(modelId: string): AgentDefinition['model'] {
	const lower = modelId.toLowerCase();
	if (lower.includes('opus')) return 'opus';
	if (lower.includes('haiku')) return 'haiku';
	if (lower.includes('sonnet')) return 'sonnet';
	return 'sonnet';
}

/**
 * Resolve the full model ID from a sub-agent config.
 */
function resolveHelperModelId(config: SubagentConfig): string {
	if (config.modelId) return config.modelId;
	const m = config.model.toLowerCase();
	if (m === 'opus') return 'claude-opus-4-6';
	if (m === 'sonnet') return 'claude-sonnet-4-6';
	if (m === 'haiku') return 'claude-haiku-4-5';
	return config.model;
}

/**
 * Build the system prompt for a worker helper sub-agent.
 *
 * Helper agents are spawned by the main Coder agent to handle heavy subtasks.
 * They work autonomously and return a concise result summary. They do NOT
 * create new PRs — they commit to the current branch and return a summary.
 */
export function buildCoderHelperAgentPrompt(): string {
	return `You are a Worker Helper Agent spawned by the main Coder Agent to handle a specific subtask.

Your job is to complete the delegated task and return a concise result summary.

## Rules

1. **Complete the task autonomously** — work thoroughly but focused
2. **Commit any file changes** to the current branch (do NOT create new PRs or new branches)
3. **Return a concise summary** — include: what you did, which files changed, and the outcome
4. **Do not scope-creep** — only do what the task explicitly asks
5. **No sub-agents** — you are a helper; do not spawn further sub-agents

## Summary Format

End your response with a structured summary:

---SUBTASK_RESULT---
status: success | partial | failed
files_changed: <comma-separated list, or "none">
summary: <1-3 sentence description of what was done and the result>
---END_SUBTASK_RESULT---
`;
}

/**
 * Build the AgentDefinition for the built-in Tester sub-agent.
 *
 * The Tester is automatically included whenever the Coder is in agent/agents mode.
 * It writes and runs tests for the work just implemented, then commits test files.
 */
export function buildTesterAgentDef(): AgentDefinition {
	return {
		description:
			'Test writer and runner. Spawned by the Coder after implementing changes to write and execute tests against the new code.',
		tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
		model: 'inherit',
		prompt: `You are a Tester Agent spawned by the main Coder Agent to write and run tests for recently implemented changes.

Your job is to ensure the implementation is correctly tested and return a concise result summary.

## Rules

1. **Understand what was implemented** — read the prompt carefully; explore the changed files
2. **Write tests** — create or update test files covering the new behavior and edge cases
3. **Run the tests** — execute them and fix any failures you introduced
4. **Commit test files** to the current branch (do NOT create new PRs or new branches)
5. **Do not modify implementation files** — only write tests; if you find a bug, report it in your summary
6. **No sub-agents** — do not spawn further sub-agents

## Summary Format

End your response with a structured summary:

---TEST_RESULT---
status: pass | fail | partial
tests_written: <count or brief description>
tests_run: <count>
failures: <list of failing tests, or "none">
summary: <1-3 sentence description of what was tested and the outcome>
---END_TEST_RESULT---
`,
	};
}

/**
 * Build the AgentDefinition for the built-in Explorer sub-agent.
 *
 * The Explorer is a read-only codebase exploration agent automatically included
 * whenever the Coder is in agent/agents mode. It uses Grep/Glob/Read/Bash to
 * explore the codebase and returns structured findings about file paths, patterns,
 * dependencies, and architecture.
 *
 * The Explorer MUST NOT modify files and MUST NOT spawn further sub-agents.
 */
export function buildCoderExplorerAgentDef(): AgentDefinition {
	return {
		description:
			'Read-only codebase explorer. Spawned by the Coder to gather structured findings about file paths, patterns, dependencies, and architecture before implementation.',
		tools: ['Read', 'Grep', 'Glob', 'Bash'],
		model: 'inherit',
		prompt: `You are an Explorer Agent spawned by the main Coder Agent to explore the codebase and return structured findings.

Your job is to gather accurate, focused information about the codebase and return it in a structured format.

## Rules

1. **Read-only** — you MUST NOT create, edit, or delete any files. No Write, Edit, or file-mutating Bash commands (no rm, mv, cp to new paths, git commit, etc.)
2. **No sub-agents** — you MUST NOT spawn further sub-agents. Do not use the Task tool.
3. **Focused exploration** — explore only what is relevant to the question asked; do not wander
4. **Concise summary** — return findings in the structured format below; omit irrelevant detail
5. **Bash for read-only operations only** — e.g., \`git log\`, \`git grep\`, \`wc -l\`, listing directory contents

## Output Format

End your response with a structured result block:

---EXPLORE_RESULT---
relevant_files: <comma-separated list of file paths most relevant to the task>
patterns: <key patterns, conventions, or idioms observed (e.g., "uses Hono router", "signals for state")>
dependencies: <relevant imports, external packages, or internal modules involved>
architecture_notes: <brief description of how the relevant area is structured>
findings: <1-5 sentences summarizing what you found and what the Coder should know before implementing>
---END_EXPLORE_RESULT---
`,
	};
}

/**
 * Build the AgentDefinition map for worker helper sub-agents.
 * Returns a map of helper name to AgentDefinition.
 */
export function buildWorkerHelperAgents(
	helpers: SubagentConfig[]
): Record<string, AgentDefinition> {
	const agents: Record<string, AgentDefinition> = {};
	const usedNames = new Set<string>();

	for (const helper of helpers) {
		// Build a short unique name
		const baseName =
			helper.name ??
			helper.model
				.toLowerCase()
				.replace(/[^a-z0-9]/g, '-')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 20);
		let name = `helper-${baseName}`;
		let counter = 2;
		while (usedNames.has(name)) {
			name = `helper-${baseName}-${counter}`;
			counter++;
		}
		usedNames.add(name);

		const modelId = resolveHelperModelId(helper);
		const provider = helper.provider ?? 'anthropic';
		const description =
			helper.description ??
			`Worker helper agent using ${modelId} (${provider}). Handles delegated subtasks to keep the main agent context clean.`;

		agents[name] = {
			description,
			// Helpers have full coding tools but NOT Task (no recursive sub-agents)
			tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
			model: toHelperAgentModel(modelId),
			prompt: buildCoderHelperAgentPrompt(),
		};
	}

	return agents;
}

/**
 * Build the behavioral system prompt for the Coder agent.
 *
 * Contains ONLY role definition, git workflow instructions, behavioral rules,
 * and sub-agent usage guidance. Task-specific context (title, description, goal,
 * room background) is delivered via the initial user message built by
 * buildCoderTaskMessage().
 *
 * The prompt always includes sub-agent usage instructions since the Coder always
 * operates in agent/agents mode with built-in coder-explorer and coder-tester.
 *
 * @param customHelperNames - Names of user-configured helper sub-agents. When
 *   provided, the prompt includes an additional section listing those helpers.
 */
export function buildCoderSystemPrompt(customHelperNames?: string[]): string {
	const sections: string[] = [];
	const hasCustomHelpers = customHelperNames && customHelperNames.length > 0;

	sections.push(`You are a Coder Agent working on a specific task within a larger goal.`);
	sections.push(`Your job is to complete the task described below to the best of your ability.`);
	sections.push(`Work carefully and thoroughly. When you are done, simply finish your response.`);

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
		`**IMPORTANT**: Do NOT commit directly to the main/dev branch. ` +
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

	// Sub-agent usage instructions — always present since Coder always uses agent/agents mode
	sections.push(`\n## Sub-Agent Usage\n`);
	sections.push(
		`Sub-agents are available to handle exploration, testing, and heavy subtasks. ` +
			`Choose your strategy based on task complexity:`
	);

	// Task complexity strategy guidance
	sections.push(`\n### Strategy by Task Complexity\n`);
	sections.push(
		`**Simple tasks** (single file, well-scoped — e.g., "fix typo in error message", "add a CSS class to button component"):\n` +
			`→ Implement directly without spawning sub-agents. No exploration needed.`
	);
	sections.push(
		`**Complex tasks** (touches 3-8 files across 1-2 packages — e.g., "add validation to the settings form", "refactor session cleanup logic"):\n` +
			`→ Spawn \`coder-explorer\` first to understand the code structure, then implement with clean context.`
	);
	sections.push(
		`**Large multi-component tasks** (spans multiple packages, 8+ files — e.g., "add WebSocket reconnection with exponential backoff", "implement new RPC handler with frontend integration"):\n` +
			`→ Delegate exploration and implementation subtasks to sub-agents, then review and integrate results.`
	);

	// Built-in: coder-tester
	sections.push(`\n### Built-in: \`coder-tester\``);
	sections.push(`Writes and runs tests for changes you just implemented.`);
	sections.push(
		`**Spawn after implementation** — before committing, run the tester to cover new code:`
	);
	sections.push(
		`\`\`\`\nTask(subagent_type: "coder-tester", prompt: "Just implemented: <summary of changes>. Write and run tests for: <specific targets>.")\n\`\`\``
	);
	sections.push(
		`The tester commits test files to the current branch and returns a \`---TEST_RESULT---\` block.`
	);

	// Built-in: coder-explorer
	sections.push(`\n### Built-in: \`coder-explorer\``);
	sections.push(
		`Read-only codebase exploration. Use before implementing complex or unfamiliar changes.`
	);
	sections.push(`**Spawn before implementation** when you need to understand the codebase:`);
	sections.push(
		`\`\`\`\nTask(subagent_type: "coder-explorer", prompt: "Explore <area/pattern/file> to understand <what you need to know>.")\n\`\`\``
	);
	sections.push(
		`The explorer returns an \`---EXPLORE_RESULT---\` block with relevant files, patterns, dependencies, and findings.`
	);
	sections.push(
		`**Do not spawn coder-explorer for simple single-file tasks** — only for complex or unfamiliar areas.`
	);

	// Custom helpers (if configured)
	if (hasCustomHelpers) {
		const helperList = customHelperNames!.join(', ');
		sections.push(`\n### Custom helpers: ${helperList}`);
		sections.push(`**Spawn helpers for:**`);
		sections.push(`- Analyzing large files (>500 lines) or many files at once`);
		sections.push(
			`- Implementing isolated components (e.g., a single module of a multi-file feature)`
		);
		sections.push(`- Verbose git operations (e.g., comparing large diffs)`);
		sections.push(
			`\`\`\`\nTask(subagent_type: "<helper-name>", prompt: "Specific task with all necessary context")\n\`\`\``
		);
		sections.push(
			`The helper commits changes to the current branch and returns a \`---SUBTASK_RESULT---\` block.`
		);
	}

	sections.push(
		`\nStore only the result summary — do NOT re-read every file the sub-agent touched.`
	);
	sections.push(`**Limit:** max 3 concurrent sub-agents per turn.`);

	return sections.join('\n');
}

/**
 * Build the initial user message for the Coder agent.
 *
 * Contains task-specific context: task title/description, goal context,
 * project background, room instructions, and previous task summaries.
 * This is what the user sees in the UI as the agent's starting prompt.
 */
export function buildCoderTaskMessage(config: CoderAgentConfig): string {
	const { task, goal, room, previousTaskSummaries } = config;

	const sections: string[] = [];

	// Task context
	sections.push(`## Task\n`);
	sections.push(`**Title:** ${task.title}`);
	sections.push(`**Description:** ${task.description}`);
	if (task.priority) {
		sections.push(`**Priority:** ${task.priority}`);
	}

	// Goal context (only if a goal is linked)
	if (goal) {
		sections.push(`\n## Goal Context\n`);
		sections.push(`**Goal:** ${goal.title}`);
		if (goal.description) {
			sections.push(`**Description:** ${goal.description}`);
		}
	}

	// Room context
	if (room.background) {
		sections.push(`\n## Project Context\n`);
		sections.push(room.background);
	}
	if (room.instructions) {
		sections.push(`\n## Instructions\n`);
		sections.push(room.instructions);
	}

	// Existing PR context (when task already has a PR from a previous iteration)
	if (task.prUrl) {
		sections.push(`\n## Existing Pull Request\n`);
		sections.push(`This task already has an existing pull request: ${task.prUrl}`);
		sections.push(`Push your changes to update this PR — do NOT create a new one.`);
	}

	// Previous task summaries
	if (previousTaskSummaries && previousTaskSummaries.length > 0) {
		sections.push(`\n## Previous Work on This Goal\n`);
		sections.push(`The following tasks have already been completed for this goal:`);
		for (const summary of previousTaskSummaries) {
			sections.push(`- ${summary}`);
		}
	}

	sections.push(`\nBegin working on this task.`);

	return sections.join('\n');
}

/**
 * Create an AgentSessionInit for a Coder agent session.
 *
 * Always uses the agent/agents pattern so the Coder has access to
 * Task/TaskOutput/TaskStop tools for spawning the built-in coder-explorer
 * and coder-tester sub-agents (and any user-configured helpers).
 *
 * The system prompt is embedded in the Coder agent definition's `prompt` field.
 * Task-specific context is delivered via the initial user message
 * (buildCoderTaskMessage).
 *
 * Note: name collisions between user helpers and built-ins cannot occur because
 * `buildWorkerHelperAgents` always prefixes helper names with `helper-`, so
 * generated keys like `helper-haiku` can never equal `coder-explorer` or
 * `coder-tester`. The spread order (built-ins then helpers) is an additional
 * safeguard that would prevent overwriting even if that invariant changed.
 */
export function createCoderAgentInit(config: CoderAgentConfig): AgentSessionInit {
	const roomConfig = config.room.config ?? {};
	const workerSubagents = getWorkerSubagents(roomConfig);
	const helperAgents = workerSubagents ? buildWorkerHelperAgents(workerSubagents) : {};

	const customHelperNames =
		Object.keys(helperAgents).length > 0 ? Object.keys(helperAgents) : undefined;

	const coderAgentDef: AgentDefinition = {
		description:
			'Implementation agent that writes code, runs tests, and creates PRs. Uses built-in coder-explorer and coder-tester sub-agents for complex tasks.',
		prompt: buildCoderSystemPrompt(customHelperNames),
		// Coder has all Claude Code tools plus Task/TaskOutput/TaskStop for spawning sub-agents
		tools: [
			'Task',
			'TaskOutput',
			'TaskStop',
			'Read',
			'Write',
			'Edit',
			'Bash',
			'Grep',
			'Glob',
			'WebFetch',
			'WebSearch',
		],
		model: 'inherit',
	};

	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
		},
		features: CODER_FEATURES,
		context: { roomId: config.room.id },
		type: 'coder',
		model: config.model ?? DEFAULT_CODER_MODEL,
		provider: config.provider,
		agent: 'Coder',
		agents: {
			Coder: coderAgentDef,
			'coder-explorer': buildCoderExplorerAgentDef(),
			'coder-tester': buildTesterAgentDef(),
			...helperAgents,
		},
		contextAutoQueue: false,
	};
}
