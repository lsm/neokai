/**
 * Goal RPC Handlers
 *
 * RPC handlers for goal operations:
 * - goal.create - Create a new goal
 * - goal.get - Get goal details
 * - goal.list - List goals in room
 * - goal.update - Update a goal (status/progress/priority)
 * - goal.needsHuman - Mark goal as needing human input
 * - goal.reactivate - Reactivate a goal (return to active)
 * - goal.linkTask - Link a task to a goal
 * - goal.delete - Delete a goal
 * - task.approve - Human approves a task PR (resumes worker for phase 2)
 */

import type { MessageHub, RoomGoal, GoalStatus, GoalPriority } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { GoalManager } from '../room/managers/goal-manager';
import type { TaskManager } from '../room/managers/task-manager';
import type { RoomRuntimeService } from '../room/runtime/room-runtime-service';
import { Logger } from '../logger';
import { isValidCronExpression, getNextRunAt, getSystemTimezone } from '../room/runtime/cron-utils';

const log = new Logger('goal-handlers');

export type GoalManagerLike = Pick<
	GoalManager,
	| 'createGoal'
	| 'getGoal'
	| 'listGoals'
	| 'updateGoalStatus'
	| 'updateGoalProgress'
	| 'updateGoalPriority'
	| 'needsHumanGoal'
	| 'reactivateGoal'
	| 'linkTaskToGoal'
	| 'linkTaskToExecution'
	| 'deleteGoal'
	| 'getActiveExecution'
	| 'updateNextRunAt'
>;

export type GoalManagerFactory = (roomId: string) => GoalManagerLike;
export type TaskManagerFactory = (
	roomId: string
) => Pick<TaskManager, 'getTask' | 'reviewTask' | 'updateTaskStatus'>;

