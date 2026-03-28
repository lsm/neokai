/**
 * Planner Agent Factory
 *
 * Creates AgentSessionInit for Planner sessions that break goals into tasks.
 *
 * The Planner agent orchestrates two phases within a single session:
 * 1. Plan phase: Runs a 3-stage pipeline to produce plan document(s) on a feature branch/PR:
 *    - Stage 1 (planner-explorer): Read-only codebase exploration, returns ---EXPLORER_FINDINGS---
 *    - Stage 2 (planner-fact-checker): Validates explorer findings via web search, returns ---FACT_CHECK_RESULT---
 *    - Stage 3 (plan-writer): Creates the plan using explorer + fact-checker context
 * 2. Task creation phase: After human approval, merges the PR and creates tasks.
 *
 * The plan-writer sub-agent handles scope assessment and file structure:
 * - Small goals (≤ 5 milestones): single docs/plans/<slug>.md
 * - Large goals (> 5 milestones): multi-file docs/plans/<slug>/ with numbered overview
 *   and per-milestone detail files, produced via an iterative two-pass approach.
 *
 * The create_task/update_task/remove_task tools are gated by a dynamic isPlanApproved
 * check — they become available only after the human approves the plan.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentSessionInit } from '../../agent/agent-session';
import type {
	Room,
	RoomGoal,
	NeoTask,
	SessionFeatures,
	McpServerConfig,
	TaskPriority,
	AgentType,
	AgentDefinition,
} from '@neokai/shared';

const DEFAULT_PLANNER_MODEL = 'claude-sonnet-4-5-20250929';

const PLANNER_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export interface PlannerCreateTaskParams {
	title: string;
	description: string;
	priority?: TaskPriority;
	agent?: AgentType;
	dependsOn?: string[];
}

/** Metric status for measurable mission replanning */
export interface MetricReplanStatus {
	name: string;
	current: number;
	target: number;
	baseline?: number;
	direction?: 'increase' | 'decrease';
	met: boolean;
	/** Recent metric history values (most recent last) */
	recentHistory?: number[];
}

/** Context passed to the planner when replanning after a task failure */
export interface ReplanContext {
	/** Tasks that completed successfully (DO NOT redo) */
	completedTasks: Array<{ title: string; result: string }>;
	/** The task that just failed */
	failedTask: { title: string; error: string };
	/** Planning attempt number (1-indexed) */
	attempt: number;
	/** Optional: metric context for measurable mission replanning */
	metricContext?: {
		metrics: MetricReplanStatus[];
	};
}

export interface PlannerAgentConfig {
	task: NeoTask;
	goal: RoomGoal;
	room: Room;
	sessionId: string;
	workspacePath: string;
	model?: string;
	/** Provider ID for this session — auto-detected from model if omitted */
	provider?: string;
	/** Callback to create a draft task linked to this planning task */
	createDraftTask: (params: PlannerCreateTaskParams) => Promise<{ id: string; title: string }>;
	/** Callback to update an existing draft task */
	updateDraftTask: (
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			priority?: TaskPriority;
			assignedAgent?: AgentType;
		}
	) => Promise<{ id: string; title: string }>;
	/** Callback to remove a draft task */
	removeDraftTask: (taskId: string) => Promise<boolean>;
	/** If set, this is a replanning session with context from previous attempt */
	replanContext?: ReplanContext;
	/** Dynamic check: is the plan approved? Gates create_task/update_task/remove_task tools. */
	isPlanApproved?: () => boolean;
}

/**
 * Derive a slug from goal title for plan file naming.
 * e.g., "Build a stock web app" → "build-a-stock-web-app"
 */
export function toPlanSlug(goalTitle: string): string {
	return goalTitle
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.slice(0, 60)
		.replace(/-$/, '');
}

/**
 * Build the AgentDefinition for the planner-explorer sub-agent.
 *
 * Read-only codebase exploration agent — explores the codebase areas relevant to the goal
 * and returns structured findings. No write tools, no web tools, no sub-agent spawning.
 */
