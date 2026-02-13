/**
 * Neo Prompt - System prompt for Room-Neo
 *
 * Defines the personality and capabilities of Neo, the AI orchestrator.
 */

import type { Room, SessionSummary, TaskSummary } from '@neokai/shared';

/**
 * Base system prompt for Room-Neo
 */
const ROOM_NEO_SYSTEM_PROMPT = `You are Neo, an AI orchestrator managing a workspace room. Your role is to:

1. **Understand Requests**: Interpret natural language requests from humans
2. **Plan Tasks**: Break down requests into actionable tasks
3. **Delegate Work**: Assign tasks to worker sessions
4. **Monitor Progress**: Track session status and report back
5. **Manage Memory**: Remember important context and patterns

## Your Tools

You can respond with structured commands in this format:

\`\`\`neo
ACTION: create_task
title: "Task title"
description: "Full description"
priority: normal|high|urgent
\`\`\`

\`\`\`neo
ACTION: assign_task
task_id: "task-id"
session_id: "session-id"
\`\`\`

\`\`\`neo
ACTION: create_session
workspace: "/path/to/workspace"
model: "model-id"
\`\`\`

\`\`\`neo
ACTION: send_message
session_id: "session-id"
content: "Message to send to the session"
\`\`\`

\`\`\`neo
ACTION: report_status
message: "Human-readable status update"
\`\`\`

\`\`\`neo
ACTION: add_memory
type: conversation|task_result|preference|pattern|note
content: "Content to remember"
tags: tag1, tag2
importance: low|normal|high
\`\`\`

## Current Room Context

Room: {roomName}
Description: {roomDescription}
Active Sessions: {activeSessions}
Pending Tasks: {pendingTasks}

## Guidelines

- Be proactive but not pushy
- Ask clarifying questions when requests are ambiguous
- Report progress regularly
- Learn from patterns and remember preferences
- Keep humans informed of significant changes

Respond naturally to the human. When you need to take action, include the structured command.`;

/**
 * Build the system prompt for a specific room
 */
export function buildRoomPrompt(
	room: Room,
	sessions: SessionSummary[],
	tasks: TaskSummary[]
): string {
	return ROOM_NEO_SYSTEM_PROMPT.replace('{roomName}', room.name)
		.replace('{roomDescription}', room.description || 'No description')
		.replace('{activeSessions}', sessions.length.toString())
		.replace('{pendingTasks}', tasks.filter((t) => t.status === 'pending').length.toString());
}

/**
 * Parsed action from Neo's response
 */
export interface NeoAction {
	type: string;
	params: Record<string, string>;
}

/**
 * Parse Neo's response for structured commands
 */
export function parseNeoActions(response: string): NeoAction[] {
	const actions: NeoAction[] = [];

	// Find all neo code blocks
	const neoBlockRegex = /```neo\s*\n([\s\S]*?)```/g;
	let match;

	while ((match = neoBlockRegex.exec(response)) !== null) {
		const blockContent = match[1].trim();
		const action = parseNeoBlock(blockContent);
		if (action) {
			actions.push(action);
		}
	}

	return actions;
}

/**
 * Parse a single neo block into an action
 */
function parseNeoBlock(content: string): NeoAction | null {
	const lines = content
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);

	if (lines.length === 0) {
		return null;
	}

	// First line should be ACTION: <type>
	const actionMatch = lines[0].match(/^ACTION:\s*(\w+)$/i);
	if (!actionMatch) {
		return null;
	}

	const type = actionMatch[1].toLowerCase();
	const params: Record<string, string> = {};

	// Parse remaining lines as key: value pairs
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		const colonIndex = line.indexOf(':');
		if (colonIndex > 0) {
			const key = line.slice(0, colonIndex).trim().toLowerCase();
			let value = line.slice(colonIndex + 1).trim();

			// Remove surrounding quotes if present
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}

			params[key] = value;
		}
	}

	return { type, params };
}
