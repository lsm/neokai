import type {
	CreateSpaceGoalParams,
	SpaceGoal,
	SpaceGoalListParams,
	SpaceTask,
	UpdateSpaceGoalParams,
} from '@neokai/shared';
import type { SpaceRepository } from '../../../storage/repositories/space-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceGoalRepository } from '../../../storage/repositories/space-goal-repository';
import type { ScheduleService } from '../schedule/schedule-service';

export interface SpaceGoalServiceDeps {
	goalRepo: SpaceGoalRepository;
	taskRepo: SpaceTaskRepository;
	spaceRepo: SpaceRepository;
	scheduleService: ScheduleService;
}

export class SpaceGoalService {
	constructor(private readonly deps: SpaceGoalServiceDeps) {}

	createGoal(params: CreateSpaceGoalParams): SpaceGoal {
		this.validateCreate(params);
		const space = this.deps.spaceRepo.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);
		if (space.status !== 'active') {
			throw new Error(`Cannot create goal in a non-active space (current: ${space.status})`);
		}

		const goal = this.deps.goalRepo.create(params);
		if (params.checkInCronExpression) {
			const schedule = this.deps.scheduleService.createSchedule({
				spaceId: params.spaceId,
				title: `Goal check-in: ${params.title}`,
				description: this.buildTaskDescription(goal),
				priority: goal.priority,
				preferredWorkflowId: goal.preferredWorkflowId,
				labels: this.goalTaskLabels(goal),
				triggerType: 'cron',
				cronExpression: params.checkInCronExpression,
				timezone: params.checkInTimezone ?? 'UTC',
				createdByAgent: 'space-goal-service',
				goalId: goal.id,
			});
			this.deps.goalRepo.setTaskScheduleId(goal.id, schedule.id);
			this.deps.goalRepo.update(goal.id, { nextCheckInAt: schedule.nextRunAt });
		}

		if (params.triggerImmediately) return this.createImmediateTask(goal.id).goal;
		return this.getGoal(goal.id) as SpaceGoal;
	}

	listGoals(params: SpaceGoalListParams): SpaceGoal[] {
		if (!params.spaceId) throw new Error('spaceId is required');
		return this.deps.goalRepo.list(params);
	}

	getGoal(goalId: string): SpaceGoal | null {
		return this.deps.goalRepo.getById(goalId);
	}

	updateGoal(goalId: string, params: UpdateSpaceGoalParams): SpaceGoal {
		const existing = this.requireGoal(goalId);
		if (
			existing.status === 'archived' &&
			params.status !== undefined &&
			params.status !== 'archived'
		) {
			throw new Error('Archived goals cannot be reactivated');
		}
		if (params.title !== undefined && !params.title.trim()) throw new Error('title is required');
		const updated = this.deps.goalRepo.update(goalId, params);
		if (!updated) throw new Error(`Goal not found: ${goalId}`);
		return updated;
	}

	pauseGoal(goalId: string): SpaceGoal {
		const goal = this.requireGoal(goalId);
		if (goal.status !== 'active') throw new Error(`Goal is not active (current: ${goal.status})`);
		if (goal.taskScheduleId) this.deps.scheduleService.pauseSchedule(goal.taskScheduleId);
		return this.updateGoal(goalId, { status: 'paused' });
	}

	resumeGoal(goalId: string): SpaceGoal {
		const goal = this.requireGoal(goalId);
		if (goal.status !== 'paused') throw new Error(`Goal is not paused (current: ${goal.status})`);
		let nextCheckInAt = goal.nextCheckInAt;
		if (goal.taskScheduleId) {
			const schedule = this.deps.scheduleService.resumeSchedule(goal.taskScheduleId);
			nextCheckInAt = schedule.nextRunAt;
		}
		return this.updateGoal(goalId, { status: 'active', nextCheckInAt });
	}

	createImmediateTask(goalId: string): {
		goal: SpaceGoal;
		task: SpaceTask | null;
		queued: boolean;
	} {
		const goal = this.requireGoal(goalId);
		if (goal.status !== 'active') {
			throw new Error(`Cannot trigger goal in '${goal.status}' status`);
		}
		if (goal.activeTaskId) {
			const active = this.deps.taskRepo.getTask(goal.activeTaskId);
			if (active && isActiveTaskStatus(active.status)) {
				return {
					goal: this.deps.goalRepo.queueNextRun(goal.id) as SpaceGoal,
					task: null,
					queued: true,
				};
			}
			this.deps.goalRepo.clearActiveTaskIfMatches(goal.id, goal.activeTaskId);
		}

		const task = this.deps.taskRepo.createTask({
			spaceId: goal.spaceId,
			title: `Goal task: ${goal.title}`,
			description: this.buildTaskDescription(goal),
			priority: goal.priority,
			labels: this.goalTaskLabels(goal),
			preferredWorkflowId: goal.preferredWorkflowId,
			goalId: goal.id,
		});
		if (!this.deps.goalRepo.claimActiveTask(goal.id, task.id)) {
			this.deps.taskRepo.deleteTask(task.id);
			return {
				goal: this.deps.goalRepo.queueNextRun(goal.id) as SpaceGoal,
				task: null,
				queued: true,
			};
		}
		return { goal: this.requireGoal(goal.id), task, queued: false };
	}

	handleTaskTerminal(taskId: string): { goal: SpaceGoal; nextTask: SpaceTask | null } | null {
		const task = this.deps.taskRepo.getTask(taskId);
		if (!task?.goalId) return null;
		const goal = this.deps.goalRepo.getById(task.goalId);
		if (!goal) return null;
		this.deps.goalRepo.clearActiveTaskIfMatches(goal.id, taskId);
		const fresh = this.requireGoal(goal.id);
		if (!fresh.autoTriggerNext || !fresh.pendingNextRun || fresh.status !== 'active') {
			return { goal: fresh, nextTask: null };
		}
		const created = this.createImmediateTask(fresh.id);
		return { goal: created.goal, nextTask: created.task };
	}

	private requireGoal(goalId: string): SpaceGoal {
		const goal = this.deps.goalRepo.getById(goalId);
		if (!goal) throw new Error(`Goal not found: ${goalId}`);
		return goal;
	}

	private validateCreate(params: CreateSpaceGoalParams): void {
		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.title?.trim()) throw new Error('title is required');
	}

	private goalTaskLabels(goal: SpaceGoal): string[] {
		return Array.from(new Set(['goal', `goal:${goal.id}`, ...goal.labels]));
	}

	private buildTaskDescription(goal: SpaceGoal): string {
		const sections = [
			`Goal: ${goal.title}`,
			goal.description,
			goal.summary ? `Current summary:\n${goal.summary}` : '',
			goal.nextSteps.length > 0
				? `Next steps:\n${goal.nextSteps.map((s) => `- ${s}`).join('\n')}`
				: '',
		].filter(Boolean);
		return sections.join('\n\n');
	}
}

function isActiveTaskStatus(status: SpaceTask['status']): boolean {
	return (
		status === 'open' || status === 'in_progress' || status === 'review' || status === 'approved'
	);
}
