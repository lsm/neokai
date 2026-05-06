/**
 * Legacy Inbox compatibility RPC handlers.
 *
 * The Room product surface is retired, but the shipped web Inbox still reads
 * preserved Room task review rows and exposes approve/reject actions. This
 * narrow shim delegates to TaskRepository directly without RoomManager /
 * RoomRuntimeService dependencies. Do not expand it into the broader legacy
 * task.* / goal.* / room.* API surface.
 */

import type { MessageHub } from '@neokai/shared';
import type { TaskSummary } from '@neokai/shared/types/neo';
import type { Database } from '../../storage/database';
import type { ReactiveDatabase } from '../../storage/reactive-database';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { resolveTaskId } from '../id-resolution';
import { Logger } from '../logger';

const log = new Logger('legacy-inbox-compat-handlers');

function toTaskSummary(task: {
	id: string;
	shortId?: string | null;
	title: string;
	status: string;
	priority: string;
	progress?: number | null;
	currentStep?: string | null;
	dependsOn: string[];
	error?: string | null;
	activeSession?: string | null;
	prUrl?: string | null;
	prNumber?: number | null;
	updatedAt: number;
}): TaskSummary {
	return {
		id: task.id,
		shortId: task.shortId ?? undefined,
		title: task.title,
		status: task.status as TaskSummary['status'],
		priority: task.priority as TaskSummary['priority'],
		progress: task.progress,
		currentStep: task.currentStep,
		dependsOn: task.dependsOn,
		error: task.error,
		activeSession: task.activeSession as 'worker' | 'leader' | null | undefined,
		prUrl: task.prUrl,
		prNumber: task.prNumber,
		updatedAt: task.updatedAt,
	};
}

export function setupLegacyInboxCompatHandlers(
	messageHub: MessageHub,
	db: Database,
	reactiveDb: ReactiveDatabase
): void {
	const makeTaskRepo = () => new TaskRepository(db.getDatabase(), reactiveDb);

	messageHub.onRequest('inbox.reviewTasks', async () => {
		const taskRepo = makeTaskRepo();
		// Rooms are retired — list all legacy review tasks globally.
		const tasks = taskRepo.listTasks(undefined, { status: 'review' });
		const reviewTasks: Array<{ task: TaskSummary; roomId: string; roomTitle: string }> = [];

		for (const task of tasks) {
			reviewTasks.push({
				task: toTaskSummary(task),
				roomId: task.roomId ?? '',
				roomTitle: '',
			});
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
		const task = taskRepo.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}
		if (task.roomId !== params.roomId) {
			throw new Error(`Task does not belong to the specified room`);
		}
		if (task.status !== 'review') {
			throw new Error(`Task is not in review status (current: ${task.status})`);
		}

		const message =
			task.taskType === 'planning'
				? 'Your plan has been approved by AI reviewers and the human reviewer. ' +
					'Now merge the plan PR (run `gh pr merge` - do NOT use --delete-branch), ' +
					'then read the plan file under `docs/plans/` and create tasks 1:1 from the approved plan using `create_task`. ' +
					'Each task title and description should match the plan exactly.'
				: 'Human has approved the PR. Merge it now by running `gh pr merge` (do NOT use --delete-branch). ' +
					'After the merge completes, your work is done.';

		// Room runtime is retired — we cannot resume a worker session automatically.
		// Transition back to in_progress so the task remains visible and actionable
		// rather than silently completing without the PR merge step being executed.
		taskRepo.updateTask(taskId, {
			status: 'in_progress',
			result: message,
			currentStep: 'Approved by human — merge PR and complete task',
		});

		log.info(`Task ${taskId} approved by human (legacy inbox)`);
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
		const task = taskRepo.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}
		if (task.roomId !== params.roomId) {
			throw new Error(`Task does not belong to the specified room`);
		}
		if (task.status !== 'review') {
			throw new Error(`Task is not in review status (current: ${task.status})`);
		}

		taskRepo.updateTask(taskId, {
			status: 'in_progress',
			error: `[Human Rejection]\n\n${params.feedback.trim()}`,
		});

		log.info(`Task ${taskId} rejected by human (legacy inbox)`);
		return { success: true };
	});
}
