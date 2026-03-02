/**
 * General Agent Factory - Creates AgentSessionInit for General (fallback worker) sessions
 *
 * The General agent handles non-coding tasks within a session group. It has access
 * to the same Claude Code tools as the Coder agent but uses a more generic system
 * prompt that doesn't assume a coding context.
 *
 * Used when the Planner assigns a task that doesn't fit a specific agent type.
 */

import type { AgentSessionInit } from '../../agent/agent-session';
import type { Room, RoomGoal, NeoTask, SessionFeatures } from '@neokai/shared';

const DEFAULT_GENERAL_MODEL = 'claude-sonnet-4-5-20250929';

const GENERAL_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export interface GeneralAgentConfig {
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
 * Build the behavioral system prompt for the General agent.
 *
 * Contains ONLY role definition and behavioral rules.
 * Task-specific context (title, description, goal, room background) is delivered
 * via the initial user message built by buildGeneralTaskMessage().
 */
export function buildGeneralSystemPrompt(): string {
	const sections: string[] = [];

	sections.push(`You are a General Agent working on a task within a larger goal.`);
	sections.push(`Your job is to complete the task described below to the best of your ability.`);
	sections.push(
		`Use whatever tools are appropriate for the task. When you are done, simply finish your response.`
	);

	return sections.join('\n');
}

/**
 * Build the initial user message for the General agent.
 *
 * Contains task-specific context: task title/description, goal context,
 * project background, room instructions, and previous task summaries.
 * This is what the user sees in the UI as the agent's starting prompt.
 */
export function buildGeneralTaskMessage(config: GeneralAgentConfig): string {
	const { task, goal, room, previousTaskSummaries } = config;

	const sections: string[] = [];

	// Task context
	sections.push(`## Task\n`);
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

	sections.push(`\nBegin working on this task.`);

	return sections.join('\n');
}

/**
 * Create an AgentSessionInit for a General agent session.
 *
 * The General agent uses the Claude Code preset (standard tools)
 * with a behavioral system prompt appended. Task-specific context is
 * delivered via the initial user message (buildGeneralTaskMessage).
 */
export function createGeneralAgentInit(config: GeneralAgentConfig): AgentSessionInit {
	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: buildGeneralSystemPrompt(),
		},
		features: GENERAL_FEATURES,
		context: { roomId: config.room.id },
		type: 'general',
		model: config.model ?? DEFAULT_GENERAL_MODEL,
	};
}
