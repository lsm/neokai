import { describe, it, expect, beforeEach } from 'bun:test';
import {
	SessionNotificationSink,
	formatEventMessage,
} from '../../../../src/lib/space/runtime/session-notification-sink';
import type { SessionNotificationSinkConfig } from '../../../../src/lib/space/runtime/session-notification-sink';
import type { SpaceNotificationEvent } from '../../../../src/lib/space/runtime/notification-sink';
import type { SessionFactory } from '../../../../src/lib/room/runtime/task-group-manager';
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
	describe('task_blocked event', () => {
		it('injects a message with [TASK_EVENT] prefix', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_blocked',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Agent reported an error',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			expect(factory.calls).toHaveLength(1);
			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] task_blocked');
		});

		it('injects into the correct session ID', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_blocked',
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
				kind: 'task_blocked',
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
				kind: 'task_blocked',
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
				kind: 'task_blocked',
				spaceId: SPACE_ID,
				taskId: 'task-42',
				reason: 'Timed out',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			const json = extractJson(message);
			expect(json.kind).toBe('task_blocked');
			expect(json.spaceId).toBe(SPACE_ID);
			expect(json.taskId).toBe('task-42');
			expect(json.reason).toBe('Timed out');
			expect(json.timestamp).toBe(TIMESTAMP);
		});

		it('message includes autonomy level (default supervised)', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'task_blocked',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('Autonomy level: 1');
			const json = extractJson(message);
			expect(json.autonomyLevel).toBe(1);
		});

		it('message includes semi_autonomous level when configured', async () => {
			const { sink, factory } = makeSink(undefined, { autonomyLevel: 3 });
			const event: SpaceNotificationEvent = {
				kind: 'task_blocked',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('Autonomy level: 3');
			const json = extractJson(message);
			expect(json.autonomyLevel).toBe(3);
		});
	});

	describe('workflow_run_blocked event', () => {
		it('formats message correctly', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_blocked',
				spaceId: SPACE_ID,
				runId: 'run-55',
				reason: 'Transition condition failed: tests did not pass',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] workflow_run_blocked');
			expect(message).toContain('run-55');
			expect(message).toContain('Transition condition failed: tests did not pass');

			const json = extractJson(message);
			expect(json.kind).toBe('workflow_run_blocked');
			expect(json.runId).toBe('run-55');
			expect(json.autonomyLevel).toBe(1);
		});

		it('uses defer delivery mode', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_blocked',
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
			expect(json.autonomyLevel).toBe(1);
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
				status: 'done',
				summary: 'All steps finished. PR #42 merged.',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] workflow_run_completed');
			expect(message).toContain('completed successfully');
			expect(message).toContain('PR #42 merged.');

			const json = extractJson(message);
			expect(json.status).toBe('done');
			expect(json.summary).toBe('All steps finished. PR #42 merged.');
			expect(json.autonomyLevel).toBe(1);
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

		it('formats a blocked run', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_completed',
				spaceId: SPACE_ID,
				runId: 'run-3',
				status: 'blocked',
				timestamp: TIMESTAMP,
			};

			await sink.notify(event);

			const { message } = factory.calls[0];
			expect(message).toContain('blocked');

			const json = extractJson(message);
			expect(json.status).toBe('blocked');
		});

		it('uses defer delivery mode', async () => {
			const { sink, factory } = makeSink();
			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_completed',
				spaceId: SPACE_ID,
				runId: 'run-1',
				status: 'done',
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
				kind: 'task_blocked',
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
					kind: 'task_blocked',
					spaceId: SPACE_ID,
					taskId: 't',
					reason: 'r',
					timestamp: TIMESTAMP,
				},
				{
					kind: 'workflow_run_blocked',
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
					status: 'done',
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
				kind: 'task_blocked',
				spaceId: 'space-x',
				taskId: 'task-x',
				reason: 'test reason',
				timestamp: TIMESTAMP,
			};

			const msg1 = formatEventMessage(event, 1);
			const msg2 = formatEventMessage(event, 1);
			expect(msg1).toBe(msg2);
		});

		it('differs by autonomy level', () => {
			const event: SpaceNotificationEvent = {
				kind: 'task_blocked',
				spaceId: 'space-x',
				taskId: 'task-x',
				reason: 'test',
				timestamp: TIMESTAMP,
			};

			const supervised = formatEventMessage(event, 1);
			const semiAuto = formatEventMessage(event, 3);
			expect(supervised).not.toBe(semiAuto);
			expect(supervised).toContain('Autonomy level: 1');
			expect(semiAuto).toContain('Autonomy level: 3');
		});
	});
});

// ---------------------------------------------------------------------------
// agent_crash event (M9.4)
// ---------------------------------------------------------------------------

