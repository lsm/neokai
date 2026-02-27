/**
 * Leader Agent Factory - Creates AgentSessionInit for Leader (reviewer) sessions
 *
 * The Leader agent reviews worker output and must call exactly one terminal tool per turn:
 * - send_to_worker(message) - Send feedback for another iteration
 * - complete_task(summary) - Accept work, mark task done
 * - fail_task(reason) - Task is not achievable
 *
 * Leader tools are MCP callbacks that route through the RoomRuntime.
 * The Leader adapts its review focus based on reviewContext:
 * - 'plan_review': Evaluates task breakdown quality, coverage, ordering
 * - 'code_review': Evaluates implementation correctness, completeness
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentSessionInit } from '../agent/agent-session';
import type { Room, RoomGoal, NeoTask, SessionFeatures, McpServerConfig } from '@neokai/shared';

const DEFAULT_LEADER_MODEL = 'claude-sonnet-4-5-20250929';

const LEADER_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export type ReviewContext = 'plan_review' | 'code_review';

export interface LeaderToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

/**
 * Callback interface for Leader tool routing.
 * The RoomRuntime implements this to handle tool calls.
 */
export interface LeaderToolCallbacks {
	sendToWorker(groupId: string, message: string): Promise<LeaderToolResult>;
	completeTask(groupId: string, summary: string): Promise<LeaderToolResult>;
	failTask(groupId: string, reason: string): Promise<LeaderToolResult>;
}

export interface LeaderAgentConfig {
	task: NeoTask;
	goal: RoomGoal;
	room: Room;
	sessionId: string;
	workspacePath: string;
	groupId: string;
	model?: string;
	/** What type of work is being reviewed */
	reviewContext?: ReviewContext;
}

/**
 * Build a system prompt for the Leader agent.
 *
 * Includes goal/task context, review policy, and the tool contract.
 * Adapts review guidelines based on whether reviewing a plan or code.
 */
export function buildLeaderSystemPrompt(config: LeaderAgentConfig): string {
	const { task, goal, room, reviewContext } = config;
	const isPlanReview = reviewContext === 'plan_review';

	const sections: string[] = [];

	if (isPlanReview) {
		sections.push(
			`You are a Leader Agent responsible for reviewing a plan created by a Planner Agent.`
		);
		sections.push(`Your job is to evaluate the task breakdown against the goal requirements.`);
	} else {
		sections.push(`You are a Leader Agent responsible for reviewing work done by a worker agent.`);
		sections.push(`Your job is to evaluate the worker's output against the task requirements.`);
	}

	// Tool contract
	sections.push(`\n## Tool Contract (CRITICAL)\n`);
	sections.push(`You MUST call exactly one tool per turn:`);
	sections.push(`- \`send_to_worker\` — Send feedback if the work needs changes`);
	sections.push(`- \`complete_task\` — Accept the work if it meets all requirements`);
	sections.push(`- \`fail_task\` — Mark the task as not achievable\n`);
	sections.push(`Do NOT respond with only text. You MUST call one of the above tools.`);

	// Task context
	sections.push(`\n## Task Under Review\n`);
	sections.push(`**Title:** ${task.title}`);
	sections.push(`**Description:** ${task.description}`);
	if (task.priority) {
		sections.push(`**Priority:** ${task.priority}`);
	}

	// Goal context
	sections.push(`\n## Goal Context\n`);
	sections.push(`**Goal:** ${goal.title}`);
	if (goal.description) {
		sections.push(`**Description:** ${goal.description}`);
	}

	// Room review policy
	if (room.instructions) {
		sections.push(`\n## Review Policy\n`);
		sections.push(room.instructions);
	}

	// Handling worker questions
	sections.push(`\n## Handling Worker Questions\n`);
	sections.push(
		`If the worker output shows \`Terminal state: waiting_for_input\`, the worker is asking a question.`
	);
	sections.push(
		`- If you can answer the question from the goal/task context, use \`send_to_worker\` with the answer`
	);
	sections.push(
		`- If the question requires human judgment or information you don't have, use \`fail_task\` with the reason (e.g., "Worker needs human input: <question>")`
	);

	// Context-specific review guidelines
	if (isPlanReview) {
		sections.push(`\n## Plan Review Guidelines\n`);
		sections.push(`1. Check that the plan covers all aspects of the goal`);
		sections.push(`2. Verify each task has clear, specific acceptance criteria`);
		sections.push(`3. Ensure tasks are ordered correctly by dependency`);
		sections.push(`4. Check that tasks are well-scoped (not too broad or too narrow)`);
		sections.push(
			`5. Verify appropriate agent types are assigned (coder for implementation, general for non-coding)`
		);
		sections.push(
			`6. If the plan needs changes, use \`send_to_worker\` with specific feedback on what to add, remove, or modify`
		);
		sections.push(
			`7. If the plan is comprehensive and well-structured, use \`complete_task\` with a summary`
		);
		sections.push(`8. Only use \`fail_task\` if the goal is fundamentally not plannable`);
	} else {
		sections.push(`\n## Review Guidelines\n`);
		sections.push(`1. Check that the implementation matches the task description`);
		sections.push(`2. Verify correctness and completeness`);
		sections.push(
			`3. If issues are found, use \`send_to_worker\` with specific actionable feedback`
		);
		sections.push(`4. If the work is complete and correct, use \`complete_task\` with a summary`);
		sections.push(`5. Only use \`fail_task\` if the task is fundamentally not achievable`);
	}

	return sections.join('\n');
}