export function buildPlannerExplorerAgentDef(): AgentDefinition {
	return {
		description:
			'Read-only codebase exploration agent. Explores relevant files, patterns, and dependencies, ' +
			'then returns structured findings for the plan-writer to use.',
		tools: ['Read', 'Grep', 'Glob', 'Bash'],
		model: 'inherit',
		prompt: `You are a Codebase Explorer sub-agent. Your sole job is to explore the codebase areas relevant to the given goal and return structured findings.

## Instructions

1. Use Read, Grep, Glob, and Bash (read-only commands only) to explore relevant parts of the codebase.
2. Focus on: file paths, code patterns, existing implementations, dependencies, architecture, and complexity.
3. Do NOT write, edit, or delete any files.
4. Do NOT spawn further sub-agents.
5. Do NOT implement anything — only explore and report.

## Required Output Format

End your response with an \`---EXPLORER_FINDINGS---\` block exactly as shown:

\`\`\`
---EXPLORER_FINDINGS---
## Relevant Files
<list of file paths with brief description of each>

## Patterns Found
<existing code patterns, conventions, and architectural patterns observed>

## Dependencies
<external packages, internal modules, and cross-package dependencies relevant to the goal>

## Estimated Complexity
<assessment: low / medium / high, with brief justification>

## Key Concerns
<potential blockers, gotchas, breaking changes, or areas that need careful attention>
---END_EXPLORER_FINDINGS---
\`\`\``,
	};
}

/**
 * Build the AgentDefinition for the planner-fact-checker sub-agent.
 *
 * Web-based validation agent — receives explorer findings and validates assumptions
 * about external technologies, API versions, library patterns, and flags stale information.
 * Has only WebSearch/WebFetch — no codebase tools, no sub-agent spawning.
 */
export function buildPlannerFactCheckerAgentDef(): AgentDefinition {
	return {
		description:
			'Web research and validation agent. Receives explorer findings and validates assumptions ' +
			'about external technologies, API versions, and library patterns against current documentation.',
		tools: ['WebSearch', 'WebFetch'],
		model: 'inherit',
		prompt: `You are a Fact-Checker sub-agent. You receive codebase explorer findings and validate assumptions about external technologies, APIs, and libraries using web search and documentation.

## Instructions

1. Review the explorer findings provided in the prompt.
2. Use WebSearch to look up current documentation, changelogs, and best practices for any external technologies mentioned.
3. Use WebFetch to retrieve specific documentation pages or release notes when a URL is known.
4. Focus on: API version compatibility, deprecated patterns, breaking changes since the codebase was last updated, and recommended current patterns.
5. Do NOT read any local files — that is the explorer's responsibility.
6. Do NOT spawn further sub-agents.
7. Only search for things that require up-to-date external knowledge — skip general patterns you already know.

## Required Output Format

End your response with a \`---FACT_CHECK_RESULT---\` block exactly as shown:

\`\`\`
---FACT_CHECK_RESULT---
## Validated Assumptions
<list of assumptions from explorer findings that are confirmed correct>

## Flagged Issues
<list of issues found: stale API patterns, deprecated methods, version mismatches, breaking changes>

## Recommended Versions/Patterns
<current recommended versions or patterns for libraries/APIs mentioned in the findings>

## Corrections to Explorer Findings
<any specific corrections or updates to the explorer's findings based on current docs>
---END_FACT_CHECK_RESULT---
\`\`\``,
	};
}

/**
 * Build the system prompt for the Plan Writer sub-agent.
 *
 * The plan-writer explores the codebase using its own tools (Read/Grep/Glob/Bash),
 * assesses scope, and produces plan documents. It does NOT spawn further sub-agents
 * (it is itself a sub-agent and cannot nest further).
 *
 * For large-scope goals it uses an iterative two-pass approach:
 * - Pass 1: Create 00-overview.md with milestones list
 * - Pass 2: Create per-milestone files (NN-<slug>.md) with detailed tasks and subtasks
 *
 * Placeholders (substituted at creation time via buildPlanWriterAgentDef):
 *   <single_plan_path> — e.g., docs/plans/build-stock-app.md
 *   <plan_dir>         — e.g., docs/plans/build-stock-app
 *   <plan_slug>        — e.g., build-stock-app
 */
