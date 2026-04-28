import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AutomationManager } from '../../../../src/lib/automation/automation-manager';
import {
	AutomationScheduler,
	type AutomationTargetLauncher,
} from '../../../../src/lib/automation/automation-scheduler';
import { AutomationConditionEvaluator } from '../../../../src/lib/automation/automation-condition-evaluator';
import { AUTOMATION_DISPATCH } from '../../../../src/lib/job-queue-constants';
import { AutomationRepository } from '../../../../src/storage/repositories/automation-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { runMigration105, runMigration106 } from '../../../../src/storage/schema/migrations';
import type { AutomationRun, AutomationTask } from '@neokai/shared';

class FakeLauncher implements AutomationTargetLauncher {
	launched: Array<{ task: AutomationTask; run: AutomationRun }> = [];

	async launch(task: AutomationTask, run: AutomationRun) {
		this.launched.push({ task, run });
		return {
			sessionId: 'session-1',
			resultSummary: 'launched',
			metadata: { fake: true },
		};
	}
}

class FailingLauncher implements AutomationTargetLauncher {
	async launch() {
		throw new Error('launch failed');
	}
}

function createJobQueueSchema(db: Database): void {
	db.exec(`
		CREATE TABLE job_queue (
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
		CREATE INDEX idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
		CREATE INDEX idx_job_queue_status ON job_queue(status);
	`);
}

