import { AUTOMATION_SWEEP } from '../job-queue-constants';
import type { AutomationScheduler } from '../automation/automation-scheduler';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';

export interface AutomationSweepResult extends Record<string, unknown> {
	timedOutRuns: number;
	syncedRuns: number;
	nextRunAt: number;
}

export async function handleAutomationSweep(
	scheduler: AutomationScheduler,
	jobQueue: JobQueueRepository,
	intervalMs = 30_000
): Promise<AutomationSweepResult> {
	const timedOutRuns = scheduler.sweepTimedOutRuns();
	const syncedRuns = await scheduler.syncLinkedRuns();
	const nextRunAt = Date.now() + intervalMs;
	const pending = jobQueue.listJobs({
		queue: AUTOMATION_SWEEP,
		status: 'pending',
		limit: 1,
	});
	if (pending.length === 0) {
		jobQueue.enqueue({
			queue: AUTOMATION_SWEEP,
			payload: {},
			runAt: nextRunAt,
			maxRetries: 0,
		});
	}
	return { timedOutRuns, syncedRuns, nextRunAt };
}
