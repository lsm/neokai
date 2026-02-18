// @ts-nocheck
/**
 * Tests for RecurringJobsConfig Component
 */

import { render, cleanup, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecurringJobsConfig } from './RecurringJobsConfig';
import type { RecurringJob } from '@neokai/shared';

describe('RecurringJobsConfig', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	afterEach(() => {
		cleanup();
		document.body.style.overflow = '';
	});

	const createMockJob = (id: string, overrides?: Partial<RecurringJob>): RecurringJob => ({
		id,
		roomId: 'room-1',
		name: `Job ${id}`,
		description: `Description for ${id}`,
		schedule: { type: 'interval', minutes: 30 },
		taskTemplate: {
			title: 'Test Task',
			description: 'Task description',
			priority: 'normal',
			executionMode: 'single',
		},
		enabled: true,
		lastRunAt: Date.now() - 3600000,
		nextRunAt: Date.now() + 3600000,
		runCount: 5,
		createdAt: Date.now() - 86400000,
		updatedAt: Date.now(),
		...overrides,
	});

	const defaultHandlers = {
		onCreateJob: vi.fn().mockResolvedValue(undefined),
		onUpdateJob: vi.fn().mockResolvedValue(undefined),
		onDeleteJob: vi.fn().mockResolvedValue(undefined),
		onTriggerJob: vi.fn().mockResolvedValue(undefined),
	};

	describe('Rendering', () => {
		it('should render the Recurring Jobs header', () => {
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={[]} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('Recurring Jobs');
		});

		it('should render "Create Job" button', () => {
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={[]} {...defaultHandlers} />
			);
			const buttons = container.querySelectorAll('button');
			const hasCreateJob = Array.from(buttons).some((btn) =>
				btn.textContent?.includes('Create Job')
			);
			expect(hasCreateJob).toBe(true);
		});

		it('should display job count badge when jobs exist', () => {
			const jobs = [createMockJob('job-1'), createMockJob('job-2')];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			const badge = container.querySelector('.rounded-full');
			expect(badge?.textContent).toBe('2');
		});
	});

	describe('Empty State', () => {
		it('should show empty state when no jobs', () => {
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={[]} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('No recurring jobs');
			expect(container.textContent).toContain('Schedule automated tasks to run periodically');
		});
	});

	describe('Loading State', () => {
		it('should disable Create Job button when loading', () => {
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={[]} {...defaultHandlers} isLoading={true} />
			);
			const buttons = container.querySelectorAll('button');
			const createButton = Array.from(buttons).find((btn) =>
				btn.textContent?.includes('Create Job')
			) as HTMLButtonElement;
			expect(createButton?.disabled).toBe(true);
		});
	});

	describe('Job Card Rendering', () => {
		it('should render job name', () => {
			const jobs = [createMockJob('job-1', { name: 'Rendered Job Name' })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('Rendered Job Name');
		});

		it('should display run count', () => {
			const jobs = [createMockJob('job-1', { runCount: 10 })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('10 runs');
		});

		it('should show enabled toggle on', () => {
			const jobs = [createMockJob('job-1', { enabled: true })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			const toggle = container.querySelector('.bg-blue-600');
			expect(toggle).toBeTruthy();
		});

		it('should show disabled toggle off', () => {
			const jobs = [createMockJob('job-1', { enabled: false })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			const toggle = container.querySelector('.bg-dark-600');
			expect(toggle).toBeTruthy();
		});

		it('should show "Disabled" text when job is disabled', () => {
			const jobs = [createMockJob('job-1', { enabled: false, nextRunAt: undefined })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('Disabled');
		});
	});

	describe('Schedule Display', () => {
		it('should display interval schedule', () => {
			const jobs = [createMockJob('job-1', { schedule: { type: 'interval', minutes: 30 } })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('Every 30 min');
		});

		it('should display daily schedule', () => {
			const jobs = [createMockJob('job-1', { schedule: { type: 'daily', hour: 9, minute: 30 } })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('Daily at 9:30');
		});

		it('should display weekly schedule', () => {
			const jobs = [
				createMockJob('job-1', { schedule: { type: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 } }),
			];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('Weekly on Mon at 9:00');
		});

		it('should display cron schedule', () => {
			const jobs = [
				createMockJob('job-1', { schedule: { type: 'cron', expression: '0 0 * * *' } }),
			];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('Cron: 0 0 * * *');
		});
	});

	describe('Next Run Display', () => {
		it('should show next run time when enabled and nextRunAt is set', () => {
			const futureTime = Date.now() + 7200000;
			const jobs = [createMockJob('job-1', { enabled: true, nextRunAt: futureTime })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('In');
		});

		it('should not show next run when disabled', () => {
			const futureTime = Date.now() + 7200000;
			const jobs = [createMockJob('job-1', { enabled: false, nextRunAt: futureTime })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).toContain('Disabled');
		});
	});

	describe('Job Expansion', () => {
		it('should not show description when collapsed', () => {
			const jobs = [createMockJob('job-1', { description: 'Detailed job description' })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);
			expect(container.textContent).not.toContain('Detailed job description');
		});

		it('should have clickable header for expansion', () => {
			const jobs = [createMockJob('job-1')];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);

			const jobRow = container.querySelector('.cursor-pointer');
			expect(jobRow).toBeTruthy();
		});
	});

	describe('Toggle Enable/Disable', () => {
		it('should have toggle button for enabled jobs', () => {
			const jobs = [createMockJob('job-123', { enabled: true })];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);

			const toggle = container.querySelector('button[type="button"]');
			expect(toggle).toBeTruthy();
		});
	});

	describe('Action Buttons', () => {
		it('should have clickable toggle button', () => {
			const jobs = [createMockJob('job-1')];
			const { container } = render(
				<RecurringJobsConfig roomId="room-1" jobs={jobs} {...defaultHandlers} />
			);

			const toggle = container.querySelector('button[type="button"]');
			expect(toggle).toBeTruthy();
		});
	});
});
