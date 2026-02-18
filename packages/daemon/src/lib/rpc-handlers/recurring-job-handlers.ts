/**
 * Recurring Job RPC Handlers
 *
 * RPC handlers for recurring job operations:
 * - recurringJob.create - Create a recurring job
 * - recurringJob.get - Get job details
 * - recurringJob.list - List jobs in a room
 * - recurringJob.update - Update a job
 * - recurringJob.enable - Enable a job
 * - recurringJob.disable - Disable a job
 * - recurringJob.delete - Delete a job
 * - recurringJob.trigger - Manually trigger a job
 * - recurringJob.getStats - Get scheduler statistics
 */

import type {
	MessageHub,
	RecurringJob,
	RecurringJobSchedule,
	RecurringTaskTemplate,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { RecurringJobScheduler } from '../room/recurring-job-scheduler';

/**
 * Type alias for testability - allows injecting mock schedulers
 */
export type RecurringJobSchedulerLike = Pick<
	RecurringJobScheduler,
	| 'createJob'
	| 'getJob'
	| 'listJobs'
	| 'updateJob'
	| 'enableJob'
	| 'disableJob'
	| 'deleteJob'
	| 'triggerJob'
	| 'getStats'
>;

/**
 * Setup recurring job RPC handlers
 *
 * @param messageHub - MessageHub instance for RPC registration
 * @param daemonHub - DaemonHub instance for event emission
 * @param scheduler - RecurringJobScheduler instance (or mock for testing)
 */
export function setupRecurringJobHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	scheduler: RecurringJobSchedulerLike
): void {
	/**
	 * Emit a recurring job status change event (enabled/disabled/deleted)
	 */
	const emitJobStatusEvent = (
		eventName: 'recurringJob.enabled' | 'recurringJob.disabled' | 'recurringJob.deleted',
		roomId: string,
		jobId: string
	) => {
		daemonHub
			.emit(eventName, {
				sessionId: `room:${roomId}`,
				roomId,
				jobId,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	/**
	 * Emit a recurring job update event
	 */
	const emitJobUpdatedEvent = (roomId: string, jobId: string, job: RecurringJob) => {
		daemonHub
			.emit('recurringJob.updated', {
				sessionId: `room:${roomId}`,
				roomId,
				jobId,
				job,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	// recurringJob.create - Create a recurring job
	messageHub.onRequest('recurringJob.create', async (data) => {
		const params = data as {
			roomId: string;
			name: string;
			description: string;
			schedule: RecurringJobSchedule;
			taskTemplate: RecurringTaskTemplate;
			enabled?: boolean;
			maxRuns?: number;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.name) {
			throw new Error('Job name is required');
		}
		if (!params.schedule) {
			throw new Error('Schedule is required');
		}
		if (!params.taskTemplate) {
			throw new Error('Task template is required');
		}

		const job = await scheduler.createJob({
			roomId: params.roomId,
			name: params.name,
			description: params.description ?? '',
			schedule: params.schedule,
			taskTemplate: params.taskTemplate,
			enabled: params.enabled,
			maxRuns: params.maxRuns,
		});

		// Event is emitted by scheduler.createJob, no need to emit here

		return { job };
	});

	// recurringJob.get - Get job details
	messageHub.onRequest('recurringJob.get', async (data) => {
		const params = data as { jobId: string };

		if (!params.jobId) {
			throw new Error('Job ID is required');
		}

		const job = scheduler.getJob(params.jobId);

		return { job };
	});

	// recurringJob.list - List jobs in a room
	messageHub.onRequest('recurringJob.list', async (data) => {
		const params = data as { roomId: string; enabledOnly?: boolean };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const jobs = scheduler.listJobs(params.roomId, params.enabledOnly);

		return { jobs };
	});

	// recurringJob.update - Update a job
	messageHub.onRequest('recurringJob.update', async (data) => {
		const params = data as {
			jobId: string;
			name?: string;
			description?: string;
			schedule?: RecurringJobSchedule;
			taskTemplate?: RecurringTaskTemplate;
			enabled?: boolean;
			maxRuns?: number;
		};

		if (!params.jobId) {
			throw new Error('Job ID is required');
		}

		const job = await scheduler.updateJob(params.jobId, {
			name: params.name,
			description: params.description,
			schedule: params.schedule,
			taskTemplate: params.taskTemplate,
			enabled: params.enabled,
			maxRuns: params.maxRuns,
		});

		if (job) {
			emitJobUpdatedEvent(job.roomId, job.id, job);
		}

		return { job };
	});

	// recurringJob.enable - Enable a job
	messageHub.onRequest('recurringJob.enable', async (data) => {
		const params = data as { jobId: string };

		if (!params.jobId) {
			throw new Error('Job ID is required');
		}

		const job = await scheduler.enableJob(params.jobId);

		if (job) {
			emitJobStatusEvent('recurringJob.enabled', job.roomId, job.id);
		}

		return { job };
	});

	// recurringJob.disable - Disable a job
	messageHub.onRequest('recurringJob.disable', async (data) => {
		const params = data as { jobId: string };

		if (!params.jobId) {
			throw new Error('Job ID is required');
		}

		const job = await scheduler.disableJob(params.jobId);

		if (job) {
			emitJobStatusEvent('recurringJob.disabled', job.roomId, job.id);
		}

		return { job };
	});

	// recurringJob.delete - Delete a job
	messageHub.onRequest('recurringJob.delete', async (data) => {
		const params = data as { jobId: string };

		if (!params.jobId) {
			throw new Error('Job ID is required');
		}

		// Get job before deletion to emit event with roomId
		const job = scheduler.getJob(params.jobId);
		const roomId = job?.roomId;

		const success = await scheduler.deleteJob(params.jobId);

		if (success && roomId) {
			emitJobStatusEvent('recurringJob.deleted', roomId, params.jobId);
		}

		return { success };
	});

	// recurringJob.trigger - Manually trigger a job
	messageHub.onRequest('recurringJob.trigger', async (data) => {
		const params = data as { jobId: string };

		if (!params.jobId) {
			throw new Error('Job ID is required');
		}

		const result = await scheduler.triggerJob(params.jobId);

		// Event is emitted by scheduler.triggerJob on success, no need to emit here

		return result;
	});

	// recurringJob.getStats - Get scheduler statistics
	messageHub.onRequest('recurringJob.getStats', async () => {
		const stats = scheduler.getStats();

		return { stats };
	});
}