/**
 * Create testable Leader tool handler functions.
 * These delegate to the provided callbacks which route through RoomRuntime.
 */
export function createLeaderToolHandlers(groupId: string, callbacks: LeaderToolCallbacks) {
	return {
		async send_to_worker(args: { message: string }): Promise<LeaderToolResult> {
			return callbacks.sendToWorker(groupId, args.message);
		},
		async complete_task(args: { summary: string }): Promise<LeaderToolResult> {
			return callbacks.completeTask(groupId, args.summary);
		},
		async fail_task(args: { reason: string }): Promise<LeaderToolResult> {
			return callbacks.failTask(groupId, args.reason);
		},
	};
}

/**
 * Create an MCP server with Leader review tools.
 * Tool callbacks route through the RoomRuntime via LeaderToolCallbacks.
 */
export function createLeaderMcpServer(groupId: string, callbacks: LeaderToolCallbacks) {
	const handlers = createLeaderToolHandlers(groupId, callbacks);

	const tools = [
		tool(
			'send_to_worker',
			'Send feedback to the worker agent for another iteration of work',
			{
				message: z.string().describe('Specific, actionable feedback for the worker agent'),
			},
			(args) => handlers.send_to_worker(args)
		),
		tool(
			'complete_task',
			'Accept the work and mark the task as completed',
			{
				summary: z
					.string()
					.describe('Summary of what was accomplished and how it meets requirements'),
			},
			(args) => handlers.complete_task(args)
		),
		tool(
			'fail_task',
			'Mark the task as not achievable',
			{
				reason: z.string().describe('Explanation of why the task cannot be completed'),
			},
			(args) => handlers.fail_task(args)
		),
	];

	return createSdkMcpServer({ name: 'leader-agent-tools', tools });
}

/**
 * Create an AgentSessionInit for a Leader agent session.
 *
 * The Leader agent does NOT use the Claude Code preset - it uses a custom
 * system prompt with review-specific instructions and MCP tools.
 */
export function createLeaderAgentInit(
	config: LeaderAgentConfig,
	callbacks: LeaderToolCallbacks
): AgentSessionInit {
	const mcpServer = createLeaderMcpServer(config.groupId, callbacks);

	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: buildLeaderSystemPrompt(config),
		mcpServers: {
			'leader-agent-tools': mcpServer as unknown as McpServerConfig,
		},
		features: LEADER_FEATURES,
		context: { roomId: config.room.id },
		type: 'leader',
		model: config.model ?? DEFAULT_LEADER_MODEL,
	};
}
