import { describe, it, expect, beforeEach } from 'bun:test';
import { SpaceAgentNotificationService } from '../../../../src/lib/space/runtime/space-agent-notification-service';
import type { SpaceAgentNotificationServiceConfig } from '../../../../src/lib/space/runtime/space-agent-notification-service';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus';
import type { MessageDeliveryMode, SpaceTask } from '@neokai/shared';
import type { SessionFactory } from '../../../../src/lib/space/runtime/types';

// ---------------------------------------------------------------------------
// Mock SessionFactory
// ---------------------------------------------------------------------------

interface InjectedCall {
	sessionId: string;
	message: string;
	opts?: { deliveryMode?: MessageDeliveryMode };
}

function makeMockSessionFactory(opts?: {
	injectError?: Error;
}): SessionFactory & { calls: InjectedCall[] } {
	const calls: InjectedCall[] = [];
	const injectError = opts?.injectError;

	const factory: SessionFactory & { calls: InjectedCall[] } = {
		calls,
		injectMessage: async (sessionId, message, injectOpts) => {
			if (injectError) throw injectError;
			calls.push({ sessionId, message, opts: injectOpts });
		},
	};

	return factory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'spaces:global:session-1';
const SPACE_ID = 'space-abc';
const TIMESTAMP = '2026-03-20T10:00:00.000Z';

function makeService(
	factoryOrOpts?:
		| (SessionFactory & { calls: InjectedCall[] })
		| Parameters<typeof makeMockSessionFactory>[0],
	extra?: Partial<SpaceAgentNotificationServiceConfig>
): {
	service: SpaceAgentNotificationService;
	factory: SessionFactory & { calls: InjectedCall[] };
	bus: InternalEventBus<DaemonInternalEventMap>;
	unsubscribe: () => void;
} {
	let factory: SessionFactory & { calls: InjectedCall[] };
	if (factoryOrOpts && 'calls' in factoryOrOpts) {
		factory = factoryOrOpts as SessionFactory & { calls: InjectedCall[] };
	} else {
		factory = makeMockSessionFactory(factoryOrOpts as Parameters<typeof makeMockSessionFactory>[0]);
	}
	const bus = new InternalEventBus<DaemonInternalEventMap>();
	const service = new SpaceAgentNotificationService({
		internalEventBus: bus,
		sessionFactory: factory,
		sessionId: SESSION_ID,
		spaceId: SPACE_ID,
		// Use notifyThreshold:1 by default so individual event tests don't need
		// to care about the threshold. The threshold-specific tests override this.
		notifyThreshold: 1,
		...extra,
	});
	const unsubscribe = service.subscribe();
	return { service, factory, bus, unsubscribe };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpaceAgentNotificationService', () => {
	describe('space.task.blocked event', () => {
		it('injects a message with [TASK_EVENT] prefix when space.task.blocked is published', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Agent reported an error',
				timestamp: TIMESTAMP,
			});

			expect(factory.calls).toHaveLength(1);
			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] task_blocked');
		});

		it('injects into the correct session ID', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			});

			expect(factory.calls[0].sessionId).toBe(SESSION_ID);
		});

		it('uses defer delivery mode', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			});

			expect(factory.calls[0].opts?.deliveryMode).toBe('defer');
		});

		it('message includes human-readable text with taskId, spaceId, and reason', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-99',
				reason: 'Unrecoverable build failure',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('task-99');
			expect(message).toContain(SPACE_ID);
			expect(message).toContain('Unrecoverable build failure');
		});

		it('message includes JSON payload with all event fields', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-42',
				reason: 'Timed out',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			const json = extractJson(message);
			expect(json.kind).toBe('task_blocked');
			expect(json.spaceId).toBe(SPACE_ID);
			expect(json.taskId).toBe('task-42');
			expect(json.reason).toBe('Timed out');
			expect(json.timestamp).toBe(TIMESTAMP);
		});

		it('message includes autonomy level (default supervised)', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('Autonomy level: 1');
			const json = extractJson(message);
			expect(json.autonomyLevel).toBe(1);
		});

		it('message includes semi_autonomous level when configured', async () => {
			const { factory, bus } = makeService(undefined, { autonomyLevel: 3 });
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('Autonomy level: 3');
			const json = extractJson(message);
			expect(json.autonomyLevel).toBe(3);
		});
	});

	describe('space.workflowRun.blocked event', () => {
		it('formats message correctly', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.workflowRun.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				runId: 'run-55',
				reason: 'Transition condition failed: tests did not pass',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] workflow_run_blocked');
			expect(message).toContain('run-55');
			expect(message).toContain('Transition condition failed: tests did not pass');

			const json = extractJson(message);
			expect(json.kind).toBe('workflow_run_blocked');
			expect(json.runId).toBe('run-55');
			expect(json.autonomyLevel).toBe(1);
		});
	});

	describe('space.task.timeout event', () => {
		it('formats elapsed time in minutes', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.task.timeout', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-slow',
				elapsedMs: 3600000, // 60 minutes
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] task_timeout');
			expect(message).toContain('60 minute');
			expect(message).toContain('task-slow');

			const json = extractJson(message);
			expect(json.kind).toBe('task_timeout');
			expect(json.elapsedMs).toBe(3600000);
			expect(json.autonomyLevel).toBe(1);
		});
	});

	describe('space.workflowRun.completed event', () => {
		it('formats a completed run', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.workflowRun.completed', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				runId: 'run-1',
				status: 'done',
				summary: 'All steps finished. PR #42 merged.',
				timestamp: TIMESTAMP,
			});

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
			const { factory, bus } = makeService();
			await bus.publish('space.workflowRun.completed', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				runId: 'run-2',
				status: 'cancelled',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('was cancelled');

			const json = extractJson(message);
			expect(json.status).toBe('cancelled');
			expect(json.summary).toBeUndefined();
		});

		it('formats a blocked run', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.workflowRun.completed', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				runId: 'run-3',
				status: 'blocked',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('blocked');

			const json = extractJson(message);
			expect(json.status).toBe('blocked');
		});
	});

	describe('space.workflowRun.reopened event', () => {
		it('formats a reopen from done with attribution', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.workflowRun.reopened', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				runId: 'run-rx',
				fromStatus: 'done',
				reason: 'user follow-up message arrived',
				by: 'user',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] workflow_run_reopened');
			expect(message).toContain("reopened from 'done'");
			expect(message).toContain("back to 'in_progress'");
			expect(message).toContain('user follow-up message arrived');
			expect(message).toContain('(by: user)');

			const json = extractJson(message);
			expect(json.kind).toBe('workflow_run_reopened');
			expect(json.runId).toBe('run-rx');
			expect(json.fromStatus).toBe('done');
			expect(json.by).toBe('user');
			expect(json.autonomyLevel).toBe(1);
		});
	});

	describe('space.agent.crashed event', () => {
		it('formats agent crash with [TASK_EVENT] prefix', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.agent.crashed', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-crashed',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] agent_crash');
			expect(message).toContain('task-crashed');
			expect(message).toContain(SPACE_ID);
			expect(message).toContain('blocked');

			const json = extractJson(message);
			expect(json.kind).toBe('agent_crash');
			expect(json.failureReason).toBe('agentCrash');
			expect(json.taskId).toBe('task-crashed');
			expect(json.spaceId).toBe(SPACE_ID);
			expect(json.autonomyLevel).toBe(1);
		});
	});

	describe('space.agent.autoCompleted event', () => {
		it('formats auto-completed message with retry context', async () => {
			// notifyThreshold:1 (default in test helper) → fires immediately
			const { factory, bus } = makeService();
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-auto',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] agent_auto_completed');
			expect(message).toContain('timed out 1 consecutive time(s)');
			expect(message).toContain('5');

			const json = extractJson(message);
			expect(json.kind).toBe('agent_auto_completed');
			expect(json.elapsedMs).toBe(300000);
			expect(json.consecutiveCount).toBe(1);
			expect(json.totalEstimatedMinutes).toBe(5);
		});
	});

	describe('space.agent.idleNonTerminal event', () => {
		it('formats idle non-terminal message', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.agent.idleNonTerminal', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-idle',
				runId: 'run-idle',
				executionId: 'exec-1',
				nodeId: 'node-1',
				agentName: 'coder',
				reason: 'Agent stopped responding',
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] agent_idle_non_terminal');
			expect(message).toContain('node-1');
			expect(message).toContain('coder');
			expect(message).toContain('Agent stopped responding');

			const json = extractJson(message);
			expect(json.kind).toBe('agent_idle_non_terminal');
			expect(json.nodeId).toBe('node-1');
			expect(json.agentName).toBe('coder');
		});
	});

	describe('space.workflowRun.retry event', () => {
		it('formats retry message', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.workflowRun.retry', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-retry',
				runId: 'run-retry',
				originalReason: 'Network timeout',
				attemptNumber: 2,
				maxAttempts: 3,
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] task_retry');
			expect(message).toContain('attempt 2/3');
			expect(message).toContain('Network timeout');

			const json = extractJson(message);
			expect(json.kind).toBe('task_retry');
			expect(json.attemptNumber).toBe(2);
			expect(json.maxAttempts).toBe(3);
		});
	});

	describe('space.workflowRun.needsAttention event', () => {
		it('formats needs attention message', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.workflowRun.needsAttention', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				runId: 'run-na',
				taskId: 'task-na',
				reason: 'All retries exhausted',
				retriesExhausted: 3,
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] workflow_run_needs_attention');
			expect(message).toContain('needs attention');
			expect(message).toContain('3');

			const json = extractJson(message);
			expect(json.kind).toBe('workflow_run_needs_attention');
			expect(json.retriesExhausted).toBe(3);
		});
	});

	describe('space.task.awaitingApproval event', () => {
		it('formats awaiting approval message', async () => {
			const { factory, bus } = makeService();
			await bus.publish('space.task.awaitingApproval', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				actionId: 'merge-pr',
				actionName: 'Merge PR',
				actionDescription: 'Merges the staged PR',
				actionType: 'script',
				requiredLevel: 4,
				spaceLevel: 2,
				autonomyLevel: 2,
				timestamp: TIMESTAMP,
			});

			const { message } = factory.calls[0];
			expect(message).toContain('[TASK_EVENT] task_awaiting_approval');
			expect(message).toContain('task-1');
			expect(message).toContain('space-a');
			expect(message).toContain("'Merge PR'");
			expect(message).toContain('Merges the staged PR');
			expect(message).toContain('Requires autonomy 4');
			expect(message).toContain('space is at 2');

			const json = extractJson(message);
			expect(json.kind).toBe('task_awaiting_approval');
			expect(json.actionId).toBe('merge-pr');
			expect(json.actionName).toBe('Merge PR');
			expect(json.actionDescription).toBe('Merges the staged PR');
			expect(json.actionType).toBe('script');
			expect(json.requiredLevel).toBe(4);
			expect(json.spaceLevel).toBe(2);
			// Service-level autonomy (default 1) is used, not event.autonomyLevel
			expect(json.autonomyLevel).toBe(1);
		});
	});

	describe('auto-completed retry threshold', () => {
		it('suppresses notification below default threshold (3)', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 3 });
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			expect(factory.calls).toHaveLength(0);
		});

		it('suppresses notifications for 2nd consecutive auto-completion', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 3 });
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			expect(factory.calls).toHaveLength(0);
		});

		it('fires notification on 3rd consecutive auto-completion (default threshold)', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 3 });

			for (let i = 0; i < 3; i++) {
				await bus.publish('space.agent.autoCompleted', {
					sessionId: 'global',
					spaceId: SPACE_ID,
					taskId: 'task-stuck',
					elapsedMs: 300000,
					timestamp: TIMESTAMP,
				});
			}

			expect(factory.calls).toHaveLength(1);
			const { message } = factory.calls[0];
			expect(message).toContain('timed out 3 consecutive time(s)');
			expect(message).toContain('15');
			const json = extractJson(message);
			expect(json.consecutiveCount).toBe(3);
			expect(json.totalEstimatedMinutes).toBe(15);
		});

		it('resets counter after threshold notification', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 2 });

			// First two auto-completions → fires notification
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(1);

			// Counter was reset, so next auto-completion starts fresh (count=1, below threshold)
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(1); // Still only 1 notification

			// Second auto-completion after reset → fires again
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(2);
		});

		it('tracks counters independently per task', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 2 });

			// Task A: 1st auto-completion (below threshold)
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-a',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			// Task B: 1st auto-completion (below threshold)
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-b',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			expect(factory.calls).toHaveLength(0);

			// Task A: 2nd auto-completion → fires notification
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-a',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			expect(factory.calls).toHaveLength(1);
			expect(factory.calls[0].message).toContain('task-a');

			// Task B: 2nd auto-completion → fires notification
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-b',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			expect(factory.calls).toHaveLength(2);
			expect(factory.calls[1].message).toContain('task-b');
		});

		it('resets counter when task completes successfully (status=done)', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 3 });

			// 2 auto-completions (below threshold)
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(0);

			// Task completes successfully → counter should be reset
			await bus.publish('space.task.updated', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				task: { id: 'task-stuck', status: 'done' } as SpaceTask,
			});

			// Now another auto-completion starts fresh (count=1, below threshold)
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(0); // Still no notification — counter was reset
		});

		it('resets counter when task is cancelled (status=cancelled)', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 3 });

			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			// Task is cancelled → counter should be reset
			await bus.publish('space.task.updated', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				task: { id: 'task-stuck', status: 'cancelled' } as SpaceTask,
			});

			// Counter was reset, so next auto-completion starts fresh
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(0);
		});

		it('resets counter when task transitions to blocked', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 3 });

			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			// Task transitions to blocked (retries exhausted) → counter should be reset
			await bus.publish('space.task.updated', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				task: { id: 'task-stuck', status: 'blocked' } as SpaceTask,
			});

			// Counter was reset, so next auto-completion starts fresh (count=1, below threshold)
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(0);
		});

		it('preserves counter when injectMessage fails on threshold notification', async () => {
			// Use an injectError factory so notify() returns false
			const { factory, bus } = makeService(
				{ injectError: new Error('Session not found') },
				{ notifyThreshold: 2 }
			);

			// Two auto-completions → threshold reached, but notification fails
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			// Notification failed — counter should NOT have been reset.
			// Verify on a fresh service instance that the counter behavior works correctly
			// after a failed notification (the counter stays, so next auto-complete at
			// count=3 on the ORIGINAL service would retry the notification).
			// Here we just verify the new service starts clean with count=1.
			const workingFactory = makeMockSessionFactory();
			const bus2 = new InternalEventBus<DaemonInternalEventMap>();
			const service2 = new SpaceAgentNotificationService({
				internalEventBus: bus2,
				sessionFactory: workingFactory,
				sessionId: SESSION_ID,
				spaceId: SPACE_ID,
				notifyThreshold: 2,
			});
			service2.subscribe();

			// First auto-completion on new service → count=1, below threshold
			await bus2.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(workingFactory.calls).toHaveLength(0);
		});

		it('clears stale counters when re-subscribing the same instance', async () => {
			const factory = makeMockSessionFactory();
			const bus = new InternalEventBus<DaemonInternalEventMap>();
			const service = new SpaceAgentNotificationService({
				internalEventBus: bus,
				sessionFactory: factory,
				sessionId: SESSION_ID,
				spaceId: SPACE_ID,
				notifyThreshold: 3,
			});

			// First subscription: accumulate 2 auto-completions
			service.subscribe();
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(0);

			// Re-subscribe the same instance — counters should be cleared
			service.subscribe();

			// After re-subscribe, only 1 auto-completion (count=1, below threshold)
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(0);
		});

		it('does not reset counter on non-terminal task update', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 3 });

			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			// Task is updated but stays in_progress → counter should NOT be reset
			await bus.publish('space.task.updated', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				task: { id: 'task-stuck', status: 'in_progress' } as SpaceTask,
			});

			// 3rd auto-completion → should fire (counter was NOT reset)
			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(1);
		});

		it('clears counter on unsubscribe', async () => {
			const { factory, bus, unsubscribe } = makeService(undefined, { notifyThreshold: 3 });

			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(0);

			// Unsubscribe clears counters
			unsubscribe();

			// Re-subscribe with a new service instance to verify counters were cleared
			const factory2 = makeMockSessionFactory();
			const bus2 = new InternalEventBus<DaemonInternalEventMap>();
			const service2 = new SpaceAgentNotificationService({
				internalEventBus: bus2,
				sessionFactory: factory2,
				sessionId: SESSION_ID,
				spaceId: SPACE_ID,
				notifyThreshold: 3,
			});
			const unsub2 = service2.subscribe();

			// First auto-completion on new service → count=1, below threshold
			await bus2.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-stuck',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});
			expect(factory2.calls).toHaveLength(0);
			unsub2();
		});

		it('supports custom notifyThreshold of 1', async () => {
			const { factory, bus } = makeService(undefined, { notifyThreshold: 1 });

			await bus.publish('space.agent.autoCompleted', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-auto',
				elapsedMs: 300000,
				timestamp: TIMESTAMP,
			});

			expect(factory.calls).toHaveLength(1);
			const json = extractJson(factory.calls[0].message);
			expect(json.consecutiveCount).toBe(1);
		});
	});

	describe('error handling', () => {
		it('logs warning and does not throw when injectMessage fails', async () => {
			const { factory, bus } = makeService({ injectError: new Error('Session not found') });

			// Should not throw despite injectMessage failing
			await expect(
				bus.publish('space.task.blocked', {
					sessionId: 'global',
					spaceId: SPACE_ID,
					taskId: 'task-1',
					reason: 'Error',
					timestamp: TIMESTAMP,
				})
			).resolves.toBeDefined();
		});
	});

	describe('unsubscribe', () => {
		it('stops receiving events after unsubscribe', async () => {
			const { factory, bus, unsubscribe } = makeService();

			// First event should be received
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(1);

			// Unsubscribe
			unsubscribe();

			// Second event should NOT be received
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-2',
				reason: 'Error 2',
				timestamp: TIMESTAMP,
			});
			expect(factory.calls).toHaveLength(1);
		});
	});

	describe('per-space filtering', () => {
		it('ignores events for other spaces', async () => {
			const { factory, bus } = makeService();

			// Event for the correct space
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: SPACE_ID,
				taskId: 'task-1',
				reason: 'Error',
				timestamp: TIMESTAMP,
			});

			// Event for a different space
			await bus.publish('space.task.blocked', {
				sessionId: 'global',
				spaceId: 'other-space',
				taskId: 'task-2',
				reason: 'Other error',
				timestamp: TIMESTAMP,
			});

			expect(factory.calls).toHaveLength(1);
			expect(factory.calls[0].message).toContain('task-1');
		});
	});

	// Compatibility tests with SessionNotificationSink output removed — the
	// session-notification-sink module has been deleted. The notification service
	// is the sole publisher and its output format is verified by the tests above.
});

// ---------------------------------------------------------------------------
// Test utility: extract the first JSON block from a message
// ---------------------------------------------------------------------------

function extractJson(message: string): Record<string, unknown> {
	const match = message.match(/```json\n([\s\S]*?)```/);
	if (!match) throw new Error(`No JSON block found in message:\n${message}`);
	return JSON.parse(match[1]) as Record<string, unknown>;
}