describe('formatEventMessage — agent_crash', () => {
	const TIMESTAMP = '2025-01-15T12:00:00.000Z';

	it('formats agent_crash with [TASK_EVENT] prefix', () => {
		const event: SpaceNotificationEvent = {
			kind: 'agent_crash',
			spaceId: 'space-crash',
			taskId: 'task-crashed',
			timestamp: TIMESTAMP,
		};

		const msg = formatEventMessage(event, 1);
		expect(msg).toContain('[TASK_EVENT] agent_crash');
	});

	it('includes task ID and space ID in human-readable summary', () => {
		const event: SpaceNotificationEvent = {
			kind: 'agent_crash',
			spaceId: 'space-crash',
			taskId: 'task-crashed',
			timestamp: TIMESTAMP,
		};

		const msg = formatEventMessage(event, 1);
		expect(msg).toContain('task-crashed');
		expect(msg).toContain('space-crash');
		expect(msg).toContain('blocked');
	});

	it('includes failureReason: agentCrash in JSON payload', () => {
		const event: SpaceNotificationEvent = {
			kind: 'agent_crash',
			spaceId: 'space-crash',
			taskId: 'task-crashed',
			timestamp: TIMESTAMP,
		};

		const msg = formatEventMessage(event, 1);
		const json = extractJson(msg);
		expect(json['kind']).toBe('agent_crash');
		expect(json['failureReason']).toBe('agentCrash');
		expect(json['taskId']).toBe('task-crashed');
		expect(json['spaceId']).toBe('space-crash');
		expect(json['autonomyLevel']).toBe(1);
	});

	it('includes autonomy level in JSON payload', () => {
		const event: SpaceNotificationEvent = {
			kind: 'agent_crash',
			spaceId: 'space-crash',
			taskId: 'task-crashed',
			timestamp: TIMESTAMP,
		};

		const msgSupervised = formatEventMessage(event, 1);
		const msgSemiAuto = formatEventMessage(event, 3);

		expect(extractJson(msgSupervised)['autonomyLevel']).toBe(1);
		expect(extractJson(msgSemiAuto)['autonomyLevel']).toBe(3);
	});

	it('SessionNotificationSink.notify() injects agent_crash message into session', async () => {
		const factory = makeMockSessionFactory();
		const sink = new SessionNotificationSink({
			sessionFactory: factory,
			sessionId: 'session:spaces:global',
			autonomyLevel: 1,
		});

		await sink.notify({
			kind: 'agent_crash',
			spaceId: 'space-crash',
			taskId: 'task-crashed',
			timestamp: TIMESTAMP,
		});

		expect(factory.calls).toHaveLength(1);
		const [call] = factory.calls;
		expect(call.sessionId).toBe('session:spaces:global');
		expect(call.message).toContain('[TASK_EVENT] agent_crash');
		expect(call.message).toContain('agentCrash');
		expect(call.opts?.deliveryMode).toBe('defer');
	});
});

describe('formatEventMessage — completion_action_executed', () => {
	const TIMESTAMP = '2025-01-15T12:00:00.000Z';

	const base = {
		kind: 'completion_action_executed' as const,
		spaceId: 'space-ca',
		taskId: 'task-ca',
		runId: 'run-ca',
		actionId: 'merge-pr',
		actionName: 'Merge PR',
		executedAt: TIMESTAMP,
		timestamp: TIMESTAMP,
	};

	it('formats completion_action_executed with [TASK_EVENT] prefix', () => {
		const event: SpaceNotificationEvent = {
			...base,
			approvedBy: 'human',
			approvalReason: 'LGTM',
		};

		const msg = formatEventMessage(event, 2);
		expect(msg).toContain('[TASK_EVENT] completion_action_executed');
	});

	it('includes the action name + reason in the human-readable summary for human approvals', () => {
		const event: SpaceNotificationEvent = {
			...base,
			approvedBy: 'human',
			approvalReason: 'Ship it',
		};

		const msg = formatEventMessage(event, 2);
		expect(msg).toContain('Merge PR');
		expect(msg).toContain('human reviewer');
		expect(msg).toContain('Ship it');
	});

	it('labels the approver as auto-policy and omits the reason for auto_policy approvals', () => {
		const event: SpaceNotificationEvent = {
			...base,
			approvedBy: 'auto_policy',
			approvalReason: null,
		};

		const msg = formatEventMessage(event, 5);
		expect(msg).toContain('auto-policy');
		// Sanity: no stray "Reason:" suffix when the approval has no rationale.
		expect(msg).not.toContain('Reason:');
	});

	it('serializes the full audit payload into the JSON block', () => {
		const event: SpaceNotificationEvent = {
			...base,
			approvedBy: 'human',
			approvalReason: 'ship it',
		};

		const json = extractJson(formatEventMessage(event, 4));
		expect(json['kind']).toBe('completion_action_executed');
		expect(json['actionId']).toBe('merge-pr');
		expect(json['actionName']).toBe('Merge PR');
		expect(json['approvedBy']).toBe('human');
		expect(json['approvalReason']).toBe('ship it');
		expect(json['taskId']).toBe('task-ca');
		expect(json['runId']).toBe('run-ca');
		expect(json['executedAt']).toBe(TIMESTAMP);
		expect(json['autonomyLevel']).toBe(4);
	});

	it('SessionNotificationSink.notify() injects completion_action_executed into session', async () => {
		const factory = makeMockSessionFactory();
		const sink = new SessionNotificationSink({
			sessionFactory: factory,
			sessionId: 'session:spaces:global',
			autonomyLevel: 2,
		});

		await sink.notify({
			...base,
			approvedBy: 'human',
			approvalReason: 'approved',
		});

		expect(factory.calls).toHaveLength(1);
		const [call] = factory.calls;
		expect(call.sessionId).toBe('session:spaces:global');
		expect(call.message).toContain('[TASK_EVENT] completion_action_executed');
		expect(call.message).toContain('Merge PR');
		expect(call.opts?.deliveryMode).toBe('defer');
	});
});

