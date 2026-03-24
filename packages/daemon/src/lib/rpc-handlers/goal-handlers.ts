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
 * - goal.listExecutions - List execution history for a recurring mission
 * - goal.recordMetric - Record a metric value for a measurable mission
 * - goal.getMetrics - Get current metric state for a goal
 * - task.approve - Human approves a task PR (resumes worker for phase 2)
 */

import type {
	MessageHub,
	RoomGoal,
	GoalStatus,
	GoalPriority,
	MissionType,
	AutonomyLevel,
	MissionMetric,
	CronSchedule,
} from '@neokai/shared';
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
	| 'patchGoal'
	| 'needsHumanGoal'
	| 'reactivateGoal'
	| 'linkTaskToGoal'
	| 'linkTaskToExecution'
	| 'deleteGoal'
	| 'getActiveExecution'
	| 'updateNextRunAt'
	| 'listExecutions'
	| 'recordMetric'
	| 'checkMetricTargets'
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

	// goal.create - Create a new goal
	messageHub.onRequest('goal.create', async (data) => {
		const params = data as {
			roomId: string;
			title: string;
			description?: string;
			priority?: GoalPriority;
			missionType?: MissionType;
			autonomyLevel?: AutonomyLevel;
			structuredMetrics?: MissionMetric[];
			schedule?: CronSchedule;
			schedulePaused?: boolean;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.title) {
			throw new Error('Goal title is required');
		}

		// nextRunAt is auto-computed in GoalManager.createGoal for recurring goals
		// with a schedule. No need to compute it here.

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.createGoal({
			title: params.title,
			description: params.description ?? '',
			priority: params.priority,
			missionType: params.missionType,
			autonomyLevel: params.autonomyLevel,
			structuredMetrics: params.structuredMetrics,
			schedule: params.schedule,
			schedulePaused: params.schedulePaused,
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

	// goal.update - Update a goal (dispatches to status/progress/priority/patch based on updates)
	messageHub.onRequest('goal.update', async (data) => {
		const params = data as {
			roomId: string;
			goalId: string;
			updates: Partial<RoomGoal> & {
				missionType?: MissionType;
				autonomyLevel?: AutonomyLevel;
				structuredMetrics?: MissionMetric[];
				schedule?: CronSchedule;
			};
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

		// Detect V2 patch fields (title, description, missionType, autonomyLevel,
		// structuredMetrics, schedule) — these go through patchGoal.
		const v2Fields = [
			'title',
			'description',
			'missionType',
			'autonomyLevel',
			'structuredMetrics',
			'schedule',
		] as const;
		const hasV2Fields = v2Fields.some((f) => f in params.updates);

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
		} else if (hasV2Fields) {
			// General patch: handles title, description, missionType, autonomyLevel,
			// structuredMetrics, schedule. Also picks up priority when present alongside V2 fields.
			const patch: Record<string, unknown> = {};
			if (priority) patch.priority = priority;
			for (const f of v2Fields) {
				if (f in params.updates) patch[f] = params.updates[f as keyof typeof params.updates];
			}
			goal = await goalManager.patchGoal(params.goalId, patch);
		} else if (priority) {
			goal = await goalManager.updateGoalPriority(params.goalId, priority);
		} else {
			throw new Error(
				'No update fields provided (status, progress, priority, or editable fields required)'
			);
		}

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
			throw new Error(`Cron expression "${params.cronExpression}" produces no future run times.`);
		}

		const updated = await goalManager.updateGoalStatus(params.goalId, goal.status, {
			schedule: { expression: params.cronExpression, timezone: tz },
			nextRunAt,
			missionType: 'recurring',
		});

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
			throw new Error(`Goal ${params.goalId} has no schedule set. Set a schedule first.`);
		}

		// Recalculate next_run_at from current time
		const tz = goal.schedule.timezone ?? getSystemTimezone();
		const nextRunAt = getNextRunAt(goal.schedule.expression, tz);
		const updated = await goalManager.updateGoalStatus(params.goalId, goal.status, {
			schedulePaused: false,
			nextRunAt: nextRunAt ?? undefined,
		});
		return { goal: updated, nextRunAt };
	});

	// goal.listExecutions - List execution history for a recurring mission
	messageHub.onRequest('goal.listExecutions', async (data) => {
		const params = data as { roomId: string; goalId: string; limit?: number };

		if (!params.roomId) throw new Error('Room ID is required');
		if (!params.goalId) throw new Error('Goal ID is required');

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.getGoal(params.goalId);
		if (!goal) throw new Error(`Goal not found: ${params.goalId}`);

		const executions = goalManager.listExecutions(params.goalId, params.limit ?? 20);
		return { executions };
	});

	// goal.recordMetric - Record a metric value for a measurable mission
	messageHub.onRequest('goal.recordMetric', async (data) => {
		const params = data as { roomId: string; goalId: string; metricName: string; value: number };

		if (!params.roomId) throw new Error('Room ID is required');
		if (!params.goalId) throw new Error('Goal ID is required');
		if (!params.metricName) throw new Error('Metric name is required');
		if (typeof params.value !== 'number') throw new Error('Value must be a number');

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.getGoal(params.goalId);
		if (!goal) throw new Error(`Goal not found: ${params.goalId}`);
		if (goal.missionType !== 'measurable') {
			throw new Error(
				`Goal ${params.goalId} is not a measurable mission (missionType: ${goal.missionType ?? 'one_shot'})`
			);
		}

		const updated = await goalManager.recordMetric(params.goalId, params.metricName, params.value);
		return {
			goal: updated,
			metric: {
				name: params.metricName,
				value: params.value,
				goalProgress: updated.progress,
			},
		};
	});

	// goal.getMetrics - Get current metric state and targets for a goal
	messageHub.onRequest('goal.getMetrics', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) throw new Error('Room ID is required');
		if (!params.goalId) throw new Error('Goal ID is required');

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.getGoal(params.goalId);
		if (!goal) throw new Error(`Goal not found: ${params.goalId}`);

		if (!goal.structuredMetrics || goal.structuredMetrics.length === 0) {
			return {
				missionType: goal.missionType ?? 'one_shot',
				structuredMetrics: [],
				legacyMetrics: goal.metrics ?? {},
				note: 'No structured metrics configured. For measurable missions, add structuredMetrics to the goal.',
			};
		}

		const checkResult = await goalManager.checkMetricTargets(params.goalId);
		return {
			missionType: goal.missionType ?? 'one_shot',
			allTargetsMet: checkResult.allMet,
			metrics: checkResult.results.map((r) => {
				const metric = goal.structuredMetrics!.find((m) => m.name === r.name);
				return {
					name: r.name,
					current: r.current,
					target: r.target,
					met: r.met,
					direction: metric?.direction ?? 'increase',
					...(metric?.baseline !== undefined ? { baseline: metric.baseline } : {}),
					...(metric?.unit ? { unit: metric.unit } : {}),
				};
			}),
		};
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
					'Now merge the plan PR (run `gh pr merge` or merge the branch manually), ' +
					'then read the plan file under `docs/plans/` and create tasks 1:1 from the approved plan using `create_task`. ' +
					'Each task title and description should match the plan exactly.'
				: 'Human has approved the PR. Merge it now by running `gh pr merge`. ' +
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
