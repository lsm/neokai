/**
 * RecurringJobScheduler - Scheduled recurring job management
 *
 * Handles:
 * - Scheduling jobs (cron, interval, daily, weekly)
 * - Triggering jobs when due
 * - Creating tasks from job templates
 * - Managing job lifecycle
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { DaemonHub } from '../daemon-hub';
import {
	RecurringJobRepository,
	type CreateRecurringJobParams,
	type UpdateRecurringJobParams,
} from '../../storage/repositories/recurring-job-repository';
import { TaskRepository } from '../../storage/repositories/task-repository';
import type { RecurringJob, RecurringJobSchedule } from '@neokai/shared';
import { Logger } from '../logger';

const log = new Logger('recurring-job-scheduler');

/**
 * Internal scheduled job state
 */
interface ScheduledJob {
	jobId: string;
	timerId: Timer | null;
	nextRunAt: number;
}

export class RecurringJobScheduler {
	private jobRepo: RecurringJobRepository;
	private taskRepo: TaskRepository;
	private scheduledJobs: Map<string, ScheduledJob> = new Map();
	private checkInterval: Timer | null = null;
	private readonly checkIntervalMs: number = 60000; // Check every minute

	constructor(
		private db: BunDatabase,
		private daemonHub: DaemonHub
	) {
		this.jobRepo = new RecurringJobRepository(db);
		this.taskRepo = new TaskRepository(db);
	}

	/**
	 * Start the scheduler - loads all enabled jobs and schedules them
	 */
	start(): void {
		log.info('Starting recurring job scheduler');

		// Load all enabled jobs
		const jobs = this.jobRepo.getAllEnabledJobs();
		log.info(`Found ${jobs.length} enabled recurring jobs`);

		for (const job of jobs) {
			this.scheduleJob(job);
		}

		// Start periodic check for due jobs
		this.checkInterval = setInterval(() => {
			this.checkDueJobs();
		}, this.checkIntervalMs);

		log.info('Recurring job scheduler started');
	}

	/**
	 * Stop the scheduler
	 */
	stop(): void {
		log.info('Stopping recurring job scheduler');

		// Clear all scheduled timers
		for (const [_jobId, scheduled] of this.scheduledJobs) {
			if (scheduled.timerId) {
				clearTimeout(scheduled.timerId);
			}
		}
		this.scheduledJobs.clear();

		// Clear check interval
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}