export function setupGoalHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	goalManagerFactory: GoalManagerFactory,
	taskManagerFactory?: TaskManagerFactory,
	runtimeService?: RoomRuntimeService
): void {
	/**
	 * Emit goal.created event to notify UI clients
	 */
	const emitGoalCreated = (roomId: string, goal: RoomGoal) => {
		daemonHub
			.emit('goal.created', {
				sessionId: `room:${roomId}`,
				roomId,
				goalId: goal.id,
				goal,
			})
			.catch((error) => {
				log.warn(`Failed to emit goal.created for room ${roomId}:`, error);
			});
	};

	/**
	 * Emit goal.updated event to notify UI clients
	 */
	const emitGoalUpdated = (roomId: string, goalId: string, goal?: RoomGoal) => {
		daemonHub
			.emit('goal.updated', {
				sessionId: `room:${roomId}`,
				roomId,
				goalId,
				goal,
			})
			.catch((error) => {
				log.warn(`Failed to emit goal.updated for room ${roomId}:`, error);
			});
	};

	/**
	 * Emit goal.progressUpdated event to notify UI clients
	 */
	const emitGoalProgressUpdated = (roomId: string, goalId: string, progress: number) => {
		daemonHub
			.emit('goal.progressUpdated', {
				sessionId: `room:${roomId}`,
				roomId,
				goalId,
				progress,
			})
			.catch((error) => {
				log.warn(`Failed to emit goal.progressUpdated for room ${roomId}:`, error);
			});
	};

	// goal.create - Create a new goal
	messageHub.onRequest('goal.create', async (data) => {
		const params = data as {
			roomId: string;
			title: string;
			description?: string;
			priority?: GoalPriority;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.title) {
			throw new Error('Goal title is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.createGoal({
			title: params.title,
			description: params.description ?? '',
			priority: params.priority,
		});

		// Emit goal.created event
		emitGoalCreated(params.roomId, goal);

		return { goal };
	});

	// goal.get - Get goal details
	messageHub.onRequest('goal.get', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.getGoal(params.goalId);

		if (!goal) {
			throw new Error(`Goal not found: ${params.goalId}`);
		}

		return { goal };
	});

	// goal.list - List goals in room
	messageHub.onRequest('goal.list', async (data) => {
		const params = data as { roomId: string; status?: GoalStatus };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goals = await goalManager.listGoals(params.status);

		return { goals };
	});

	// goal.update - Update a goal (dispatches to status/progress/priority based on updates)
	messageHub.onRequest('goal.update', async (data) => {
		const params = data as {
			roomId: string;
			goalId: string;
			updates: Partial<RoomGoal>;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}
		if (!params.updates || Object.keys(params.updates).length === 0) {
			throw new Error('No update fields provided');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const { status, progress, priority, metrics, ...rest } = params.updates;

		let goal: RoomGoal;
		if (status) {
			goal = await goalManager.updateGoalStatus(params.goalId, status, {
				...(progress !== undefined ? { progress } : {}),
				...(priority ? { priority } : {}),
				...rest,
			});
		} else if (progress !== undefined) {
			goal = await goalManager.updateGoalProgress(
				params.goalId,
				progress,
				metrics as Record<string, number> | undefined
			);
		} else if (priority) {
			goal = await goalManager.updateGoalPriority(params.goalId, priority);
		} else {
			throw new Error('No update fields provided (status, progress, or priority required)');
		}

		emitGoalUpdated(params.roomId, params.goalId, goal);

		return { goal };
	});

	// goal.needsHuman - Mark goal as needing human input
	messageHub.onRequest('goal.needsHuman', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.needsHumanGoal(params.goalId);

		emitGoalUpdated(params.roomId, params.goalId, goal);

		return { goal };
	});

	// goal.reactivate - Reactivate a goal (return to active)
	messageHub.onRequest('goal.reactivate', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.reactivateGoal(params.goalId);

		emitGoalUpdated(params.roomId, params.goalId, goal);

		return { goal };
	});

	// goal.linkTask - Link a task to a goal
	messageHub.onRequest('goal.linkTask', async (data) => {
		const params = data as { roomId: string; goalId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);

		// For recurring missions with an active execution, use the atomic dual-write path.
		let goal;
		const linkedGoal = await goalManager.getGoal(params.goalId);
		if (linkedGoal?.missionType === 'recurring') {
			const activeExecution = goalManager.getActiveExecution(params.goalId);
			if (activeExecution) {
				goal = await goalManager.linkTaskToExecution(
					params.goalId,
					activeExecution.id,
					params.taskId
				);
			} else {
				goal = await goalManager.linkTaskToGoal(params.goalId, params.taskId);
			}
		} else {
			goal = await goalManager.linkTaskToGoal(params.goalId, params.taskId);
		}

		// Emit goal.updated event (task linked and progress recalculated)
		emitGoalUpdated(params.roomId, params.goalId, goal);
		emitGoalProgressUpdated(params.roomId, params.goalId, goal.progress);

		return { goal };
	});

	// goal.delete - Delete a goal
	messageHub.onRequest('goal.delete', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const success = await goalManager.deleteGoal(params.goalId);

		// Emit goal.updated event with undefined goal to signal deletion
		emitGoalUpdated(params.roomId, params.goalId);

		return { success };
	});

	// goal.setSchedule - Set or update cron schedule for a recurring mission
	messageHub.onRequest('goal.setSchedule', async (data) => {
		const params = data as {
			roomId: string;
			goalId: string;
			cronExpression: string;
			timezone?: string;
		};

		if (!params.roomId) throw new Error('Room ID is required');
		if (!params.goalId) throw new Error('Goal ID is required');
		if (!params.cronExpression) throw new Error('Cron expression is required');

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.getGoal(params.goalId);
		if (!goal) throw new Error(`Goal not found: ${params.goalId}`);
		if (goal.missionType !== 'recurring') {
			throw new Error(
				`Goal ${params.goalId} is not a recurring mission (missionType=${goal.missionType ?? 'one_shot'})`
			);
		}
		if (!isValidCronExpression(params.cronExpression)) {
			throw new Error(
				`Invalid cron expression: "${params.cronExpression}". Use 5-field cron or presets (@daily, @weekly, @hourly, @monthly).`
			);
		}

		const tz = params.timezone ?? goal.schedule?.timezone ?? getSystemTimezone();
		const nextRunAt = getNextRunAt(params.cronExpression, tz);
		if (nextRunAt === null) {
			throw new Error(
				`Cron expression "${params.cronExpression}" produces no future run times.`
			);
		}

		const updated = await goalManager.updateGoalStatus(params.goalId, goal.status, {
			schedule: { expression: params.cronExpression, timezone: tz },
			nextRunAt,
			missionType: 'recurring',
		});

		emitGoalUpdated(params.roomId, params.goalId, updated);
		return { goal: updated, nextRunAt };
	});

	// goal.pauseSchedule - Pause the schedule for a recurring mission
	messageHub.onRequest('goal.pauseSchedule', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) throw new Error('Room ID is required');
		if (!params.goalId) throw new Error('Goal ID is required');

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.getGoal(params.goalId);
		if (!goal) throw new Error(`Goal not found: ${params.goalId}`);
		if (goal.missionType !== 'recurring') {
			throw new Error(`Goal ${params.goalId} is not a recurring mission.`);
		}

		const updated = await goalManager.updateGoalStatus(params.goalId, goal.status, {
			schedulePaused: true,
		});
		emitGoalUpdated(params.roomId, params.goalId, updated);
		return { goal: updated };
	});

	// goal.resumeSchedule - Resume a paused recurring mission schedule
	messageHub.onRequest('goal.resumeSchedule', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) throw new Error('Room ID is required');
		if (!params.goalId) throw new Error('Goal ID is required');

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.getGoal(params.goalId);
		if (!goal) throw new Error(`Goal not found: ${params.goalId}`);
		if (goal.missionType !== 'recurring') {
			throw new Error(`Goal ${params.goalId} is not a recurring mission.`);
		}
		if (!goal.schedule) {
			throw new Error(
				`Goal ${params.goalId} has no schedule set. Set a schedule first.`
			);
		}

		// Recalculate next_run_at from current time
		const tz = goal.schedule.timezone ?? getSystemTimezone();
		const nextRunAt = getNextRunAt(goal.schedule.expression, tz);
		const updated = await goalManager.updateGoalStatus(params.goalId, goal.status, {
			schedulePaused: false,
			nextRunAt: nextRunAt ?? undefined,
		});
		emitGoalUpdated(params.roomId, params.goalId, updated);
		return { goal: updated, nextRunAt };
	});

	// task.approve - Human approves the PR; resume leader to complete task flow
	const approveTaskHandler = async (data: unknown) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}
		if (!taskManagerFactory || !runtimeService) {
			throw new Error(
				'Task manager factory and runtime service are required for task approval handlers'
			);
		}

		const taskManager = taskManagerFactory(params.roomId);
		const task = await taskManager.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
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
					'Now merge the plan PR (run `gh pr merge --merge` or merge the branch manually), ' +
					'then read the plan file under `docs/plans/` and create tasks 1:1 from the approved plan using `create_task`. ' +
					'Each task title and description should match the plan exactly.'
				: 'Human has approved the PR. Merge it now by running `gh pr merge --merge`. ' +
					'After the merge completes, your work is done.';

		const resumed = await runtime.resumeWorkerFromHuman(params.taskId, message, {
			approved: true,
		});
		if (!resumed) {
			throw new Error(
				`Failed to resume task ${params.taskId} — no submitted-for-review group found`
			);
		}

		log.info(`Task ${params.taskId} approved by human in room ${params.roomId}`);
		return { success: true };
	};

	// task.approve - Task-scoped RPC name
	messageHub.onRequest('task.approve', approveTaskHandler);
}
