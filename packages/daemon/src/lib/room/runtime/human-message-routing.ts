/**
 * Human Message Routing
 *
 * Shared helper that routes a human message to the correct agent(s) based on
 * the current state of the session group associated with a task.
 *
 * State routing (auto mode):
 * - awaiting_human  → inject into worker (resume from human approval/rejection)
 * - awaiting_leader → inject into leader + append to group timeline
 * - awaiting_worker → error (unless explicit target=worker)
 * - completed       → error: task is already completed
 * - failed          → error: task has already failed
 * - no group        → error: no active session group for the task
 */

import type { MessageHub } from '@neokai/shared';
import type { RoomRuntime } from './room-runtime';
import type { SessionGroupRepository } from '../state/session-group-repository';

export interface HumanMessageResult {
	success: boolean;
	error?: string;
}

export type HumanMessageTarget = 'auto' | 'worker' | 'leader';

/**
 * Route a human message to the correct agent based on the group's current state.
 *
 * @param runtime       The RoomRuntime instance for the room
 * @param groupRepo     The SessionGroupRepository for DB access
 * @param taskId        The task ID to route the message to
 * @param message       The human message content
 * @param target        Optional explicit target agent ('auto' | 'worker' | 'leader')
 */
export async function routeHumanMessageToGroup(
	runtime: RoomRuntime,
	groupRepo: SessionGroupRepository,
	taskId: string,
	message: string,
	target: HumanMessageTarget = 'auto',
	_messageHub?: MessageHub
): Promise<HumanMessageResult> {
	const group = groupRepo.getGroupByTaskId(taskId);

	if (!group) {
		return { success: false, error: 'No active session group found for this task' };
	}

	if (group.state === 'completed') {
		return { success: false, error: 'Task is already completed' };
	}
	if (group.state === 'failed') {
		return { success: false, error: 'Task has already failed' };
	}

	if (target === 'worker') {
		if (group.state === 'awaiting_human') {
			// Worker is paused waiting for human — resume by injecting into worker.
			const resumed = await runtime.resumeWorkerFromHuman(taskId, message, { approved: false });
			if (!resumed) {
				return { success: false, error: 'Failed to resume worker from human message' };
			}
			return { success: true };
		}

		const injected = await runtime.injectMessageToWorker(taskId, message);
		if (!injected) {
			return { success: false, error: 'Failed to inject message into worker session' };
		}
		return { success: true };
	}

	if (target === 'leader') {
		const injected = await runtime.injectMessageToLeader(taskId, message);
		if (!injected) {
			return { success: false, error: 'Failed to inject message into leader session' };
		}
		return { success: true };
	}

	// Auto mode (backward-compatible): route by state.
	switch (group.state) {
		case 'awaiting_human': {
			const resumed = await runtime.resumeWorkerFromHuman(taskId, message, { approved: false });
			if (!resumed) {
				return { success: false, error: 'Failed to resume worker from human message' };
			}
			return { success: true };
		}

		case 'awaiting_leader': {
			const injected = await runtime.injectMessageToLeader(taskId, message);
			if (!injected) {
				return { success: false, error: 'Failed to inject message into leader session' };
			}
			return { success: true };
		}

		case 'awaiting_worker':
			return {
				success: false,
				error: 'Worker is running — wait for leader review before sending messages',
			};

		default:
			return { success: false, error: `Unexpected group state: ${group.state}` };
	}
}