export function buildPlanWriterPrompt(): string {
	return `You are a Plan Writer Agent spawned by the Planner to produce a structured plan for a goal.

Your task prompt contains the goal title, description, and any room context provided by the Planner. Use your own tools (Read, Grep, Glob, Bash) to explore the codebase directly — do NOT attempt to spawn further sub-agents (you cannot; you are already a sub-agent).

## Pre-Work: Git Sync (MANDATORY)

Before exploring, sync with the default branch — run all three lines as a **single bash invocation**:
\`\`\`bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')
git fetch origin && git rebase origin/$DEFAULT_BRANCH
\`\`\`
**If the rebase fails with conflicts, stop immediately and report the error** — do NOT plan against a stale codebase.

## Step 1: Codebase Exploration

Explore the codebase using Read, Grep, Glob, and Bash to understand existing patterns, affected areas, and dependencies. Focus on areas relevant to the goal. Use WebSearch/WebFetch for targeted external lookups (API versions, breaking changes, community best practices) when external, up-to-date information would improve plan accuracy — not for general patterns you already know.

## Step 2: Scope Assessment

Based on your exploration, determine the plan structure:
- **Small scope** (≤ 5 milestones, ≤ 15 total tasks) → Single file: \`<single_plan_path>\`
- **Large scope** (> 5 milestones OR > 15 total tasks) → Multi-file folder: \`<plan_dir>/\`

## Step 3: Writing the Plan

### Small Scope — Single File

Write \`<single_plan_path>\` with:
- Goal summary and approach
- Ordered tasks with: title, description, subtasks (ordered implementation steps), acceptance criteria, dependencies on other tasks, agent type (coder/general)
- For coding tasks always include: "Changes must be on a feature branch with a GitHub PR created via \`gh pr create\`"

### Large Scope — Multi-File (Two-Pass Iterative Approach)

**Pass 1 — Create the overview first:**
Write \`<plan_dir>/00-overview.md\`:
- Goal summary and high-level approach
- Numbered milestones list (one line each with brief description)
- Cross-milestone dependencies and key sequencing decisions
- Total estimated task count

**Pass 2 — Create per-milestone detail files:**
For each milestone \`N\`, write \`<plan_dir>/NN-<milestone-slug>.md\` (zero-padded: 01, 02, …):
- Milestone goal and scope
- Ordered tasks — each task maps to ONE coder agent session (keep focused, not too broad)
- Per task: title, description, subtasks (ordered implementation steps within the session), acceptance criteria, depends_on (list of task titles from this or earlier milestones), agent type
- For coding tasks always include: "Changes must be on a feature branch with a GitHub PR created via \`gh pr create\`"

**File naming rules:**
- Overview: \`<plan_dir>/00-overview.md\`
- Milestones: \`<plan_dir>/01-<milestone-slug>.md\`, \`<plan_dir>/02-<milestone-slug>.md\`, …
- Milestone slug = lowercase, hyphens only (e.g., "User Authentication" → \`user-authentication\`)

## Step 4: Branch, Commit, PR

1. Create a feature branch: \`git checkout -b plan/<plan_slug>\`
2. Commit all plan files with a clear message
3. Push and create a PR (detect base branch in subshell):
   \`\`\`bash
   gh pr create --fill --base $(b=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'); [ -z "$b" ] && b=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p'); echo "$b")
   \`\`\`

## Step 5: Return Result

End your response with:
\`\`\`
---PLAN_RESULT---
pr_number: <number>
branch: <branch-name>
plan_files: <comma-separated relative file paths>
structure: single | multi
---END_PLAN_RESULT---
\`\`\``;
}

/**
 * Build the AgentDefinition for the plan-writer sub-agent.
 * The plan slug is embedded into the prompt at creation time so file paths are concrete.
 */
export function buildPlanWriterAgentDef(planSlug: string): AgentDefinition {
	const singlePlanPath = `docs/plans/${planSlug}.md`;
	const planDir = `docs/plans/${planSlug}`;
	const prompt = buildPlanWriterPrompt()
		.replace(/<single_plan_path>/g, singlePlanPath)
		.replace(/<plan_dir>/g, planDir)
		.replace(/<plan_slug>/g, planSlug);

	return {
		description:
			'Plan writer that explores the codebase using its own tools and produces structured plan documents. ' +
			'Supports single-file plans for small goals and multi-file iterative plans for large-scope goals.',
		tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
		model: 'inherit',
		prompt,
	};
}

/**
 * Build the behavioral system prompt for the Planner agent.
 *
 * The Planner orchestrates two phases:
 * 1. Plan phase: Runs a 3-stage pipeline (planner-explorer → planner-fact-checker → plan-writer)
 *    to explore, validate, and create a plan PR.
 * 2. Task creation phase: After human approval, merges the PR and creates tasks.
 *
 * Goal-specific context is delivered via the initial user message.
 */
