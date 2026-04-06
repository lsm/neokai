/**
 * Human Message Routing
 *
 * Routes a human message to the worker or leader session of an **active** group.
 * Uses getActiveGroupsForTask() to find only groups where completed_at IS NULL.
 *
 * Callers are responsible for pre-processing tasks before calling this function:
 * - needs_attention/cancelled → caller should use runtime.reviveTaskForMessage()
 * - completed → caller should use runtime.reviveTaskForMessage() or block with an error
 * - in_progress with no active group (phase transition) → caller should reviveTaskForMessage()
 * - archived → caller should block immediately (terminal state)
 */

import type { RoomRuntime } from './room-runtime';
import type { SessionGroupRepository } from '../state/session-group-repository';

export interface HumanMessageResult {
	success: boolean;
	error?: string;
}

export type HumanMessageTarget = 'worker' | 'leader';

/**
 * Route a human message to the specified agent of an active session group.
 * Returns an error if no active (completedAt = null) group exists for the task.
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
	const activeGroups = groupRepo.getActiveGroupsForTask(taskId);

	if (activeGroups.length === 0) {
		return { success: false, error: 'No active session group found for this task' };
	}

	// Simple routing — at least one active group exists
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
