/**
 * Coder Agent Factory - Creates AgentSessionInit for Coder (worker) sessions
 *
 * The Coder agent is the implementation worker in a session group. It receives a task
 * with context from the goal and room, then works using standard coding tools
 * (bash, edit, read, write, glob, grep) until it reaches a terminal state.
 *
 * No special MCP tools are needed - Coder just works until done.
 */

import type { AgentSessionInit } from '../agent/agent-session';
import type { Room, RoomGoal, NeoTask, SessionFeatures } from '@neokai/shared';

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
	goal: RoomGoal;
	room: Room;
	sessionId: string;
	workspacePath: string;
	model?: string;
	/** Summaries of previously completed tasks in the same goal */
	previousTaskSummaries?: string[];
}

/**
 * Build a system prompt for the Coder agent.
 *
 * Includes task context, goal context, room instructions, and
 * summaries of previous work on the same goal.
 */
export function buildCoderSystemPrompt(config: CoderAgentConfig): string {
	const { task, goal, room, previousTaskSummaries } = config;

	const sections: string[] = [];

	sections.push(`You are a Coder Agent working on a specific task within a larger goal.`);
	sections.push(`Your job is to complete the task described below to the best of your ability.`);
	sections.push(`Work carefully and thoroughly. When you are done, simply finish your response.`);

	// Mandatory Git workflow
	sections.push(`\n## Git Workflow (MANDATORY)\n`);
	sections.push(
		`You are working in an isolated git worktree on a feature branch. ` +
			`The branch has already been created for you. Follow this workflow:`
	);
	sections.push(`1. Implement the task, making logical commits along the way`);
	sections.push(`2. Push your branch: \`git push -u origin HEAD\``);
	sections.push(`3. Create a pull request: \`gh pr create --fill\``);
	sections.push(`4. Finish your response`);
	sections.push(``);
	sections.push(
		`**IMPORTANT**: Do NOT commit directly to the main/dev/master branch. ` +
			`The runtime enforces this — you will be sent back if no feature branch and PR exist.`
	);

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
 * Create an AgentSessionInit for a Coder agent session.
 *
 * The Coder agent uses the Claude Code preset (standard coding tools)
 * with a custom system prompt appended for task context.
 */
export function createCoderAgentInit(config: CoderAgentConfig): AgentSessionInit {
	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: buildCoderSystemPrompt(config),
		},
		features: CODER_FEATURES,
		context: { roomId: config.room.id },
		type: 'coder',
		model: config.model ?? DEFAULT_CODER_MODEL,
	};
}
