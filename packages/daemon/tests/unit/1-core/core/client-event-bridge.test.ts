/**
 * ClientEventBridge Tests
 *
 * Verifies that the bridge declaratively maps DaemonHub events to
 * ClientEventGateway deliveries with the correct channels.
 */

import { describe, expect, it, mock } from 'bun:test';
import {
	ClientEventBridge,
	createClientEventBridge,
} from '../../../../src/lib/client-event-bridge';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { IClientEventGateway, EventChannel } from '@neokai/shared';

describe('ClientEventBridge', () => {
	function buildFixture() {
		const eventHandlers = new Map<string, Function>();
		const unsubscribers: string[] = [];

		const daemonHub = {
			on: mock((event: string, handler: Function) => {
				eventHandlers.set(event, handler);
				return () => {
					unsubscribers.push(event);
					eventHandlers.delete(event);
				};
			}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		const published: { method: string; data: unknown; channel: EventChannel }[] = [];

		const gateway = {
			publish: mock((method: string, data: unknown, channel: EventChannel) => {
				published.push({ method, data, channel });
			}),
			publishGlobal: mock((method: string, data?: unknown) => {
				published.push({ method, data, channel: { kind: 'global' } });
			}),
		} as unknown as IClientEventGateway;

		return { daemonHub, gateway, eventHandlers, published, unsubscribers };
	}

	describe('start', () => {
		it('should subscribe to all space bridge events', () => {
			const { daemonHub, gateway, eventHandlers } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, gateway);
			bridge.start();

			expect(eventHandlers.has('space.created')).toBe(true);
			expect(eventHandlers.has('space.updated')).toBe(true);
			expect(eventHandlers.has('space.archived')).toBe(true);
			expect(eventHandlers.has('space.deleted')).toBe(true);
			expect(eventHandlers.has('space.task.created')).toBe(true);
			expect(eventHandlers.has('space.task.updated')).toBe(true);
			expect(eventHandlers.has('space.schedule.updated')).toBe(true);
			expect(eventHandlers.has('space.workflowRun.created')).toBe(true);
			expect(eventHandlers.has('space.workflowRun.updated')).toBe(true);
			expect(eventHandlers.has('space.gateData.updated')).toBe(true);
			expect(eventHandlers.has('spaceAgent.created')).toBe(true);
			expect(eventHandlers.has('spaceAgent.updated')).toBe(true);
			expect(eventHandlers.has('spaceAgent.deleted')).toBe(true);
			expect(eventHandlers.has('spaceWorkflow.created')).toBe(true);
			expect(eventHandlers.has('spaceWorkflow.updated')).toBe(true);
			expect(eventHandlers.has('spaceWorkflow.deleted')).toBe(true);
		});

		it('should be idempotent', () => {
			const { daemonHub, gateway, eventHandlers } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, gateway);
			bridge.start();
			bridge.start();

			// Only one handler per event should be registered
			expect(eventHandlers.size).toBe(16);
		});
	});

	describe('stop', () => {
		it('should unsubscribe from all events', () => {
			const { daemonHub, gateway, unsubscribers } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, gateway);
			bridge.start();
			bridge.stop();

			expect(unsubscribers.length).toBe(16);
		});
	});

	describe('space event forwarding', () => {
		it('forwards space.created to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = { sessionId: 'global', spaceId: 's-1', space: { id: 's-1' } };
			eventHandlers.get('space.created')!(data);

			expect(published[0].method).toBe('space.created');
			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.updated to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = { sessionId: 'global', spaceId: 's-1', space: { name: 'Updated' } };
			eventHandlers.get('space.updated')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.archived to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				space: { id: 's-1', status: 'archived' },
			};
			eventHandlers.get('space.archived')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.deleted to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = { sessionId: 'global', spaceId: 's-1' };
			eventHandlers.get('space.deleted')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.task.created to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				taskId: 't-1',
				task: { id: 't-1', title: 'Task 1' },
			};
			eventHandlers.get('space.task.created')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.task.updated to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				taskId: 't-1',
				task: { id: 't-1', status: 'in_progress' },
			};
			eventHandlers.get('space.task.updated')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.schedule.updated to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				scheduleId: 'sch-1',
				schedule: { id: 'sch-1', cron: '0 9 * * *' },
			};
			eventHandlers.get('space.schedule.updated')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.workflowRun.created to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				runId: 'run-1',
				run: { id: 'run-1', status: 'pending' },
			};
			eventHandlers.get('space.workflowRun.created')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.workflowRun.updated to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				runId: 'run-1',
				run: { status: 'running' },
			};
			eventHandlers.get('space.workflowRun.updated')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.gateData.updated to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				runId: 'run-1',
				gateId: 'g-1',
				data: { votes: 3 },
			};
			eventHandlers.get('space.gateData.updated')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards spaceAgent.created to space-scoped channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'space:s-1',
				spaceId: 's-1',
				agent: { id: 'a-1', name: 'Agent 1' },
			};
			eventHandlers.get('spaceAgent.created')!(data);

			expect(published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
		});

		it('forwards spaceAgent.updated to space-scoped channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'space:s-1',
				spaceId: 's-1',
				agent: { id: 'a-1', name: 'Updated Agent' },
			};
			eventHandlers.get('spaceAgent.updated')!(data);

			expect(published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
		});

		it('forwards spaceAgent.deleted to space-scoped channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = { sessionId: 'space:s-1', spaceId: 's-1', agentId: 'a-1' };
			eventHandlers.get('spaceAgent.deleted')!(data);

			expect(published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
		});

		it('forwards spaceWorkflow.created to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				workflow: { id: 'wf-1', name: 'Workflow 1' },
			};
			eventHandlers.get('spaceWorkflow.created')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards spaceWorkflow.updated to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				workflow: { id: 'wf-1', name: 'Updated Workflow' },
			};
			eventHandlers.get('spaceWorkflow.updated')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards spaceWorkflow.deleted to global channel', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = { sessionId: 'global', spaceId: 's-1', workflowId: 'wf-1' };
			eventHandlers.get('spaceWorkflow.deleted')!(data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});
	});

	describe('payload passthrough', () => {
		it('passes the original payload through unchanged', () => {
			const { daemonHub, gateway, eventHandlers, published } = buildFixture();
			createClientEventBridge(daemonHub, gateway).start();

			const data = { sessionId: 'global', spaceId: 's-1', space: { id: 's-1', name: 'Test' } };
			eventHandlers.get('space.created')!(data);

			expect(published[0].data).toEqual(data);
		});
	});
});
