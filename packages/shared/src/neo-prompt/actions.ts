/**
 * Neo Prompt Actions - Utilities for building and parsing Neo actions
 *
 * Provides functions for:
 * - Building room-specific system prompts
 * - Parsing structured commands from Neo's responses
 * - Extracting text content from responses
 */

import type { Room, SessionSummary, TaskSummary } from '../types/neo';
import { _ROOM_NEO_SYSTEM_PROMPT } from './prompt';

/**
 * Parsed action from Neo's response
 */
export interface NeoAction {
	type: string;
	params: Record<string, string>;
}

/**
 * Build the system prompt for a specific room
 */
export function buildRoomPrompt(
	room: Room,
	sessions: SessionSummary[],
	tasks: TaskSummary[]
): string {
	return _ROOM_NEO_SYSTEM_PROMPT
		.replace('{roomName}', room.name)
		.replace('{roomDescription}', room.description || 'No description')
		.replace('{activeSessions}', sessions.length.toString())
		.replace('{pendingTasks}', tasks.filter((t) => t.status === 'pending').length.toString());
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
 * Extract text response (non-action content) from Neo's response
 */
function _extractTextResponse(response: string): string {
	// Remove neo blocks from the response
	const textResponse = response.replace(/```neo\s*\n[\s\S]*?```/g, '').trim();
	return textResponse;
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