// ---------------------------------------------------------------------------
// task_awaiting_approval event (completion-action pause surface)
// ---------------------------------------------------------------------------

describe('formatEventMessage — task_awaiting_approval', () => {
	const TIMESTAMP = '2026-04-19T12:00:00.000Z';

	it('formats task_awaiting_approval with [TASK_EVENT] prefix and action metadata', () => {
		const event: SpaceNotificationEvent = {
			kind: 'task_awaiting_approval',
			spaceId: 'space-a',
			taskId: 'task-1',
			actionId: 'merge-pr',
			actionName: 'Merge PR',
			actionDescription: 'Merges the staged PR',
			actionType: 'script',
			requiredLevel: 4,
			spaceLevel: 2,
			autonomyLevel: 2,
			timestamp: TIMESTAMP,
		};

		const msg = formatEventMessage(event, 2);
		expect(msg).toContain('[TASK_EVENT] task_awaiting_approval');
		expect(msg).toContain('task-1');
		expect(msg).toContain('space-a');
		expect(msg).toContain("'Merge PR'");
		expect(msg).toContain('Merges the staged PR');
		expect(msg).toContain('Requires autonomy 4');
		expect(msg).toContain('space is at 2');
	});

	it('includes action metadata in JSON payload', () => {
		const event: SpaceNotificationEvent = {
			kind: 'task_awaiting_approval',
			spaceId: 'space-a',
			taskId: 'task-1',
			actionId: 'merge-pr',
			actionName: 'Merge PR',
			actionDescription: 'Merges the staged PR',
			actionType: 'script',
			requiredLevel: 4,
			spaceLevel: 2,
			autonomyLevel: 2,
			timestamp: TIMESTAMP,
		};

		const msg = formatEventMessage(event, 2);
		const json = extractJson(msg);
		expect(json['kind']).toBe('task_awaiting_approval');
		expect(json['actionId']).toBe('merge-pr');
		expect(json['actionName']).toBe('Merge PR');
		expect(json['actionDescription']).toBe('Merges the staged PR');
		expect(json['actionType']).toBe('script');
		expect(json['requiredLevel']).toBe(4);
		expect(json['spaceLevel']).toBe(2);
		expect(json['autonomyLevel']).toBe(2);
		expect(json['taskId']).toBe('task-1');
		expect(json['spaceId']).toBe('space-a');
	});

	it('omits actionDescription from JSON when absent', () => {
		const event: SpaceNotificationEvent = {
			kind: 'task_awaiting_approval',
			spaceId: 'space-a',
			taskId: 'task-1',
			actionId: 'deploy',
			actionName: 'Deploy',
			actionType: 'mcp_call',
			requiredLevel: 5,
			spaceLevel: 1,
			autonomyLevel: 1,
			timestamp: TIMESTAMP,
		};

		const msg = formatEventMessage(event, 1);
		const json = extractJson(msg);
		expect(json['actionDescription']).toBeUndefined();
	});

	it('SessionNotificationSink.notify() injects task_awaiting_approval message', async () => {
		const factory = makeMockSessionFactory();
		const sink = new SessionNotificationSink({
			sessionFactory: factory,
			sessionId: 'session:spaces:global',
			autonomyLevel: 2,
		});

		await sink.notify({
			kind: 'task_awaiting_approval',
			spaceId: 'space-a',
			taskId: 'task-1',
			actionId: 'merge-pr',
			actionName: 'Merge PR',
			actionType: 'script',
			requiredLevel: 4,
			spaceLevel: 2,
			autonomyLevel: 2,
			timestamp: TIMESTAMP,
		});

		expect(factory.calls).toHaveLength(1);
		const [call] = factory.calls;
		expect(call.message).toContain('[TASK_EVENT] task_awaiting_approval');
		expect(call.message).toContain('Merge PR');
		expect(call.opts?.deliveryMode).toBe('defer');
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
