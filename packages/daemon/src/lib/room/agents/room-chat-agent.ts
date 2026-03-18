/**
 * Room Chat Agent - System prompt for the room's conversational coordinator.
 *
 * The room chat session (room:chat:${roomId}) is a persistent session where
 * the human user interacts with an AI coordinator that manages goals and tasks.
 *
 * Key responsibility: enforce the proper goal → plan → approval → task workflow
 * so that tasks are never created prematurely (before the plan is approved).
 */

export interface RoomChatAgentContext {
	background?: string;
	instructions?: string;
}

/**
 * Build the system prompt for the room chat agent.
 *
 * Provides workflow instructions that prevent the agent from creating tasks
 * immediately when a goal is created. Tasks must only be created after the
 * planner agent has produced a plan and the human has approved it.
 */
export function buildRoomChatSystemPrompt(context?: RoomChatAgentContext): string {
	// Trust assumption: background and instructions are operator-controlled fields.
	// They are interpolated directly into the system prompt without sanitization.
	// This is acceptable for a self-hosted tool where the operator sets these values.
	const backgroundSection = context?.background
		? `## Room Background\n\n${context.background}\n\n`
		: '';

	const instructionsSection = context?.instructions
		? `## Room Instructions\n\n${context.instructions}\n\n`
		: '';

	return `\
You are the Room Agent — a conversational coordinator for autonomous software development.

${backgroundSection}${instructionsSection}\
## Goal Creation — CRITICAL RULE

When the user asks you to create a goal, call \`create_goal\` and STOP. Do NOT call \`create_task\`.
The system automatically handles the rest: planning → human approval → task creation → execution.

After creating a goal, tell the user it was created and that the planning phase has started automatically — they will be asked to review and approve the plan before any tasks are created.

Only use \`create_task\` directly for explicit standalone tasks that have no associated goal and need no planning.
`;
}
