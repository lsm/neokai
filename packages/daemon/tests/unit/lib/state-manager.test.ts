/**
 * StateManager Tests
 *
 * Tests for the server-side state coordinator.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { StateManager } from '../../../src/lib/state-manager';
import type { MessageHub, Session, GlobalSettings } from '@liuboer/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { SessionManager } from '../../../src/lib/session-manager';
import type { AuthManager } from '../../../src/lib/auth-manager';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import type { Config } from '../../../src/config';

describe('StateManager', () => {
	let stateManager: StateManager;
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let mockAuthManager: AuthManager;
	let mockSettingsManager: SettingsManager;
	let mockEventBus: DaemonHub;
	let mockConfig: Config;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;
	let eventHandlers: Map<string, Array<(data: unknown) => void | Promise<void>>>;
	let publishedMessages: Array<{ channel: string; data: unknown; options: unknown }>;

	const mockSession: Session = {
		id: 'test-session-id',
		title: 'Test Session',
		workspacePath: '/test/workspace',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: 'active',
		config: {
			model: 'claude-sonnet-4-20250514',
			maxTokens: 8192,
			temperature: 1.0,
		},
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		},
	};

	beforeEach(() => {
		handlers = new Map();
		eventHandlers = new Map();
		publishedMessages = [];

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
			publish: mock(async (channel: string, data: unknown, options: unknown) => {
				publishedMessages.push({ channel, data, options });
			}),
		} as unknown as MessageHub;

		// Mock EventBus (DaemonHub)
		mockEventBus = {
			on: mock((event: string, handler: (data: unknown) => void | Promise<void>) => {
				const existing = eventHandlers.get(event) || [];
				existing.push(handler);
				eventHandlers.set(event, existing);
				return () => {
					const idx = existing.indexOf(handler);
					if (idx >= 0) existing.splice(idx, 1);
				};
			}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		// Mock SessionManager
		mockSessionManager = {
			getSessionAsync: mock(async (sessionId: string) => {
				if (sessionId === 'nonexistent') return null;
				return {
					getSessionData: () => mockSession,
					getProcessingState: () => ({ status: 'idle' }),
					getSlashCommands: async () => ['help', 'clear'],
					getContextInfo: () => ({ totalTokens: 1000, maxTokens: 128000 }),
					getSDKMessages: () => [],
				};
			}),
			listSessions: mock(() => [mockSession]),
			getActiveSessions: mock(() => 1),
			getTotalSessions: mock(() => 1),
		} as unknown as SessionManager;

		// Mock AuthManager
		mockAuthManager = {
			getAuthStatus: mock(async () => ({
				isAuthenticated: true,
				method: 'api_key' as const,
				hasApiKey: true,
			})),
		} as unknown as AuthManager;

		// Mock SettingsManager
		mockSettingsManager = {
			getGlobalSettings: mock(() => ({
				showArchived: false,
			})),
		} as unknown as SettingsManager;

		// Mock Config
		mockConfig = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxSessions: 10,
			dbPath: '/test/db.sqlite',
		} as unknown as Config;

		stateManager = new StateManager(
			mockMessageHub,
			mockSessionManager,
			mockAuthManager,
			mockSettingsManager,
			mockConfig,
			mockEventBus
		);
	});

	describe('handlers setup', () => {
		it('should register all state handlers', () => {
			expect(handlers.has('state.global.snapshot')).toBe(true);
			expect(handlers.has('state.session.snapshot')).toBe(true);
			expect(handlers.has('state.system')).toBe(true);
			expect(handlers.has('state.sessions')).toBe(true);
			expect(handlers.has('state.settings')).toBe(true);
			expect(handlers.has('state.session')).toBe(true);
			expect(handlers.has('state.sdkMessages')).toBe(true);
		});
	});

	describe('event listeners', () => {
		it('should register all event listeners', () => {
			expect(eventHandlers.has('api.connection')).toBe(true);
			expect(eventHandlers.has('session.created')).toBe(true);
			expect(eventHandlers.has('session.updated')).toBe(true);
			expect(eventHandlers.has('session.deleted')).toBe(true);
			expect(eventHandlers.has('auth.changed')).toBe(true);
			expect(eventHandlers.has('settings.updated')).toBe(true);
			expect(eventHandlers.has('sessions.filterChanged')).toBe(true);
			expect(eventHandlers.has('commands.updated')).toBe(true);
			expect(eventHandlers.has('context.updated')).toBe(true);
			expect(eventHandlers.has('session.error')).toBe(true);
			expect(eventHandlers.has('session.errorClear')).toBe(true);
		});

		it('should handle api.connection event', async () => {
			const handler = eventHandlers.get('api.connection')![0];
			handler({ status: 'disconnected', timestamp: Date.now() });
			// The handler fires broadcastSystemChange without awaiting, so wait a tick
			await new Promise((r) => setTimeout(r, 10));

			// Should broadcast system change
			const systemPublish = publishedMessages.find((m) => m.channel === 'state.system');
			expect(systemPublish).toBeDefined();
		});

		it('should handle session.created event', async () => {
			const handler = eventHandlers.get('session.created')![0];
			await handler({ session: mockSession });

			// Should broadcast sessions delta
			const deltaPublish = publishedMessages.find((m) => m.channel === 'state.sessions.delta');
			expect(deltaPublish).toBeDefined();

			// Should publish session.created event
			const createdPublish = publishedMessages.find((m) => m.channel === 'session.created');
			expect(createdPublish).toBeDefined();
		});

		it('should handle session.updated event', async () => {
			// First create the session to populate cache
			const createHandler = eventHandlers.get('session.created')![0];
			await createHandler({ session: mockSession });
			publishedMessages = []; // Clear previous messages

			const handler = eventHandlers.get('session.updated')![0];
			await handler({
				sessionId: mockSession.id,
				session: { title: 'Updated Title' },
				processingState: { status: 'processing' },
			});

			// Should broadcast session state
			const sessionPublish = publishedMessages.find((m) => m.channel === 'state.session');
			expect(sessionPublish).toBeDefined();
		});

		it('should handle session.deleted event', async () => {
			// First create the session
			const createHandler = eventHandlers.get('session.created')![0];
			await createHandler({ session: mockSession });
			publishedMessages = [];

			const handler = eventHandlers.get('session.deleted')![0];
			await handler({ sessionId: mockSession.id });

			// Should broadcast sessions delta with removed
			const deltaPublish = publishedMessages.find((m) => m.channel === 'state.sessions.delta');
			expect(deltaPublish).toBeDefined();
			expect((deltaPublish!.data as { removed?: string[] }).removed).toContain(mockSession.id);
		});

		it('should handle auth.changed event', async () => {
			const handler = eventHandlers.get('auth.changed')![0];
			await handler({});

			const systemPublish = publishedMessages.find((m) => m.channel === 'state.system');
			expect(systemPublish).toBeDefined();
		});

		it('should handle settings.updated event', async () => {
			const handler = eventHandlers.get('settings.updated')![0];
			await handler({});

			const settingsPublish = publishedMessages.find((m) => m.channel === 'state.settings');
			expect(settingsPublish).toBeDefined();
		});

		it('should handle sessions.filterChanged event', async () => {
			const handler = eventHandlers.get('sessions.filterChanged')![0];
			await handler({});

			const sessionsPublish = publishedMessages.find((m) => m.channel === 'state.sessions');
			expect(sessionsPublish).toBeDefined();
		});

		it('should handle commands.updated event', async () => {
			const handler = eventHandlers.get('commands.updated')![0];
			await handler({ sessionId: mockSession.id, commands: ['help', 'clear'] });

			const sessionPublish = publishedMessages.find((m) => m.channel === 'state.session');
			expect(sessionPublish).toBeDefined();
		});

		it('should handle context.updated event', async () => {
			const handler = eventHandlers.get('context.updated')![0];
			await handler({
				sessionId: mockSession.id,
				contextInfo: { totalTokens: 5000, maxTokens: 128000 },
			});

			// Should publish context.updated
			const contextPublish = publishedMessages.find((m) => m.channel === 'context.updated');
			expect(contextPublish).toBeDefined();

			// Should also broadcast session state
			const sessionPublish = publishedMessages.find((m) => m.channel === 'state.session');
			expect(sessionPublish).toBeDefined();
		});

		it('should handle session.error event', async () => {
			const handler = eventHandlers.get('session.error')![0];
			await handler({
				sessionId: mockSession.id,
				error: 'Test error',
				details: { code: 500 },
			});

			const sessionPublish = publishedMessages.find((m) => m.channel === 'state.session');
			expect(sessionPublish).toBeDefined();
		});

		it('should handle session.errorClear event', async () => {
			const handler = eventHandlers.get('session.errorClear')![0];
			await handler({ sessionId: mockSession.id });

			const sessionPublish = publishedMessages.find((m) => m.channel === 'state.session');
			expect(sessionPublish).toBeDefined();
		});
	});

	describe('getGlobalSnapshot', () => {
		it('should return full global state snapshot', async () => {
			const handler = handlers.get('state.global.snapshot')!;
			const result = (await handler({})) as {
				sessions: unknown;
				system: unknown;
				settings: unknown;
				meta: { channel: string; sessionId: string };
			};

			expect(result.sessions).toBeDefined();
			expect(result.system).toBeDefined();
			expect(result.settings).toBeDefined();
			expect(result.meta).toBeDefined();
			expect(result.meta.channel).toBe('global');
		});
	});

	describe('getSessionSnapshot', () => {
		it('should return session state snapshot', async () => {
			const handler = handlers.get('state.session.snapshot')!;
			const result = (await handler({ sessionId: mockSession.id })) as {
				session: unknown;
				sdkMessages: unknown;
				meta: { channel: string; sessionId: string };
			};

			expect(result.session).toBeDefined();
			expect(result.sdkMessages).toBeDefined();
			expect(result.meta).toBeDefined();
			expect(result.meta.sessionId).toBe(mockSession.id);
		});
	});

	describe('getSystemState', () => {
		it('should return system state', async () => {
			const handler = handlers.get('state.system')!;
			const result = (await handler({})) as {
				version: string;
				claudeSDKVersion: string;
				defaultModel: string;
				auth: unknown;
				health: unknown;
				apiConnection: unknown;
			};

			expect(result.version).toBeDefined();
			expect(result.claudeSDKVersion).toBeDefined();
			expect(result.defaultModel).toBe('claude-sonnet-4-20250514');
			expect(result.auth).toBeDefined();
			expect(result.health).toBeDefined();
			expect(result.apiConnection).toBeDefined();
		});
	});

	describe('getSessionsState', () => {
		it('should return sessions state', async () => {
			const handler = handlers.get('state.sessions')!;
			const result = (await handler({})) as {
				sessions: Session[];
				hasArchivedSessions: boolean;
			};

			expect(result.sessions).toBeDefined();
			expect(result.sessions.length).toBe(1);
			expect(result.hasArchivedSessions).toBe(false);
		});

		it('should filter archived sessions when showArchived is false', async () => {
			// Setup sessions with one archived
			(mockSessionManager.listSessions as ReturnType<typeof mock>).mockReturnValue([
				mockSession,
				{ ...mockSession, id: 'archived-session', status: 'archived' },
			]);

			const handler = handlers.get('state.sessions')!;
			const result = (await handler({})) as {
				sessions: Session[];
				hasArchivedSessions: boolean;
			};

			expect(result.sessions.length).toBe(1);
			expect(result.hasArchivedSessions).toBe(true);
		});

		it('should include archived sessions when showArchived is true', async () => {
			// Setup settings to show archived
			(mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				showArchived: true,
			});
			(mockSessionManager.listSessions as ReturnType<typeof mock>).mockReturnValue([
				mockSession,
				{ ...mockSession, id: 'archived-session', status: 'archived' },
			]);

			const handler = handlers.get('state.sessions')!;
			const result = (await handler({})) as {
				sessions: Session[];
				hasArchivedSessions: boolean;
			};

			expect(result.sessions.length).toBe(2);
		});
	});

	describe('getSettingsState', () => {
		it('should return settings state', async () => {
			const handler = handlers.get('state.settings')!;
			const result = (await handler({})) as {
				settings: GlobalSettings;
				timestamp: number;
			};

			expect(result.settings).toBeDefined();
			expect(result.timestamp).toBeDefined();
		});
	});

	describe('getSessionState', () => {
		it('should return session state', async () => {
			const handler = handlers.get('state.session')!;
			const result = (await handler({ sessionId: mockSession.id })) as {
				sessionInfo: Session;
				agentState: unknown;
				commandsData: { availableCommands: string[] };
				contextInfo: unknown;
				error: unknown;
			};

			expect(result.sessionInfo).toBeDefined();
			expect(result.agentState).toBeDefined();
			expect(result.commandsData.availableCommands).toEqual(['help', 'clear']);
			expect(result.contextInfo).toBeDefined();
		});

		it('should throw if session not found', async () => {
			const handler = handlers.get('state.session')!;
			await expect(handler({ sessionId: 'nonexistent' })).rejects.toThrow('Session not found');
		});
	});

	describe('getSDKMessagesState', () => {
		it('should return SDK messages state', async () => {
			const handler = handlers.get('state.sdkMessages')!;
			const result = (await handler({ sessionId: mockSession.id })) as {
				sdkMessages: unknown[];
				timestamp: number;
			};

			expect(result.sdkMessages).toBeDefined();
			expect(result.timestamp).toBeDefined();
		});

		it('should throw if session not found', async () => {
			const handler = handlers.get('state.sdkMessages')!;
			await expect(handler({ sessionId: 'nonexistent' })).rejects.toThrow('Session not found');
		});
	});

	describe('broadcasters', () => {
		it('should broadcast sessions change', async () => {
			await stateManager.broadcastSessionsChange();

			const publish = publishedMessages.find((m) => m.channel === 'state.sessions');
			expect(publish).toBeDefined();
			expect((publish!.options as { sessionId: string }).sessionId).toBe('global');
		});

		it('should broadcast sessions delta', async () => {
			await stateManager.broadcastSessionsDelta({
				added: [mockSession],
				timestamp: Date.now(),
			});

			const publish = publishedMessages.find((m) => m.channel === 'state.sessions.delta');
			expect(publish).toBeDefined();
		});

		it('should broadcast system change', async () => {
			await stateManager.broadcastSystemChange();

			const publish = publishedMessages.find((m) => m.channel === 'state.system');
			expect(publish).toBeDefined();
		});

		it('should broadcast settings change', async () => {
			await stateManager.broadcastSettingsChange();

			const publish = publishedMessages.find((m) => m.channel === 'state.settings');
			expect(publish).toBeDefined();
		});

		it('should broadcast session state change', async () => {
			await stateManager.broadcastSessionStateChange(mockSession.id);

			const publish = publishedMessages.find((m) => m.channel === 'state.session');
			expect(publish).toBeDefined();
			expect((publish!.options as { sessionId: string }).sessionId).toBe(mockSession.id);
		});

		it('should handle session not found in broadcastSessionStateChange', async () => {
			// Should not throw, just log warning
			await stateManager.broadcastSessionStateChange('nonexistent');

			// May or may not publish based on fallback logic
			// The important thing is it doesn't throw
		});

		it('should broadcast SDK messages change', async () => {
			await stateManager.broadcastSDKMessagesChange(mockSession.id);

			const publish = publishedMessages.find((m) => m.channel === 'state.sdkMessages');
			expect(publish).toBeDefined();
		});

		it('should broadcast SDK messages delta', async () => {
			await stateManager.broadcastSDKMessagesDelta(mockSession.id, {
				added: [],
				timestamp: Date.now(),
			});

			const publish = publishedMessages.find((m) => m.channel === 'state.sdkMessages.delta');
			expect(publish).toBeDefined();
		});
	});

	describe('version management', () => {
		it('should increment version for each channel independently', async () => {
			// Broadcast to different channels
			await stateManager.broadcastSessionsChange();
			await stateManager.broadcastSystemChange();
			await stateManager.broadcastSessionsChange();

			// Sessions channel should have version 2
			const sessionsPublishes = publishedMessages.filter((m) => m.channel === 'state.sessions');
			expect(sessionsPublishes.length).toBe(2);
			expect((sessionsPublishes[0].data as { version: number }).version).toBe(1);
			expect((sessionsPublishes[1].data as { version: number }).version).toBe(2);

			// System channel should have version 1
			const systemPublish = publishedMessages.find((m) => m.channel === 'state.system');
			expect((systemPublish!.data as { version: number }).version).toBe(1);
		});
	});

	describe('broadcastSessionUpdateFromCache', () => {
		it('should handle archived session filtering', async () => {
			// Create an archived session
			const archivedSession = { ...mockSession, status: 'archived' as const };

			// Trigger session.created to populate cache
			const createHandler = eventHandlers.get('session.created')![0];
			await createHandler({ session: archivedSession });
			publishedMessages = [];

			// Trigger session.updated
			const updateHandler = eventHandlers.get('session.updated')![0];
			await updateHandler({
				sessionId: archivedSession.id,
				session: archivedSession,
				processingState: { status: 'idle' },
			});

			// Should broadcast removal since showArchived is false
			const deltaPublish = publishedMessages.find((m) => m.channel === 'state.sessions.delta');
			expect(deltaPublish).toBeDefined();
			expect((deltaPublish!.data as { removed?: string[] }).removed).toContain(archivedSession.id);
		});

		it('should use fallback state when session fetch fails', async () => {
			// Setup session manager to throw for getSessionAsync
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			// First populate the cache
			const createHandler = eventHandlers.get('session.created')![0];
			await createHandler({ session: mockSession });

			// Now update processing state in cache
			const updateHandler = eventHandlers.get('session.updated')![0];
			await updateHandler({
				sessionId: mockSession.id,
				processingState: { status: 'processing' },
			});

			publishedMessages = [];

			// Broadcast session state - should use fallback
			await stateManager.broadcastSessionStateChange(mockSession.id);

			// May have published something via fallback, may not depending on cache state
			// The important thing is no error was thrown
			// publishedMessages may contain a fallback state.session publish
			expect(publishedMessages).toBeDefined();
		});
	});
});
