/**
 * Human Message Routing
 *
 * Shared helper that routes a human message to the correct agent(s) based on
 * the current state of the session group associated with a task.
 *
 * State routing:
 * - awaiting_human  → inject into worker (resume from human approval/rejection)
 * - awaiting_leader → inject into leader + append to group timeline
 * - awaiting_worker → error: worker is running, wait for leader review
 * - completed       → error: task is already completed
 * - failed          → error: task has already failed
 * - no group        → error: no active session group for the task
 */

import type { RoomRuntime } from './room-runtime';
import type { SessionGroupRepository } from '../state/session-group-repository';

export interface HumanMessageResult {
	success: boolean;
	error?: string;
}

/**
 * Route a human message to the correct agent based on the group's current state.
 *
 * @param runtime       The RoomRuntime instance for the room
 * @param groupRepo     The SessionGroupRepository for DB access
 * @param taskId        The task ID to route the message to
 * @param message       The human message content
 */
export async function routeHumanMessageToGroup(
	runtime: RoomRuntime,
	groupRepo: SessionGroupRepository,
	taskId: string,
	message: string
): Promise<HumanMessageResult> {
	const group = groupRepo.getGroupByTaskId(taskId);

	if (!group) {
		return { success: false, error: 'No active session group found for this task' };
	}

	switch (group.state) {
		case 'awaiting_human': {
			// Worker is paused waiting for human — inject directly into worker.
			// resumeWorkerFromHuman() appends the message internally; do NOT call appendMessage here.
			const resumed = await runtime.resumeWorkerFromHuman(taskId, message, { approved: false });
			if (!resumed) {
				return { success: false, error: 'Failed to resume worker from human message' };
			}
			return { success: true };
		}

		case 'awaiting_leader': {
			// Leader is actively reviewing — inject message and record it in the timeline.
			// Note: injectMessageToLeader writes to the SDK messages table only; we must
			// also explicitly append to session_group_messages so it appears in the UI.
			// This is NOT a double-write — the two paths write to different tables.
			const injected = await runtime.injectMessageToLeader(taskId, message);
			if (!injected) {
				return { success: false, error: 'Failed to inject message into leader session' };
			}
			// Store as a 'user' message with JSON content so the frontend renderer can
			// parse it (renderer calls JSON.parse for all non-'status' message types).
			groupRepo.appendMessage({
				groupId: group.id,
				role: 'human',
				messageType: 'user',
				content: JSON.stringify({
					type: 'user',
					message: {
						role: 'user',
						content: [{ type: 'text', text: message }],
					},
					_taskMeta: {
						authorRole: 'human',
						authorSessionId: '',
						turnId: `human_${group.id}_${group.feedbackIteration}`,
						iteration: group.feedbackIteration,
					},
				}),
			});
			return { success: true };
		}

		case 'awaiting_worker':
			return {
				success: false,
				error: 'Worker is running — wait for leader review before sending messages',
			};

		case 'completed':
			return { success: false, error: 'Task is already completed' };

		case 'failed':
			return { success: false, error: 'Task has already failed' };

		default:
			return { success: false, error: `Unexpected group state: ${group.state}` };
	}
}
