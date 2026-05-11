/**
 * ClientEventBridge Tests
 *
 * Verifies that the bridge:
 * 1. Declaratively maps DaemonHub events to ClientEventGateway deliveries
 * 2. Registers RPC handlers for state snapshots
 * 3. Manages versioned state broadcasts (system, settings, session, SDK messages)
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	ClientEventBridge,
	createClientEventBridge,
} from '../../../../src/lib/client-event-bridge';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type {
	MessageHub,
	IClientEventGateway,
	EventChannel,
	SDKMessagesUpdate,
} from '@neokai/shared';
import { STATE_CHANNELS } from '@neokai/shared';
import type {
	StateProjectionService,
	ChannelVersionSource,
} from '../../../../src/lib/state-projection-service';

/**
 * Minimal mock of StateProjectionService + ChannelVersionSource for bridge tests.
 */
function createMockStateProjection() {
	const versions = new Map<string, number>();

	return {
		incrementVersion: mock((channel: string) => {
			const current = versions.get(channel) || 0;
			const next = current + 1;
			versions.set(channel, next);
			return next;
		}),
		getVersion: mock((channel: string) => versions.get(channel) || 0),
		deleteVersion: mock((channel: string) => {
			versions.delete(channel);
		}),
		getGlobalSnapshot: mock(async () => ({})),
		getSystemState: mock(async () => ({
			version: '0.1.1',
			auth: { isAuthenticated: true },
			health: { status: 'ok' },
			timestamp: Date.now(),
		})),
		getSettingsState: mock(async () => ({
			settings: {},
			timestamp: Date.now(),
		})),
		getSessionsState: mock(async () => ({
			sessions: [],
			hasArchivedSessions: false,
			timestamp: Date.now(),
		})),
		getSessionState: mock(async () => ({
			sessionInfo: { id: 'test-id' },
			agentState: { status: 'idle' },
			commandsData: { availableCommands: [] },
			error: null,
			timestamp: Date.now(),
		})),
		getSessionSnapshot: mock(async () => ({
			session: {},
			sdkMessages: {},
			meta: {},
		})),
		getSDKMessagesState: mock(async () => ({
			sdkMessages: [],
			hasMore: false,
			timestamp: Date.now(),
		})),
	} as unknown as StateProjectionService & ChannelVersionSource;
}

