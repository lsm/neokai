/**
 * StateManager Tests
 *
 * Unit tests for server-side state coordination and broadcasting.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { StateManager } from '../../../src/lib/state-manager';
import type { MessageHub, Session, GlobalSettings, AgentProcessingState } from '@neokai/shared';
import { STATE_CHANNELS, DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { SessionManager } from '../../../src/lib/session-manager';
import type { AuthManager } from '../../../src/lib/auth-manager';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import type { AgentSession } from '../../../src/lib/agent/agent-session';
import type { Config } from '../../../src/config';

describe('StateManager', () => {
	let stateManager: StateManager;
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let mockAuthManager: AuthManager;
	let mockSettingsManager: SettingsManager;
	let mockConfig: Config;
	let mockEventBus: DaemonHub;
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

		// EventBus mock
		mockEventBus = {
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
			mockEventBus
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
			expect(eventHandlers.has('auth.changed')).toBe(true);
			expect(eventHandlers.has('settings.updated')).toBe(true);
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
			const mockSessions: Session[] = [
				{ id: '1', status: 'active', metadata: {} } as Session,
				{ id: '2', status: 'archived', metadata: {} } as Session,
				{ id: '3', status: 'active', metadata: {} } as Session,
			];
			(mockSessionManager.listSessions as ReturnType<typeof mock>).mockReturnValue(mockSessions);
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
			expect(result).toHaveProperty('contextInfo');
			expect(result).toHaveProperty('error');
			expect(result).toHaveProperty('timestamp');
		});
	});

	describe('getSessionSnapshot', () => {
		it('should return session snapshot', async () => {
			const mockAgentSession = {
				getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
				getProcessingState: mock(() => ({ status: 'idle' })),
				getSlashCommands: mock(async () => []),
				getContextInfo: mock(() => null),
				getSDKMessages: mock(() => []),
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
			it('should cache session and broadcast delta', async () => {
				const handler = eventHandlers.get('session.created');
				const mockSession: Session = {
					id: 'new-session-id',
					title: 'New Session',
					status: 'active',
					metadata: {},
				} as Session;

				await handler!({ session: mockSession });

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.GLOBAL_SESSIONS + '.delta',
					expect.objectContaining({
						added: [mockSession],
						timestamp: expect.any(Number),
					}),
					{ channel: 'global' }
				);

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					'session.created',
					{ sessionId: 'new-session-id' },
					{ channel: 'global' }
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
			it('should clear caches and broadcast', async () => {
				// First create a session to cache
				const createHandler = eventHandlers.get('session.created');
				await createHandler!({
					session: { id: 'test-id', title: 'Test', status: 'active', metadata: {} },
				});

				// Now delete it
				const deleteHandler = eventHandlers.get('session.deleted');
				await deleteHandler!({ sessionId: 'test-id' });

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.GLOBAL_SESSIONS + '.delta',
					expect.objectContaining({
						removed: ['test-id'],
					}),
					{ channel: 'global' }
				);

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					'session.deleted',
					{ sessionId: 'test-id' },
					{ channel: 'global' }
				);
			});
		});

		describe('auth.changed', () => {
			it('should broadcast system state change', async () => {
				const handler = eventHandlers.get('auth.changed');
				await handler!();

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.GLOBAL_SYSTEM,
					expect.objectContaining({
						auth: expect.any(Object),
					}),
					{ channel: 'global' }
				);
			});
		});

		describe('settings.updated', () => {
			it('should broadcast settings change', async () => {
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
		});

		describe('sessions.filterChanged', () => {
			it('should broadcast sessions change', async () => {
				const handler = eventHandlers.get('sessions.filterChanged');
				await handler!();

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.GLOBAL_SESSIONS,
					expect.any(Object),
					{ channel: 'global' }
				);
			});
		});

		describe('commands.updated', () => {
			it('should cache commands and broadcast', async () => {
				const mockAgentSession = {
					getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
					getProcessingState: mock(() => ({ status: 'idle' })),
					getSlashCommands: mock(async () => ['cmd1', 'cmd2']),
					getContextInfo: mock(() => null),
				};
				(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
					mockAgentSession
				);

				const handler = eventHandlers.get('commands.updated');
				await handler!({ sessionId: 'test-id', commands: ['cmd1', 'cmd2'] });

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.SESSION,
					expect.any(Object),
					{ channel: 'session:test-id' }
				);
			});
		});

		describe('context.updated', () => {
			it('should cache context and broadcast', async () => {
				const mockAgentSession = {
					getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
					getProcessingState: mock(() => ({ status: 'idle' })),
					getSlashCommands: mock(async () => []),
					getContextInfo: mock(() => null),
				};
				(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
					mockAgentSession
				);

				const handler = eventHandlers.get('context.updated');
				const contextInfo = { files: 5, tokens: 1000 };
				await handler!({ sessionId: 'test-id', contextInfo });

				expect(mockMessageHub.event).toHaveBeenCalledWith('context.updated', contextInfo, {
					channel: 'session:test-id',
				});
			});
		});

		describe('session.error', () => {
			it('should cache error and broadcast', async () => {
				const mockAgentSession = {
					getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
					getProcessingState: mock(() => ({ status: 'idle' })),
					getSlashCommands: mock(async () => []),
					getContextInfo: mock(() => null),
				};
				(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
					mockAgentSession
				);

				const handler = eventHandlers.get('session.error');
				await handler!({
					sessionId: 'test-id',
					error: 'Something went wrong',
					details: { code: 'ERR_001' },
				});

				expect(mockMessageHub.event).toHaveBeenCalledWith(
					STATE_CHANNELS.SESSION,
					expect.objectContaining({
						error: expect.objectContaining({
							message: 'Something went wrong',
							details: { code: 'ERR_001' },
						}),
					}),
					{ channel: 'session:test-id' }
				);
			});
		});

		describe('session.errorClear', () => {
			it('should clear error and broadcast', async () => {
				const mockAgentSession = {
					getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
					getProcessingState: mock(() => ({ status: 'idle' })),
					getSlashCommands: mock(async () => []),
					getContextInfo: mock(() => null),
				};
				(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
					mockAgentSession
				);

				// First set an error
				const errorHandler = eventHandlers.get('session.error');
				await errorHandler!({
					sessionId: 'test-id',
					error: 'Error',
				});

				// Now clear it
				const clearHandler = eventHandlers.get('session.errorClear');
				await clearHandler!({ sessionId: 'test-id' });

				// Should have been called multiple times (set error + clear error)
				expect(mockMessageHub.event).toHaveBeenCalled();
			});
		});

		describe('api.connection', () => {
			it('should update API connection state and broadcast', async () => {
				// Reset mock to track new calls
				(mockMessageHub.event as ReturnType<typeof mock>).mockClear();

				const handler = eventHandlers.get('api.connection');
				const connectionData = {
					status: 'disconnected' as const,
					retryCount: 3,
					timestamp: Date.now(),
				};

				// The api.connection handler calls broadcastSystemChange with .catch(),
				// so we need to call it and wait for the async broadcast to complete
				handler!(connectionData);

				// Wait for the async broadcast to complete
				await new Promise((resolve) => setTimeout(resolve, 10));

				// Check that the broadcast was made with the updated API connection state
				const calls = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls;
				const systemCall = calls.find(
					(call: unknown[]) => call[0] === STATE_CHANNELS.GLOBAL_SYSTEM
				);

				expect(systemCall).toBeDefined();
				expect(systemCall[1].apiConnection).toEqual(connectionData);
			});
		});
	});

	describe('broadcastSessionsChange', () => {
		it('should broadcast full sessions state', async () => {
			await stateManager.broadcastSessionsChange();

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SESSIONS,
				expect.objectContaining({
					sessions: expect.any(Array),
					version: expect.any(Number),
				}),
				{ channel: 'global' }
			);
		});

		it('should accept optional sessions parameter', async () => {
			const customSessions: Session[] = [{ id: '1', status: 'active', metadata: {} } as Session];

			await stateManager.broadcastSessionsChange(customSessions);

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SESSIONS,
				expect.objectContaining({
					sessions: customSessions,
				}),
				{ channel: 'global' }
			);
		});
	});

	describe('broadcastSessionsDelta', () => {
		it('should broadcast sessions delta', async () => {
			const mockSession = { id: '1', status: 'active', metadata: {} } as Session;

			await stateManager.broadcastSessionsDelta({
				added: [mockSession],
				timestamp: Date.now(),
			});

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SESSIONS + '.delta',
				expect.objectContaining({
					added: [mockSession],
					version: expect.any(Number),
				}),
				{ channel: 'global' }
			);
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
				getSDKMessages: mock(() => [{ id: 'msg1' }]),
			};
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
				mockAgentSession
			);

			await stateManager.broadcastSDKMessagesChange('test-id');

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				STATE_CHANNELS.SESSION_SDK_MESSAGES,
				expect.objectContaining({
					sdkMessages: expect.any(Array),
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
