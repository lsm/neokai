/**
 * Human Message Routing
 *
 * Routes a human message to the worker or leader session of an **active** group.
 * - Active groups (completedAt = null): messages are injected directly
 * - Terminated groups (completedAt set): messages are blocked regardless of status
 *
 * Callers are responsible for pre-processing terminated tasks before calling this
 * function. For example:
 * - needs_attention → caller should use runtime.reviveTaskForMessage()
 * - cancelled/completed → caller should block with a user-facing error
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
 * Route a human message to the specified agent of an active session group.
 * Returns an error if the group is terminated (completedAt is set).
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

	// Terminated groups cannot accept injected messages. Callers must revive or
	// restart the task through the appropriate path before calling this function.
	if (group.completedAt !== null) {
		const task = await taskManager.getTask(taskId);
		const statusLabel = task ? `'${task.status}' status` : 'a terminated state';
		return {
			success: false,
			error: `Task is in ${statusLabel} and cannot receive messages. Use the appropriate restart mechanism.`,
		};
	}

	// Simple routing — group is active
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
