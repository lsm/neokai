import { describe, it, expect } from 'bun:test';
import {
	NullNotificationSink,
	type SpaceNotificationEvent,
	type TaskNeedsAttentionEvent,
	type WorkflowRunNeedsAttentionEvent,
	type TaskTimeoutEvent,
	type WorkflowRunCompletedEvent,
} from '../../../src/lib/space/runtime/notification-sink';

describe('SpaceNotificationEvent types', () => {
	it('constructs a task_needs_attention event', () => {
		const event: TaskNeedsAttentionEvent = {
			kind: 'task_needs_attention',
			spaceId: 'space-1',
			taskId: 'task-42',
			reason: 'Agent reported an unrecoverable error',
			timestamp: '2026-03-20T10:00:00.000Z',
		};

		expect(event.kind).toBe('task_needs_attention');
		expect(event.spaceId).toBe('space-1');
		expect(event.taskId).toBe('task-42');
		expect(event.reason).toBe('Agent reported an unrecoverable error');
		expect(event.timestamp).toBe('2026-03-20T10:00:00.000Z');
	});

	it('constructs a workflow_run_needs_attention event', () => {
		const event: WorkflowRunNeedsAttentionEvent = {
			kind: 'workflow_run_needs_attention',
			spaceId: 'space-2',
			runId: 'run-99',
			reason: 'Transition condition failed: tests did not pass',
			timestamp: '2026-03-20T11:00:00.000Z',
		};

		expect(event.kind).toBe('workflow_run_needs_attention');
		expect(event.spaceId).toBe('space-2');
		expect(event.runId).toBe('run-99');
		expect(event.reason).toBe('Transition condition failed: tests did not pass');
	});

	it('constructs a task_timeout event', () => {
		const event: TaskTimeoutEvent = {
			kind: 'task_timeout',
			spaceId: 'space-3',
			taskId: 'task-7',
			elapsedMs: 3600000,
			timestamp: '2026-03-20T12:00:00.000Z',
		};

		expect(event.kind).toBe('task_timeout');
		expect(event.elapsedMs).toBe(3600000);
	});

	it('constructs a workflow_run_completed event with summary', () => {
		const event: WorkflowRunCompletedEvent = {
			kind: 'workflow_run_completed',
			spaceId: 'space-4',
			runId: 'run-1',
			status: 'completed',
			summary: 'All three steps finished successfully. PR #42 merged.',
			timestamp: '2026-03-20T13:00:00.000Z',
		};

		expect(event.kind).toBe('workflow_run_completed');
		expect(event.status).toBe('completed');
		expect(event.summary).toBe('All three steps finished successfully. PR #42 merged.');
	});

	it('constructs a workflow_run_completed event without summary', () => {
		const event: WorkflowRunCompletedEvent = {
			kind: 'workflow_run_completed',
			spaceId: 'space-4',
			runId: 'run-2',
			status: 'failed',
			timestamp: '2026-03-20T13:00:00.000Z',
		};

		expect(event.kind).toBe('workflow_run_completed');
		expect(event.status).toBe('failed');
		expect(event.summary).toBeUndefined();
	});

	it('SpaceNotificationEvent union narrows correctly via kind', () => {
		const events: SpaceNotificationEvent[] = [
			{
				kind: 'task_needs_attention',
				spaceId: 's',
				taskId: 't',
				reason: 'r',
				timestamp: 'ts',
			},
			{
				kind: 'workflow_run_needs_attention',
				spaceId: 's',
				runId: 'r',
				reason: 'r',
				timestamp: 'ts',
			},
			{ kind: 'task_timeout', spaceId: 's', taskId: 't', elapsedMs: 0, timestamp: 'ts' },
			{
				kind: 'workflow_run_completed',
				spaceId: 's',
				runId: 'r',
				status: 'completed',
				timestamp: 'ts',
			},
		];

		const kinds = events.map((e) => e.kind);
		expect(kinds).toEqual([
			'task_needs_attention',
			'workflow_run_needs_attention',
			'task_timeout',
			'workflow_run_completed',
		]);
	});
});

describe('NullNotificationSink', () => {
	it('implements NotificationSink and resolves without error', async () => {
		const sink = new NullNotificationSink();
		const event: SpaceNotificationEvent = {
			kind: 'task_needs_attention',
			spaceId: 'space-1',
			taskId: 'task-1',
			reason: 'test',
			timestamp: new Date().toISOString(),
		};

		await expect(sink.notify(event)).resolves.toBeUndefined();
	});

	it('handles all event kinds without throwing', async () => {
		const sink = new NullNotificationSink();

		const events: SpaceNotificationEvent[] = [
			{
				kind: 'task_needs_attention',
				spaceId: 's',
				taskId: 't',
				reason: 'r',
				timestamp: 'ts',
			},
			{
				kind: 'workflow_run_needs_attention',
				spaceId: 's',
				runId: 'r',
				reason: 'r',
				timestamp: 'ts',
			},
			{ kind: 'task_timeout', spaceId: 's', taskId: 't', elapsedMs: 5000, timestamp: 'ts' },
			{
				kind: 'workflow_run_completed',
				spaceId: 's',
				runId: 'r',
				status: 'cancelled',
				timestamp: 'ts',
			},
		];

		for (const event of events) {
			await expect(sink.notify(event)).resolves.toBeUndefined();
		}
	});

	it('can be called multiple times concurrently', async () => {
		const sink = new NullNotificationSink();
		const event: SpaceNotificationEvent = {
			kind: 'workflow_run_completed',
			spaceId: 's',
			runId: 'r',
			status: 'completed',
			timestamp: 'ts',
		};

		await expect(
			Promise.all([sink.notify(event), sink.notify(event), sink.notify(event)])
		).resolves.toBeDefined();
	});
});
