/**
 * Space Task Message RPC Handlers
 *
 * RPC handlers for human ↔ Task Agent message routing:
 * - space.task.sendMessage — inject a human message into a Task Agent session
 * - space.task.getMessages — paginated snapshot of messages from a Task Agent session
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { AgentSession } from '../agent/agent-session';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import { Logger } from '../logger';

const log = new Logger('space-task-message-handlers');

/**
 * Minimal interface for interacting with the Task Agent manager.
 * Decouples RPC handlers from the concrete TaskAgentManager class.
 */
export interface TaskAgentManagerInterface {
	/** Ensure a Task Agent session exists for the given task and return latest task snapshot. */
	ensureTaskAgentSession(taskId: string): Promise<import('@neokai/shared').SpaceTask>;
	/** Inject a message into the Task Agent session for the given task. */
	injectTaskAgentMessage(taskId: string, message: string): Promise<void>;
	/** Returns the live AgentSession for the given task, or undefined if not spawned. */
	getTaskAgent(taskId: string): AgentSession | undefined;
}

/**
 * Register RPC handlers for human ↔ Task Agent message routing.
 *
 * Separate from `setupSpaceTaskHandlers` because it requires a live
 * `TaskAgentManager` instance, which is created after `SpaceRuntimeService`.
 *
 * Handlers:
 *   space.task.sendMessage  — inject a human message into a Task Agent session
 *   space.task.getMessages  — paginated snapshot of messages from a Task Agent session
 */
export function setupSpaceTaskMessageHandlers(
	messageHub: MessageHub,
	taskAgentManager: TaskAgentManagerInterface,
	db: Database,
	daemonHub: DaemonHub
): void {
	const taskRepo = new SpaceTaskRepository(db.getDatabase());

	// ─── space.task.ensureAgentSession ──────────────────────────────────────────
	messageHub.onRequest('space.task.ensureAgentSession', async (data) => {
		const params = data as { spaceId: string; taskId: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}

		// Validate task exists and belongs to the given space
		const task = taskRepo.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
		}
		if (task.spaceId !== params.spaceId) {
			throw new Error(`Task not found: ${params.taskId}`);
		}

		const updatedTask = await taskAgentManager.ensureTaskAgentSession(params.taskId);

		await daemonHub.emit('space.task.updated', {
			sessionId: 'global',
			spaceId: params.spaceId,
			taskId: params.taskId,
			task: updatedTask,
		});

		log.info(`space.task.ensureAgentSession: ensured session for task ${params.taskId}`);

		return {
			taskId: updatedTask.id,
			sessionId: updatedTask.taskAgentSessionId ?? null,
			task: updatedTask,
		};
	});

	// ─── space.task.sendMessage ─────────────────────────────────────────────────
	messageHub.onRequest('space.task.sendMessage', async (data) => {
		const params = data as { spaceId: string; taskId: string; message: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}
		if (!params.message || params.message.trim() === '') {
			throw new Error('message is required');
		}
		if (params.message.length > 10_000) {
			throw new Error('Message is too long (max 10,000 characters)');
		}

		// Validate task exists and belongs to the given space
		const task = taskRepo.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
		}
		if (task.spaceId !== params.spaceId) {
			throw new Error(`Task not found: ${params.taskId}`);
		}

		// Ensure a live Task Agent session exists before injecting. This recovers from:
		// - first message on a task that has not spawned yet
		// - persisted-but-not-live sessions after daemon restart
		const sessionBefore = task.taskAgentSessionId ?? null;
		const ensuredTask = await taskAgentManager.ensureTaskAgentSession(params.taskId);
		const sessionAfter = ensuredTask.taskAgentSessionId ?? null;

		if (sessionAfter !== sessionBefore) {
			await daemonHub.emit('space.task.updated', {
				sessionId: 'global',
				spaceId: params.spaceId,
				taskId: params.taskId,
				task: ensuredTask,
			});
		}

		await taskAgentManager.injectTaskAgentMessage(params.taskId, params.message);
		log.info(`space.task.sendMessage: injected message into task ${params.taskId}`);

		return { ok: true };
	});

	// ─── space.task.getMessages ─────────────────────────────────────────────────
	messageHub.onRequest('space.task.getMessages', async (data) => {
		const params = data as {
			spaceId: string;
			taskId: string;
			cursor?: string;
			limit?: number;
		};

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}

		// Validate task exists and belongs to the given space
		const task = taskRepo.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
		}
		if (task.spaceId !== params.spaceId) {
			throw new Error(`Task not found: ${params.taskId}`);
		}
		if (!task.taskAgentSessionId) {
			throw new Error(`Task Agent session not started for task: ${params.taskId}`);
		}

		const sessionId = task.taskAgentSessionId;
		const limit = Math.max(1, Math.min(params.limit ?? 50, 200));

		// Parse cursor as a numeric timestamp for the `before` DB filter
		let before: number | undefined;
		if (params.cursor) {
			const parsed = Number(params.cursor);
			if (!Number.isNaN(parsed)) {
				before = parsed;
			}
		}

		// Prefer reading from the live in-memory session (if the Task Agent is active),
		// falling back to the DB for completed or restarted sessions.
		const liveSession = taskAgentManager.getTaskAgent(params.taskId);
		const { messages, hasMore } = liveSession
			? liveSession.getSDKMessages(limit, before)
			: db.getSDKMessages(sessionId, limit, before);

		return { messages, hasMore, sessionId };
	});
}