export function buildPlannerSystemPrompt(goalTitle?: string): string {
	const planSlug = goalTitle ? toPlanSlug(goalTitle) : 'plan';
	const planDir = `docs/plans/${planSlug}`;
	const planPath = `docs/plans/${planSlug}.md`;

	return `\
You are a Planner Agent responsible for breaking down a goal into a concrete plan.

Your job has two phases within a single session:
1. **Plan phase**: Orchestrate a 3-stage pipeline to explore, fact-check, and create a plan PR
2. **Task creation phase**: After the plan is approved, merge the PR and create tasks

## Pre-Planning Setup (MANDATORY)

Before starting, sync with the default branch.
Run all three lines as a **single bash invocation** (variables persist within one call):
\`\`\`bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')
git fetch origin && git rebase origin/$DEFAULT_BRANCH
\`\`\`
**If the rebase fails with conflicts, stop immediately and report the error** — do NOT plan against a stale codebase

You may also use \`WebSearch\` or \`WebFetch\` to verify current technology choices or check for recent breaking changes before spawning sub-agents.

## Phase 1: Planning (3-Stage Pipeline)

Execute the following three stages in order, passing accumulated context forward at each stage.

### Stage 1: Codebase Exploration

Spawn the \`planner-explorer\` sub-agent with the goal context:

\`\`\`
Task(subagent_type: "planner-explorer", prompt: "Goal: <title>\\n\\nDescription: <description>\\n\\n<room context>")
\`\`\`

Collect the \`---EXPLORER_FINDINGS---\` block from the response verbatim — this is the structured output you will pass to subsequent stages.

**If planner-explorer fails or times out:** Skip Stage 2 and proceed directly to Stage 3 (spawn plan-writer) with only the goal context — the plan-writer has its own Read/Grep/Glob/Bash tools and can explore directly.

### Stage 2: Fact-Checking

Spawn the \`planner-fact-checker\` sub-agent with the goal context **plus** the explorer findings verbatim:

\`\`\`
Task(subagent_type: "planner-fact-checker", prompt: "Goal: <title>\\n\\nDescription: <description>\\n\\n<room context>\\n\\n## Explorer Findings\\n\\n<verbatim ---EXPLORER_FINDINGS--- block>")
\`\`\`

Collect the \`---FACT_CHECK_RESULT---\` block from the response verbatim.

**If planner-fact-checker fails or times out:** Proceed to Stage 3 with explorer findings only and note that fact-checking was skipped.

### Stage 3: Plan Writing

Spawn the \`plan-writer\` sub-agent with the goal context, explorer findings, **and** fact-checker results:

\`\`\`
Task(subagent_type: "plan-writer", prompt: "Goal: <title>\\n\\nDescription: <description>\\n\\n<room context>\\n\\n## Explorer Findings\\n\\n<verbatim ---EXPLORER_FINDINGS--- block>\\n\\n## Fact-Check Results\\n\\n<verbatim ---FACT_CHECK_RESULT--- block>")
\`\`\`

The plan-writer will:
- Use explorer + fact-checker context as its foundation, but also verify directly with its own tools
- For small goals (≤ 5 milestones): write a single plan file at \`${planPath}\`
- For large goals (> 5 milestones): write multi-file plans in \`${planDir}/\` with a numbered overview (\`00-overview.md\`) and per-milestone files (\`01-<milestone>.md\`, \`02-<milestone>.md\`, …)
- Use an iterative two-pass approach for large goals: first create the overview, then expand each milestone into detailed tasks and subtasks
- Create a feature branch, commit, push, and open a PR

Parse the \`---PLAN_RESULT---\` block in the plan-writer's response to capture:
- \`pr_number\` — needed for Phase 2 merge
- \`plan_files\` — file paths to read in Phase 2
- \`structure\` — \`single\` or \`multi\`

**If the Leader sends feedback on the plan:** Edit the plan files directly (you have Write/Edit/Bash tools), push to the existing branch, and finish your response.

- Do NOT call \`create_task\` — that tool is disabled until the plan is approved
- Do NOT implement any code — only plan

Finish your response after the plan-writer completes — the Leader will dispatch reviewers, then submit for human approval.

## Phase 2: Task Creation (after plan approval)

When the Leader sends you an approval message, you are in Phase 2.
**IMPORTANT**: Do NOT skip straight to \`create_task\` — you MUST merge the plan PR first.

1. Merge the plan PR: run \`gh pr merge <PR_NUMBER>\` (use the pr_number from the Phase 1 plan-writer result; do NOT use --delete-branch)
2. Read the plan files (use the \`plan_files\` list from Phase 1, or find them under \`${planDir}/\` or at \`${planPath}\`)
3. Create tasks 1:1 from the plan sections using the \`create_task\` tool
4. Each task title and description should match the plan exactly
5. For each task, assign the appropriate agent type: "coder" for implementation tasks, "general" for non-coding tasks
6. Use the \`depends_on\` parameter to declare task dependencies. Pass the task IDs returned by previous \`create_task\` calls. Tasks without dependencies can run in parallel; tasks with dependencies will wait until all dependencies are completed.
7. Each task description must include clear acceptance criteria. For coding tasks, always include: "Changes must be on a feature branch with a GitHub PR created via \`gh pr create\`"
8. Do NOT implement any code — only create tasks from the approved plan
9. Finish your response after all tasks are created`;
}

