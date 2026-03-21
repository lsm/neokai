/**
 * Space Task Message RPC Handlers
 *
 * RPC handler for sending messages to Task Agent sessions:
 * - space.task.sendMessage — inject a human or agent message into a Task Agent session
 */

import type { MessageHub } from '@neokai/shared';
import type { TaskAgentManager } from '../space/runtime/task-agent-manager';
import { Logger } from '../logger';

const log = new Logger('space-task-message-handlers');

export function setupSpaceTaskSendMessageHandler(
	messageHub: MessageHub,
	taskAgentManager: TaskAgentManager
): void {
	// ─── space.task.sendMessage ──────────────────────────────────────────────────
	messageHub.onRequest('space.task.sendMessage', async (data) => {
		const params = data as { taskId: string; message: string };

		if (!params.taskId) {
			throw new Error('taskId is required');
		}
		if (!params.message || params.message.trim() === '') {
			throw new Error('message is required');
		}

		if (!taskAgentManager.isTaskAgentAlive(params.taskId)) {
			throw new Error(`No active Task Agent session for task: ${params.taskId}`);
		}

		await taskAgentManager.injectTaskAgentMessage(params.taskId, params.message);
		log.info(`space.task.sendMessage: injected message into task ${params.taskId}`);

		return { ok: true };
	});
}
