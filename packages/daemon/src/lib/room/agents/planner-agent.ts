/**
 * Planner Agent Factory
 *
 * Creates AgentSessionInit for Planner sessions that break goals into tasks.
 *
 * The Planner agent:
 * - Examines the codebase to understand scope
 * - Creates concrete, well-scoped tasks via the create_task MCP tool
 * - Can update or remove draft tasks during plan polishing with Leader feedback
 * - Tasks are created as 'draft' and tagged with createdByTaskId
 * - Leader reviews the plan; on complete_task() the runtime promotes drafts to pending
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

/** Context passed to the planner when replanning after a task failure */
export interface ReplanContext {
	/** Tasks that completed successfully (DO NOT redo) */
	completedTasks: Array<{ title: string; result: string }>;
	/** The task that just failed */
	failedTask: { title: string; error: string };
	/** Planning attempt number (1-indexed) */
	attempt: number;
}

export interface PlannerAgentConfig {
	task: NeoTask;
	goal: RoomGoal;
	room: Room;
	sessionId: string;
	workspacePath: string;
	model?: string;
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
 * Build the behavioral system prompt for the Planner agent.
 *
 * Single-session lifecycle:
 * 1. Examine codebase, write plan as docs/plans/<slug>.md, commit, create PR
 * 2. (Worker exits → Leader reviews → submit_for_review → Human approves)
 * 3. When resumed with approval message: merge PR, create tasks using create_task tool
 *
 * The create_task/update_task/remove_task tools are gated by a dynamic isPlanApproved
 * check — they become available only after the human approves the plan.
 *
 * Goal-specific context is delivered via the initial user message.
 */
export function buildPlannerSystemPrompt(goalTitle?: string): string {
	const sections: string[] = [];

	const planSlug = goalTitle ? toPlanSlug(goalTitle) : 'plan';
	const planPath = `docs/plans/${planSlug}.md`;

	sections.push(
		`You are a Planner Agent responsible for breaking down a goal into a concrete plan.`
	);
	sections.push(`\nYour job has two phases within a single session:`);
	sections.push(`1. **Plan phase**: Examine the codebase, write a plan document, and create a PR`);
	sections.push(
		`2. **Task creation phase**: After the plan is approved, merge the PR and create tasks`
	);

	sections.push(`\n## Phase 1: Planning\n`);
	sections.push(`1. Read relevant files to understand the current codebase state`);
	sections.push(`2. Break the goal into 3-8 concrete, independently executable tasks`);
	sections.push(
		`3. Order tasks by dependency (later tasks build on earlier ones). Note explicit dependencies between tasks — which tasks must complete before others can start.`
	);
	sections.push(
		`4. Each task description must include clear acceptance criteria. ` +
			`For coding tasks, always include: "Changes must be on a feature branch with a GitHub PR created via \`gh pr create\`"`
	);
	sections.push(
		`5. For each task, assign the appropriate agent type: "coder" for implementation tasks, "general" for non-coding tasks`
	);
	sections.push(
		`6. Do NOT call \`create_task\` — that tool is disabled until the plan is approved`
	);
	sections.push(`7. Do NOT implement any code — only plan`);
	sections.push(`8. If the Leader sends feedback, update the plan document accordingly`);

	sections.push(`\n### Plan Deliverable (REQUIRED)\n`);
	sections.push(`You MUST produce a plan file and create a PR for review:`);
	sections.push(
		`1. Create the \`docs/plans/\` directory if it doesn't exist, then write the plan file at \`${planPath}\` with: goal, ordered task list with descriptions, dependencies between tasks, acceptance criteria, and agent type assignments`
	);
	sections.push(`2. Create a feature branch, commit the plan file, and push it`);
	sections.push(
		`3. Create a GitHub PR via \`gh pr create\` with the plan summary as the PR description`
	);
	sections.push(
		`4. Finish your response — the Leader will dispatch reviewers, then submit for human approval`
	);

	sections.push(`\n## Phase 2: Task Creation (after plan approval)\n`);
	sections.push(
		`When the human approves the plan, you will receive a message with approval instructions.`
	);
	sections.push(
		`1. Merge the plan PR: run \`gh pr merge --merge\` or \`git merge\` the plan branch`
	);
	sections.push(
		`2. Read the plan file (look for \`${planPath}\` or any \`.md\` file under \`docs/plans/\`) to get the approved plan`
	);
	sections.push(`3. Create tasks 1:1 from the plan sections using the \`create_task\` tool`);
	sections.push(`4. Each task title and description should match the plan exactly`);
	sections.push(
		`5. For each task, assign the appropriate agent type: "coder" for implementation tasks, "general" for non-coding tasks`
	);
	sections.push(
		`6. Use the \`depends_on\` parameter to declare task dependencies. ` +
			`Pass the task IDs returned by previous \`create_task\` calls. ` +
			`Tasks without dependencies can run in parallel; tasks with dependencies will wait until all dependencies are completed.`
	);
	sections.push(
		`7. Each task description must include clear acceptance criteria. ` +
			`For coding tasks, always include: "Changes must be on a feature branch with a GitHub PR created via \`gh pr create\`"`
	);
	sections.push(`8. Do NOT implement any code — only create tasks from the approved plan`);
	sections.push(`9. Finish your response after all tasks are created`);

	return sections.join('\n');
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
						'Write your plan file under docs/plans/, commit it, and create a PR instead. ' +
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
 * Uses the Claude Code preset (for read/glob/grep codebase access) plus planning
 * MCP tools. The system prompt instructs the agent to plan only, not implement.
 */
export function createPlannerAgentInit(config: PlannerAgentConfig): AgentSessionInit {
	const mcpServer = createPlannerMcpServer(config);

	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: buildPlannerSystemPrompt(config.goal.title),
		},
		mcpServers: {
			'planner-tools': mcpServer as unknown as McpServerConfig,
		},
		features: PLANNER_FEATURES,
		context: { roomId: config.room.id },
		type: 'planner',
		model: config.model ?? DEFAULT_PLANNER_MODEL,
		contextAutoQueue: false,
	};
}