describe('AutomationScheduler', () => {
	let db: Database;
	let manager: AutomationManager;
	let jobQueue: JobQueueRepository;
	let scheduler: AutomationScheduler;
	let launcher: FakeLauncher;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		runMigration105(db as never);
		runMigration106(db as never);
		createJobQueueSchema(db);
		manager = new AutomationManager(new AutomationRepository(db as never));
		jobQueue = new JobQueueRepository(db as never);
		scheduler = new AutomationScheduler(manager, jobQueue);
		launcher = new FakeLauncher();
		scheduler.registerLauncher('job_handler', launcher);
	});

	afterEach(() => {
		db.close();
	});

	it('schedules active automations with nextRunAt', () => {
		const nextRunAt = Date.now() + 60_000;
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Scheduled check',
			triggerType: 'interval',
			triggerConfig: { intervalMs: 60_000 },
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			nextRunAt,
		});

		scheduler.scheduleTask(automation);

		const jobs = jobQueue.listJobs({ queue: AUTOMATION_DISPATCH, status: 'pending' });
		expect(jobs).toHaveLength(1);
		expect(jobs[0].payload).toEqual({
			automationId: automation.id,
			dispatchKey: `${automation.id}:scheduled:${nextRunAt}`,
			triggerReason: 'scheduled',
		});
		expect(jobs[0].runAt).toBe(nextRunAt);
	});

	it('computes initial runAt for interval automations without nextRunAt', () => {
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Interval check',
			triggerType: 'interval',
			triggerConfig: { intervalMs: 60_000 },
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
		});

		scheduler.scheduleTask(automation);

		const updated = manager.getTask(automation.id);
		const jobs = jobQueue.listJobs({ queue: AUTOMATION_DISPATCH, status: 'pending' });
		expect(typeof updated?.nextRunAt).toBe('number');
		expect(jobs).toHaveLength(1);
		expect(jobs[0].payload).toMatchObject({ automationId: automation.id });
	});

	it('triggerNow creates a runtime-owned run and launches the target', async () => {
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Manual check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
		});

		const run = await scheduler.triggerNow(automation.id);

		expect(run.status).toBe('running');
		expect(run.triggerType).toBe('manual');
		expect(run.sessionId).toBe('session-1');
		expect(run.metadata).toEqual({ fake: true });
		expect(
			manager.listRunEvents({ automationRunId: run.id }).map((event) => event.eventType)
		).toEqual(
			expect.arrayContaining(['run_created', 'target_launch_started', 'target_launch_succeeded'])
		);
		expect(launcher.launched).toHaveLength(1);
	});

	it('triggerNow does not consume the existing schedule for scheduled automations', async () => {
		const nextRunAt = Date.now() + 60_000;
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Run now without rescheduling',
			triggerType: 'interval',
			triggerConfig: { intervalMs: 60_000 },
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			nextRunAt,
		});

		await scheduler.triggerNow(automation.id);

		const updated = manager.getTask(automation.id);
		expect(typeof updated?.lastRunAt).toBe('number');
		expect(updated?.nextRunAt).toBe(nextRunAt);
	});

	it('reuses an existing run when dispatch key is repeated', async () => {
		const nextRunAt = Date.now() - 1;
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Idempotent scheduled check',
			triggerType: 'interval',
			triggerConfig: { intervalMs: 60_000 },
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			nextRunAt,
		});
		const dispatchKey = `${automation.id}:scheduled:${nextRunAt}`;

		const first = await scheduler.dispatch(automation.id, { dispatchKey });
		const second = await scheduler.dispatch(automation.id, {
			dispatchKey,
			ignoreDueTime: true,
		});

		expect(second.id).toBe(first.id);
		expect(launcher.launched).toHaveLength(1);
	});

	it('skip concurrency policy records a skipped run without launching target', async () => {
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Overlap check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
		});
		await scheduler.triggerNow(automation.id);

		const skipped = await scheduler.triggerNow(automation.id);

		expect(skipped.status).toBe('succeeded');
		expect(skipped.metadata?.skippedTarget).toBe(true);
		expect(launcher.launched).toHaveLength(1);
	});

	it('queue concurrency policy creates queued runs and drains them later', async () => {
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Queue check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			concurrencyPolicy: 'queue',
		});
		await scheduler.triggerNow(automation.id);

		const queued = await scheduler.triggerNow(automation.id);
		expect(queued.status).toBe('queued');
		expect(launcher.launched).toHaveLength(1);

		manager.updateRun(launcher.launched[0].run.id, { status: 'succeeded' });
		const drained = await scheduler.dispatch(automation.id, { triggerReason: 'queued' });

		expect(drained.status).toBe('running');
		expect(drained.id).toBe(queued.id);
		expect(launcher.launched).toHaveLength(2);
	});

	it('cancel_previous concurrency policy cancels running runs before launch', async () => {
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Cancel previous check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			concurrencyPolicy: 'cancel_previous',
		});
		const first = await scheduler.triggerNow(automation.id);

		const second = await scheduler.triggerNow(automation.id);

		expect(manager.getRun(first.id)?.status).toBe('cancelled');
		expect(second.status).toBe('running');
		expect(launcher.launched).toHaveLength(2);
	});

	it('records condition checks and skips target launch when condition is not met', async () => {
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'PR status check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			conditionConfig: {
				type: 'github_pr_status',
				repository: 'acme/project',
				prNumber: 42,
			},
		});

		const skipped = await scheduler.triggerNow(automation.id);
		const updated = manager.getTask(automation.id);

		expect(skipped.status).toBe('succeeded');
		expect(skipped.metadata?.skippedTarget).toBe(true);
		expect((skipped.metadata?.condition as { reason?: string }).reason).toBe(
			'condition_evaluator_unavailable'
		);
		expect(typeof updated?.lastCheckedAt).toBe('number');
		expect(updated?.lastConditionResult?.passed).toBe(false);
		expect(updated?.conditionFailureCount).toBe(1);
		expect(launcher.launched).toHaveLength(0);
	});

	it('passes github_pr_status conditions when the PR state matches', async () => {
		const evaluator = new AutomationConditionEvaluator({
			gitHubReader: {
				async getPullRequestStatus() {
					return { state: 'merged', draft: false, headSha: 'abc123' };
				},
			},
		});
		scheduler = new AutomationScheduler(manager, jobQueue, evaluator);
		launcher = new FakeLauncher();
		scheduler.registerLauncher('job_handler', launcher);
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'PR merged check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			conditionConfig: {
				type: 'github_pr_status',
				repository: 'acme/project',
				prNumber: 42,
				states: ['merged'],
			},
		});

		const run = await scheduler.triggerNow(automation.id);

		expect(run.status).toBe('running');
		expect(manager.getTask(automation.id)?.lastConditionResult?.passed).toBe(true);
		expect(launcher.launched).toHaveLength(1);
	});

	it('evaluates composite and web query conditions', async () => {
		const evaluator = new AutomationConditionEvaluator({
			webReader: {
				async query() {
					return { status: 200, text: 'healthy' };
				},
			},
		});
		scheduler = new AutomationScheduler(manager, jobQueue, evaluator);
		launcher = new FakeLauncher();
		scheduler.registerLauncher('job_handler', launcher);
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Composite condition check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			conditionConfig: {
				type: 'all',
				conditions: [
					{ type: 'always' },
					{
						type: 'web_query',
						url: 'https://example.test/health',
						expectedStatus: 200,
						containsText: 'healthy',
					},
				],
			},
		});

		const run = await scheduler.triggerNow(automation.id);

		expect(run.status).toBe('running');
		expect(manager.getTask(automation.id)?.lastConditionResult?.reason).toBe(
			'all_conditions_passed'
		);
	});

	it('dispatches event-triggered automations that match payload filters', async () => {
		const matching = manager.createTask({
			ownerType: 'global',
			title: 'Matching event',
			triggerType: 'event',
			triggerConfig: { eventName: 'github.pr.updated', filters: { repository: 'acme/project' } },
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
		});
		manager.createTask({
			ownerType: 'global',
			title: 'Non-matching event',
			triggerType: 'event',
			triggerConfig: { eventName: 'github.pr.updated', filters: { repository: 'other/project' } },
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
		});

		const runs = await scheduler.emitEvent('github.pr.updated', { repository: 'acme/project' });

		expect(runs).toHaveLength(1);
		expect(runs[0].automationTaskId).toBe(matching.id);
		expect(runs[0].triggerType).toBe('event');
		expect(launcher.launched).toHaveLength(1);
	});

	it('queues retry jobs for failed launches while attempts remain', async () => {
		scheduler.registerLauncher('job_handler', new FailingLauncher());
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Retry check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			maxRetries: 1,
		});

		const failed = await scheduler.triggerNow(automation.id);

		expect(failed.status).toBe('failed');
		const retryJobs = jobQueue
			.listJobs({ queue: AUTOMATION_DISPATCH, status: 'pending' })
			.filter((job) => (job.payload as { triggerReason?: string }).triggerReason === 'retry');
		expect(retryJobs).toHaveLength(1);
		expect(retryJobs[0].payload).toMatchObject({
			automationId: automation.id,
			triggerReason: 'retry',
			attempt: 2,
		});
	});

	it('marks stale running runs as timed out and schedules retry', () => {
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Timeout check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			timeoutMs: 1,
			maxRetries: 1,
		});
		const run = manager.createRun({
			automationTaskId: automation.id,
			ownerType: automation.ownerType,
			ownerId: automation.ownerId,
			status: 'running',
			triggerType: 'manual',
		});
		manager.updateRun(run.id, { startedAt: Date.now() - 10_000 });

		const count = scheduler.sweepTimedOutRuns();
		const updated = manager.getRun(run.id);

		expect(count).toBe(1);
		expect(updated?.status).toBe('timed_out');
		expect(
			jobQueue
				.listJobs({ queue: AUTOMATION_DISPATCH, status: 'pending' })
				.some((job) => (job.payload as { triggerReason?: string }).triggerReason === 'retry')
		).toBe(true);
	});

	it('recovers old running runs that never linked a target', () => {
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Orphan recovery check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			maxRetries: 1,
		});
		const run = manager.createRun({
			automationTaskId: automation.id,
			ownerType: automation.ownerType,
			ownerId: automation.ownerId,
			status: 'running',
			triggerType: 'manual',
		});
		manager.updateRun(run.id, { startedAt: Date.now() - 10_000 });

		const count = scheduler.recoverOrphanedRuns(1);
		const updated = manager.getRun(run.id);

		expect(count).toBe(1);
		expect(updated?.status).toBe('lost');
		expect(
			manager.listRunEvents({ automationRunId: run.id }).some((event) => {
				return event.eventType === 'run_recovered';
			})
		).toBe(true);
	});

	it('syncs linked room task completion back to automation runs', async () => {
		scheduler = new AutomationScheduler(manager, jobQueue, undefined, {
			async getRoomTaskStatus() {
				return { status: 'completed', result: 'Task completed' };
			},
		});
		const automation = manager.createTask({
			ownerType: 'room',
			ownerId: 'room-1',
			title: 'Linked room task',
			triggerType: 'manual',
			targetType: 'room_task',
			targetConfig: {
				roomId: 'room-1',
				titleTemplate: 'Check',
				descriptionTemplate: 'Check progress.',
				taskType: 'research',
				assignedAgent: 'general',
			},
		});
		const run = manager.createRun({
			automationTaskId: automation.id,
			ownerType: automation.ownerType,
			ownerId: automation.ownerId,
			status: 'running',
			triggerType: 'manual',
		});
		manager.updateRun(run.id, { roomTaskId: 'task-1' });

		const updated = await scheduler.syncLinkedRuns();

		expect(updated).toBe(1);
		expect(manager.getRun(run.id)?.status).toBe('succeeded');
		expect(manager.getRun(run.id)?.resultSummary).toBe('Task completed');
	});

	it('pauses automations after repeated identical failures', async () => {
		scheduler.registerLauncher('job_handler', new FailingLauncher());
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Circuit breaker check',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
			maxRetries: 0,
		});

		await scheduler.triggerNow(automation.id);
		await scheduler.triggerNow(automation.id);
		const failed = await scheduler.triggerNow(automation.id);
		const updated = manager.getTask(automation.id);

		expect(failed.status).toBe('failed');
		expect(updated?.status).toBe('paused');
		expect(updated?.consecutiveFailureCount).toBe(3);
		expect(updated?.lastFailureFingerprint).toContain('launch failed');
		expect(updated?.pausedReason).toContain('Paused after 3 consecutive automation failures');
		expect(
			manager.listRunEvents({ automationRunId: failed.id }).some((event) => {
				return event.eventType === 'circuit_breaker_paused';
			})
		).toBe(true);
	});

	it('dispatch job rejects paused automations', async () => {
		const automation = manager.createTask({
			ownerType: 'global',
			title: 'Paused check',
			status: 'paused',
			triggerType: 'manual',
			targetType: 'job_handler',
			targetConfig: { queue: 'test.queue' },
		});
		const job = jobQueue.enqueue({
			queue: AUTOMATION_DISPATCH,
			payload: { automationId: automation.id },
		});

		await expect(scheduler.handleDispatchJob(job)).rejects.toThrow('is not active');
	});
});
