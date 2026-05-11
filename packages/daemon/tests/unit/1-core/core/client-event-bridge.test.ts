/**
 * ClientEventBridge Tests
 *
 * Verifies that the bridge:
 * 1. Declaratively maps DaemonHub events to ClientEventGateway deliveries
 * 2. Registers RPC handlers for state snapshots
 * 3. Manages versioned state broadcasts (system, settings, session, SDK messages)
 * 4. Subscribes to InternalEventBus for settings.updated and session.updated
 * 5. Routes migrated space events through InternalEventBus, unmigrated through DaemonHub
 */

import { describe, expect, it, mock } from 'bun:test';
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
import type {
	DaemonInternalEventMap,
	InternalEventBus,
} from '../../../../src/lib/internal-event-bus';

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
		getCachedSessionState: mock(() => null),
	} as unknown as StateProjectionService & ChannelVersionSource;
}

describe('ClientEventBridge', () => {
	function buildFixture() {
		const daemonEventHandlers = new Map<string, Function[]>();
		const daemonUnsubscribers: string[] = [];

		const daemonHub = {
			on: mock((event: string, handler: Function) => {
				const existing = daemonEventHandlers.get(event) || [];
				existing.push(handler);
				daemonEventHandlers.set(event, existing);
				return () => {
					daemonUnsubscribers.push(event);
					const handlers = daemonEventHandlers.get(event);
					if (handlers) {
						const idx = handlers.indexOf(handler);
						if (idx !== -1) handlers.splice(idx, 1);
						if (handlers.length === 0) daemonEventHandlers.delete(event);
					}
				};
			}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		const eventBusSubscribers = new Map<string, Function[]>();

		const internalEventBus = {
			subscribe: mock((event: string, handler: Function) => {
				const existing = eventBusSubscribers.get(event) || [];
				existing.push(handler);
				eventBusSubscribers.set(event, existing);
				return () => {};
			}),
			publish: mock(async () => ({ delivered: 0, failures: [] })),
			publishAsync: mock(() => {}),
		} as unknown as InternalEventBus<DaemonInternalEventMap>;

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
			daemonEventHandlers,
			eventBusSubscribers,
			requestHandlers,
			published,
			daemonUnsubscribers,
			stateProjection,
			internalEventBus,
		};
	}

	describe('start', () => {
		it('should subscribe migrated space events on InternalEventBus and unmigrated on DaemonHub', () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();

			// Migrated events should be on InternalEventBus (not DaemonHub)
			expect(f.eventBusSubscribers.has('space.created')).toBe(true);
			expect(f.eventBusSubscribers.has('space.updated')).toBe(true);
			expect(f.eventBusSubscribers.has('space.archived')).toBe(true);
			expect(f.eventBusSubscribers.has('space.deleted')).toBe(true);
			expect(f.eventBusSubscribers.has('space.task.created')).toBe(true);
			expect(f.eventBusSubscribers.has('space.task.updated')).toBe(true);
			expect(f.eventBusSubscribers.has('space.schedule.updated')).toBe(true);
			expect(f.eventBusSubscribers.has('space.workflowRun.created')).toBe(true);
			expect(f.eventBusSubscribers.has('space.workflowRun.updated')).toBe(true);
			expect(f.eventBusSubscribers.has('space.gateData.updated')).toBe(true);

			// Unmigrated events should remain on DaemonHub
			expect(f.daemonEventHandlers.has('spaceAgent.created')).toBe(true);
			expect(f.daemonEventHandlers.has('spaceAgent.updated')).toBe(true);
			expect(f.daemonEventHandlers.has('spaceAgent.deleted')).toBe(true);
			expect(f.daemonEventHandlers.has('spaceWorkflow.created')).toBe(true);
			expect(f.daemonEventHandlers.has('spaceWorkflow.updated')).toBe(true);
			expect(f.daemonEventHandlers.has('spaceWorkflow.deleted')).toBe(true);
		});

		it('should subscribe to session bridge events on daemonHub', () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();

			expect(f.daemonEventHandlers.has('session.created')).toBe(true);
			expect(f.daemonEventHandlers.has('session.deleted')).toBe(true);
			expect(f.daemonEventHandlers.has('context.updated')).toBe(true);
		});

		it('should subscribe to connection/auth bridge events on daemonHub', () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();

			expect(f.daemonEventHandlers.has('api.connection')).toBe(true);
			expect(f.daemonEventHandlers.has('auth.changed')).toBe(true);
		});

		it('should subscribe to config and error events on daemonHub', () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();

			expect(f.daemonEventHandlers.has('commands.updated')).toBe(true);
			expect(f.daemonEventHandlers.has('session.error')).toBe(true);
			expect(f.daemonEventHandlers.has('session.errorClear')).toBe(true);
		});

		it('should subscribe to settings.updated on InternalEventBus', () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();

			expect(f.eventBusSubscribers.has('settings.updated')).toBe(true);
		});

		it('should subscribe to session.updated on InternalEventBus', () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();

			expect(f.eventBusSubscribers.has('session.updated')).toBe(true);
		});

		it('should register RPC handlers', () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();

			expect(f.requestHandlers.has(STATE_CHANNELS.GLOBAL_SNAPSHOT)).toBe(true);
			expect(f.requestHandlers.has(STATE_CHANNELS.SESSION_SNAPSHOT)).toBe(true);
			expect(f.requestHandlers.has(STATE_CHANNELS.GLOBAL_SYSTEM)).toBe(true);
			expect(f.requestHandlers.has(STATE_CHANNELS.GLOBAL_SESSIONS)).toBe(true);
			expect(f.requestHandlers.has(STATE_CHANNELS.GLOBAL_SETTINGS)).toBe(true);
			expect(f.requestHandlers.has(STATE_CHANNELS.SESSION)).toBe(true);
			expect(f.requestHandlers.has(STATE_CHANNELS.SESSION_SDK_MESSAGES)).toBe(true);
		});

		it('should be idempotent', () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();
			bridge.start();

			// DaemonHub: 6 unmigrated space + 3 session + 2 conn/auth + 1 config + 2 error + 1 context.updated broadcast = 15
			// InternalEventBus: 15 migrated space + 1 settings.updated + 1 session.updated = 17
			// Total daemonHub unique events: 15 (context.updated has 2 handlers)
			expect(f.daemonEventHandlers.size).toBe(15);
			expect(f.eventBusSubscribers.size).toBe(17);
		});
	});

	describe('stop', () => {
		it('should unsubscribe from all daemonHub events', () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();
			bridge.stop();

			expect(f.daemonUnsubscribers.length).toBeGreaterThan(0);
		});
	});

	describe('settings.updated via InternalEventBus', () => {
		it('should trigger broadcastSettingsChange when settings.updated fires on InternalEventBus', async () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const handler = f.eventBusSubscribers.get('settings.updated')![0];
			await handler({ namespaceId: 'global', settings: {} });

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SETTINGS
			);
			expect(f.messageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SETTINGS,
				expect.objectContaining({ version: expect.any(Number) }),
				{ channel: 'global' }
			);
		});
	});

	describe('session.updated via InternalEventBus', () => {
		it('should trigger broadcastSessionStateChange with namespaceId', async () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const handler = f.eventBusSubscribers.get('session.updated')![0];
			await handler({
				namespaceId: 'sess-1',
				processingState: { status: 'processing' },
			});

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION}:sess-1`
			);
		});
	});

	describe('space event forwarding via InternalEventBus', () => {
		it('forwards space.task.updated from InternalEventBus to global channel', async () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const handler = f.eventBusSubscribers.get('space.task.updated')![0];
			handler({
				namespaceId: 'global',
				sessionId: 'global',
				spaceId: 's-1',
				taskId: 't-1',
				task: {
					id: 't-1',
					status: 'in_progress',
				} as DaemonInternalEventMap['space.task.updated']['task'],
			});

			expect(f.published[0].method).toBe('space.task.updated');
			expect(f.published[0].channel).toEqual({ kind: 'global' });
		});
	});

	describe('unmigrated space event forwarding via DaemonHub', () => {
		it('forwards spaceAgent.created to space-scoped channel', () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const data = {
				sessionId: 'space:s-1',
				spaceId: 's-1',
				agent: { id: 'a-1', name: 'Agent 1' },
			};
			f.daemonEventHandlers.get('spaceAgent.created')![0](data);

			expect(f.published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
		});
	});

	describe('session event forwarding', () => {
		it('forwards session.created to global channel with transformed payload', () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const data = {
				sessionId: 'sess-1',
				session: { id: 'sess-1', title: 'Test', status: 'active', metadata: {} },
			};
			f.daemonEventHandlers.get('session.created')![0](data);

			expect(f.published[0].method).toBe('session.created');
			expect(f.published[0].data).toEqual({ sessionId: 'sess-1' });
			expect(f.published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards session.deleted to global channel with transformed payload', () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const data = { sessionId: 'sess-1' };
			f.daemonEventHandlers.get('session.deleted')![0](data);

			expect(f.published[0].method).toBe('session.deleted');
			expect(f.published[0].data).toEqual({ sessionId: 'sess-1' });
			expect(f.published[0].channel).toEqual({ kind: 'global' });
		});

		it('forwards context.updated to session-scoped channel', () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const contextInfo = { files: 5, tokens: 1000 };
			const data = { sessionId: 'sess-1', contextInfo };
			f.daemonEventHandlers.get('context.updated')![0](data);

			expect(f.published[0].method).toBe('context.updated');
			expect(f.published[0].data).toEqual(contextInfo);
			expect(f.published[0].channel).toEqual({ kind: 'session', sessionId: 'sess-1' });
		});
	});

	describe('connection/auth event broadcasts (daemonHub)', () => {
		it('triggers broadcastSystemChange on api.connection', async () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const data = { sessionId: 'global', status: 'disconnected', timestamp: Date.now() };
			await f.daemonEventHandlers.get('api.connection')![0](data);

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(STATE_CHANNELS.GLOBAL_SYSTEM);
		});

		it('triggers broadcastSystemChange on auth.changed', async () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const data = { sessionId: 'global', method: 'api_key', isAuthenticated: true };
			await f.daemonEventHandlers.get('auth.changed')![0](data);

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(STATE_CHANNELS.GLOBAL_SYSTEM);
		});
	});

	describe('config event broadcasts (daemonHub)', () => {
		it('triggers broadcastSessionStateChange on commands.updated', async () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const data = { sessionId: 'sess-1', commands: ['cmd1', 'cmd2'] };
			await f.daemonEventHandlers.get('commands.updated')![0](data);

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION}:sess-1`
			);
		});
	});

	describe('error event broadcasts (daemonHub)', () => {
		it('triggers broadcastSessionStateChange on session.error', async () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const data = { sessionId: 'sess-1', error: 'Something went wrong' };
			await f.daemonEventHandlers.get('session.error')![0](data);

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION}:sess-1`
			);
		});

		it('triggers broadcastSessionStateChange on session.errorClear', async () => {
			const f = buildFixture();
			createClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			).start();

			const data = { sessionId: 'sess-1' };
			await f.daemonEventHandlers.get('session.errorClear')![0](data);

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION}:sess-1`
			);
		});
	});

	describe('broadcast methods', () => {
		it('broadcastSystemChange publishes system state with version', async () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);

			await bridge.broadcastSystemChange();

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(STATE_CHANNELS.GLOBAL_SYSTEM);
			expect(f.messageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SYSTEM,
				expect.objectContaining({ version: expect.any(Number) }),
				{ channel: 'global' }
			);
		});

		it('broadcastSettingsChange publishes settings state with version', async () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);

			await bridge.broadcastSettingsChange();

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SETTINGS
			);
			expect(f.messageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SETTINGS,
				expect.objectContaining({ settings: expect.any(Object), version: expect.any(Number) }),
				{ channel: 'global' }
			);
		});

		it('broadcastSessionStateChange publishes session state with version', async () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);

			await bridge.broadcastSessionStateChange('test-id');

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION}:test-id`
			);
			expect(f.messageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.SESSION,
				expect.objectContaining({
					sessionInfo: expect.any(Object),
					agentState: expect.any(Object),
					version: expect.any(Number),
				}),
				{ channel: 'session:test-id' }
			);
		});

		it('broadcastSessionStateChange skips empty sessionId', async () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);

			await bridge.broadcastSessionStateChange('');

			expect(f.stateProjection.incrementVersion).not.toHaveBeenCalled();
			expect(f.messageHub.event).not.toHaveBeenCalled();
		});

		it('broadcastSessionStateChange uses fallback when getSessionState throws', async () => {
			const f = buildFixture();
			(f.stateProjection.getSessionState as ReturnType<typeof mock>).mockRejectedValue(
				new Error('Session not found')
			);
			(f.stateProjection.getCachedSessionState as ReturnType<typeof mock>).mockReturnValue({
				sessionInfo: { id: 'test-id' },
				agentState: { status: 'idle' },
				commandsData: { availableCommands: [] },
				error: null,
				timestamp: Date.now(),
			});
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);

			await bridge.broadcastSessionStateChange('test-id');

			expect(f.stateProjection.getCachedSessionState).toHaveBeenCalledWith('test-id');
			expect(f.messageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.SESSION,
				expect.objectContaining({
					sessionInfo: { id: 'test-id' },
					version: expect.any(Number),
				}),
				{ channel: 'session:test-id' }
			);
		});

		it('broadcastSDKMessagesChange publishes SDK messages with version', async () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);

			await bridge.broadcastSDKMessagesChange('test-id');

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION_SDK_MESSAGES}:test-id`
			);
		});

		it('broadcastSDKMessagesDelta publishes delta with version', async () => {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);

			await bridge.broadcastSDKMessagesDelta('test-id', {
				added: [{ id: 'msg1' }],
				timestamp: Date.now(),
			});

			expect(f.stateProjection.incrementVersion).toHaveBeenCalledWith(
				`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta:test-id`
			);
		});
	});

	describe('RPC handlers', () => {
		function startBridge() {
			const f = buildFixture();
			const bridge = new ClientEventBridge(
				f.daemonHub,
				f.messageHub,
				f.gateway,
				f.stateProjection,
				f.internalEventBus
			);
			bridge.start();
			return f;
		}

		it('delegates GLOBAL_SNAPSHOT to stateProjection', async () => {
			const f = startBridge();
			await f.requestHandlers.get(STATE_CHANNELS.GLOBAL_SNAPSHOT)!({});
			expect(f.stateProjection.getGlobalSnapshot).toHaveBeenCalled();
		});

		it('delegates SESSION_SNAPSHOT to stateProjection', async () => {
			const f = startBridge();
			await f.requestHandlers.get(STATE_CHANNELS.SESSION_SNAPSHOT)!({ sessionId: 'test-id' });
			expect(f.stateProjection.getSessionSnapshot).toHaveBeenCalledWith('test-id');
		});

		it('delegates GLOBAL_SYSTEM to stateProjection', async () => {
			const f = startBridge();
			await f.requestHandlers.get(STATE_CHANNELS.GLOBAL_SYSTEM)!({});
			expect(f.stateProjection.getSystemState).toHaveBeenCalled();
		});

		it('delegates GLOBAL_SESSIONS to stateProjection', async () => {
			const f = startBridge();
			await f.requestHandlers.get(STATE_CHANNELS.GLOBAL_SESSIONS)!({});
			expect(f.stateProjection.getSessionsState).toHaveBeenCalled();
		});

		it('delegates GLOBAL_SETTINGS to stateProjection', async () => {
			const f = startBridge();
			await f.requestHandlers.get(STATE_CHANNELS.GLOBAL_SETTINGS)!({});
			expect(f.stateProjection.getSettingsState).toHaveBeenCalled();
		});

		it('delegates SESSION to stateProjection', async () => {
			const f = startBridge();
			await f.requestHandlers.get(STATE_CHANNELS.SESSION)!({ sessionId: 'test-id' });
			expect(f.stateProjection.getSessionState).toHaveBeenCalledWith('test-id');
		});

		it('delegates SESSION_SDK_MESSAGES to stateProjection', async () => {
			const f = startBridge();
			await f.requestHandlers.get(STATE_CHANNELS.SESSION_SDK_MESSAGES)!({
				sessionId: 'test-id',
				since: 100,
			});
			expect(f.stateProjection.getSDKMessagesState).toHaveBeenCalledWith('test-id', 100);
		});
	});
});