/**
 * Build the initial user message for the Planner agent.
 *
 * Contains goal-specific context: goal title/description, project background,
 * room instructions, and replanning context if this is a replan session.
 * This is what the user sees in the UI as the agent's starting prompt.
 */
export function buildPlannerTaskMessage(config: PlannerAgentConfig): string {
	const { goal, room } = config;
	const sections: string[] = [];

	sections.push(`## Goal to Plan\n`);
	sections.push(`**Goal:** ${goal.title}`);
	if (goal.description) {
		sections.push(`**Description:** ${goal.description}`);
	}

	if (room.background) {
		sections.push(`\n## Project Context\n`);
		sections.push(room.background);
	}
	if (room.instructions) {
		sections.push(`\n## Instructions\n`);
		sections.push(room.instructions);
	}

	// Replanning context — enriched info when replanning after task failure
	if (config.replanContext) {
		const rc = config.replanContext;
		sections.push(`\n## Replanning Context (Attempt ${rc.attempt})\n`);
		sections.push(
			`This is a REPLAN. A previous plan partially executed. Build on what succeeded.\n`
		);

		if (rc.completedTasks.length > 0) {
			sections.push(`### Completed Tasks (DO NOT redo these)\n`);
			for (const t of rc.completedTasks) {
				sections.push(`- **${t.title}**: ${t.result}`);
			}
			sections.push('');
		}

		sections.push(`### Failed Task\n`);
		sections.push(`- **${rc.failedTask.title}**: ${rc.failedTask.error}`);
		sections.push('');
		sections.push(`Create new tasks that address the failure and complete the remaining goal.`);
		sections.push(`Do NOT create tasks for work that already completed successfully.`);

		// Metric context for measurable missions
		if (rc.metricContext && rc.metricContext.metrics.length > 0) {
			sections.push(`\n### Metric Targets (Measurable Mission)\n`);
			sections.push(
				`This goal has KPI targets. Your plan must include tasks that move these metrics toward their targets.\n`
			);
			for (const m of rc.metricContext.metrics) {
				const direction = m.direction ?? 'increase';
				const statusIcon = m.met ? '[MET]' : '[NOT MET]';
				const dirStr = direction === 'increase' ? 'increase to' : 'decrease to';
				let line = `- **${m.name}**: current=${m.current}, need to ${dirStr} ${m.target} ${statusIcon}`;
				if (direction === 'decrease' && m.baseline !== undefined) {
					line += `, baseline=${m.baseline}`;
				}
				sections.push(line);
				if (m.recentHistory && m.recentHistory.length > 0) {
					sections.push(`  Recent history: ${m.recentHistory.join(' → ')}`);
				}
			}
			sections.push('');
			sections.push(`Focus your plan on tasks that will directly improve the unmet metrics above.`);
		}
	}

	sections.push(`\nBreak this goal into tasks.`);

	return sections.join('\n');
}

/**
 * Create the MCP server with planning tools.
 */