describe('ClientEventBridge', () => {
	function buildFixture() {
		const eventHandlers = new Map<string, Function[]>();
		const unsubscribers: string[] = [];

		const daemonHub = {
			on: mock((event: string, handler: Function) => {
				const existing = eventHandlers.get(event) || [];
				existing.push(handler);
				eventHandlers.set(event, existing);
				return () => {
					unsubscribers.push(event);
					const handlers = eventHandlers.get(event);
					if (handlers) {
						const idx = handlers.indexOf(handler);
						if (idx !== -1) handlers.splice(idx, 1);
						if (handlers.length === 0) eventHandlers.delete(event);
					}
				};
			}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		const requestHandlers = new Map<string, Function>();
		const messageHub = {
			event: mock(() => {}),
			onRequest: mock((method: string, handler: Function) => {
				requestHandlers.set(method, handler);
				return () => {};
			}),
		} as unknown as MessageHub;

		const published: { method: string; data: unknown; channel: EventChannel }[] = [];

		const gateway = {
			publish: mock((method: string, data: unknown, channel: EventChannel) => {
				published.push({ method, data, channel });
			}),
			publishGlobal: mock((method: string, data?: unknown) => {
				published.push({ method, data, channel: { kind: 'global' } });
			}),
		} as unknown as IClientEventGateway;

		const stateProjection = createMockStateProjection();

		return {
			daemonHub,
			messageHub,
			gateway,
			eventHandlers,
			requestHandlers,
			published,
			unsubscribers,
			stateProjection,
		};
	}

	describe('start', () => {
		it('should subscribe to all space bridge events', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
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

		it('should subscribe to session bridge events', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			expect(eventHandlers.has('session.created')).toBe(true);
			expect(eventHandlers.has('session.deleted')).toBe(true);
			expect(eventHandlers.has('context.updated')).toBe(true);
		});

		it('should subscribe to connection/auth bridge events', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			expect(eventHandlers.has('api.connection')).toBe(true);
			expect(eventHandlers.has('auth.changed')).toBe(true);
		});

		it('should subscribe to config bridge events', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			expect(eventHandlers.has('commands.updated')).toBe(true);
		});

		it('should subscribe to error bridge events', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			expect(eventHandlers.has('session.error')).toBe(true);
			expect(eventHandlers.has('session.errorClear')).toBe(true);
		});

		it('should register RPC handlers', () => {
			const { daemonHub, messageHub, gateway, requestHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			expect(requestHandlers.has(STATE_CHANNELS.GLOBAL_SNAPSHOT)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.SESSION_SNAPSHOT)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.GLOBAL_SYSTEM)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.GLOBAL_SESSIONS)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.GLOBAL_SETTINGS)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.SESSION)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.SESSION_SDK_MESSAGES)).toBe(true);
		});

		it('should be idempotent', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();
			bridge.start();

			// 16 space + 3 session + 2 conn/auth + 1 config + 2 error + 1 settings + 1 session.updated = 26 unique events
			// (context.updated has 2 handlers but is 1 unique event key)
			expect(eventHandlers.size).toBe(26);
		});
	});

	describe('stop', () => {
		it('should unsubscribe from all events', () => {
			const { daemonHub, messageHub, gateway, unsubscribers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();
			bridge.stop();

			// Each daemonHub.on call produces one unsubscriber
			expect(unsubscribers.length).toBeGreaterThan(0);
		});
	});

	describe('space event forwarding', () => {
		it('forwards space.created to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'global', spaceId: 's-1', space: { id: 's-1' } };
			eventHandlers.get('space.created')![0](data);

			expect(published[0].method).toBe('space.created');
			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.updated to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'global', spaceId: 's-1', space: { name: 'Updated' } };
			eventHandlers.get('space.updated')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.archived to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				space: { id: 's-1', status: 'archived' },
			};
			eventHandlers.get('space.archived')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.deleted to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'global', spaceId: 's-1' };
			eventHandlers.get('space.deleted')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.task.created to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				taskId: 't-1',
				task: { id: 't-1', title: 'Task 1' },
			};
			eventHandlers.get('space.task.created')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.task.updated to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				taskId: 't-1',
				task: { id: 't-1', status: 'in_progress' },
			};
			eventHandlers.get('space.task.updated')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.schedule.updated to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				scheduleId: 'sch-1',
				schedule: { id: 'sch-1', cron: '0 9 * * *' },
			};
			eventHandlers.get('space.schedule.updated')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.workflowRun.created to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				runId: 'run-1',
				run: { id: 'run-1', status: 'pending' },
			};
			eventHandlers.get('space.workflowRun.created')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.workflowRun.updated to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				runId: 'run-1',
				run: { status: 'running' },
			};
			eventHandlers.get('space.workflowRun.updated')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards space.gateData.updated to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				runId: 'run-1',
				gateId: 'g-1',
				data: { votes: 3 },
			};
			eventHandlers.get('space.gateData.updated')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards spaceAgent.created to space-scoped channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'space:s-1',
				spaceId: 's-1',
				agent: { id: 'a-1', name: 'Agent 1' },
			};
			eventHandlers.get('spaceAgent.created')![0](data);

			expect(published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
		});

		it('forwards spaceAgent.updated to space-scoped channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'space:s-1',
				spaceId: 's-1',
				agent: { id: 'a-1', name: 'Updated Agent' },
			};
			eventHandlers.get('spaceAgent.updated')![0](data);

			expect(published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
		});

		it('forwards spaceAgent.deleted to space-scoped channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'space:s-1', spaceId: 's-1', agentId: 'a-1' };
			eventHandlers.get('spaceAgent.deleted')![0](data);

			expect(published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
		});

		it('forwards spaceWorkflow.created to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				workflow: { id: 'wf-1', name: 'Workflow 1' },
			};
			eventHandlers.get('spaceWorkflow.created')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards spaceWorkflow.updated to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'global',
				spaceId: 's-1',
				workflow: { id: 'wf-1', name: 'Updated Workflow' },
			};
			eventHandlers.get('spaceWorkflow.updated')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards spaceWorkflow.deleted to global channel', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'global', spaceId: 's-1', workflowId: 'wf-1' };
			eventHandlers.get('spaceWorkflow.deleted')![0](data);

			expect(published[0].channel).toEqual({ kind: 'global' });
		});
	});

	describe('session event forwarding', () => {
		it('forwards session.created to global channel with transformed payload', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = {
				sessionId: 'sess-1',
				session: { id: 'sess-1', title: 'Test', status: 'active', metadata: {} },
			};
			eventHandlers.get('session.created')![0](data);

			expect(published[0].method).toBe('session.created');
			expect(published[0].data).toEqual({ sessionId: 'sess-1' });
			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards session.deleted to global channel with transformed payload', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'sess-1' };
			eventHandlers.get('session.deleted')![0](data);

			expect(published[0].method).toBe('session.deleted');
			expect(published[0].data).toEqual({ sessionId: 'sess-1' });
			expect(published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards context.updated to session-scoped channel with transformed payload', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const contextInfo = { files: 5, tokens: 1000 };
			const data = { sessionId: 'sess-1', contextInfo };
			eventHandlers.get('context.updated')![0](data);

			expect(published[0].method).toBe('context.updated');
			expect(published[0].data).toEqual(contextInfo);
			expect(published[0].channel).toEqual({ kind: 'session', sessionId: 'sess-1' });
		});
	});

	describe('connection/auth event broadcasts', () => {
		it('triggers broadcastSystemChange on api.connection', async () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'global', status: 'disconnected', timestamp: Date.now() };
			await eventHandlers.get('api.connection')![0](data);

			expect(stateProjection.incrementVersion).toHaveBeenCalledWith(STATE_CHANNELS.GLOBAL_SYSTEM);
			expect(messageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SYSTEM,
				expect.objectContaining({ version: expect.any(Number) }),
				{ channel: 'global' }
			);
		});

		it('triggers broadcastSystemChange on auth.changed', async () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'global', method: 'api_key', isAuthenticated: true };
			await eventHandlers.get('auth.changed')![0](data);

			expect(stateProjection.incrementVersion).toHaveBeenCalledWith(STATE_CHANNELS.GLOBAL_SYSTEM);
		});
	});

	describe('config event broadcasts', () => {
		it('triggers broadcastSessionStateChange on commands.updated', async () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'sess-1', commands: ['cmd1', 'cmd2'] };
			await eventHandlers.get('commands.updated')![0](data);

			expect(stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION}:sess-1`
			);
		});
	});

	describe('context.updated broadcast trigger', () => {
		it('triggers broadcastSessionStateChange on context.updated', async () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'sess-1', contextInfo: { files: 5, tokens: 1000 } };
			// The broadcast trigger is the second handler (index 1) for context.updated
			await eventHandlers.get('context.updated')![1](data);

			expect(stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION}:sess-1`
			);
		});
	});

	describe('error event broadcasts', () => {
		it('triggers broadcastSessionStateChange on session.error', async () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'sess-1', error: 'Something went wrong' };
			await eventHandlers.get('session.error')![0](data);

			expect(stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION}:sess-1`
			);
		});

		it('triggers broadcastSessionStateChange on session.errorClear', async () => {
			const { daemonHub, messageHub, gateway, eventHandlers, stateProjection } = buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'sess-1' };
			await eventHandlers.get('session.errorClear')![0](data);

			expect(stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION}:sess-1`
			);
		});
	});

	describe('payload passthrough', () => {
		it('passes the original payload through unchanged', () => {
			const { daemonHub, messageHub, gateway, eventHandlers, published, stateProjection } =
				buildFixture();
			createClientEventBridge(daemonHub, messageHub, gateway, stateProjection).start();

			const data = { sessionId: 'global', spaceId: 's-1', space: { id: 's-1', name: 'Test' } };
			eventHandlers.get('space.created')![0](data);

			expect(published[0].data).toEqual(data);
		});
	});

	describe('broadcast methods', () => {
		describe('broadcastSystemChange', () => {
			it('should broadcast system state with version', async () => {
				const { daemonHub, messageHub, gateway, stateProjection } = buildFixture();
				const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);

				await bridge.broadcastSystemChange();

				expect(stateProjection.incrementVersion).toHaveBeenCalledWith(STATE_CHANNELS.GLOBAL_SYSTEM);
				expect(messageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.GLOBAL_SYSTEM,
					expect.objectContaining({
						version: expect.any(Number),
						auth: expect.any(Object),
					}),
					{ channel: 'global' }
				);
			});
		});

		describe('broadcastSettingsChange', () => {
			it('should broadcast settings state with version', async () => {
				const { daemonHub, messageHub, gateway, stateProjection } = buildFixture();
				const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);

				await bridge.broadcastSettingsChange();

				expect(stateProjection.incrementVersion).toHaveBeenCalledWith(
					STATE_CHANNELS.GLOBAL_SETTINGS
				);
				expect(messageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.GLOBAL_SETTINGS,
					expect.objectContaining({
						settings: expect.any(Object),
						version: expect.any(Number),
					}),
					{ channel: 'global' }
				);
			});
		});

		describe('broadcastSessionStateChange', () => {
			it('should broadcast session state with version', async () => {
				const { daemonHub, messageHub, gateway, stateProjection } = buildFixture();
				const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);

				await bridge.broadcastSessionStateChange('test-id');

				expect(stateProjection.incrementVersion).toHaveBeenCalledWith(
					`${STATE_CHANNELS.SESSION}:test-id`
				);
				expect(messageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.SESSION,
					expect.objectContaining({
						sessionInfo: expect.any(Object),
						agentState: expect.any(Object),
						version: expect.any(Number),
					}),
					{ channel: 'session:test-id' }
				);
			});

			it('should skip broadcast for empty sessionId', async () => {
				const { daemonHub, messageHub, gateway, stateProjection } = buildFixture();
				const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);

				await bridge.broadcastSessionStateChange('');

				expect(stateProjection.incrementVersion).not.toHaveBeenCalled();
				expect(messageHub.event).not.toHaveBeenCalled();
			});
		});

		describe('broadcastSDKMessagesChange', () => {
			it('should broadcast SDK messages state with version', async () => {
				const { daemonHub, messageHub, gateway, stateProjection } = buildFixture();
				const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);

				await bridge.broadcastSDKMessagesChange('test-id');

				expect(stateProjection.incrementVersion).toHaveBeenCalledWith(
					`${STATE_CHANNELS.SESSION_SDK_MESSAGES}:test-id`
				);
				expect(messageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.SESSION_SDK_MESSAGES,
					expect.objectContaining({
						sdkMessages: expect.any(Array),
						hasMore: false,
						version: expect.any(Number),
					}),
					{ channel: 'session:test-id' }
				);
			});
		});

		describe('broadcastSDKMessagesDelta', () => {
			it('should broadcast SDK messages delta with version', async () => {
				const { daemonHub, messageHub, gateway, stateProjection } = buildFixture();
				const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);

				await bridge.broadcastSDKMessagesDelta('test-id', {
					added: [{ id: 'msg1' }],
					timestamp: Date.now(),
				});

				expect(stateProjection.incrementVersion).toHaveBeenCalledWith(
					`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta:test-id`
				);
				expect(messageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.SESSION_SDK_MESSAGES + '.delta',
					expect.objectContaining({
						added: [{ id: 'msg1' }],
						version: expect.any(Number),
					}),
					{ channel: 'session:test-id' }
				);
			});
		});
	});

	describe('RPC handlers', () => {
		it('should delegate GLOBAL_SNAPSHOT to stateProjection', async () => {
			const { daemonHub, messageHub, gateway, requestHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SNAPSHOT);
			await handler!({});

			expect(stateProjection.getGlobalSnapshot).toHaveBeenCalled();
		});

		it('should delegate SESSION_SNAPSHOT to stateProjection', async () => {
			const { daemonHub, messageHub, gateway, requestHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			const handler = requestHandlers.get(STATE_CHANNELS.SESSION_SNAPSHOT);
			await handler!({ sessionId: 'test-id' });

			expect(stateProjection.getSessionSnapshot).toHaveBeenCalledWith('test-id');
		});

		it('should delegate GLOBAL_SYSTEM to stateProjection', async () => {
			const { daemonHub, messageHub, gateway, requestHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SYSTEM);
			await handler!({});

			expect(stateProjection.getSystemState).toHaveBeenCalled();
		});

		it('should delegate GLOBAL_SESSIONS to stateProjection', async () => {
			const { daemonHub, messageHub, gateway, requestHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SESSIONS);
			await handler!({});

			expect(stateProjection.getSessionsState).toHaveBeenCalled();
		});

		it('should delegate GLOBAL_SETTINGS to stateProjection', async () => {
			const { daemonHub, messageHub, gateway, requestHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SETTINGS);
			await handler!({});

			expect(stateProjection.getSettingsState).toHaveBeenCalled();
		});

		it('should delegate SESSION to stateProjection', async () => {
			const { daemonHub, messageHub, gateway, requestHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			const handler = requestHandlers.get(STATE_CHANNELS.SESSION);
			await handler!({ sessionId: 'test-id' });

			expect(stateProjection.getSessionState).toHaveBeenCalledWith('test-id');
		});

		it('should delegate SESSION_SDK_MESSAGES to stateProjection', async () => {
			const { daemonHub, messageHub, gateway, requestHandlers, stateProjection } = buildFixture();
			const bridge = new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
			bridge.start();

			const handler = requestHandlers.get(STATE_CHANNELS.SESSION_SDK_MESSAGES);
			await handler!({ sessionId: 'test-id', since: 100 });

			expect(stateProjection.getSDKMessagesState).toHaveBeenCalledWith('test-id', 100);
		});
	});
});
