/**
 * Human Message Routing
 *
 * Routes a human message to the worker or leader session.
 * - Active groups: messages are injected directly
 * - Failed tasks: group is reset and task transitions to in_progress before injecting
 */

import type { TaskStatus } from '@neokai/shared';
import type { RoomRuntime } from './room-runtime';
import type { SessionGroupRepository } from '../state/session-group-repository';
import { VALID_STATUS_TRANSITIONS } from '../managers/task-manager';

export interface TaskOperator {
	getTask(taskId: string): Promise<{ status: TaskStatus } | null>;
	setTaskStatus(taskId: string, status: TaskStatus, options?: { result?: string; error?: string }): Promise<unknown>;
}

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
 * @param taskManager   The TaskManager for task operations
 * @param taskId        The task ID to route the message to
 * @param message       The human message content
 * @param target        Target agent ('worker' | 'leader'), defaults to 'worker'
 */
export async function routeHumanMessageToGroup(
	runtime: RoomRuntime,
	groupRepo: SessionGroupRepository,
	taskManager: TaskOperator,
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
		const task = await taskManager.getTask(taskId);
		if (!task) {
			return { success: false, error: 'Task not found' };
		}

		// Allow restarting failed (or cancelled) tasks - transition to in_progress
		if (task.status === 'failed' || task.status === 'cancelled') {
			const allowedTransitions = VALID_STATUS_TRANSITIONS[task.status as TaskStatus];
			if (!allowedTransitions.includes('in_progress')) {
				return { success: false, error: `Task in '${task.status}' status cannot be restarted` };
			}

			// Save previous status for potential rollback
			const previousStatus = task.status;
			const previousVersion = group.version;

			// Reset the group for restart (clears completedAt, resets state)
			const reset = groupRepo.resetGroupForRestart(group.id);
			if (!reset) {
				return { success: false, error: 'Failed to reset task group for restart' };
			}

			// Transition task to in_progress
			try {
				await taskManager.setTaskStatus(taskId, 'in_progress');
			} catch (error) {
				// Rollback group state on failure (group was already reset, so use previousVersion + 1)
				groupRepo.failGroup(group.id, previousVersion + 1);
				return { success: false, error: `Failed to transition task to in_progress: ${error}` };
			}

			// Try to inject the message
			let injected = false;
			if (target === 'leader') {
				injected = await runtime.injectMessageToLeader(taskId, message);
			} else {
				injected = await runtime.injectMessageToWorker(taskId, message);
			}

			// If injection failed, rollback the status and group changes
			if (!injected) {
				// Rollback: restore group to failed state and revert task status
				groupRepo.failGroup(group.id, previousVersion + 1);
				try {
					await taskManager.setTaskStatus(taskId, previousStatus);
				} catch {
					// Rollback failure is logged but the main error is the injection failure
				}
				return {
					success: false,
					error: `Failed to inject message into ${target} session`,
				};
			}

			return { success: true };
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
