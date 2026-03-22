/**
 * Job handler for github.poll queue.
 *
 * Triggers a poll of all GitHub repositories and self-schedules the next poll
 * job, with deduplication to prevent multiple concurrent poll chains.
 */

import { GITHUB_POLL } from '../job-queue-constants';
import type { GitHubPollingService } from '../github/polling-service';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';

export interface GitHubPollHandlerDeps {
	pollingService: GitHubPollingService;
	jobQueue: JobQueueRepository;
	intervalMs: number;
}

export interface GitHubPollResult {
	polled: boolean;
	nextRunAt: number;
}

export async function handleGitHubPoll(deps: GitHubPollHandlerDeps): Promise<GitHubPollResult> {
	const { pollingService, jobQueue, intervalMs } = deps;
	const nextRunAt = Date.now() + intervalMs;

	try {
		await pollingService.triggerPoll();
	} finally {
		const pendingJobs = jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['pending'],
			limit: 10,
		});

		if (pendingJobs.length === 0) {
			jobQueue.enqueue({
				queue: GITHUB_POLL,
				payload: {},
				runAt: nextRunAt,
			});
		}
	}

	return { polled: true, nextRunAt };
}
