/**
 * RecurringJobScheduler Tests
 *
 * Tests for scheduled recurring job management:
 * - Lifecycle management (start/stop)
 * - Creating jobs with different schedules (interval, daily, weekly, cron)
 * - Job CRUD operations
 * - Enabling/disabling jobs
 * - Manual triggering
 * - Schedule calculations
 * - Scheduled execution with timers
 * - Max runs limit handling
 */

import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { RecurringJobScheduler } from '../../../src/lib/room/recurring-job-scheduler';
import { RoomManager } from '../../../src/lib/room/room-manager';
import { createDaemonHub, type DaemonHub } from '../../../src/lib/daemon-hub';
import type { RecurringJob, RecurringJobSchedule, RecurringTaskTemplate } from '@neokai/shared';

describe('RecurringJobScheduler', () => {
	let db: Database;
	let daemonHub: DaemonHub;
	let scheduler: RecurringJobScheduler;
	let roomManager: RoomManager;
	let roomId: string;
	let emittedEvents: Array<{ event: string; data: unknown }>;

	beforeEach(async () => {
		// Use an anonymous in-memory database for each test
		db = new Database(':memory:');
		createTables(db);

		// Add migration 18 columns to tasks table (multi-session task support)
		db.exec(`
			ALTER TABLE tasks ADD COLUMN session_ids TEXT DEFAULT '[]';
			ALTER TABLE tasks ADD COLUMN execution_mode TEXT DEFAULT 'single'
				CHECK(execution_mode IN ('single', 'parallel', 'serial', 'parallel_then_merge'));
			ALTER TABLE tasks ADD COLUMN sessions TEXT DEFAULT '[]';
			ALTER TABLE tasks ADD COLUMN recurring_job_id TEXT;
		`);

		// Create recurring_jobs table (migration 19 - not included in createTables)
		db.exec(`
			CREATE TABLE IF NOT EXISTS recurring_jobs (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				schedule TEXT NOT NULL DEFAULT '{}',
				task_template TEXT NOT NULL DEFAULT '{}',
				enabled INTEGER DEFAULT 1,
				last_run_at INTEGER,
				next_run_at INTEGER,
				run_count INTEGER DEFAULT 0,
				max_runs INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_recurring_jobs_room ON recurring_jobs(room_id);
			CREATE INDEX IF NOT EXISTS idx_recurring_jobs_enabled ON recurring_jobs(enabled);
			CREATE INDEX IF NOT EXISTS idx_recurring_jobs_next_run ON recurring_jobs(next_run_at);
		`);

		// Create room manager and a room
		roomManager = new RoomManager(db);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: ['/workspace/test'],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;

		// Track emitted events
		emittedEvents = [];

		// Create and initialize DaemonHub
		daemonHub = createDaemonHub('test');
		await daemonHub.initialize();

		// Create scheduler
		scheduler = new RecurringJobScheduler(db, daemonHub);
	});

	afterEach(() => {
		// Stop scheduler to clear any timers
		scheduler.stop();
		db.close();
	});

	// Helper to create a basic job template
	const createTestTemplate = (): RecurringTaskTemplate => ({
		title: 'Test Task',
		description: 'A test task description',
		priority: 'normal',
	});

	// Helper to create a basic interval schedule
	const createIntervalSchedule = (minutes: number = 60): RecurringJobSchedule => ({
		type: 'interval',
		minutes,
	});

	// Helper to create a daily schedule
	const createDailySchedule = (hour: number = 9, minute: number = 0): RecurringJobSchedule => ({
		type: 'daily',
		hour,
		minute,
	});

	// Helper to create a weekly schedule
	const createWeeklySchedule = (
		dayOfWeek: number = 1,
		hour: number = 9,
		minute: number = 0
	): RecurringJobSchedule => ({
		type: 'weekly',
		dayOfWeek,
		hour,
		minute,
	});

	// Helper to create a cron schedule
	const createCronSchedule = (expression: string = '0 9 * * *'): RecurringJobSchedule => ({
		type: 'cron',
		expression,
	});

	describe('initialization', () => {
		it('should create scheduler instance', () => {
			expect(scheduler).toBeDefined();
		});

		it('should start with no scheduled jobs', () => {
			const stats = scheduler.getStats();
			expect(stats.scheduledJobs).toBe(0);
		});
	});

	describe('start/stop lifecycle', () => {
		it('should start scheduler without errors', () => {
			expect(() => scheduler.start()).not.toThrow();
		});

		it('should stop scheduler without errors', () => {
			scheduler.start();
			expect(() => scheduler.stop()).not.toThrow();
		});

		it('should load enabled jobs on start', async () => {
			// Create an enabled job before starting
			await scheduler.createJob({
				roomId,
				name: 'Test Job',
				description: 'Test description',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});

			scheduler.start();

			const stats = scheduler.getStats();
			expect(stats.scheduledJobs).toBe(1);
		});

		it('should not load disabled jobs on start', async () => {
			// Create a disabled job before starting
			await scheduler.createJob({
				roomId,
				name: 'Disabled Job',
				description: 'Test description',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: false,
			});

			scheduler.start();

			const stats = scheduler.getStats();
			expect(stats.scheduledJobs).toBe(0);
		});

		it('should clear all timers on stop', async () => {
			await scheduler.createJob({
				roomId,
				name: 'Test Job',
				description: 'Test description',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});

			scheduler.start();
			expect(scheduler.getStats().scheduledJobs).toBe(1);

			scheduler.stop();
			expect(scheduler.getStats().scheduledJobs).toBe(0);
		});
	});

	describe('createJob', () => {
		it('should create a job with minimal params', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			expect(job).toBeDefined();
			expect(job.id).toBeDefined();
			expect(job.roomId).toBe(roomId);
			expect(job.name).toBe('Test Job');
			expect(job.description).toBe('');
			expect(job.enabled).toBe(true);
			expect(job.runCount).toBe(0);
			expect(job.nextRunAt).toBeDefined();
		});

		it('should create a job with all params', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Full Job',
				description: 'A detailed description',
				schedule: createDailySchedule(14, 30),
				taskTemplate: {
					title: 'Daily Task',
					description: 'Task desc',
					priority: 'high',
					executionMode: 'parallel',
				},
				enabled: false,
				maxRuns: 10,
			});

			expect(job.name).toBe('Full Job');
			expect(job.description).toBe('A detailed description');
			expect(job.schedule).toEqual(createDailySchedule(14, 30));
			expect(job.taskTemplate.priority).toBe('high');
			expect(job.taskTemplate.executionMode).toBe('parallel');
			expect(job.enabled).toBe(false);
			expect(job.maxRuns).toBe(10);
		});

		it('should create job with daily schedule', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Daily Job',
				description: '',
				schedule: createDailySchedule(9, 30),
				taskTemplate: createTestTemplate(),
			});

			expect(job.schedule.type).toBe('daily');
			expect((job.schedule as { hour: number; minute: number }).hour).toBe(9);
			expect((job.schedule as { hour: number; minute: number }).minute).toBe(30);
		});

		it('should create job with weekly schedule', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Weekly Job',
				description: '',
				schedule: createWeeklySchedule(5, 10, 0), // Friday at 10:00
				taskTemplate: createTestTemplate(),
			});

			expect(job.schedule.type).toBe('weekly');
			const weeklySchedule = job.schedule as { dayOfWeek: number; hour: number; minute: number };
			expect(weeklySchedule.dayOfWeek).toBe(5);
			expect(weeklySchedule.hour).toBe(10);
		});

		it('should create job with cron schedule', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Cron Job',
				description: '',
				schedule: createCronSchedule('0 9 * * 1-5'),
				taskTemplate: createTestTemplate(),
			});

			expect(job.schedule.type).toBe('cron');
			expect((job.schedule as { expression: string }).expression).toBe('0 9 * * 1-5');
		});

		it('should calculate nextRunAt when creating job', async () => {
			const before = Date.now();
			await scheduler.createJob({
				roomId,
				name: 'Test Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});
			const after = Date.now();

			// Get the job again to see the updated nextRunAt (createJob returns the initial job without nextRunAt)
			const jobs = scheduler.listJobs(roomId);
			expect(jobs).toHaveLength(1);
			expect(jobs[0].nextRunAt).toBeDefined();
			expect(jobs[0].nextRunAt!).toBeGreaterThanOrEqual(before);
			expect(jobs[0].nextRunAt!).toBeLessThanOrEqual(after + 60 * 60 * 1000);
		});

		it('should schedule enabled job immediately', async () => {
			await scheduler.createJob({
				roomId,
				name: 'Enabled Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});

			// Job should be scheduled
			expect(scheduler.getStats().scheduledJobs).toBe(1);
		});

		it('should not schedule disabled job', async () => {
			await scheduler.createJob({
				roomId,
				name: 'Disabled Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: false,
			});

			expect(scheduler.getStats().scheduledJobs).toBe(0);
		});
	});

	describe('getJob', () => {
		it('should get a job by ID', async () => {
			const created = await scheduler.createJob({
				roomId,
				name: 'Test Job',
				description: 'Test description',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const retrieved = scheduler.getJob(created.id);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe(created.id);
			expect(retrieved?.name).toBe('Test Job');
		});

		it('should return null for non-existent job', () => {
			const job = scheduler.getJob('non-existent-id');
			expect(job).toBeNull();
		});
	});

	describe('listJobs', () => {
		it('should list all jobs for a room', async () => {
			await scheduler.createJob({
				roomId,
				name: 'Job 1',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});
			await scheduler.createJob({
				roomId,
				name: 'Job 2',
				description: '',
				schedule: createIntervalSchedule(30),
				taskTemplate: createTestTemplate(),
			});

			const jobs = scheduler.listJobs(roomId);

			expect(jobs).toHaveLength(2);
		});

		it('should list only enabled jobs when enabledOnly is true', async () => {
			await scheduler.createJob({
				roomId,
				name: 'Enabled Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});
			await scheduler.createJob({
				roomId,
				name: 'Disabled Job',
				description: '',
				schedule: createIntervalSchedule(30),
				taskTemplate: createTestTemplate(),
				enabled: false,
			});

			const jobs = scheduler.listJobs(roomId, true);

			expect(jobs).toHaveLength(1);
			expect(jobs[0].name).toBe('Enabled Job');
		});

		it('should return empty array for room with no jobs', () => {
			const jobs = scheduler.listJobs(roomId);
			expect(jobs).toEqual([]);
		});

		it('should not return jobs from other rooms', async () => {
			await scheduler.createJob({
				roomId,
				name: 'Room 1 Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const room2 = roomManager.createRoom({ name: 'Room 2' });
			await scheduler.createJob({
				roomId: room2.id,
				name: 'Room 2 Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const jobsRoom1 = scheduler.listJobs(roomId);
			const jobsRoom2 = scheduler.listJobs(room2.id);

			expect(jobsRoom1).toHaveLength(1);
			expect(jobsRoom2).toHaveLength(1);
			expect(jobsRoom1[0].name).toBe('Room 1 Job');
			expect(jobsRoom2[0].name).toBe('Room 2 Job');
		});
	});

	describe('updateJob', () => {
		it('should update job name', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Original Name',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const updated = await scheduler.updateJob(job.id, { name: 'New Name' });

			expect(updated?.name).toBe('New Name');
		});

		it('should update job description', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: 'Original desc',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const updated = await scheduler.updateJob(job.id, { description: 'New desc' });

			expect(updated?.description).toBe('New desc');
		});

		it('should update job schedule', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const updated = await scheduler.updateJob(job.id, {
				schedule: createDailySchedule(10, 0),
			});

			expect(updated?.schedule.type).toBe('daily');
		});

		it('should update task template', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const newTemplate: RecurringTaskTemplate = {
				title: 'Updated Task',
				description: 'Updated description',
				priority: 'high',
			};

			const updated = await scheduler.updateJob(job.id, { taskTemplate: newTemplate });

			expect(updated?.taskTemplate.title).toBe('Updated Task');
			expect(updated?.taskTemplate.priority).toBe('high');
		});

		it('should update maxRuns', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const updated = await scheduler.updateJob(job.id, { maxRuns: 5 });

			expect(updated?.maxRuns).toBe(5);
		});

		it('should reschedule job when schedule changes', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});

			const originalNextRun = job.nextRunAt;

			// Wait a bit to ensure time difference
			await new Promise((resolve) => setTimeout(resolve, 10));

			await scheduler.updateJob(job.id, {
				schedule: createIntervalSchedule(120),
			});

			const updated = scheduler.getJob(job.id);
			expect(updated?.nextRunAt).not.toBe(originalNextRun);
		});

		it('should return null for non-existent job', async () => {
			const result = await scheduler.updateJob('non-existent', { name: 'Test' });
			expect(result).toBeNull();
		});
	});

	describe('enableJob', () => {
		it('should enable a disabled job', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: false,
			});

			expect(job.enabled).toBe(false);

			const updated = await scheduler.enableJob(job.id);

			expect(updated?.enabled).toBe(true);
		});

		it('should schedule job when enabled', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: false,
			});

			expect(scheduler.getStats().scheduledJobs).toBe(0);

			await scheduler.enableJob(job.id);

			expect(scheduler.getStats().scheduledJobs).toBe(1);
		});

		it('should return null for non-existent job', async () => {
			const result = await scheduler.enableJob('non-existent');
			expect(result).toBeNull();
		});
	});

	describe('disableJob', () => {
		it('should disable an enabled job', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});

			const updated = await scheduler.disableJob(job.id);

			expect(updated?.enabled).toBe(false);
		});

		it('should unschedule job when disabled', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});

			expect(scheduler.getStats().scheduledJobs).toBe(1);

			await scheduler.disableJob(job.id);

			expect(scheduler.getStats().scheduledJobs).toBe(0);
		});

		it('should return null for non-existent job', async () => {
			const result = await scheduler.disableJob('non-existent');
			expect(result).toBeNull();
		});
	});

	describe('deleteJob', () => {
		it('should delete an existing job', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const result = await scheduler.deleteJob(job.id);

			expect(result).toBe(true);

			const retrieved = scheduler.getJob(job.id);
			expect(retrieved).toBeNull();
		});

		it('should unschedule job when deleted', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});

			expect(scheduler.getStats().scheduledJobs).toBe(1);

			await scheduler.deleteJob(job.id);

			expect(scheduler.getStats().scheduledJobs).toBe(0);
		});

		it('should return false for non-existent job', async () => {
			const result = await scheduler.deleteJob('non-existent');
			expect(result).toBe(false);
		});
	});

	describe('triggerJob', () => {
		it('should trigger job and create task', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: {
					title: 'Triggered Task',
					description: 'Task from trigger',
					priority: 'high',
				},
			});

			const result = await scheduler.triggerJob(job.id);

			expect(result.success).toBe(true);
			expect(result.taskId).toBeDefined();
		});

		it('should return error for non-existent job', async () => {
			const result = await scheduler.triggerJob('non-existent');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Job not found');
		});

		it('should create task with template values', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: {
					title: 'Template Task',
					description: 'Template description',
					priority: 'urgent',
					executionMode: 'parallel',
				},
			});

			const result = await scheduler.triggerJob(job.id);

			expect(result.success).toBe(true);

			// Verify task was created with correct values by checking the database
			const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.taskId) as Record<
				string,
				unknown
			>;
			expect(taskRow).toBeDefined();
			expect(taskRow.title).toBe('Template Task');
			expect(taskRow.description).toBe('Template description');
			expect(taskRow.priority).toBe('urgent');
			expect(taskRow.execution_mode).toBe('parallel');
		});

		it('should set recurringJobId on created task', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			const result = await scheduler.triggerJob(job.id);

			const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.taskId) as Record<
				string,
				unknown
			>;
			expect(taskRow.recurring_job_id).toBe(job.id);
		});
	});

	describe('calculateNextRun', () => {
		it('should calculate next run for interval schedule', () => {
			const now = Date.now();
			const schedule: RecurringJobSchedule = { type: 'interval', minutes: 30 };

			const nextRun = scheduler.calculateNextRun(schedule);

			expect(nextRun).toBeGreaterThanOrEqual(now + 30 * 60 * 1000 - 100);
			expect(nextRun).toBeLessThanOrEqual(now + 30 * 60 * 1000 + 100);
		});

		it('should calculate next run for daily schedule (future today)', () => {
			const now = new Date();
			const futureHour = (now.getHours() + 2) % 24;
			const schedule: RecurringJobSchedule = {
				type: 'daily',
				hour: futureHour,
				minute: 0,
			};

			const nextRun = scheduler.calculateNextRun(schedule);
			const nextRunDate = new Date(nextRun);

			expect(nextRunDate.getHours()).toBe(futureHour);
			expect(nextRunDate.getMinutes()).toBe(0);
		});

		it('should calculate next run for daily schedule (past today -> tomorrow)', () => {
			const now = new Date();
			const pastHour = (now.getHours() - 2 + 24) % 24;
			const schedule: RecurringJobSchedule = {
				type: 'daily',
				hour: pastHour,
				minute: 0,
			};

			const nextRun = scheduler.calculateNextRun(schedule);
			const nextRunDate = new Date(nextRun);

			// Should be tomorrow
			expect(nextRun).toBeGreaterThan(now.getTime());
			expect(nextRunDate.getHours()).toBe(pastHour);
		});

		it('should calculate next run for weekly schedule', () => {
			const now = new Date();
			// Get a day that's not today
			const targetDay = (now.getDay() + 3) % 7;
			const schedule: RecurringJobSchedule = {
				type: 'weekly',
				dayOfWeek: targetDay,
				hour: 10,
				minute: 30,
			};

			const nextRun = scheduler.calculateNextRun(schedule);
			const nextRunDate = new Date(nextRun);

			expect(nextRunDate.getDay()).toBe(targetDay);
			expect(nextRunDate.getHours()).toBe(10);
			expect(nextRunDate.getMinutes()).toBe(30);
		});

		it('should calculate next run for weekly schedule (same day, future time)', () => {
			const now = new Date();
			const futureHour = (now.getHours() + 2) % 24;
			const schedule: RecurringJobSchedule = {
				type: 'weekly',
				dayOfWeek: now.getDay(),
				hour: futureHour,
				minute: 0,
			};

			const nextRun = scheduler.calculateNextRun(schedule);
			const nextRunDate = new Date(nextRun);

			expect(nextRunDate.getDay()).toBe(now.getDay());
			expect(nextRunDate.getHours()).toBe(futureHour);
		});

		it('should calculate next run for weekly schedule (same day, past time -> next week)', () => {
			const now = new Date();
			const pastHour = (now.getHours() - 2 + 24) % 24;
			const schedule: RecurringJobSchedule = {
				type: 'weekly',
				dayOfWeek: now.getDay(),
				hour: pastHour,
				minute: 0,
			};

			const nextRun = scheduler.calculateNextRun(schedule);
			const nextRunDate = new Date(nextRun);

			// Should be at least 6 days in the future
			const diffDays = (nextRun - now.getTime()) / (24 * 60 * 60 * 1000);
			expect(diffDays).toBeGreaterThanOrEqual(6);
			expect(nextRunDate.getDay()).toBe(now.getDay());
		});

		it('should calculate next run for cron schedule (falls back to daily)', () => {
			const now = Date.now();
			const schedule: RecurringJobSchedule = {
				type: 'cron',
				expression: '0 9 * * *',
			};

			const nextRun = scheduler.calculateNextRun(schedule);

			// Cron falls back to daily (next day at midnight)
			const nextRunDate = new Date(nextRun);
			expect(nextRunDate.getHours()).toBe(0);
			expect(nextRunDate.getMinutes()).toBe(0);
			expect(nextRun).toBeGreaterThan(now);
		});
	});

	describe('getStats', () => {
		it('should return correct stats for empty scheduler', () => {
			const stats = scheduler.getStats();

			expect(stats.totalJobs).toBe(0);
			expect(stats.enabledJobs).toBe(0);
			expect(stats.scheduledJobs).toBe(0);
		});

		it('should return correct stats after creating jobs', async () => {
			await scheduler.createJob({
				roomId,
				name: 'Job 1',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});
			await scheduler.createJob({
				roomId,
				name: 'Job 2',
				description: '',
				schedule: createIntervalSchedule(30),
				taskTemplate: createTestTemplate(),
				enabled: false,
			});

			const stats = scheduler.getStats();

			// getStats only counts enabled jobs via getAllEnabledJobs
			expect(stats.totalJobs).toBe(1); // Only enabled jobs
			expect(stats.enabledJobs).toBe(1);
			expect(stats.scheduledJobs).toBe(1); // Only enabled job is scheduled
		});
	});

	describe('maxRuns limit', () => {
		it('should not schedule job when maxRuns is reached', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Limited Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
				maxRuns: 0, // Already at max
			});

			// Job should not be scheduled because maxRuns is 0 and runCount is 0
			// Wait, runCount starts at 0, so if maxRuns is 0, runCount >= maxRuns is true
			// Actually, hasReachedMaxRuns checks runCount >= maxRuns, so 0 >= 0 is true

			// The job will be created but not scheduled
			// We need to verify by checking scheduled count
			expect(scheduler.getStats().scheduledJobs).toBe(0);
		});

		it('should not schedule job when maxRuns is already reached', async () => {
			// Create a job with maxRuns of 1
			const job = await scheduler.createJob({
				roomId,
				name: 'Limited Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
				maxRuns: 1,
			});

			// Job should be scheduled initially (runCount is 0, maxRuns is 1)
			expect(scheduler.getStats().scheduledJobs).toBe(1);

			// Manually update runCount to reach maxRuns
			// Note: triggerJob doesn't increment runCount - only scheduled execution does
			// To test max runs behavior, we simulate the state after scheduled execution
			db.prepare('UPDATE recurring_jobs SET run_count = 1 WHERE id = ?').run(job.id);

			// Restart scheduler to reload jobs and test max runs check
			scheduler.stop();
			scheduler.start();

			// Job should not be scheduled because runCount (1) >= maxRuns (1)
			expect(scheduler.getStats().scheduledJobs).toBe(0);
		});
	});

	describe('event emission', () => {
		it('should emit recurringJob.created event when job is created', async () => {
			const emitSpy = spyOn(daemonHub, 'emit');

			await scheduler.createJob({
				roomId,
				name: 'Test Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			expect(emitSpy).toHaveBeenCalledWith('recurringJob.created', expect.any(Object));

			const call = emitSpy.mock.calls.find((c) => c[0] === 'recurringJob.created');
			expect(call).toBeDefined();
			expect(call?.[1]).toMatchObject({
				sessionId: `room:${roomId}`,
				roomId,
				jobId: expect.any(String),
				job: expect.objectContaining({ name: 'Test Job' }),
			});

			emitSpy.mockRestore();
		});

		it('should emit recurringJob.triggered event when job is triggered', async () => {
			const emitSpy = spyOn(daemonHub, 'emit');

			const job = await scheduler.createJob({
				roomId,
				name: 'Test Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			// Clear previous calls
			emitSpy.mockClear();

			await scheduler.triggerJob(job.id);

			expect(emitSpy).toHaveBeenCalledWith('recurringJob.triggered', expect.any(Object));

			const call = emitSpy.mock.calls.find((c) => c[0] === 'recurringJob.triggered');
			expect(call).toBeDefined();
			expect(call?.[1]).toMatchObject({
				sessionId: `room:${roomId}`,
				roomId,
				jobId: job.id,
				taskId: expect.any(String),
			});

			emitSpy.mockRestore();
		});
	});

	describe('multiple rooms', () => {
		it('should isolate jobs between rooms', async () => {
			const room2 = roomManager.createRoom({ name: 'Room 2' });

			await scheduler.createJob({
				roomId,
				name: 'Room 1 Job',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});
			await scheduler.createJob({
				roomId: room2.id,
				name: 'Room 2 Job',
				description: '',
				schedule: createIntervalSchedule(30),
				taskTemplate: createTestTemplate(),
			});

			const jobsRoom1 = scheduler.listJobs(roomId);
			const jobsRoom2 = scheduler.listJobs(room2.id);

			expect(jobsRoom1).toHaveLength(1);
			expect(jobsRoom2).toHaveLength(1);
			expect(jobsRoom1[0].name).toBe('Room 1 Job');
			expect(jobsRoom2[0].name).toBe('Room 2 Job');
		});
	});

	describe('edge cases', () => {
		it('should handle special characters in job name', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test with "quotes" and \'apostrophes\'',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			expect(job.name).toBe('Test with "quotes" and \'apostrophes\'');
		});

		it('should handle unicode in job name and description', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: '你好世界 Job',
				description: 'Description with unicode: مرحبا',
				schedule: createIntervalSchedule(60),
				taskTemplate: {
					title: 'Task 任务',
					description: 'Unicode: 日本語',
					priority: 'normal',
				},
			});

			expect(job.name).toBe('你好世界 Job');
			expect(job.description).toBe('Description with unicode: مرحبا');
			expect(job.taskTemplate.title).toBe('Task 任务');
		});

		it('should handle very long description', async () => {
			const longDescription = 'x'.repeat(10000);
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: longDescription,
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
			});

			expect(job.description).toBe(longDescription);
		});

		it('should handle interval of 0 minutes', async () => {
			// 0 minutes should still work (immediate execution)
			const job = await scheduler.createJob({
				roomId,
				name: 'Immediate Job',
				description: '',
				schedule: { type: 'interval', minutes: 0 },
				taskTemplate: createTestTemplate(),
			});

			expect(job.schedule.type).toBe('interval');
		});

		it('should handle daily schedule at midnight', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Midnight Job',
				description: '',
				schedule: { type: 'daily', hour: 0, minute: 0 },
				taskTemplate: createTestTemplate(),
			});

			expect(job.schedule.type).toBe('daily');
			const dailySchedule = job.schedule as { hour: number; minute: number };
			expect(dailySchedule.hour).toBe(0);
			expect(dailySchedule.minute).toBe(0);
		});

		it('should handle weekly schedule on Sunday (day 0)', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Sunday Job',
				description: '',
				schedule: { type: 'weekly', dayOfWeek: 0, hour: 10, minute: 0 },
				taskTemplate: createTestTemplate(),
			});

			expect(job.schedule.type).toBe('weekly');
			const weeklySchedule = job.schedule as { dayOfWeek: number; hour: number; minute: number };
			expect(weeklySchedule.dayOfWeek).toBe(0);
		});

		it('should handle weekly schedule on Saturday (day 6)', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Saturday Job',
				description: '',
				schedule: { type: 'weekly', dayOfWeek: 6, hour: 10, minute: 0 },
				taskTemplate: createTestTemplate(),
			});

			expect(job.schedule.type).toBe('weekly');
			const weeklySchedule = job.schedule as { dayOfWeek: number; hour: number; minute: number };
			expect(weeklySchedule.dayOfWeek).toBe(6);
		});

		it('should handle multiple status transitions', async () => {
			const job = await scheduler.createJob({
				roomId,
				name: 'Test',
				description: '',
				schedule: createIntervalSchedule(60),
				taskTemplate: createTestTemplate(),
				enabled: true,
			});

			// Disable
			await scheduler.disableJob(job.id);
			expect(scheduler.getJob(job.id)?.enabled).toBe(false);

			// Enable
			await scheduler.enableJob(job.id);
			expect(scheduler.getJob(job.id)?.enabled).toBe(true);

			// Update
			await scheduler.updateJob(job.id, { name: 'Updated Name' });
			expect(scheduler.getJob(job.id)?.name).toBe('Updated Name');

			// Delete
			await scheduler.deleteJob(job.id);
			expect(scheduler.getJob(job.id)).toBeNull();
		});
	});
});
