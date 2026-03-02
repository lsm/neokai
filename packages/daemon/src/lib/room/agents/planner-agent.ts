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
}

/**
 * Build the behavioral system prompt for the Planner agent.
 *
 * Contains ONLY role definition, tool contract, and planning guidelines.
 * Goal-specific context (title, description, room background, replan info)
 * is delivered via the initial user message built by buildPlannerTaskMessage().
 */
export function buildPlannerSystemPrompt(): string {
	const sections: string[] = [];

	sections.push(
		`You are a Planner Agent responsible for breaking down a goal into concrete tasks.`
	);
	sections.push(
		`\nYour job is to examine the codebase and produce a clear, ordered task breakdown.`
	);

	sections.push(`\n## Planning Guidelines\n`);
	sections.push(`1. Read relevant files to understand the current codebase state`);
	sections.push(`2. Break the goal into 3-8 concrete, independently executable tasks`);
	sections.push(`3. Order tasks by dependency (later tasks build on earlier ones)`);
	sections.push(
		`4. Each task description must include clear acceptance criteria. ` +
			`For coding tasks, always include: "Changes must be on a feature branch with a GitHub PR created via \`gh pr create\`"`
	);
	sections.push(
		`5. For each task, assign the appropriate agent type: "coder" for implementation tasks, "general" for non-coding tasks`
	);
	sections.push(`6. Call \`create_task\` for each task — this is how you record your plan`);
	sections.push(`7. Do NOT implement any code — only plan and call create_task`);
	sections.push(
		`8. If the Leader sends feedback, use \`update_task\` or \`remove_task\` to refine your plan, and \`create_task\` for new additions`
	);

	sections.push(`\n## Deliverable (REQUIRED)\n`);
	sections.push(
		`After creating all tasks via the planning tools, you MUST also:`
	);
	sections.push(
		`1. Write a plan file at \`PLAN.md\` in the repository root summarizing the plan (goal, task list with descriptions, dependencies, and acceptance criteria)`
	);
	sections.push(
		`2. Create a feature branch, commit the plan file, and push it`
	);
	sections.push(
		`3. Create a GitHub PR via \`gh pr create\` with the plan summary as the PR description`
	);
	sections.push(
		`4. Finish your response — the Leader will review the plan and either approve or request changes`
	);

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
function createPlannerMcpServer(config: PlannerAgentConfig) {
	const tools = [
		tool(
			'create_task',
			'Record a task in the plan. Call this for each task you identify.',
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
			},
			async (args) => {
				try {
					const task = await config.createDraftTask({
						title: args.title,
						description: args.description,
						priority: args.priority as TaskPriority | undefined,
						agent: args.agent as AgentType | undefined,
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
			'Update an existing draft task. Use this to refine tasks based on Leader feedback.',
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
			'Remove a draft task from the plan.',
			{
				task_id: z.string().describe('The ID of the draft task to remove'),
			},
			async (args) => {
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
			append: buildPlannerSystemPrompt(),
		},
		mcpServers: {
			'planner-tools': mcpServer as unknown as McpServerConfig,
		},
		features: PLANNER_FEATURES,
		context: { roomId: config.room.id },
		type: 'planner',
		model: config.model ?? DEFAULT_PLANNER_MODEL,
	};
}
