/**
 * Craft Agent Factory - Creates AgentSessionInit for Craft (worker) sessions
 *
 * The Craft agent is the "doer" in a (Craft, Lead) group. It receives a task
 * with context from the goal and room, then works using standard coding tools
 * (bash, edit, read, write, glob, grep) until it reaches a terminal state.
 *
 * No special MCP tools are needed - Craft just works until done.
 */

import type { AgentSessionInit } from '../agent/agent-session';
import type { Room, RoomGoal, NeoTask, SessionFeatures } from '@neokai/shared';

const DEFAULT_CRAFT_MODEL = 'claude-sonnet-4-5-20250929';

const CRAFT_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export interface CraftAgentConfig {
	task: NeoTask;
	goal: RoomGoal;
	room: Room;
	sessionId: string;
	workspacePath: string;
	model?: string;
	/** Summaries of previously completed tasks in the same goal */
	previousTaskSummaries?: string[];
}

/**
 * Build a system prompt for the Craft agent.
 *
 * Includes task context, goal context, room instructions, and
 * summaries of previous work on the same goal.
 */
export function buildCraftSystemPrompt(config: CraftAgentConfig): string {
	const { task, goal, room, previousTaskSummaries } = config;

	const sections: string[] = [];

	sections.push(`You are a Craft Agent working on a specific task within a larger goal.`);
	sections.push(`Your job is to complete the task described below to the best of your ability.`);
	sections.push(`Work carefully and thoroughly. When you are done, simply finish your response.`);

	// Task context
	sections.push(`\n## Task\n`);
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

	// Room context
	if (room.background) {
		sections.push(`\n## Project Context\n`);
		sections.push(room.background);
	}
	if (room.instructions) {
		sections.push(`\n## Instructions\n`);
		sections.push(room.instructions);
	}

	// Previous task summaries
	if (previousTaskSummaries && previousTaskSummaries.length > 0) {
		sections.push(`\n## Previous Work on This Goal\n`);
		sections.push(`The following tasks have already been completed for this goal:`);
		for (const summary of previousTaskSummaries) {
			sections.push(`- ${summary}`);
		}
	}

	return sections.join('\n');
}

/**
 * Create an AgentSessionInit for a Craft agent session.
 *
 * The Craft agent uses the Claude Code preset (standard coding tools)
 * with a custom system prompt appended for task context.
 */
export function createCraftAgentInit(config: CraftAgentConfig): AgentSessionInit {
	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: buildCraftSystemPrompt(config),
		},
		features: CRAFT_FEATURES,
		context: { roomId: config.room.id },
		type: 'craft',
		model: config.model ?? DEFAULT_CRAFT_MODEL,
	};
}
