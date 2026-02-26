/**
 * Lead Agent Factory - Creates AgentSessionInit for Lead (reviewer) sessions
 *
 * The Lead agent is the "reviewer" in a (Craft, Lead) group. It reviews Craft's
 * work and must call exactly one terminal tool per turn:
 * - send_to_craft(message) - Send feedback for another iteration
 * - complete_task(summary) - Accept work, mark task done
 * - fail_task(reason) - Task is not achievable
 *
 * Lead tools are MCP callbacks that route through the RoomRuntime.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentSessionInit } from '../agent/agent-session';
import type { Room, RoomGoal, NeoTask, SessionFeatures, McpServerConfig } from '@neokai/shared';

const DEFAULT_LEAD_MODEL = 'claude-sonnet-4-5-20250929';

const LEAD_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export interface LeadToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

/**
 * Callback interface for Lead tool routing.
 * The RoomRuntime implements this to handle tool calls.
 */
export interface LeadToolCallbacks {
	sendToCraft(groupId: string, message: string): Promise<LeadToolResult>;
	completeTask(groupId: string, summary: string): Promise<LeadToolResult>;
	failTask(groupId: string, reason: string): Promise<LeadToolResult>;
}

export interface LeadAgentConfig {
	task: NeoTask;
	goal: RoomGoal;
	room: Room;
	sessionId: string;
	workspacePath: string;
	groupId: string;
	model?: string;
}

/**
 * Build a system prompt for the Lead agent.
 *
 * Includes goal/task context, review policy, and the tool contract.
 */
export function buildLeadSystemPrompt(config: LeadAgentConfig): string {
	const { task, goal, room } = config;

	const sections: string[] = [];

	sections.push(`You are a Lead Agent responsible for reviewing work done by a Craft Agent.`);
	sections.push(`Your job is to evaluate the Craft Agent's output against the task requirements.`);

	// Tool contract
	sections.push(`\n## Tool Contract (CRITICAL)\n`);
	sections.push(`You MUST call exactly one tool per turn:`);
	sections.push(`- \`send_to_craft\` — Send feedback if the work needs changes`);
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

	// Review guidelines
	sections.push(`\n## Review Guidelines\n`);
	sections.push(`1. Check that the implementation matches the task description`);
	sections.push(`2. Verify correctness and completeness`);
	sections.push(`3. If issues are found, use \`send_to_craft\` with specific actionable feedback`);
	sections.push(`4. If the work is complete and correct, use \`complete_task\` with a summary`);
	sections.push(`5. Only use \`fail_task\` if the task is fundamentally not achievable`);

	return sections.join('\n');
}

/**
 * Create testable Lead tool handler functions.
 * These delegate to the provided callbacks which route through RoomRuntime.
 */
export function createLeadToolHandlers(groupId: string, callbacks: LeadToolCallbacks) {
	return {
		async send_to_craft(args: { message: string }): Promise<LeadToolResult> {
			return callbacks.sendToCraft(groupId, args.message);
		},
		async complete_task(args: { summary: string }): Promise<LeadToolResult> {
			return callbacks.completeTask(groupId, args.summary);
		},
		async fail_task(args: { reason: string }): Promise<LeadToolResult> {
			return callbacks.failTask(groupId, args.reason);
		},
	};
}

/**
 * Create an MCP server with Lead review tools.
 * Tool callbacks route through the RoomRuntime via LeadToolCallbacks.
 */
export function createLeadMcpServer(groupId: string, callbacks: LeadToolCallbacks) {
	const handlers = createLeadToolHandlers(groupId, callbacks);

	const tools = [
		tool(
			'send_to_craft',
			'Send feedback to the Craft Agent for another iteration of work',
			{
				message: z.string().describe('Specific, actionable feedback for the Craft Agent'),
			},
			(args) => handlers.send_to_craft(args)
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

	return createSdkMcpServer({ name: 'lead-agent-tools', tools });
}

/**
 * Create an AgentSessionInit for a Lead agent session.
 *
 * The Lead agent does NOT use the Claude Code preset - it uses a custom
 * system prompt with review-specific instructions and MCP tools.
 */
export function createLeadAgentInit(
	config: LeadAgentConfig,
	callbacks: LeadToolCallbacks
): AgentSessionInit {
	const mcpServer = createLeadMcpServer(config.groupId, callbacks);

	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: buildLeadSystemPrompt(config),
		mcpServers: {
			'lead-agent-tools': mcpServer as unknown as McpServerConfig,
		},
		features: LEAD_FEATURES,
		context: { roomId: config.room.id },
		type: 'lead',
		model: config.model ?? DEFAULT_LEAD_MODEL,
	};
}
