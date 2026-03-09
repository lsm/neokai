/**
 * Human Message Routing
 *
 * Routes a human message to the worker or leader session.
 * No state gates - messages can be sent to either agent at any time.
 */

import type { RoomRuntime } from './room-runtime';
import type { SessionGroupRepository } from '../state/session-group-repository';

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
		return { success: false, error: 'Task is already completed or failed' };
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
