import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceGoalService } from '../../../src/lib/space/goals/goal-service';
import { ScheduleService } from '../../../src/lib/space/schedule/schedule-service';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { TaskScheduleRepository } from '../../../src/storage/repositories/task-schedule-repository';
import { createSpaceTables } from '../helpers/space-test-db';

function createJobQueueTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS job_queue (
			id TEXT PRIMARY KEY,
			queue TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
			payload TEXT NOT NULL DEFAULT '{}',
			result TEXT,
			error TEXT,
			priority INTEGER NOT NULL DEFAULT 0,
			max_retries INTEGER NOT NULL DEFAULT 3,
			retry_count INTEGER NOT NULL DEFAULT 0,
			run_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
	`);
}

describe('SpaceGoalService', () => {
	let db: Database;
	let goalRepo: SpaceGoalRepository;
	let taskRepo: SpaceTaskRepository;
	let spaceRepo: SpaceRepository;
	let scheduleRepo: TaskScheduleRepository;
	let service: SpaceGoalService;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		createJobQueueTable(db);

		goalRepo = new SpaceGoalRepository(db as never);
		taskRepo = new SpaceTaskRepository(db as never);
		spaceRepo = new SpaceRepository(db as never);
		scheduleRepo = new TaskScheduleRepository(db as never);
		const scheduleService = new ScheduleService({
			db: db as never,
			scheduleRepo,
			jobQueue: new JobQueueRepository(db as never),
			spaceRepo,
		});
		service = new SpaceGoalService({ goalRepo, taskRepo, spaceRepo, scheduleService });

		const space = spaceRepo.createSpace({
			slug: 'test',
			workspacePath: '/workspace/test',
			name: 'Test Space',
		});
		spaceId = space.id;
	});

	afterEach(() => {
		db.close();
	});

	it('creates a goal with rolling state and an optional recurring check-in schedule', () => {
		const goal = service.createGoal({
			spaceId,
			title: 'Improve onboarding',
			description: 'Make first-run experience smoother',
			type: 'recurring',
			priority: 'high',
			labels: ['product'],
			metrics: { activated: 10 },
			summary: 'Initial state',
			progress: 35,
			nextSteps: ['Audit current flow'],
			preferredWorkflowId: 'workflow-1',
			checkInCronExpression: '0 9 * * 1',
			checkInTimezone: 'UTC',
		});

		expect(goal.title).toBe('Improve onboarding');
		expect(goal.type).toBe('recurring');
		expect(goal.priority).toBe('high');
		expect(goal.labels).toEqual(['product']);
		expect(goal.metrics).toEqual({ activated: 10 });
		expect(goal.summary).toBe('Initial state');
		expect(goal.progress).toBe(35);
		expect(goal.nextSteps).toEqual(['Audit current flow']);
		expect(goal.taskScheduleId).toBeString();
		expect(goal.nextCheckInAt).not.toBeNull();

		const schedule = scheduleRepo.getById(goal.taskScheduleId as string);
		expect(schedule?.goalId).toBe(goal.id);
		expect(schedule?.preferredWorkflowId).toBe('workflow-1');
		expect(schedule?.labels).toEqual(['goal', `goal:${goal.id}`, 'product']);
	});

	it('creates an immediate goal task and queues concurrent triggers', () => {
		const goal = service.createGoal({
			spaceId,
			title: 'Ship docs',
			labels: ['docs'],
			preferredWorkflowId: 'workflow-docs',
			autoTriggerNext: true,
		});

		const first = service.createImmediateTask(goal.id);
		expect(first.queued).toBe(false);
		expect(first.task?.goalId).toBe(goal.id);
		expect(first.task?.preferredWorkflowId).toBe('workflow-docs');
		expect(first.task?.labels).toEqual(['goal', `goal:${goal.id}`, 'docs']);
		expect(first.goal.activeTaskId).toBe(first.task?.id);

		const second = service.createImmediateTask(goal.id);
		expect(second.queued).toBe(true);
		expect(second.task).toBeNull();
		expect(second.goal.pendingNextRun).toBe(true);
	});

	it('auto-triggers one queued task after the active task reaches a terminal status', () => {
		const goal = service.createGoal({
			spaceId,
			title: 'Keep improving',
			autoTriggerNext: true,
		});
		const first = service.createImmediateTask(goal.id);
		expect(first.task).not.toBeNull();
		service.createImmediateTask(goal.id);

		taskRepo.updateTask(first.task!.id, { status: 'done' });
		const terminal = service.handleTaskTerminal(first.task!.id);

		expect(terminal?.nextTask).not.toBeNull();
		expect(terminal?.nextTask?.goalId).toBe(goal.id);
		const updated = goalRepo.getById(goal.id);
		expect(updated?.activeTaskId).toBe(terminal?.nextTask?.id);
		expect(updated?.pendingNextRun).toBe(false);
	});
});
