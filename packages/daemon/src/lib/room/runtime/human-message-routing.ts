/**
 * Human Message Routing
 *
 * Routes a human message to the worker or leader session.
 * - Active groups: messages are injected directly
 * - needs_attention tasks: group is reset and task transitions to in_progress before injecting
 * - cancelled/completed tasks: messages are blocked (caller should use set_task_status to restart)
 */

import type { TaskStatus } from '@neokai/shared';
import type { RoomRuntime } from './room-runtime';
import type { SessionGroupRepository } from '../state/session-group-repository';

export interface TaskOperator {
	getTask(taskId: string): Promise<{ status: TaskStatus } | null>;
	setTaskStatus(
		taskId: string,
		status: TaskStatus,
		options?: { result?: string; error?: string }
	): Promise<unknown>;
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
		// Get the task to check its status - we may be able to restart a needs_attention task
		const task = await taskManager.getTask(taskId);
		if (!task) {
			return { success: false, error: 'Task not found' };
		}

		// Only needs_attention tasks can be restarted via message injection.
		// Cancelled tasks have their workspace cleaned up on cancellation, so
		// restarting them via session injection would point at a gone workspace.
		// Completed tasks are terminal. For both, the caller should use set_task_status.
		if (task.status !== 'needs_attention') {
			return {
				success: false,
				error: `Task is in '${task.status}' status and cannot receive messages. Use set_task_status to restart it.`,
			};
		}

		// Save previous status for potential rollback
		const previousStatus = task.status;

		// Reset the group for restart (clears completedAt, resets state, bumps version)
		const resetGroup = groupRepo.resetGroupForRestart(group.id);
		if (!resetGroup) {
			return { success: false, error: 'Failed to reset task group for restart' };
		}

		// Transition task to in_progress
		try {
			await taskManager.setTaskStatus(taskId, 'in_progress');
		} catch (error) {
			// Rollback group state on failure (use the version returned by resetGroupForRestart)
			groupRepo.failGroup(group.id, resetGroup.version);
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
			// Rollback: restore group to needs_attention state and revert task status
			groupRepo.failGroup(group.id, resetGroup.version);
			try {
				await taskManager.setTaskStatus(taskId, previousStatus);
			} catch {
				// Rollback failure is best-effort; swallow to avoid masking the injection error
			}
			return {
				success: false,
				error: `Failed to inject message into ${target} session`,
			};
		}

		return { success: true };
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
