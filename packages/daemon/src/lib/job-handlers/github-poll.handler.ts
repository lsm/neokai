/**
 * Job handler for github.poll queue.
 *
 * Triggers a poll of all GitHub repositories and self-schedules the next poll
 * job, with deduplication to prevent multiple concurrent poll chains.
 */

import { GITHUB_POLL } from '../job-queue-constants';
import { Logger } from '../logger';
import type { GitHubPollingService } from '../github/polling-service';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';

const log = new Logger('github-poll-handler');

export interface GitHubPollHandlerDeps {
	pollingService: GitHubPollingService | undefined;
	jobQueue: JobQueueRepository;
	intervalMs: number;
}

// Extends Record<string, unknown> so the result satisfies JobHandler's return type.
export interface GitHubPollResult extends Record<string, unknown> {
	polled: boolean;
	nextRunAt: number;
}

export async function handleGitHubPoll(deps: GitHubPollHandlerDeps): Promise<GitHubPollResult> {
	const { pollingService, jobQueue, intervalMs } = deps;

	let polled = false;

	try {
		if (pollingService) {
			await pollingService.triggerPoll();
			polled = true;
		} else {
			log.warn('github.poll handler called but no polling service is configured');
		}
	} catch (error) {
		log.error('triggerPoll failed', {
			error: error instanceof Error ? error.message : error,
		});
	}

	// Compute nextRunAt after the poll so the interval is measured from
	// completion, not from when the job was dequeued.
	const nextRunAt = Date.now() + intervalMs;

	// Only enqueue the next job if there is no pending or processing job
	// already in the chain. Checking 'processing' prevents a duplicate chain
	// from forming under stale-reclaim or slow-poll scenarios.
	const existingJobs = jobQueue.listJobs({
		queue: GITHUB_POLL,
		status: ['pending', 'processing'],
		limit: 10,
	});

	if (existingJobs.length === 0) {
		jobQueue.enqueue({
			queue: GITHUB_POLL,
			payload: {},
			runAt: nextRunAt,
		});
	}

	return { polled, nextRunAt };
}