		log.info('Recurring job scheduler stopped');
	}

	/**
	 * Create a new recurring job
	 */
	async createJob(params: CreateRecurringJobParams): Promise<RecurringJob> {
		const job = this.jobRepo.createJob(params);

		// Calculate next run time
		const nextRunAt = this.calculateNextRun(job.schedule);
		this.jobRepo.updateJob(job.id, { nextRunAt });

		// Schedule if enabled
		if (job.enabled) {
			const updatedJob = this.jobRepo.getJob(job.id);
			if (updatedJob) {
				this.scheduleJob(updatedJob);
			}
		}

		// Emit job created event
		await this.daemonHub.emit('recurringJob.created', {
			sessionId: `room:${job.roomId}`,
			roomId: job.roomId,
			jobId: job.id,
			job: job,
		});

		return job;
	}

	/**
	 * Get a job by ID
	 */
	getJob(jobId: string): RecurringJob | null {
		return this.jobRepo.getJob(jobId);
	}

	/**
	 * List jobs for a room
	 */
	listJobs(roomId: string, enabledOnly?: boolean): RecurringJob[] {
		return this.jobRepo.listJobs(roomId, enabledOnly);
	}

	/**
	 * Update a job
	 */
	async updateJob(jobId: string, params: UpdateRecurringJobParams): Promise<RecurringJob | null> {
		const job = this.jobRepo.updateJob(jobId, params);
		if (!job) return null;

		// Reschedule if schedule changed or enabled status changed
		if (params.schedule || params.enabled !== undefined) {
			this.unscheduleJob(jobId);
			if (job.enabled) {
				this.scheduleJob(job);
			}
		}

		return job;
	}

	/**
	 * Enable a job
	 */
	async enableJob(jobId: string): Promise<RecurringJob | null> {
		const job = this.jobRepo.enableJob(jobId);
		if (!job) return null;

		this.scheduleJob(job);
		return job;
	}

	/**
	 * Disable a job
	 */
	async disableJob(jobId: string): Promise<RecurringJob | null> {
		const job = this.jobRepo.disableJob(jobId);
		if (!job) return null;

		this.unscheduleJob(jobId);
		return job;
	}

	/**
	 * Delete a job
	 */
	async deleteJob(jobId: string): Promise<boolean> {
		this.unscheduleJob(jobId);
		return this.jobRepo.deleteJob(jobId);
	}

	/**
	 * Manually trigger a job (for testing or immediate execution)
	 */
	async triggerJob(jobId: string): Promise<{ success: boolean; taskId?: string; error?: string }> {
		const job = this.jobRepo.getJob(jobId);
		if (!job) {
			return { success: false, error: 'Job not found' };
		}

		try {
			const taskId = await this.executeJob(job);
			return { success: true, taskId };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			log.error(`Failed to trigger job ${jobId}:`, errorMessage);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Schedule a job for execution
	 */
	private scheduleJob(job: RecurringJob): void {
		// Don't schedule if max runs reached
		if (this.jobRepo.hasReachedMaxRuns(job)) {
			log.info(`Job ${job.id} has reached max runs (${job.runCount}/${job.maxRuns})`);
			return;
		}

		// Calculate next run time if not set
		let nextRunAt = job.nextRunAt;
		if (!nextRunAt) {
			nextRunAt = this.calculateNextRun(job.schedule);
			this.jobRepo.updateJob(job.id, { nextRunAt });
		}

		const now = Date.now();
		const delay = Math.max(0, nextRunAt - now);

		log.debug(`Scheduling job ${job.id} to run in ${delay}ms`);

		// Clear existing timer if any
		const existing = this.scheduledJobs.get(job.id);
		if (existing?.timerId) {
			clearTimeout(existing.timerId);
		}

		// Set timer for execution
		const timerId = setTimeout(() => {
			this.executeJobIfDue(job.id);
		}, delay);

		this.scheduledJobs.set(job.id, {
			jobId: job.id,
			timerId,
			nextRunAt,
		});
	}

	/**
	 * Unschedule a job
	 */
	private unscheduleJob(jobId: string): void {
		const scheduled = this.scheduledJobs.get(jobId);
		if (scheduled?.timerId) {
			clearTimeout(scheduled.timerId);
		}
		this.scheduledJobs.delete(jobId);
	}

	/**
	 * Check for due jobs and execute them
	 */
	private checkDueJobs(): void {
		const dueJobs = this.jobRepo.getDueJobs();

		for (const job of dueJobs) {
			this.executeJobIfDue(job.id);
		}
	}

	/**
	 * Execute a job if it's due
	 */
	private async executeJobIfDue(jobId: string): Promise<void> {
		const job = this.jobRepo.getJob(jobId);
		if (!job || !job.enabled) {
			this.unscheduleJob(jobId);
			return;
		}

		// Check if max runs reached
		if (this.jobRepo.hasReachedMaxRuns(job)) {
			log.info(`Job ${jobId} has reached max runs, disabling`);
			this.jobRepo.disableJob(jobId);
			this.unscheduleJob(jobId);
			return;
		}

		try {
			await this.executeJob(job);

			// Calculate next run and reschedule
			const nextRunAt = this.calculateNextRun(job.schedule);
			this.jobRepo.markJobRun(jobId, nextRunAt);

			// Reschedule
			const updatedJob = this.jobRepo.getJob(jobId);
			if (updatedJob && updatedJob.enabled) {
				this.scheduleJob(updatedJob);
			}
		} catch (error) {
			log.error(`Failed to execute job ${jobId}:`, error);

			// Still reschedule on error
			const nextRunAt = this.calculateNextRun(job.schedule);
			this.jobRepo.updateJob(jobId, { nextRunAt });

			const updatedJob = this.jobRepo.getJob(jobId);
			if (updatedJob && updatedJob.enabled) {
				this.scheduleJob(updatedJob);
			}
		}
	}

	/**
	 * Execute a job - create a task from the template
	 */
	private async executeJob(job: RecurringJob): Promise<string> {
		log.info(`Executing recurring job: ${job.name} (${job.id})`);

		const template = job.taskTemplate;

		// Create task from template
		const task = this.taskRepo.createTask({
			roomId: job.roomId,
			title: template.title,
			description: template.description,
			priority: template.priority,
		});

		// Update task with recurring job reference
		this.taskRepo.updateTask(task.id, {
			recurringJobId: job.id,
			executionMode: template.executionMode,
		});

		// Emit job triggered event
		await this.daemonHub.emit('recurringJob.triggered', {
			sessionId: `room:${job.roomId}`,
			roomId: job.roomId,
			jobId: job.id,
			taskId: task.id,
		});

		log.info(`Created task ${task.id} from recurring job ${job.id}`);

		return task.id;
	}

	/**
	 * Calculate the next run time based on schedule
	 */
	calculateNextRun(schedule: RecurringJobSchedule): number {
		const now = new Date();

		switch (schedule.type) {
			case 'interval':
				return now.getTime() + schedule.minutes * 60 * 1000;

			case 'daily': {
				// Schedule for today at the specified time, or tomorrow if already passed
				const target = new Date(now);
				target.setHours(schedule.hour, schedule.minute, 0, 0);

				if (target.getTime() <= now.getTime()) {
					// Already passed today, schedule for tomorrow
					target.setDate(target.getDate() + 1);
				}

				return target.getTime();
			}

			case 'weekly': {
				// Schedule for the next occurrence of the specified day and time
				const target = new Date(now);
				target.setHours(schedule.hour, schedule.minute, 0, 0);

				const currentDay = target.getDay();
				const daysUntilTarget = (schedule.dayOfWeek - currentDay + 7) % 7;

				if (daysUntilTarget === 0 && target.getTime() <= now.getTime()) {
					// Already passed today, schedule for next week
					target.setDate(target.getDate() + 7);
				} else {
					target.setDate(target.getDate() + daysUntilTarget);
				}

				return target.getTime();
			}

			case 'cron': {
				// Simple cron parsing - just support basic patterns for now
				// For full cron support, use a library like cron-parser
				// For now, default to daily if cron expression provided
				log.warn(
					`Cron expression '${schedule.expression}' not fully supported, defaulting to daily`
				);
				const target = new Date(now);
				target.setDate(target.getDate() + 1);
				target.setHours(0, 0, 0, 0);
				return target.getTime();
			}

			default:
				// Default to 1 day from now
				return now.getTime() + 24 * 60 * 60 * 1000;
		}
	}

	/**
	 * Get scheduler statistics
	 */
	getStats(): { totalJobs: number; enabledJobs: number; scheduledJobs: number } {
		const allJobs = this.jobRepo.getAllEnabledJobs();
		return {
			totalJobs: allJobs.length,
			enabledJobs: allJobs.filter((j) => j.enabled).length,
			scheduledJobs: this.scheduledJobs.size,
		};
	}
}
