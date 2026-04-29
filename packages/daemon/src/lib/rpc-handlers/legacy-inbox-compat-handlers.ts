/**
 * Legacy Inbox compatibility RPC handlers.
 *
 * The Room product surface is retired, but the shipped web Inbox still reads
 * preserved Room task review rows and exposes approve/reject actions. Keep this
 * narrow shim registered until that UI is migrated or removed. Do not expand it
 * into the broader legacy task.* / goal.* / room.* API surface.
 */

import type { MessageHub } from '@neokai/shared';
import type { TaskSummary } from '@neokai/shared/types/neo';
import type { Database } from '../../storage/database';
import type { ReactiveDatabase } from '../../storage/reactive-database';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { SessionGroupRepository } from '../room/state/session-group-repository';
import type { RoomManager } from '../room/managers/room-manager';
import { TaskManager } from '../room/managers/task-manager';
import type { RoomRuntimeService } from '../room/runtime/room-runtime-service';
import { resolveTaskId } from '../id-resolution';
import { toTaskSummary } from '../task-utils';
import { Logger } from '../logger';

const log = new Logger('legacy-inbox-compat-handlers');

export function setupLegacyInboxCompatHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	db: Database,
	reactiveDb: ReactiveDatabase,
	runtimeService: RoomRuntimeService
): void {
	const makeTaskRepo = () => new TaskRepository(db.getDatabase(), reactiveDb);
	const makeGroupRepo = () => new SessionGroupRepository(db.getDatabase(), reactiveDb);
	const makeTaskManager = (roomId: string) =>
		new TaskManager(db.getDatabase(), roomId, reactiveDb, db.getShortIdAllocator());

	messageHub.onRequest('inbox.reviewTasks', async () => {
		const rooms = roomManager.listRooms(false);
		const taskRepo = makeTaskRepo();
		const reviewTasks: Array<{ task: TaskSummary; roomId: string; roomTitle: string }> = [];

		for (const room of rooms) {
			const tasks = taskRepo.listTasks(room.id, { status: 'review' });
			for (const task of tasks) {
				reviewTasks.push({
					task: toTaskSummary(task),
					roomId: room.id,
					roomTitle: room.name,
				});
			}
		}

		reviewTasks.sort((a, b) => b.task.updatedAt - a.task.updatedAt);
		return { tasks: reviewTasks };
	});

	messageHub.onRequest('task.approve', async (data) => {
		const params = data as { roomId?: string; taskId?: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskRepo = makeTaskRepo();
		const taskId = resolveTaskId(params.taskId, params.roomId, taskRepo);
		const taskManager = makeTaskManager(params.roomId);
		const task = await taskManager.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}
		if (task.status !== 'review') {
			throw new Error(`Task is not in review status (current: ${task.status})`);
		}

		const runtime = runtimeService.getRuntime(params.roomId);
		if (!runtime) {
			throw new Error(`No runtime found for room: ${params.roomId}`);
		}

		const message =
			task.taskType === 'planning'
				? 'Your plan has been approved by AI reviewers and the human reviewer. ' +
					'Now merge the plan PR (run `gh pr merge` - do NOT use --delete-branch), ' +
					'then read the plan file under `docs/plans/` and create tasks 1:1 from the approved plan using `create_task`. ' +
					'Each task title and description should match the plan exactly.'
				: 'Human has approved the PR. Merge it now by running `gh pr merge` (do NOT use --delete-branch). ' +
					'After the merge completes, your work is done.';

		const resumed = await runtime.resumeWorkerFromHuman(taskId, message, {
			approved: true,
		});
		if (!resumed) {
			throw new Error(`Failed to resume task ${taskId} - no submitted-for-review group found`);
		}

		log.info(`Task ${taskId} approved by human in room ${params.roomId}`);
		return { success: true };
	});

	messageHub.onRequest('task.reject', async (data) => {
		const params = data as { roomId?: string; taskId?: string; feedback?: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}
		if (!params.feedback || !params.feedback.trim()) {
			throw new Error('Feedback is required for rejection');
		}
		if (params.feedback.length > 10_000) {
			throw new Error('Feedback is too long (max 10,000 characters)');
		}

		const taskRepo = makeTaskRepo();
		const taskId = resolveTaskId(params.taskId, params.roomId, taskRepo);
		const taskManager = makeTaskManager(params.roomId);
		const task = await taskManager.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}
		if (task.status !== 'review') {
			throw new Error(`Task is not in review status (current: ${task.status})`);
		}

		const runtime = runtimeService.getRuntime(params.roomId);
		if (!runtime) {
			throw new Error(`No runtime found for room: ${params.roomId}`);
		}

		const group = makeGroupRepo().getGroupByTaskId(taskId);
		if (!group) {
			throw new Error('No active session group for this task');
		}

		const resumed = await runtime.resumeWorkerFromHuman(
			taskId,
			`[Human Rejection]\n\n${params.feedback.trim()}`,
			{ approved: false }
		);
		if (!resumed) {
			throw new Error('Failed to reject task - task may not be awaiting review');
		}

		log.info(`Task ${taskId} rejected by human in room ${params.roomId}`);
		return { success: true };
	});
}
