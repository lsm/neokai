import { describe, it, expect, beforeEach } from 'bun:test';
import {
	SessionNotificationSink,
	formatEventMessage,
} from '../../../src/lib/space/runtime/session-notification-sink';
import type { SessionNotificationSinkConfig } from '../../../src/lib/space/runtime/session-notification-sink';
import type { SpaceNotificationEvent } from '../../../src/lib/space/runtime/notification-sink';
import type { SessionFactory } from '../../../src/lib/room/runtime/task-group-manager';
import type { MessageDeliveryMode } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Mock SessionFactory
// ---------------------------------------------------------------------------

interface InjectedCall {
	sessionId: string;
	message: string;
	opts?: { deliveryMode?: MessageDeliveryMode };
}

function makeMockSessionFactory(opts?: {
	sessionExists?: boolean;
	injectError?: Error;
}): SessionFactory & { calls: InjectedCall[] } {
	const calls: InjectedCall[] = [];
	const sessionExists = opts?.sessionExists ?? true;
	const injectError = opts?.injectError;

	const factory: SessionFactory & { calls: InjectedCall[] } = {
		calls,
		createAndStartSession: async () => {},
		injectMessage: async (sessionId, message, injectOpts) => {
			if (injectError) throw injectError;
			calls.push({ sessionId, message, opts: injectOpts });
		},
		hasSession: () => sessionExists,
		answerQuestion: async () => false,
		createWorktree: async () => null,
		restoreSession: async () => false,
		startSession: async () => false,
		setSessionMcpServers: () => false,
		removeWorktree: async () => false,
	};

	return factory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'spaces:global:session-1';
const SPACE_ID = 'space-abc';
const TIMESTAMP = '2026-03-20T10:00:00.000Z';

function makeSink(
	factoryOrOpts?:
		| (SessionFactory & { calls: InjectedCall[] })
		| Parameters<typeof makeMockSessionFactory>[0],
	extra?: Partial<SessionNotificationSinkConfig>
): { sink: SessionNotificationSink; factory: SessionFactory & { calls: InjectedCall[] } } {
	let factory: SessionFactory & { calls: InjectedCall[] };
	if (factoryOrOpts && 'calls' in factoryOrOpts) {
		factory = factoryOrOpts as SessionFactory & { calls: InjectedCall[] };
	} else {
		factory = makeMockSessionFactory(factoryOrOpts as Parameters<typeof makeMockSessionFactory>[0]);
	}
	const sink = new SessionNotificationSink({
		sessionFactory: factory,
		sessionId: SESSION_ID,
		...extra,
	});
	return { sink, factory };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionNotificationSink', () => {
	describe('task_needs_attention event', () => {
		it('injects a message with [TASK_EVENT] prefix', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Agent reported an error',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			expect(factory.calls).toHaveLength(1);
			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] task_needs_attention');
		});

		it('injects into the correct session ID', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			expect(factory.calls[0].sessionId).toBe(SESSION_ID);
		});

		it('uses defer delivery mode', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			expect(factory.calls[0].opts?.deliveryMode).toBe('defer');
		});

		it('message includes human-readable text with taskId, spaceId, and reason', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: SPACE_ID,
				taskId: 'task-99',
				reason: 'Unrecoverable build failure',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('task-99');
			expect(message).toContain(SPACE_ID);
			expect(message).toContain('Unrecoverable build failure');
		});

		it('message includes JSON payload with all event fields', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: SPACE_ID,
				taskId: 'task-42',
				reason: 'Timed out',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			const json = extractJson(message);
			expect(json.kind).toBe('task_needs_attention');
			expect(json.spaceId).toBe(SPACE_ID);
			expect(json.taskId).toBe('task-42');
			expect(json.reason).toBe('Timed out');
			expect(json.timestamp).toBe(TIMESTAMP);
		});

		it('message includes autonomy level (default supervised)', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('supervised');
			const json = extractJson(message);
			expect(json.autonomyLevel).toBe('supervised');
		});

		it('message includes semi_autonomous level when configured', async () => {
			const { sink, factory } = makeSink(undefined, { autonomyLevel: 'semi_autonomous' });
			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('semi_autonomous');
			const json = extractJson(message);
			expect(json.autonomyLevel).toBe('semi_autonomous');
		});
	});

	describe('workflow_run_needs_attention event', () => {
		it('formats message correctly', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_needs_attention',
				spaceId: SPACE_ID,
				runId: 'run-55',
				reason: 'Transition condition failed: tests did not pass',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] workflow_run_needs_attention');
			expect(message).toContain('run-55');
			expect(message).toContain('Transition condition failed: tests did not pass');

			const json = extractJson(message);
			expect(json.kind).toBe('workflow_run_needs_attention');
			expect(json.runId).toBe('run-55');
			expect(json.autonomyLevel).toBe('supervised');
		});

		it('uses defer delivery mode', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_needs_attention',
				spaceId: SPACE_ID,
				runId: 'run-1',
				reason: 'Failure',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			expect(factory.calls[0].opts?.deliveryMode).toBe('defer');
		});
	});

	describe('task_timeout event', () => {
		it('formats elapsed time in minutes', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_timeout',
				spaceId: SPACE_ID,
				taskId: 'task-slow',
				elapsedMs: 3600000, // 60 minutes
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] task_timeout');
			expect(message).toContain('60 minute');
			expect(message).toContain('task-slow');

			const json = extractJson(message);
			expect(json.kind).toBe('task_timeout');
			expect(json.elapsedMs).toBe(3600000);
			expect(json.autonomyLevel).toBe('supervised');
		});

		it('uses defer delivery mode', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_timeout',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				elapsedMs: 60000,
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			expect(factory.calls[0].opts?.deliveryMode).toBe('defer');
		});
	});

	describe('workflow_run_completed event', () => {
		it('formats a completed run', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_completed',
				spaceId: SPACE_ID,
				runId: 'run-1',
				status: 'completed',
				summary: 'All steps finished. PR #42 merged.',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] workflow_run_completed');
			expect(message).toContain('completed successfully');
			expect(message).toContain('PR #42 merged.');

			const json = extractJson(message);
			expect(json.status).toBe('completed');
			expect(json.summary).toBe('All steps finished. PR #42 merged.');
			expect(json.autonomyLevel).toBe('supervised');
		});

		it('formats a cancelled run', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_completed',
				spaceId: SPACE_ID,
				runId: 'run-2',
				status: 'cancelled',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('was cancelled');

			const json = extractJson(message);
			expect(json.status).toBe('cancelled');
			expect(json.summary).toBeUndefined();
		});

		it('formats a needs_attention run', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_completed',
				spaceId: SPACE_ID,
				runId: 'run-3',
				status: 'needs_attention',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('needs attention');

			const json = extractJson(message);
			expect(json.status).toBe('needs_attention');
		});

		it('uses defer delivery mode', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_completed',
				spaceId: SPACE_ID,
				runId: 'run-1',
				status: 'completed',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			expect(factory.calls[0].opts?.deliveryMode).toBe('defer');
		});
	});

	describe('error handling', () => {
		it('logs warning and does not throw when session not found', async () => {
			const { sink, factory } = makeSink({
				injectError: new Error('Session not in service cache: spaces:global:session-1'),
			});

			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			};

			// Should not throw despite injectMessage failing
			await expect(sink.notify(event)).resolves.toBeUndefined();
			// Message was attempted
			expect(factory.calls).toHaveLength(0); // error was thrown before push
		});

		it('does not throw on any error from injectMessage', async () => {
			const { sink } = makeSink({ injectError: new Error('Unexpected failure') });
			const events: SpaceNotificationEvent[] = [
				{
					kind: 'task_needs_attention',
					spaceId: SPACE_ID,
					taskId: 't',
					reason: 'r',
					timestamp: TIMESTAMP,
				},
				{
					kind: 'workflow_run_needs_attention',
					spaceId: SPACE_ID,
					runId: 'r',
					reason: 'r',
					timestamp: TIMESTAMP,
				},
				{
					kind: 'task_timeout',
					spaceId: SPACE_ID,
					taskId: 't',
					elapsedMs: 1000,
					timestamp: TIMESTAMP,
				},
				{
					kind: 'workflow_run_completed',
					spaceId: SPACE_ID,
					runId: 'r',
					status: 'completed',
					timestamp: TIMESTAMP,
				},
			];

			for (const event of events) {
				await expect(sink.notify(event)).resolves.toBeUndefined();
			}
		});
	});

	describe('formatEventMessage (exported helper)', () => {
		it('produces consistent output for the same input', () => {
			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: 'space-x',
				taskId: 'task-x',
				reason: 'test reason',
				timestamp: TIMESTAMP,
			};

			const msg1 = formatEventMessage(event, 'supervised');
			const msg2 = formatEventMessage(event, 'supervised');
			expect(msg1).toBe(msg2);
		});

		it('differs by autonomy level', () => {
			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: 'space-x',
				taskId: 'task-x',
				reason: 'test',
				timestamp: TIMESTAMP,
			};

			const supervised = formatEventMessage(event, 'supervised');
			const semiAuto = formatEventMessage(event, 'semi_autonomous');
			expect(supervised).not.toBe(semiAuto);
			expect(supervised).toContain('supervised');
			expect(semiAuto).toContain('semi_autonomous');
		});
	});
});

// ---------------------------------------------------------------------------
// Test utility: extract the first JSON block from a message
// ---------------------------------------------------------------------------

function extractJson(message: string): Record<string, unknown> {
	const match = message.match(/```json\n([\s\S]*?)```/);
	if (!match) throw new Error(`No JSON block found in message:\n${message}`);
	return JSON.parse(match[1]) as Record<string, unknown>;
}
