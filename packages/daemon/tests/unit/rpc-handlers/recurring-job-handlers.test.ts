/**
 * Tests for Recurring Job RPC Handlers
 *
 * Tests the RPC handlers for recurring job operations:
 * - recurringJob.create - Create a recurring job
 * - recurringJob.get - Get job details
 * - recurringJob.list - List jobs in a room
 * - recurringJob.update - Update a job
 * - recurringJob.enable - Enable a job
 * - recurringJob.disable - Disable a job
 * - recurringJob.delete - Delete a job
 * - recurringJob.trigger - Manually trigger a job
 * - recurringJob.getStats - Get scheduler statistics
 *
 * Mocks RecurringJobScheduler to focus on RPC handler logic.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import {
	MessageHub,
	type RecurringJob,
	type RecurringJobSchedule,
	type RecurringTaskTemplate,
} from '@neokai/shared';
import {
	setupRecurringJobHandlers,
	type RecurringJobSchedulerLike,
} from '../../../src/lib/rpc-handlers/recurring-job-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock RecurringJobScheduler methods
const mockScheduler = {
	createJob: mock(
		async (): Promise<RecurringJob> => ({
			id: 'job-123',
			roomId: 'room-123',
			name: 'Test Job',
			description: 'Test description',
			schedule: { type: 'interval', minutes: 30 } as RecurringJobSchedule,
			taskTemplate: {
				title: 'Task Template',
				description: 'Template description',
				priority: 'normal',
			} as RecurringTaskTemplate,
			enabled: true,
			runCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	getJob: mock((): RecurringJob | null => ({
		id: 'job-123',
		roomId: 'room-123',
		name: 'Test Job',
		description: 'Test description',
		schedule: { type: 'interval', minutes: 30 } as RecurringJobSchedule,
		taskTemplate: {
			title: 'Task Template',
			description: 'Template description',
			priority: 'normal',
		} as RecurringTaskTemplate,
		enabled: true,
		runCount: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	})),
	listJobs: mock((): RecurringJob[] => [
		{
			id: 'job-123',
			roomId: 'room-123',
			name: 'Test Job',
			description: 'Test description',
			schedule: { type: 'interval', minutes: 30 } as RecurringJobSchedule,
			taskTemplate: {
				title: 'Task Template',
				description: 'Template description',
				priority: 'normal',
			} as RecurringTaskTemplate,
			enabled: true,
			runCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
	]),
	updateJob: mock(
		async (): Promise<RecurringJob | null> => ({
			id: 'job-123',
			roomId: 'room-123',
			name: 'Updated Job',
			description: 'Updated description',
			schedule: { type: 'interval', minutes: 60 } as RecurringJobSchedule,
			taskTemplate: {
				title: 'Updated Template',
				description: 'Updated template description',
				priority: 'high',
			} as RecurringTaskTemplate,
			enabled: true,
			runCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	enableJob: mock(
		async (): Promise<RecurringJob | null> => ({
			id: 'job-123',
			roomId: 'room-123',
			name: 'Test Job',
			description: 'Test description',
			schedule: { type: 'interval', minutes: 30 } as RecurringJobSchedule,
			taskTemplate: {
				title: 'Task Template',
				description: 'Template description',
				priority: 'normal',
			} as RecurringTaskTemplate,
			enabled: true,
			runCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	disableJob: mock(
		async (): Promise<RecurringJob | null> => ({
			id: 'job-123',
			roomId: 'room-123',
			name: 'Test Job',
			description: 'Test description',
			schedule: { type: 'interval', minutes: 30 } as RecurringJobSchedule,
			taskTemplate: {
				title: 'Task Template',
				description: 'Template description',
				priority: 'normal',
			} as RecurringTaskTemplate,
			enabled: false,
			runCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	deleteJob: mock(async (): Promise<boolean> => true),
	triggerJob: mock(
		async (): Promise<{ success: boolean; taskId?: string; error?: string }> => ({
			success: true,
			taskId: 'task-123',
		})
	),
	getStats: mock((): { totalJobs: number; enabledJobs: number; totalRuns: number } => ({
		totalJobs: 5,
		enabledJobs: 3,
		totalRuns: 10,
	})),
};

// Helper to create a minimal mock MessageHub that captures handlers
function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

// Helper to create mock DaemonHub
function createMockDaemonHub(): {
	daemonHub: DaemonHub;
	emit: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emit: emitMock };
}

describe('Recurring Job RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();

		// Reset all mocks
		mockScheduler.createJob.mockClear();
		mockScheduler.getJob.mockClear();
		mockScheduler.listJobs.mockClear();
		mockScheduler.updateJob.mockClear();
		mockScheduler.enableJob.mockClear();
		mockScheduler.disableJob.mockClear();
		mockScheduler.deleteJob.mockClear();
		mockScheduler.triggerJob.mockClear();
		mockScheduler.getStats.mockClear();

		// Setup handlers with mocked dependencies
		setupRecurringJobHandlers(
			messageHubData.hub,
			daemonHubData.daemonHub,
			mockScheduler as unknown as RecurringJobSchedulerLike
		);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('recurringJob.create', () => {
		it('creates a recurring job with all parameters', async () => {
			const handler = messageHubData.handlers.get('recurringJob.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				name: 'Daily Check',
				description: 'Daily health check',
				schedule: { type: 'daily', hour: 9, minute: 0 } as RecurringJobSchedule,
				taskTemplate: {
					title: 'Health Check',
					description: 'Run health check',
					priority: 'high',
				} as RecurringTaskTemplate,
				enabled: true,
				maxRuns: 100,
			};

			const result = (await handler!(params, {})) as { job: RecurringJob };

			expect(mockScheduler.createJob).toHaveBeenCalled();
			expect(result.job).toBeDefined();
			expect(result.job.roomId).toBe('room-123');
		});

		it('creates a recurring job with minimal parameters', async () => {
			const handler = messageHubData.handlers.get('recurringJob.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				name: 'Simple Job',
				schedule: { type: 'interval', minutes: 60 } as RecurringJobSchedule,
				taskTemplate: {
					title: 'Task',
					description: 'Description',
					priority: 'normal',
				} as RecurringTaskTemplate,
			};

			const result = (await handler!(params, {})) as { job: RecurringJob };

			expect(mockScheduler.createJob).toHaveBeenCalled();
			expect(result.job).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.create');
			expect(handler).toBeDefined();

			const params = {
				name: 'Test Job',
				schedule: { type: 'interval', minutes: 30 },
				taskTemplate: { title: 'Task', description: 'Desc', priority: 'normal' },
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when name is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				schedule: { type: 'interval', minutes: 30 },
				taskTemplate: { title: 'Task', description: 'Desc', priority: 'normal' },
			};

			await expect(handler!(params, {})).rejects.toThrow('Job name is required');
		});

		it('throws error when schedule is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				name: 'Test Job',
				taskTemplate: { title: 'Task', description: 'Desc', priority: 'normal' },
			};

			await expect(handler!(params, {})).rejects.toThrow('Schedule is required');
		});

		it('throws error when taskTemplate is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				name: 'Test Job',
				schedule: { type: 'interval', minutes: 30 },
			};

			await expect(handler!(params, {})).rejects.toThrow('Task template is required');
		});
	});

	describe('recurringJob.get', () => {
		it('returns job details', async () => {
			const handler = messageHubData.handlers.get('recurringJob.get');
			expect(handler).toBeDefined();

			const params = {
				jobId: 'job-123',
			};

			const result = (await handler!(params, {})) as { job: RecurringJob | null };

			expect(mockScheduler.getJob).toHaveBeenCalledWith('job-123');
			expect(result.job).toBeDefined();
			expect(result.job?.id).toBe('job-123');
		});

		it('returns null when job not found', async () => {
			const handler = messageHubData.handlers.get('recurringJob.get');
			expect(handler).toBeDefined();

			mockScheduler.getJob.mockReturnValueOnce(null);

			const params = {
				jobId: 'non-existent',
			};

			const result = (await handler!(params, {})) as { job: RecurringJob | null };

			expect(result.job).toBeNull();
		});

		it('throws error when jobId is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.get');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Job ID is required');
		});
	});

	describe('recurringJob.list', () => {
		it('lists all jobs in a room', async () => {
			const handler = messageHubData.handlers.get('recurringJob.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { jobs: RecurringJob[] };

			expect(mockScheduler.listJobs).toHaveBeenCalledWith('room-123', undefined);
			expect(Array.isArray(result.jobs)).toBe(true);
		});

		it('lists enabled jobs only', async () => {
			const handler = messageHubData.handlers.get('recurringJob.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				enabledOnly: true,
			};

			await handler!(params, {});

			expect(mockScheduler.listJobs).toHaveBeenCalledWith('room-123', true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.list');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('recurringJob.update', () => {
		it('updates a job', async () => {
			const handler = messageHubData.handlers.get('recurringJob.update');
			expect(handler).toBeDefined();

			const params = {
				jobId: 'job-123',
				name: 'Updated Job Name',
				description: 'Updated description',
			};

			const result = (await handler!(params, {})) as { job: RecurringJob | null };

			expect(mockScheduler.updateJob).toHaveBeenCalledWith('job-123', {
				name: 'Updated Job Name',
				description: 'Updated description',
				schedule: undefined,
				taskTemplate: undefined,
				enabled: undefined,
				maxRuns: undefined,
			});
			expect(result.job).toBeDefined();
		});

		it('updates job schedule', async () => {
			const handler = messageHubData.handlers.get('recurringJob.update');
			expect(handler).toBeDefined();

			const params = {
				jobId: 'job-123',
				schedule: { type: 'weekly', dayOfWeek: 1, hour: 10, minute: 0 } as RecurringJobSchedule,
			};

			await handler!(params, {});

			expect(mockScheduler.updateJob).toHaveBeenCalledWith(
				'job-123',
				expect.objectContaining({
					schedule: { type: 'weekly', dayOfWeek: 1, hour: 10, minute: 0 },
				})
			);
		});

		it('throws error when jobId is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.update');
			expect(handler).toBeDefined();

			await expect(handler!({ name: 'New Name' }, {})).rejects.toThrow('Job ID is required');
		});

		it('emits recurringJob.updated event when job is updated', async () => {
			const handler = messageHubData.handlers.get('recurringJob.update');
			expect(handler).toBeDefined();

			await handler!({ jobId: 'job-123', name: 'New Name' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'recurringJob.updated',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					jobId: 'job-123',
				})
			);
		});

		it('does not emit event when job not found', async () => {
			const handler = messageHubData.handlers.get('recurringJob.update');
			expect(handler).toBeDefined();

			mockScheduler.updateJob.mockResolvedValueOnce(null);

			await handler!({ jobId: 'non-existent', name: 'New Name' }, {});

			// Only the updateJob call should happen, no emit
			expect(mockScheduler.updateJob).toHaveBeenCalled();
		});
	});

	describe('recurringJob.enable', () => {
		it('enables a job', async () => {
			const handler = messageHubData.handlers.get('recurringJob.enable');
			expect(handler).toBeDefined();

			const params = {
				jobId: 'job-123',
			};

			const result = (await handler!(params, {})) as { job: RecurringJob | null };

			expect(mockScheduler.enableJob).toHaveBeenCalledWith('job-123');
			expect(result.job).toBeDefined();
			expect(result.job?.enabled).toBe(true);
		});

		it('throws error when jobId is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.enable');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Job ID is required');
		});

		it('emits recurringJob.enabled event when job is enabled', async () => {
			const handler = messageHubData.handlers.get('recurringJob.enable');
			expect(handler).toBeDefined();

			await handler!({ jobId: 'job-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'recurringJob.enabled',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					jobId: 'job-123',
				})
			);
		});

		it('does not emit event when job not found', async () => {
			const handler = messageHubData.handlers.get('recurringJob.enable');
			expect(handler).toBeDefined();

			mockScheduler.enableJob.mockResolvedValueOnce(null);

			await handler!({ jobId: 'non-existent' }, {});

			expect(mockScheduler.enableJob).toHaveBeenCalled();
		});
	});

	describe('recurringJob.disable', () => {
		it('disables a job', async () => {
			const handler = messageHubData.handlers.get('recurringJob.disable');
			expect(handler).toBeDefined();

			const params = {
				jobId: 'job-123',
			};

			const result = (await handler!(params, {})) as { job: RecurringJob | null };

			expect(mockScheduler.disableJob).toHaveBeenCalledWith('job-123');
			expect(result.job).toBeDefined();
			expect(result.job?.enabled).toBe(false);
		});

		it('throws error when jobId is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.disable');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Job ID is required');
		});

		it('emits recurringJob.disabled event when job is disabled', async () => {
			const handler = messageHubData.handlers.get('recurringJob.disable');
			expect(handler).toBeDefined();

			await handler!({ jobId: 'job-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'recurringJob.disabled',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					jobId: 'job-123',
				})
			);
		});

		it('does not emit event when job not found', async () => {
			const handler = messageHubData.handlers.get('recurringJob.disable');
			expect(handler).toBeDefined();

			mockScheduler.disableJob.mockResolvedValueOnce(null);

			await handler!({ jobId: 'non-existent' }, {});

			expect(mockScheduler.disableJob).toHaveBeenCalled();
		});
	});

	describe('recurringJob.delete', () => {
		it('deletes a job', async () => {
			const handler = messageHubData.handlers.get('recurringJob.delete');
			expect(handler).toBeDefined();

			const params = {
				jobId: 'job-123',
			};

			const result = (await handler!(params, {})) as { success: boolean };

			expect(mockScheduler.deleteJob).toHaveBeenCalledWith('job-123');
			expect(result.success).toBe(true);
		});

		it('throws error when jobId is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.delete');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Job ID is required');
		});

		it('emits recurringJob.deleted event when job is deleted', async () => {
			const handler = messageHubData.handlers.get('recurringJob.delete');
			expect(handler).toBeDefined();

			await handler!({ jobId: 'job-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'recurringJob.deleted',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					jobId: 'job-123',
				})
			);
		});

		it('does not emit event when job not found', async () => {
			const handler = messageHubData.handlers.get('recurringJob.delete');
			expect(handler).toBeDefined();

			mockScheduler.getJob.mockReturnValueOnce(null);
			mockScheduler.deleteJob.mockResolvedValueOnce(false);

			await handler!({ jobId: 'non-existent' }, {});

			// No event should be emitted when job not found
			expect(mockScheduler.deleteJob).toHaveBeenCalled();
		});

		it('returns false when delete fails', async () => {
			const handler = messageHubData.handlers.get('recurringJob.delete');
			expect(handler).toBeDefined();

			mockScheduler.deleteJob.mockResolvedValueOnce(false);

			const result = (await handler!({ jobId: 'job-123' }, {})) as { success: boolean };

			expect(result.success).toBe(false);
		});
	});

	describe('recurringJob.trigger', () => {
		it('triggers a job manually', async () => {
			const handler = messageHubData.handlers.get('recurringJob.trigger');
			expect(handler).toBeDefined();

			const params = {
				jobId: 'job-123',
			};

			const result = (await handler!(params, {})) as {
				success: boolean;
				taskId?: string;
				error?: string;
			};

			expect(mockScheduler.triggerJob).toHaveBeenCalledWith('job-123');
			expect(result.success).toBe(true);
			expect(result.taskId).toBe('task-123');
		});

		it('throws error when jobId is missing', async () => {
			const handler = messageHubData.handlers.get('recurringJob.trigger');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Job ID is required');
		});

		it('returns error when trigger fails', async () => {
			const handler = messageHubData.handlers.get('recurringJob.trigger');
			expect(handler).toBeDefined();

			mockScheduler.triggerJob.mockResolvedValueOnce({
				success: false,
				error: 'Job is disabled',
			});

			const params = {
				jobId: 'job-123',
			};

			const result = (await handler!(params, {})) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toBe('Job is disabled');
		});
	});

	describe('recurringJob.getStats', () => {
		it('returns scheduler statistics', async () => {
			const handler = messageHubData.handlers.get('recurringJob.getStats');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as {
				stats: { totalJobs: number; enabledJobs: number; totalRuns: number };
			};

			expect(mockScheduler.getStats).toHaveBeenCalled();
			expect(result.stats).toBeDefined();
			expect(result.stats.totalJobs).toBe(5);
			expect(result.stats.enabledJobs).toBe(3);
			expect(result.stats.totalRuns).toBe(10);
		});
	});
});
