/**
 * StateManager Tests
 *
 * Unit tests for server-side state coordination and broadcasting.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { StateManager } from '../../../../src/lib/state-manager';
import type { MessageHub, Session, GlobalSettings, AgentProcessingState } from '@neokai/shared';
import { STATE_CHANNELS, DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';
import type { Database } from '../../../../src/storage/database';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type {
	DaemonInternalEventMap,
	InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { Config } from '../../../../src/config';

describe('StateManager', () => {
	let stateManager: StateManager;
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let mockAuthManager: AuthManager;
	let mockSettingsManager: SettingsManager;
	let mockConfig: Config;
	let mockDaemonHub: DaemonHub;
	let eventHandlers: Map<string, Function>;
	let requestHandlers: Map<string, Function>;

	beforeEach(() => {
		eventHandlers = new Map();
		requestHandlers = new Map();

		// MessageHub mock
		mockMessageHub = {
			event: mock(async () => {}),
			onRequest: mock((method: string, handler: Function) => {
				requestHandlers.set(method, handler);
				return () => {};
			}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		// SessionManager mock
		mockSessionManager = {
			getActiveSessions: mock(() => 2),
			getTotalSessions: mock(() => 5),
			listSessions: mock(() => []),
			getSessionAsync: mock(async () => null),
		} as unknown as SessionManager;

		// AuthManager mock
		mockAuthManager = {
			getAuthStatus: mock(async () => ({
				isAuthenticated: true,
				method: 'api_key' as const,
			})),
		} as unknown as AuthManager;

		// SettingsManager mock
		mockSettingsManager = {
			getGlobalSettings: mock(() => ({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
			})),
		} as unknown as SettingsManager;

		// Config mock
		mockConfig = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxSessions: 10,
			dbPath: '/test/db.sqlite',
		} as unknown as Config;

		// DaemonHub mock
		mockDaemonHub = {
			on: mock((event: string, handler: Function) => {
				eventHandlers.set(event, handler);
				return () => {};
			}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		stateManager = new StateManager(
			mockMessageHub,
			mockSessionManager,
			mockAuthManager,
			mockSettingsManager,
			mockConfig,
			mockDaemonHub
		);
	});

	describe('constructor', () => {
		it('should register RPC handlers on initialization', () => {
			expect(requestHandlers.has(STATE_CHANNELS.GLOBAL_SNAPSHOT)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.SESSION_SNAPSHOT)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.GLOBAL_SYSTEM)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.GLOBAL_SESSIONS)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.GLOBAL_SETTINGS)).toBe(true);
			expect(requestHandlers.has(STATE_CHANNELS.SESSION)).toBe(true);
		});

		it('should register event listeners on initialization', () => {
			expect(eventHandlers.has('session.created')).toBe(true);
			expect(eventHandlers.has('session.updated')).toBe(true);
			expect(eventHandlers.has('session.deleted')).toBe(true);
			// auth.changed forwarding extracted to ClientEventBridge
			expect(eventHandlers.has('auth.changed')).toBe(false);
			expect(eventHandlers.has('settings.updated')).toBe(true);
		});

		it('should NOT register space forwarding handlers (migrated to ClientEventBridge)', () => {
			expect(eventHandlers.has('space.created')).toBe(false);
			expect(eventHandlers.has('space.updated')).toBe(false);
			expect(eventHandlers.has('space.archived')).toBe(false);
			expect(eventHandlers.has('space.deleted')).toBe(false);
			expect(eventHandlers.has('space.task.created')).toBe(false);
			expect(eventHandlers.has('space.task.updated')).toBe(false);
			expect(eventHandlers.has('space.schedule.updated')).toBe(false);
			expect(eventHandlers.has('space.workflowRun.created')).toBe(false);
			expect(eventHandlers.has('space.workflowRun.updated')).toBe(false);
			expect(eventHandlers.has('space.gateData.updated')).toBe(false);
			expect(eventHandlers.has('spaceAgent.created')).toBe(false);
			expect(eventHandlers.has('spaceAgent.updated')).toBe(false);
			expect(eventHandlers.has('spaceAgent.deleted')).toBe(false);
			expect(eventHandlers.has('spaceWorkflow.created')).toBe(false);
			expect(eventHandlers.has('spaceWorkflow.updated')).toBe(false);
			expect(eventHandlers.has('spaceWorkflow.deleted')).toBe(false);
		});
	});

	describe('getGlobalSnapshot', () => {
		it('should return global state snapshot', async () => {
			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SNAPSHOT);
			const result = await handler!({});

			expect(result).toHaveProperty('sessions');
			expect(result).toHaveProperty('system');
			expect(result).toHaveProperty('settings');
			expect(result).toHaveProperty('meta');
			expect(result.meta.channel).toBe('global');
		});
	});

	describe('getSystemState', () => {
		it('should return unified system state', async () => {
			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SYSTEM);
			const result = await handler!({});

			expect(result).toHaveProperty('version');
			expect(result).toHaveProperty('claudeSDKVersion');
			expect(result).toHaveProperty('defaultModel');
			expect(result).toHaveProperty('maxSessions');
			expect(result).toHaveProperty('storageLocation');
			expect(result).toHaveProperty('auth');
			expect(result).toHaveProperty('health');
			expect(result).toHaveProperty('apiConnection');
		});

		it('should include authentication status', async () => {
			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SYSTEM);
			const result = await handler!({});

			expect(result.auth).toEqual({
				isAuthenticated: true,
				method: 'api_key',
			});
		});

		it('should include health information', async () => {
			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SYSTEM);
			const result = await handler!({});

			expect(result.health.status).toBe('ok');
			expect(result.health.sessions).toEqual({
				active: 2,
				total: 5,
			});
		});
	});

	describe('getSessionsState', () => {
		it('should return sessions state', async () => {
			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SESSIONS);
			const result = await handler!({});

			expect(result).toHaveProperty('sessions');
			expect(result).toHaveProperty('hasArchivedSessions');
			expect(result).toHaveProperty('timestamp');
		});

		it('should filter archived sessions when showArchived is false', async () => {
			const allSessions: Session[] = [
				{ id: '1', status: 'active', metadata: {} } as Session,
				{ id: '2', status: 'archived', metadata: {} } as Session,
				{ id: '3', status: 'active', metadata: {} } as Session,
			];
			const activeSessions = allSessions.filter((s) => s.status !== 'archived');

			// Server-side filtering: listSessions() returns different results based on params
			(mockSessionManager.listSessions as ReturnType<typeof mock>).mockImplementation(
				(options?: { includeArchived?: boolean }) => {
					return options?.includeArchived ? allSessions : activeSessions;
				}
			);
			(mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				showArchived: false,
			});

			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SESSIONS);
			const result = await handler!({});

			expect(result.sessions).toHaveLength(2);
			expect(result.sessions.map((s: Session) => s.id)).toEqual(['1', '3']);
		});

		it('should include archived sessions when showArchived is true', async () => {
			const mockSessions: Session[] = [
				{ id: '1', status: 'active', metadata: {} } as Session,
				{ id: '2', status: 'archived', metadata: {} } as Session,
			];
			(mockSessionManager.listSessions as ReturnType<typeof mock>).mockReturnValue(mockSessions);
			(mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				...DEFAULT_GLOBAL_SETTINGS,
				showArchived: true,
			});

			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SESSIONS);
			const result = await handler!({});

			expect(result.sessions).toHaveLength(2);
			expect(result.hasArchivedSessions).toBe(true);
		});

		it('should detect archived sessions presence', async () => {
			const mockSessions: Session[] = [
				{ id: '1', status: 'active', metadata: {} } as Session,
				{ id: '2', status: 'archived', metadata: {} } as Session,
			];
			(mockSessionManager.listSessions as ReturnType<typeof mock>).mockReturnValue(mockSessions);

			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SESSIONS);
			const result = await handler!({});

			expect(result.hasArchivedSessions).toBe(true);
		});
	});

	describe('getSettingsState', () => {
		it('should return settings state', async () => {
			const handler = requestHandlers.get(STATE_CHANNELS.GLOBAL_SETTINGS);
			const result = await handler!({});

			expect(result).toHaveProperty('settings');
			expect(result).toHaveProperty('timestamp');
		});
	});

	describe('getSessionState', () => {
		it('should throw error for non-existent session', async () => {
			const handler = requestHandlers.get(STATE_CHANNELS.SESSION);

			await expect(handler!({ sessionId: 'nonexistent' })).rejects.toThrow('Session not found');
		});

		it('should return session state for existing session', async () => {
			const mockAgentSession = {
				getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
				getProcessingState: mock(() => ({ status: 'idle' })),
				getSlashCommands: mock(async () => []),
				getContextInfo: mock(() => null),
			};
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
				mockAgentSession
			);

			const handler = requestHandlers.get(STATE_CHANNELS.SESSION);
			const result = await handler!({ sessionId: 'test-id' });

			expect(result).toHaveProperty('sessionInfo');
			expect(result).toHaveProperty('agentState');
			expect(result).toHaveProperty('commandsData');
			expect(result).toHaveProperty('error');
			expect(result).toHaveProperty('timestamp');
		});

		it('should prefer processingStateCache over ghost session in-memory state', async () => {
			// Simulate a room leader/worker session where the SessionCache has a "ghost"
			// (an AgentSession loaded from DB) with stale idle state. The live session
			// in RoomRuntimeService has transitioned to waiting_for_input, which was
			// propagated to processingStateCache via session.updated event.
			const pendingQuestion = {
				toolUseId: 'tool-use-123',
				questions: [
					{
						question: 'Which approach?',
						header: 'Architecture',
						options: [{ label: 'Option A', description: 'First option' }],
						multiSelect: false,
					},
				],
				askedAt: Date.now(),
			};

			// Ghost session loaded from DB has stale idle state
			const ghostAgentSession = {
				getSessionData: mock(() => ({ id: 'leader-session-id', title: 'Leader' })),
				getProcessingState: mock(() => ({ status: 'idle' as const })),
				getSlashCommands: mock(async () => []),
				getContextInfo: mock(() => null),
			};
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
				ghostAgentSession
			);

			// Simulate session.updated event from ProcessingStateManager populating the cache
			const updateHandler = eventHandlers.get('session.updated');
			await updateHandler!({
				sessionId: 'leader-session-id',
				processingState: { status: 'waiting_for_input', pendingQuestion },
			});

			// The state.session RPC should return cached waiting_for_input, not ghost's idle
			const handler = requestHandlers.get(STATE_CHANNELS.SESSION);
			const result = await handler!({ sessionId: 'leader-session-id' });

			expect(result.agentState.status).toBe('waiting_for_input');
			expect(result.agentState.pendingQuestion).toEqual(pendingQuestion);
			// Confirm the ghost's getProcessingState was NOT used as the final value
			expect(ghostAgentSession.getProcessingState).toHaveBeenCalledTimes(0);
		});
	});

	describe('getSessionSnapshot', () => {
		it('should return session snapshot', async () => {
			const mockAgentSession = {
				getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
				getProcessingState: mock(() => ({ status: 'idle' })),
				getSlashCommands: mock(async () => []),
				getContextInfo: mock(() => null),
				getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
			};
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
				mockAgentSession
			);

			const handler = requestHandlers.get(STATE_CHANNELS.SESSION_SNAPSHOT);
			const result = await handler!({ sessionId: 'test-id' });

			expect(result).toHaveProperty('session');
			expect(result).toHaveProperty('sdkMessages');
			expect(result).toHaveProperty('meta');
			expect(result.meta.sessionId).toBe('test-id');
		});
	});

	describe('event handlers', () => {
		describe('session.created', () => {
			it('should cache session and initial processing state', async () => {
				const handler = eventHandlers.get('session.created');
				const mockSession: Session = {
					id: 'new-session-id',
					title: 'New Session',
					status: 'active',
					metadata: {},
				} as Session;

				await handler!({ session: mockSession });

				// Forwarding extracted to ClientEventBridge; StateManager only caches
				expect(mockMessageHub.event).not.toHaveBeenCalledWith(
					'session.created',
					expect.anything(),
					expect.anything()
				);
			});
		});

		describe('session.updated', () => {
			it('should update cache and broadcast', async () => {
				// First create a session to cache
				const createHandler = eventHandlers.get('session.created');
				await createHandler!({
					session: { id: 'test-id', title: 'Original', status: 'active', metadata: {} },
				});

				// Now update it
				const updateHandler = eventHandlers.get('session.updated');
				await updateHandler!({
					sessionId: 'test-id',
					session: { title: 'Updated' },
					processingState: { status: 'processing' },
				});

				// Should broadcast session state change
				expect(mockMessageHub.event).toHaveBeenCalled();
			});

			it('should handle update for non-cached session gracefully', async () => {
				const updateHandler = eventHandlers.get('session.updated');

				// Update without creating first (partial data scenario)
				// Should complete without throwing - just log and continue
				let error: Error | null = null;
				try {
					await updateHandler!({
						sessionId: 'nonexistent-id',
						session: { title: 'Partial' },
					});
				} catch (e) {
					error = e as Error;
				}
				// The handler should not throw - it handles errors internally
				expect(error).toBeNull();
			});
		});

		describe('session.deleted', () => {
			it('should clear caches including error cache', async () => {
				// First create a session to cache
				const createHandler = eventHandlers.get('session.created');
				await createHandler!({
					session: { id: 'test-id', title: 'Test', status: 'active', metadata: {} },
				});

				// Now delete it
				const deleteHandler = eventHandlers.get('session.deleted');
				await deleteHandler!({ sessionId: 'test-id' });

				// Forwarding extracted to ClientEventBridge; StateManager only clears caches
				expect(mockMessageHub.event).not.toHaveBeenCalledWith(
					'session.deleted',
					expect.anything(),
					expect.anything()
				);
			});

			it('should clean up channelVersions for deleted session', async () => {
				// Seed channel versions by broadcasting
				const mockAgentSession = {
					getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
					getProcessingState: mock(() => ({ status: 'idle' })),
					getSlashCommands: mock(async () => []),
					getContextInfo: mock(() => null),
					getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
				};
				(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
					mockAgentSession
				);

				// Trigger broadcasts to populate channelVersions
				await stateManager.broadcastSessionStateChange('test-id');
				await stateManager.broadcastSDKMessagesChange('test-id');
				await stateManager.broadcastSDKMessagesDelta('test-id', {
					added: [{ id: 'msg1' }],
					timestamp: Date.now(),
				});

				// Verify versions exist before deletion by checking messageHub was called
				// (which means versions were incremented and used)
				const callsBefore = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls.length;
				expect(callsBefore).toBeGreaterThan(0);

				// Delete the session
				const deleteHandler = eventHandlers.get('session.deleted');
				await deleteHandler!({ sessionId: 'test-id' });

				// After deletion, versions for that session should be gone.
				// Verify by broadcasting again for the same sessionId — if cleanup
				// worked, the version counter restarts from 1.
				(mockMessageHub.event as ReturnType<typeof mock>).mockClear();
				await stateManager.broadcastSessionStateChange('test-id');

				const sessionCall = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls.find(
					(c: unknown[]) => c[0] === STATE_CHANNELS.SESSION
				);
				expect(sessionCall).toBeDefined();
				expect((sessionCall![1] as { version: number }).version).toBe(1);
			});
		});

		describe('auth.changed', () => {
			it('handler removed — forwarding fully extracted to ClientEventBridge', () => {
				// StateManager no longer registers an auth.changed handler;
				// ClientEventBridge subscribes to auth.changed and triggers
				// broadcastSystemChange via the StateBroadcasts interface.
				expect(eventHandlers.has('auth.changed')).toBe(false);
			});
		});

		describe('settings.updated', () => {
			it('should broadcast settings change via DaemonHub fallback', async () => {
				const handler = eventHandlers.get('settings.updated');
				await handler!();

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.GLOBAL_SETTINGS,
					expect.objectContaining({
						settings: expect.any(Object),
					}),
					{ channel: 'global' }
				);
			});

			it('should broadcast settings change via InternalEventBus', async () => {
				const internalSubscribers = new Map<string, Function>();
				const mockInternalEventBus = {
					subscribe: mock((event: string, handler: Function) => {
						internalSubscribers.set(event, handler);
						return () => {};
					}),
				} as unknown as InternalEventBus<DaemonInternalEventMap>;

				const sm = new StateManager(
					mockMessageHub,
					mockSessionManager,
					mockAuthManager,
					mockSettingsManager,
					mockConfig,
					mockDaemonHub,
					undefined,
					mockInternalEventBus
				);

				// Verify internalEventBus.subscribe was called for settings.updated
				expect(internalSubscribers.has('settings.updated')).toBe(true);

				const handler = internalSubscribers.get('settings.updated');
				await handler!();

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.GLOBAL_SETTINGS,
					expect.objectContaining({
						settings: expect.any(Object),
					}),
					{ channel: 'global' }
				);
			});
		});

		describe('commands.updated', () => {
			it('should cache commands only (broadcast extracted to ClientEventBridge)', async () => {
				(mockMessageHub.event as ReturnType<typeof mock>).mockClear();

				const handler = eventHandlers.get('commands.updated');
				await handler!({ sessionId: 'test-id', commands: ['cmd1', 'cmd2'] });

				// Forwarding extracted to ClientEventBridge; StateManager only caches
				const calls = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls;
				const sessionCall = calls.find((call: unknown[]) => call[0] === STATE_CHANNELS.SESSION);
				expect(sessionCall).toBeUndefined();
			});
		});

		describe('context.updated', () => {
			it('handler removed — forwarding fully extracted to ClientEventBridge', () => {
				// StateManager no longer registers a context.updated handler;
				// ClientEventBridge subscribes to context.updated and forwards
				// through ClientEventGateway directly.
				expect(eventHandlers.has('context.updated')).toBe(false);
			});
		});

		describe('session.error', () => {
			it('should cache error only (broadcast extracted to ClientEventBridge)', async () => {
				(mockMessageHub.event as ReturnType<typeof mock>).mockClear();

				const handler = eventHandlers.get('session.error');
				await handler!({
					sessionId: 'test-id',
					error: 'Something went wrong',
					details: { code: 'ERR_001' },
				});

				// Forwarding extracted to ClientEventBridge; StateManager only caches
				const calls = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls;
				const sessionCall = calls.find((call: unknown[]) => call[0] === STATE_CHANNELS.SESSION);
				expect(sessionCall).toBeUndefined();
			});
		});

		describe('session.errorClear', () => {
			it('should clear error only (broadcast extracted to ClientEventBridge)', async () => {
				(mockMessageHub.event as ReturnType<typeof mock>).mockClear();

				const clearHandler = eventHandlers.get('session.errorClear');
				await clearHandler!({ sessionId: 'test-id' });

				// Forwarding extracted to ClientEventBridge; StateManager only clears cache
				const calls = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls;
				const sessionCall = calls.find((call: unknown[]) => call[0] === STATE_CHANNELS.SESSION);
				expect(sessionCall).toBeUndefined();
			});
		});

		describe('api.connection', () => {
			it('should update API connection state only (broadcast extracted to ClientEventBridge)', async () => {
				(mockMessageHub.event as ReturnType<typeof mock>).mockClear();

				const handler = eventHandlers.get('api.connection');
				const connectionData = {
					status: 'disconnected' as const,
					retryCount: 3,
					timestamp: Date.now(),
				};

				handler!(connectionData);

				// Give any async work time to complete
				await new Promise((resolve) => setTimeout(resolve, 10));

				// Forwarding extracted to ClientEventBridge; StateManager only updates cache
				const calls = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls;
				const systemCall = calls.find(
					(call: unknown[]) => call[0] === STATE_CHANNELS.GLOBAL_SYSTEM
				);
				expect(systemCall).toBeUndefined();
			});
		});
	});

	describe('broadcastSystemChange', () => {
		it('should broadcast system state', async () => {
			await stateManager.broadcastSystemChange();

			// Check that event was called with the right channel and structure
			const calls = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls;
			const systemCall = calls.find((call: unknown[]) => call[0] === STATE_CHANNELS.GLOBAL_SYSTEM);

			expect(systemCall).toBeDefined();
			expect(systemCall[1]).toHaveProperty('version');
			expect(systemCall[1]).toHaveProperty('auth');
			expect(systemCall[1]).toHaveProperty('health');
			expect(systemCall[1]).toHaveProperty('apiConnection');
			expect(systemCall[2]).toEqual({ channel: 'global' });
		});
	});

	describe('broadcastSettingsChange', () => {
		it('should broadcast settings state', async () => {
			await stateManager.broadcastSettingsChange();

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SETTINGS,
				expect.objectContaining({
					settings: expect.any(Object),
				}),
				{ channel: 'global' }
			);
		});
	});

	describe('broadcastSessionStateChange', () => {
		it('should broadcast session state for existing session', async () => {
			const mockAgentSession = {
				getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
				getProcessingState: mock(() => ({ status: 'idle' })),
				getSlashCommands: mock(async () => []),
				getContextInfo: mock(() => null),
			};
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
				mockAgentSession
			);

			await stateManager.broadcastSessionStateChange('test-id');

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.SESSION,
				expect.objectContaining({
					sessionInfo: expect.any(Object),
					agentState: expect.any(Object),
				}),
				{ channel: 'session:test-id' }
			);
		});

		it('should handle non-existent session gracefully', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			// Should complete without throwing
			await stateManager.broadcastSessionStateChange('nonexistent');
			// If we get here, the test passes
			expect(true).toBe(true);
		});
	});

	describe('broadcastSDKMessagesChange', () => {
		it('should broadcast SDK messages state', async () => {
			const mockAgentSession = {
				getSDKMessages: mock(() => ({ messages: [{ id: 'msg1' }], hasMore: false })),
			};
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
				mockAgentSession
			);

			await stateManager.broadcastSDKMessagesChange('test-id');

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.SESSION_SDK_MESSAGES,
				expect.objectContaining({
					sdkMessages: expect.any(Array),
					hasMore: false,
				}),
				{ channel: 'session:test-id' }
			);
		});
	});

	describe('broadcastSDKMessagesDelta', () => {
		it('should broadcast SDK messages delta', async () => {
			await stateManager.broadcastSDKMessagesDelta('test-id', {
				added: [{ id: 'msg1' }],
				timestamp: Date.now(),
			});

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.SESSION_SDK_MESSAGES + '.delta',
				expect.objectContaining({
					added: [{ id: 'msg1' }],
					version: expect.any(Number),
				}),
				{ channel: 'session:test-id' }
			);
		});
	});

	describe('version tracking', () => {
		it('should increment version on each broadcast', async () => {
			// First broadcast
			await stateManager.broadcastSystemChange();
			const firstCall = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls[0];
			const firstVersion = firstCall[1].version;

			// Second broadcast
			await stateManager.broadcastSystemChange();
			const secondCall = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls[1];
			const secondVersion = secondCall[1].version;

			expect(secondVersion).toBeGreaterThan(firstVersion);
		});

		it('should track versions per channel independently', async () => {
			await stateManager.broadcastSystemChange();
			await stateManager.broadcastSettingsChange();

			const calls = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls;

			// Each channel should have its own version starting at 1
			expect(calls[0][1].version).toBe(1);
			expect(calls[1][1].version).toBe(1);
		});
	});
});

describe('ClientEventGateway DI seam', () => {
	// ====================================================================
	// ClientEventGateway DI seam — verifies that callers can inject a custom
	// gateway into StateManager and that the gateway is exposed via
	// getClientEventGateway() for sharing with ClientEventBridge.
	//
	// Forwarding of session.created / session.deleted / context.updated now
	// lives in ClientEventBridge (see client-event-bridge.test.ts).  These
	// tests guard the injection seam itself against silent regressions.
	// ====================================================================

	it('exposes the injected gateway via getClientEventGateway', () => {
		const localMessageHub = {
			event: mock(async () => {}),
			onRequest: mock(() => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		const localEventBus = {
			on: mock(() => () => {}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		const publish = mock(() => {});
		const publishGlobal = mock(() => {});
		const injectedGateway = { publish, publishGlobal };

		const localSessionManager = {
			getActiveSessions: mock(() => 2),
			getTotalSessions: mock(() => 5),
			listSessions: mock(() => []),
			getSessionAsync: mock(async () => null),
		} as unknown as SessionManager;

		const localAuthManager = {
			getAuthStatus: mock(async () => ({
				isAuthenticated: true,
				method: 'api_key' as const,
			})),
		} as unknown as AuthManager;

		const localSettingsManager = {
			getGlobalSettings: mock(() => DEFAULT_GLOBAL_SETTINGS),
		} as unknown as SettingsManager;

		const localConfig = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxSessions: 10,
			dbPath: '/test/db.sqlite',
		} as unknown as Config;

		const sm = new StateManager(
			localMessageHub,
			localSessionManager,
			localAuthManager,
			localSettingsManager,
			localConfig,
			localEventBus,
			undefined,
			undefined,
			injectedGateway
		);

		const gateway = sm.getClientEventGateway();
		expect(gateway).toBe(injectedGateway);
	});

	it('falls back to a default ClientEventGateway when none is injected', async () => {
		const localMessageHub = {
			event: mock(async () => {}),
			onRequest: mock(() => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		const localEventBus = {
			on: mock((event: string, handler: Function) => {
				return () => {};
			}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		const localSessionManager = {
			getActiveSessions: mock(() => 2),
			getTotalSessions: mock(() => 5),
			listSessions: mock(() => []),
			getSessionAsync: mock(async () => null),
		} as unknown as SessionManager;

		const localAuthManager = {
			getAuthStatus: mock(async () => ({
				isAuthenticated: true,
				method: 'api_key' as const,
			})),
		} as unknown as AuthManager;

		const localSettingsManager = {
			getGlobalSettings: mock(() => DEFAULT_GLOBAL_SETTINGS),
		} as unknown as SettingsManager;

		const localConfig = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxSessions: 10,
			dbPath: '/test/db.sqlite',
		} as unknown as Config;

		const sm = new StateManager(
			localMessageHub,
			localSessionManager,
			localAuthManager,
			localSettingsManager,
			localConfig,
			localEventBus
		);

		// The gateway should exist and be a real ClientEventGateway (not undefined)
		const gateway = sm.getClientEventGateway();
		expect(gateway).toBeDefined();
		expect(gateway.publish).toBeDefined();
		expect(gateway.publishGlobal).toBeDefined();
	});
});
