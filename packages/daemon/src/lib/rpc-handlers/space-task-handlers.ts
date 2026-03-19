/**
 * Space Task RPC Handlers
 *
 * RPC handlers for SpaceTask CRUD operations:
 * - spaceTask.create - Create a task in a Space
 * - spaceTask.list   - List tasks in a Space
 * - spaceTask.get    - Get a task by ID
 * - spaceTask.update - Update task fields (metadata and status with transition validation)
 */

import type { MessageHub } from '@neokai/shared';
import type { CreateSpaceTaskParams, UpdateSpaceTaskParams, SpaceTaskStatus } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceTaskManager } from '../space/managers/space-task-manager';
import { Logger } from '../logger';

const log = new Logger('space-task-handlers');

/**
 * Factory that creates a SpaceTaskManager bound to a specific spaceId.
 * Injected so tests can substitute a mock manager.
 */
export type SpaceTaskManagerFactory = (spaceId: string) => SpaceTaskManager;

export function setupSpaceTaskHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager,
	taskManagerFactory: SpaceTaskManagerFactory,
	daemonHub: DaemonHub
): void {
	// ─── spaceTask.create ───────────────────────────────────────────────────────
	messageHub.onRequest('spaceTask.create', async (data) => {
		const params = data as CreateSpaceTaskParams;

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.title || params.title.trim() === '') {
			throw new Error('title is required');
		}
		if (params.description === undefined || params.description === null) {
			throw new Error('description is required');
		}

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const taskManager = taskManagerFactory(params.spaceId);
		const { spaceId, ...rest } = params;
		const task = await taskManager.createTask(rest);

		daemonHub
			.emit('space.task.created', {
				sessionId: 'global',
				spaceId,
				taskId: task.id,
				task,
			})
			.catch((err) => {
				log.warn('Failed to emit space.task.created:', err);
			});

		return task;
	});

	// ─── spaceTask.list ─────────────────────────────────────────────────────────
	messageHub.onRequest('spaceTask.list', async (data) => {
		const params = data as { spaceId: string; includeArchived?: boolean };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const taskManager = taskManagerFactory(params.spaceId);
		return taskManager.listTasks(params.includeArchived ?? false);
	});

	// ─── spaceTask.get ──────────────────────────────────────────────────────────
	messageHub.onRequest('spaceTask.get', async (data) => {
		const params = data as { spaceId: string; taskId: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}

		const taskManager = taskManagerFactory(params.spaceId);
		const task = await taskManager.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
		}

		return task;
	});

	// ─── spaceTask.update ───────────────────────────────────────────────────────
	messageHub.onRequest('spaceTask.update', async (data) => {
		const params = data as { spaceId: string; taskId: string } & UpdateSpaceTaskParams;

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}

		const { spaceId, taskId, ...updateParams } = params;
		const taskManager = taskManagerFactory(spaceId);

		let task;

		// If status is being changed, use the validated transition method
		if (updateParams.status !== undefined) {
			task = await taskManager.setTaskStatus(taskId, updateParams.status as SpaceTaskStatus, {
				result: updateParams.result ?? undefined,
				error: updateParams.error ?? undefined,
			});
		} else {
			// General field update via manager's updateTask
			task = await taskManager.updateTask(taskId, updateParams);
		}

		daemonHub
			.emit('space.task.updated', {
				sessionId: 'global',
				spaceId,
				taskId,
				task,
			})
			.catch((err) => {
				log.warn('Failed to emit space.task.updated:', err);
			});

		return task;
	});
}