export function createPlannerMcpServer(config: PlannerAgentConfig) {
	const phaseGateError = {
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify({
					success: false,
					error:
						'This tool is not available during the planning phase. ' +
						'The plan-writer sub-agent will create plan files under docs/plans/, commit them, and create a PR. ' +
						'Tasks will be created after the plan is approved.',
				}),
			},
		],
	};

	// Dynamic gate: checks isPlanApproved at tool invocation time (not MCP creation time)
	const isApproved = () => config.isPlanApproved?.() ?? false;

	const tools = [
		tool(
			'create_task',
			'Record a task in the plan. Call this for each task you identify. Only available after the plan is approved.',
			{
				title: z
					.string()
					.describe('Short, action-oriented task title (e.g., "Add JWT auth middleware")'),
				description: z
					.string()
					.describe('Detailed description with acceptance criteria — what "done" looks like'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.default('normal')
					.describe('Task priority'),
				agent: z
					.enum(['coder', 'general'])
					.optional()
					.default('coder')
					.describe('Which agent type should execute this task'),
				depends_on: z
					.array(z.string())
					.optional()
					.default([])
					.describe(
						'IDs of tasks this task depends on (from previous create_task calls). Task will not start until all dependencies are completed.'
					),
			},
			async (args) => {
				if (!isApproved()) return phaseGateError;
				try {
					const task = await config.createDraftTask({
						title: args.title,
						description: args.description,
						priority: args.priority as TaskPriority | undefined,
						agent: args.agent as AgentType | undefined,
						dependsOn: args.depends_on,
					});
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({ success: true, taskId: task.id, title: task.title }),
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({ success: false, error: String(error) }),
							},
						],
					};
				}
			}
		),
		tool(
			'update_task',
			'Update an existing draft task. Use this to refine tasks based on Leader feedback. Only available after the plan is approved.',
			{
				task_id: z.string().describe('The ID of the draft task to update'),
				title: z.string().optional().describe('Updated task title'),
				description: z.string().optional().describe('Updated task description'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.describe('Updated priority'),
				agent: z.enum(['coder', 'general']).optional().describe('Updated agent type'),
			},
			async (args) => {
				if (!isApproved()) return phaseGateError;
				try {
					const task = await config.updateDraftTask(args.task_id, {
						title: args.title,
						description: args.description,
						priority: args.priority as TaskPriority | undefined,
						assignedAgent: args.agent as AgentType | undefined,
					});
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({ success: true, taskId: task.id, title: task.title }),
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({ success: false, error: String(error) }),
							},
						],
					};
				}
			}
		),
		tool(
			'remove_task',
			'Remove a draft task from the plan. Only available after the plan is approved.',
			{
				task_id: z.string().describe('The ID of the draft task to remove'),
			},
			async (args) => {
				if (!isApproved()) return phaseGateError;
				try {
					const removed = await config.removeDraftTask(args.task_id);
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({ success: removed }),
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({ success: false, error: String(error) }),
							},
						],
					};
				}
			}
		),
	];

	return createSdkMcpServer({ name: 'planner-tools', tools });
}

/**
 * Create an AgentSessionInit for a Planner agent.
 *
 * Uses the agent/agents pattern so the Planner has access to the Task/TaskOutput/TaskStop
 * tools for spawning the 3-stage pipeline sub-agents:
 * - planner-explorer: read-only codebase exploration
 * - planner-fact-checker: web-based validation of explorer findings
 * - plan-writer: produces the plan documents using accumulated context
 *
 * MCP planning tools (create_task, update_task, remove_task) are provided via mcpServers
 * and are available to the main Planner agent thread regardless.
 */
export function createPlannerAgentInit(config: PlannerAgentConfig): AgentSessionInit {
	const mcpServer = createPlannerMcpServer(config);
	const planSlug = toPlanSlug(config.goal.title);

	const plannerAgentDef: AgentDefinition = {
		description:
			'Planning agent that orchestrates a 3-stage pipeline (explorer → fact-checker → plan-writer) ' +
			'to create a plan PR, then creates tasks from the approved plan.',
		prompt: buildPlannerSystemPrompt(config.goal.title),
		// Planner needs Task/TaskOutput/TaskStop to spawn the 3-stage pipeline sub-agents,
		// plus standard tools for direct file editing during feedback rounds.
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
		mcpServers: {
			'planner-tools': mcpServer as unknown as McpServerConfig,
		},
		features: PLANNER_FEATURES,
		context: { roomId: config.room.id },
		type: 'planner',
		model: config.model ?? DEFAULT_PLANNER_MODEL,
		provider: config.provider,
		agent: 'Planner',
		agents: {
			Planner: plannerAgentDef,
			'planner-explorer': buildPlannerExplorerAgentDef(),
			'planner-fact-checker': buildPlannerFactCheckerAgentDef(),
			'plan-writer': buildPlanWriterAgentDef(planSlug),
		},
		contextAutoQueue: false,
	};
}
