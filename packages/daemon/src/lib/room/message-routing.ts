/**
 * Message Routing - Formats messages between Worker and Leader agents
 *
 * Handles the structured envelope format for Worker → Leader routing
 * and the feedback format for Leader → Worker routing.
 */

import type { TerminalStateKind } from './session-observer';
import type { NeoTask } from '@neokai/shared';

export interface WorkerOutputEnvelopeParams {
	/** Current feedback iteration number */
	iteration: number;
	/** Task title for context */
	taskTitle: string;
	/** Task type (coding, planning, etc.) */
	taskType?: string;
	/** How the worker's turn ended */
	terminalState: TerminalStateKind;
	/** Summary of tool calls made by worker */
	toolCallSummaries?: string[];
	/** The actual worker assistant output */
	workerOutput: string;
}

/**
 * Format worker output as a structured envelope for Leader review.
 *
 * This is injected into the Leader session as a user message.
 */
export function formatWorkerToLeaderEnvelope(params: WorkerOutputEnvelopeParams): string {
	const lines: string[] = [];

	lines.push(`[WORKER OUTPUT] Iteration: ${params.iteration}`);
	lines.push(`Task: ${params.taskTitle}`);
	if (params.taskType) {
		lines.push(`Task type: ${params.taskType}`);
	}
	lines.push(`Terminal state: ${params.terminalState}`);
	if (params.toolCallSummaries && params.toolCallSummaries.length > 0) {
		lines.push(`Tool calls: ${JSON.stringify(params.toolCallSummaries)}`);
	}
	lines.push('---');
	lines.push(params.workerOutput);

	return lines.join('\n');
}

export interface PlanEnvelopeParams {
	/** Current feedback iteration number */
	iteration: number;
	/** Goal title for context */
	goalTitle: string;
	/** How the planner's turn ended */
	terminalState: TerminalStateKind;
	/** The actual planner assistant output */
	workerOutput: string;
	/** Draft tasks created by the planner */
	draftTasks: Array<Pick<NeoTask, 'id' | 'title' | 'description' | 'priority' | 'assignedAgent'>>;
}

/**
 * Format planner output as a structured envelope for Leader review.
 * Includes the list of draft tasks so the Leader can evaluate the plan.
 */
export function formatPlanEnvelope(params: PlanEnvelopeParams): string {
	const lines: string[] = [];

	lines.push(`[PLANNER OUTPUT] Iteration: ${params.iteration}`);
	lines.push(`Goal: ${params.goalTitle}`);
	lines.push(`Tasks created: ${params.draftTasks.length}`);
	lines.push(`Terminal state: ${params.terminalState}`);
	lines.push('---');
	lines.push(params.workerOutput);

	if (params.draftTasks.length > 0) {
		lines.push('');
		lines.push('## Current Plan');
		lines.push('');
		for (let i = 0; i < params.draftTasks.length; i++) {
			const t = params.draftTasks[i];
			lines.push(
				`${i + 1}. **${t.title}** (agent: ${t.assignedAgent ?? 'coder'}, priority: ${t.priority})`
			);
			lines.push(`   ${t.description}`);
			lines.push(`   _Task ID: ${t.id}_`);
			lines.push('');
		}
	}

	return lines.join('\n');
}

/**
 * Format Leader feedback for injection into worker session.
 *
 * This is injected into the worker session as a user message.
 */
export function formatLeaderToWorkerFeedback(feedback: string, iteration: number): string {
	return `[LEADER FEEDBACK] Iteration: ${iteration}\n---\n${feedback}`;
}

/**
 * Format the Leader contract nudge message.
 * Injected when Leader fails to call a required tool.
 */
export function formatLeaderContractNudge(): string {
	return 'You must call exactly one of: send_to_worker, complete_task, or fail_task. Do NOT respond with only text.';
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
