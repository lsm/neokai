/**
 * Neo Prompt Actions - Utilities for building room prompts
 */

import type { Room, SessionSummary, TaskSummary } from '../types/neo';
import { _ROOM_NEO_SYSTEM_PROMPT } from './prompt';

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
