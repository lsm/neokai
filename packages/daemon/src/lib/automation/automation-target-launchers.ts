import type { AutomationRun, AutomationTask, RoomGoal } from '@neokai/shared';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { GoalManager } from '../room/managers/goal-manager';
import type { TaskManager } from '../room/managers/task-manager';
import type { SpaceTaskManager } from '../space/managers/space-task-manager';
import { enqueueRoomTick } from '../job-handlers/room-tick.handler';
import { NEO_SESSION_ID } from '../neo/neo-agent-manager';
import {
	assertJobHandlerTargetConfig,
	assertNeoAgentTargetConfig,
	assertRoomMissionTargetConfig,
	assertRoomTaskTargetConfig,
	assertSpaceTaskTargetConfig,
	assertSpaceWorkflowTargetConfig,
	type AutomationLaunchResult,
	type AutomationTargetLauncher,
} from './automation-scheduler';

export type TaskManagerFactory = (roomId: string) => TaskManager;
export type GoalManagerFactory = (roomId: string) => GoalManager;
export type SpaceTaskManagerFactory = (spaceId: string) => SpaceTaskManager;
export type NeoMessageInjector = (sessionId: string, message: string) => Promise<void>;

export interface RoomMissionRuntime {
	triggerNow(goalId: string): Promise<RoomGoal>;
}

export type RoomMissionRuntimeFactory = (roomId: string) => RoomMissionRuntime | null;

export class RoomTaskAutomationLauncher implements AutomationTargetLauncher {
	constructor(
		private taskManagerFactory: TaskManagerFactory,
		private goalManagerFactory: GoalManagerFactory,
		private jobQueue: JobQueueRepository
	) {}

	async launch(task: AutomationTask): Promise<AutomationLaunchResult> {
		const config = assertRoomTaskTargetConfig(task.targetType, task.targetConfig);
		const taskManager = this.taskManagerFactory(config.roomId);
		const created = await taskManager.createTask({
			title: this.renderTemplate(config.titleTemplate, task),
			description: this.renderTemplate(config.descriptionTemplate, task),
			priority: config.priority,
			taskType: config.taskType ?? 'coding',
			assignedAgent: config.assignedAgent ?? 'coder',
			status: 'pending',
		});

		if (config.goalId) {
			const goalManager = this.goalManagerFactory(config.roomId);
			await goalManager.linkTaskToGoal(config.goalId, created.id);
		}

		enqueueRoomTick(config.roomId, this.jobQueue, 0);
		return {
			roomTaskId: created.id,
			roomGoalId: config.goalId,
			resultSummary: `Created Room task "${created.title}"`,
		};
	}

	private renderTemplate(template: string, task: AutomationTask): string {
		return template
			.replaceAll('{{automation.title}}', task.title)
			.replaceAll('{{automation.description}}', task.description);
	}
}

export class RoomMissionAutomationLauncher implements AutomationTargetLauncher {
	constructor(
		private goalManagerFactory: GoalManagerFactory,
		private roomRuntimeFactory: RoomMissionRuntimeFactory,
		private jobQueue: JobQueueRepository
	) {}

	async launch(task: AutomationTask): Promise<AutomationLaunchResult> {
		const config = assertRoomMissionTargetConfig(task.targetType, task.targetConfig);
		const goalManager = this.goalManagerFactory(config.roomId);
		const goal = await goalManager.getGoal(config.goalId);
		if (!goal) {
			throw new Error(`Room mission not found: ${config.goalId}`);
		}

		if (config.action === 'check') {
			enqueueRoomTick(config.roomId, this.jobQueue, 0);
			const activeExecution = goalManager.getActiveExecution(config.goalId);
			return {
				roomGoalId: goal.id,
				missionExecutionId: activeExecution?.id,
				resultSummary: `Queued health check for Room mission "${goal.title}"`,
				metadata: {
					action: config.action,
					status: goal.status,
					activeExecutionId: activeExecution?.id ?? null,
				},
			};
		}

		const runtime = this.roomRuntimeFactory(config.roomId);
		if (!runtime) {
			throw new Error(`Room runtime is not available for room ${config.roomId}`);
		}
		const updatedGoal = await runtime.triggerNow(config.goalId);
		const activeExecution = goalManager.getActiveExecution(config.goalId);
		enqueueRoomTick(config.roomId, this.jobQueue, 0);
		return {
			roomGoalId: updatedGoal.id,
			missionExecutionId: activeExecution?.id,
			resultSummary: `Triggered Room mission "${updatedGoal.title}"`,
			metadata: {
				action: config.action,
				status: updatedGoal.status,
				activeExecutionId: activeExecution?.id ?? null,
			},
		};
	}
}

