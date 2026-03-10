/**
 * Human Message Routing
 *
 * Routes a human message to the worker or leader session.
 * - Active groups: messages are injected directly
 * - Failed tasks: group is reset and task transitions to in_progress before injecting
 */

import type { RoomRuntime } from './room-runtime';
import type { SessionGroupRepository } from '../state/session-group-repository';
import { VALID_STATUS_TRANSITIONS } from '../managers/task-manager';
import type { TaskStatus } from '@neokai/shared';

export interface HumanMessageResult {
	success: boolean;
	error?: string;
}

export type HumanMessageTarget = 'worker' | 'leader';

/**
 * Route a human message to the specified agent.
 *
 * @param runtime       The RoomRuntime instance for the room
 * @param groupRepo     The SessionGroupRepository for DB access
 * @param taskId        The task ID to route the message to
 * @param message       The human message content
 * @param target        Target agent ('worker' | 'leader'), defaults to 'worker'
 */
export async function routeHumanMessageToGroup(
	runtime: RoomRuntime,
	groupRepo: SessionGroupRepository,
	taskId: string,
	message: string,
	target: HumanMessageTarget = 'worker'
): Promise<HumanMessageResult> {
	const group = groupRepo.getGroupByTaskId(taskId);

	if (!group) {
		return { success: false, error: 'No active session group found for this task' };
	}

	// Check if group is terminated using completedAt timestamp
	if (group.completedAt !== null) {
		// Get the task to check its status - we may be able to restart a failed task
		const task = await runtime.taskManager.getTask(taskId);
		if (!task) {
			return { success: false, error: 'Task not found' };
		}

		// Allow restarting failed (or cancelled) tasks - transition to in_progress
		if (task.status === 'failed' || task.status === 'cancelled') {
			const allowedTransitions = VALID_STATUS_TRANSITIONS[task.status as TaskStatus];
			if (!allowedTransitions.includes('in_progress')) {
				return { success: false, error: `Task in '${task.status}' status cannot be restarted` };
			}

			// Reset the group for restart (clears completedAt, resets state)
			const reset = groupRepo.resetGroupForRestart(group.id);
			if (!reset) {
				return { success: false, error: 'Failed to reset task group for restart' };
			}

			// Transition task to in_progress
			try {
				await runtime.taskManager.updateTaskStatus(taskId, 'in_progress');
			} catch (error) {
				return { success: false, error: `Failed to transition task to in_progress: ${error}` };
			}
		} else {
			// For other terminated states (completed), still block messages
			return { success: false, error: 'Task is already completed' };
		}
	}

	// Simple routing - no state checks
	if (target === 'leader') {
		const injected = await runtime.injectMessageToLeader(taskId, message);
		return injected
			? { success: true }
			: { success: false, error: 'Failed to inject message into leader session' };
	} else {
		const injected = await runtime.injectMessageToWorker(taskId, message);
		return injected
			? { success: true }
			: { success: false, error: 'Failed to inject message into worker session' };
	}
}
