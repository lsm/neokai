import type { Job } from '../../storage/repositories/job-queue-repository';
import type { AutomationScheduler } from '../automation/automation-scheduler';

export function createAutomationDispatchHandler(scheduler: AutomationScheduler) {
	return async function automationDispatchHandler(job: Job): Promise<Record<string, unknown>> {
		return scheduler.handleDispatchJob(job);
	};
}
