/**
 * Message Routing - Formats messages between Craft and Lead agents
 *
 * Handles the structured envelope format for Craft → Lead routing
 * and the feedback format for Lead → Craft routing.
 */

import type { TerminalStateKind } from './session-observer';

export interface CraftOutputEnvelopeParams {
	/** Current feedback iteration number */
	iteration: number;
	/** Task title for context */
	taskTitle: string;
	/** Task type (coding, planning, etc.) */
	taskType?: string;
	/** How Craft's turn ended */
	terminalState: TerminalStateKind;
	/** Summary of tool calls made by Craft */
	toolCallSummaries?: string[];
	/** The actual Craft assistant output */
	craftOutput: string;
}

/**
 * Format Craft output as a structured envelope for Lead review.
 *
 * This is injected into the Lead session as a user message.
 */
export function formatCraftToLeadEnvelope(params: CraftOutputEnvelopeParams): string {
	const lines: string[] = [];

	lines.push(`[CRAFT OUTPUT] Iteration: ${params.iteration}`);
	lines.push(`Task: ${params.taskTitle}`);
	if (params.taskType) {
		lines.push(`Task type: ${params.taskType}`);
	}
	lines.push(`Terminal state: ${terminalStateLabel(params.terminalState)}`);
	if (params.toolCallSummaries && params.toolCallSummaries.length > 0) {
		lines.push(`Tool calls: ${JSON.stringify(params.toolCallSummaries)}`);
	}
	lines.push('---');
	lines.push(params.craftOutput);

	return lines.join('\n');
}

function terminalStateLabel(kind: TerminalStateKind): string {
	switch (kind) {
		case 'completed':
			return 'success';
		case 'waiting_for_input':
			return 'question';
		case 'interrupted':
			return 'interrupted';
	}
}

/**
 * Format Lead feedback for injection into Craft session.
 *
 * This is injected into the Craft session as a user message.
 */
export function formatLeadToCraftFeedback(feedback: string, iteration: number): string {
	return `[LEAD FEEDBACK] Iteration: ${iteration}\n---\n${feedback}`;
}

/**
 * Format the Lead contract nudge message.
 * Injected when Lead fails to call a required tool.
 */
export function formatLeadContractNudge(): string {
	return 'You must call exactly one of: send_to_craft, complete_task, or fail_task. Do NOT respond with only text.';
}

/**
 * Priority ordering for task selection.
 * Returns a numeric value for sorting (lower = higher priority).
 */
export function priorityOrder(priority: string): number {
	switch (priority) {
		case 'urgent':
			return 0;
		case 'high':
			return 1;
		case 'normal':
			return 2;
		case 'low':
			return 3;
		default:
			return 2;
	}
}

/**
 * Sort tasks by priority (descending) then creation time (ascending).
 */
export function sortTasksByPriority<T extends { priority: string; createdAt: number; id: string }>(
	tasks: T[]
): T[] {
	return [...tasks].sort((a, b) => {
		const pDiff = priorityOrder(a.priority) - priorityOrder(b.priority);
		if (pDiff !== 0) return pDiff;
		const tDiff = a.createdAt - b.createdAt;
		if (tDiff !== 0) return tDiff;
		return a.id.localeCompare(b.id);
	});
}
