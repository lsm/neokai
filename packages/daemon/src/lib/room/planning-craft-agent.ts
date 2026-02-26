/**
 * Planning Craft Agent Factory
 *
 * Creates AgentSessionInit for Craft sessions that plan a goal into tasks.
 *
 * The Planning Craft agent:
 * - Examines the codebase to understand scope
 * - Creates concrete, well-scoped tasks via the create_task MCP tool
 * - Tasks are created as 'draft' and tagged with createdByTaskId
 * - Lead reviews the plan; on complete_task() the runtime promotes drafts to pending
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentSessionInit } from '../agent/agent-session';
import type {
	Room,
	RoomGoal,
	NeoTask,
	SessionFeatures,
	McpServerConfig,
	TaskPriority,
} from '@neokai/shared';

const DEFAULT_PLANNING_MODEL = 'claude-sonnet-4-5-20250929';

const PLANNING_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export interface PlanningCraftCreateTaskParams {
	title: string;
	description: string;
	priority?: TaskPriority;
}

export interface PlanningCraftAgentConfig {
	task: NeoTask;
	goal: RoomGoal;
	room: Room;
	sessionId: string;
	workspacePath: string;
	model?: string;
	/** Callback to create a draft task linked to this planning task */
	createDraftTask: (
		params: PlanningCraftCreateTaskParams
	) => Promise<{ id: string; title: string }>;
}

/**
 * Build system prompt for Planning Craft agent.
 */
export function buildPlanningCraftSystemPrompt(config: PlanningCraftAgentConfig): string {
	const { goal, room } = config;
	const sections: string[] = [];

	sections.push(
		`You are a Planning Agent responsible for breaking down a goal into concrete tasks.`
	);
	sections.push(
		`\nYour job is to examine the codebase and produce a clear, ordered task breakdown.`
	);
	sections.push(
		`Use the \`create_task\` tool to record each task. Do NOT write code or make changes.`
	);

	sections.push(`\n## Goal to Plan\n`);
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

	sections.push(`\n## Planning Guidelines\n`);
	sections.push(`1. Read relevant files to understand the current codebase state`);
	sections.push(`2. Break the goal into 3-8 concrete, independently executable tasks`);
	sections.push(`3. Order tasks by dependency (later tasks build on earlier ones)`);
	sections.push(`4. Each task description must include clear acceptance criteria`);
	sections.push(`5. Call \`create_task\` for each task — this is how you record your plan`);
	sections.push(`6. When done creating all tasks, finish your response`);
	sections.push(`7. Do NOT implement anything — only plan and call create_task`);

	return sections.join('\n');
}

/**
 * Create the MCP server with the create_task tool for planning.
 */
function createPlanningMcpServer(config: PlanningCraftAgentConfig) {
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
			},
			async (args) => {
				try {
					const task = await config.createDraftTask({
						title: args.title,
						description: args.description,
						priority: args.priority as TaskPriority | undefined,
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
	];

	return createSdkMcpServer({ name: 'planning-tools', tools });
}

/**
 * Create an AgentSessionInit for a Planning Craft agent.
 *
 * Uses the Claude Code preset (for read/glob/grep access) plus a create_task
 * MCP tool. The system prompt instructs the agent to plan only, not implement.
 */
export function createPlanningCraftAgentInit(config: PlanningCraftAgentConfig): AgentSessionInit {
	const mcpServer = createPlanningMcpServer(config);

	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: buildPlanningCraftSystemPrompt(config),
		},
		mcpServers: {
			'planning-tools': mcpServer as unknown as McpServerConfig,
		},
		features: PLANNING_FEATURES,
		context: { roomId: config.room.id },
		type: 'craft',
		model: config.model ?? DEFAULT_PLANNING_MODEL,
	};
}