export class SpaceTaskAutomationLauncher implements AutomationTargetLauncher {
	constructor(private spaceTaskManagerFactory: SpaceTaskManagerFactory) {}

	async launch(task: AutomationTask): Promise<AutomationLaunchResult> {
		const config = assertSpaceTaskTargetConfig(task.targetType, task.targetConfig);
		const manager = this.spaceTaskManagerFactory(config.spaceId);
		const created = await manager.createTask({
			title: this.renderTemplate(config.titleTemplate, task),
			description: this.renderTemplate(config.descriptionTemplate, task),
			priority: config.priority,
			labels: config.labels,
			status: 'open',
		});
		return {
			spaceTaskId: created.id,
			resultSummary: `Created Space task #${created.taskNumber}`,
		};
	}

	private renderTemplate(template: string, task: AutomationTask): string {
		return template
			.replaceAll('{{automation.title}}', task.title)
			.replaceAll('{{automation.description}}', task.description);
	}
}

export class SpaceWorkflowAutomationLauncher implements AutomationTargetLauncher {
	constructor(private spaceTaskManagerFactory: SpaceTaskManagerFactory) {}

	async launch(task: AutomationTask): Promise<AutomationLaunchResult> {
		const config = assertSpaceWorkflowTargetConfig(task.targetType, task.targetConfig);
		const manager = this.spaceTaskManagerFactory(config.spaceId);
		const created = await manager.createTask({
			title: this.renderTemplate(config.titleTemplate, task),
			description: this.renderTemplate(config.descriptionTemplate, task),
			priority: config.priority,
			labels: config.labels,
			preferredWorkflowId: config.preferredWorkflowId,
			status: 'open',
		});
		return {
			spaceTaskId: created.id,
			resultSummary: `Created Space workflow task #${created.taskNumber}`,
		};
	}

	private renderTemplate(template: string, task: AutomationTask): string {
		return template
			.replaceAll('{{automation.title}}', task.title)
			.replaceAll('{{automation.description}}', task.description);
	}
}

export class JobHandlerAutomationLauncher implements AutomationTargetLauncher {
	constructor(private jobQueue: JobQueueRepository) {}

	async launch(task: AutomationTask, run: AutomationRun): Promise<AutomationLaunchResult> {
		const config = assertJobHandlerTargetConfig(task.targetType, task.targetConfig);
		const job = this.jobQueue.enqueue({
			queue: config.queue,
			payload: {
				...config.payload,
				automation: {
					taskId: task.id,
					runId: run.id,
				},
			},
		});
		return {
			status: 'succeeded',
			resultSummary: `Queued job ${job.id} on ${config.queue}`,
			metadata: {
				jobId: job.id,
				queue: config.queue,
			},
		};
	}
}

export class NeoAgentAutomationLauncher implements AutomationTargetLauncher {
	constructor(private injectMessage: NeoMessageInjector) {}

	async launch(task: AutomationTask): Promise<AutomationLaunchResult> {
		const config = assertNeoAgentTargetConfig(task.targetType, task.targetConfig);
		await this.injectMessage(NEO_SESSION_ID, this.renderTemplate(config.promptTemplate, task));
		return {
			sessionId: NEO_SESSION_ID,
			resultSummary: 'Sent automation prompt to Neo',
			metadata: {
				target: 'neo_agent',
			},
		};
	}

	private renderTemplate(template: string, task: AutomationTask): string {
		return template
			.replaceAll('{{automation.title}}', task.title)
			.replaceAll('{{automation.description}}', task.description);
	}
}
