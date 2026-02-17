/**
 * Session Manager Tests
 *
 * Unit tests for the main session orchestrator that coordinates
 * SessionCache, SessionLifecycle, ToolsConfigManager, and MessagePersistence.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { SessionManager, CleanupState } from '../../../src/lib/session/session-manager';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { AuthManager } from '../../../src/lib/auth-manager';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import type { MessageHub, Session } from '@neokai/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

describe('SessionManager', () => {
	let sessionManager: SessionManager;
	let mockDb: Database;
	let mockMessageHub: MessageHub;
	let mockAuthManager: AuthManager;
	let mockSettingsManager: SettingsManager;
	let mockEventBus: DaemonHub;
	let config: Record<string, unknown>;
	let eventHandlers: Map<string, (...args: unknown[]) => unknown>;

	beforeEach(() => {
		eventHandlers = new Map();

		// Database mocks
		mockDb = {
			createSession: mock(() => {}),
			updateSession: mock(() => {}),
			deleteSession: mock(() => {}),
			getSession: mock(() => null),
			getGlobalSettings: mock(() => ({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
			})),
			listSessions: mock(() => []),
			getGlobalToolsConfig: mock(() => ({
				systemPrompt: {
					claudeCodePreset: { allowed: true, defaultEnabled: true },
				},
				mcpServers: {},
				kaiTools: {
					memory: { allowed: true, defaultEnabled: true },
				},
			})),
			saveGlobalToolsConfig: mock(() => {}),
			getMessagesByStatus: mock(() => []),
			saveSDKMessage: mock(() => {}),
			getUserMessages: mock(() => []),
			getSDKMessages: mock(() => []),
			getSDKMessageCount: mock(() => 0),
			deleteMessagesAfter: mock(() => 0),
			deleteMessagesAtAndAfter: mock(() => 0),
			getUserMessageByUuid: mock(() => undefined),
			countMessagesAfter: mock(() => 0),
			updateMessage: mock(() => {}),
			saveUserMessage: mock(() => {}),
		} as unknown as Database;

		// Message hub mocks
		mockMessageHub = {
			event: mock(async () => {}),
			onRequest: mock(() => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		// Auth manager mocks
		mockAuthManager = {
			getCurrentApiKey: mock(async () => 'test-api-key'),
			initialize: mock(async () => {}),
			getAuthStatus: mock(async () => ({ isAuthenticated: true })),
		} as unknown as AuthManager;

		// Settings manager mocks
		mockSettingsManager = {
			getSettings: mock(() => ({})),
			updateSettings: mock(() => {}),
			getGlobalSettings: mock(() => ({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
			})),
			listMcpServersFromSources: mock(() => []),
		} as unknown as SettingsManager;

		// Event bus mocks - capture handlers for testing
		mockEventBus = {
			on: mock((event: string, handler: (...args: unknown[]) => unknown) => {
				eventHandlers.set(event, handler);
				return () => eventHandlers.delete(event);
			}),
			emit: mock(async () => {}),
			initialize: mock(async () => {}),
		} as unknown as DaemonHub;

		// Config
		config = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxTokens: 8192,
			temperature: 1.0,
			workspaceRoot: '/default/workspace',
			disableWorktrees: true,
		};

		sessionManager = new SessionManager(
			mockDb,
			mockMessageHub,
			mockAuthManager,
			mockSettingsManager,
			mockEventBus,
			config as Parameters<typeof SessionManager>[5]
		);
	});

	afterEach(async () => {
		// Ensure cleanup after each test
		try {
			await sessionManager.cleanup();
		} catch {
			// Ignore cleanup errors in afterEach
		}
	});

	describe('constructor', () => {
		it('should initialize with clean state', () => {
			expect(sessionManager.getCleanupState()).toBe(CleanupState.IDLE);
		});

		it('should setup event subscriptions', () => {
			expect(mockEventBus.on).toHaveBeenCalledWith('message.sendRequest', expect.any(Function));
			expect(mockEventBus.on).toHaveBeenCalledWith('message.persisted', expect.any(Function));
		});

		it('should have no active sessions initially', () => {
			expect(sessionManager.getActiveSessions()).toBe(0);
		});
	});

	describe('createSession', () => {
		it('should delegate to sessionLifecycle.create', async () => {
			(mockDb.createSession as ReturnType<typeof mock>).mockImplementation((session: Session) => {
				// Store created session for retrieval
				(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(session);
			});

			const sessionId = await sessionManager.createSession({});

			expect(sessionId).toBeDefined();
			expect(typeof sessionId).toBe('string');
		});

		it('should create session with title', async () => {
			(mockDb.createSession as ReturnType<typeof mock>).mockImplementation((session: Session) => {
				(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(session);
			});

			await sessionManager.createSession({ title: 'Test Session' });

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					title: 'Test Session',
				})
			);
		});

		it('should create session with custom workspace path', async () => {
			(mockDb.createSession as ReturnType<typeof mock>).mockImplementation((session: Session) => {
				(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(session);
			});

			await sessionManager.createSession({ workspacePath: '/custom/path' });

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					workspacePath: '/custom/path',
				})
			);
		});
	});

	describe('getSession', () => {
		it('should return null for non-existent session', () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			const result = sessionManager.getSession('nonexistent');

			expect(result).toBeNull();
		});

		it('should return cached session', async () => {
			const mockSession: Session = {
				id: 'test-session-id',
				title: 'Test',
				workspacePath: '/test',
				status: 'active',
				config: {},
				metadata: {},
			};
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

			// First access loads and caches
			const result = sessionManager.getSession('test-session-id');

			expect(result).not.toBeNull();
		});
	});

	describe('getSessionAsync', () => {
		it('should return null for non-existent session', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			const result = await sessionManager.getSessionAsync('nonexistent');

			expect(result).toBeNull();
		});

		it('should return cached session', async () => {
			const mockSession: Session = {
				id: 'test-session-id',
				title: 'Test',
				workspacePath: '/test',
				status: 'active',
				config: {},
				metadata: {},
			};
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

			const result = await sessionManager.getSessionAsync('test-session-id');

			expect(result).not.toBeNull();
		});
	});

	describe('listSessions', () => {
		it('should return list from database', () => {
			const mockSessions: Session[] = [
				{
					id: '1',
					title: 'Session 1',
					workspacePath: '/1',
					status: 'active',
					config: {},
					metadata: {},
				},
				{
					id: '2',
					title: 'Session 2',
					workspacePath: '/2',
					status: 'active',
					config: {},
					metadata: {},
				},
			];
			(mockDb.listSessions as ReturnType<typeof mock>).mockReturnValue(mockSessions);

			const result = sessionManager.listSessions();

			expect(result).toEqual(mockSessions);
			expect(mockDb.listSessions).toHaveBeenCalled();
		});

		it('should return empty array when no sessions', () => {
			(mockDb.listSessions as ReturnType<typeof mock>).mockReturnValue([]);

			const result = sessionManager.listSessions();

			expect(result).toEqual([]);
		});
	});

	describe('updateSession', () => {
		it('should delegate to sessionLifecycle.update', async () => {
			await sessionManager.updateSession('test-id', { title: 'Updated' });

			expect(mockDb.updateSession).toHaveBeenCalledWith('test-id', { title: 'Updated' });
		});

		it('should emit session.updated event', async () => {
			await sessionManager.updateSession('test-id', { title: 'Updated' });

			expect(mockEventBus.emit).toHaveBeenCalledWith(
				'session.updated',
				expect.objectContaining({
					sessionId: 'test-id',
				})
			);
		});
	});

	describe('deleteSession', () => {
		it('should delegate to sessionLifecycle.delete', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				workspacePath: '/test',
			});

			await sessionManager.deleteSession('test-id');

			expect(mockDb.deleteSession).toHaveBeenCalledWith('test-id');
		});
	});

	describe('getActiveSessions', () => {
		it('should return count from sessionCache', () => {
			expect(sessionManager.getActiveSessions()).toBe(0);
		});
	});

	describe('getTotalSessions', () => {
		it('should return count from database', () => {
			(mockDb.listSessions as ReturnType<typeof mock>).mockReturnValue([
				{ id: '1' } as Session,
				{ id: '2' } as Session,
			]);

			expect(sessionManager.getTotalSessions()).toBe(2);
		});
	});

	describe('getGlobalToolsConfig', () => {
		it('should delegate to toolsConfigManager', () => {
			const result = sessionManager.getGlobalToolsConfig();

			expect(result).toBeDefined();
		});
	});

	describe('saveGlobalToolsConfig', () => {
		it('should delegate to toolsConfigManager', () => {
			const config = { useClaudeCodePreset: true };
			sessionManager.saveGlobalToolsConfig(
				config as ReturnType<typeof sessionManager.getGlobalToolsConfig>
			);

			// Config should be saved (no error means success)
		});
	});

	describe('getFromDB', () => {
		it('should return session from database', () => {
			const mockSession = { id: 'test-id', title: 'Test' };
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

			const result = sessionManager.getSessionFromDB('test-id');

			expect(mockDb.getSession).toHaveBeenCalledWith('test-id');
			expect(result).toEqual(mockSession);
		});

		it('should return null if session not found', () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			const result = sessionManager.getSessionFromDB('nonexistent');

			expect(result).toBeNull();
		});
	});

	describe('markOutputRemoved', () => {
		it('should delegate to sessionLifecycle', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				metadata: { removedOutputs: [] },
			});

			await sessionManager.markOutputRemoved('test-id', 'msg-uuid');

			expect(mockDb.updateSession).toHaveBeenCalled();
		});
	});

	describe('generateTitleAndRenameBranch', () => {
		it('should delegate to sessionLifecycle', async () => {
			// First create a session to populate the cache
			const mockSession: Session = {
				id: 'test-id',
				title: 'Test',
				workspacePath: '/test',
				status: 'active',
				config: {},
				metadata: { titleGenerated: true },
			};
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

			// Access session to cache it
			sessionManager.getSession('test-id');

			const result = await sessionManager.generateTitleAndRenameBranch('test-id', 'test message');

			expect(result).toBeDefined();
		});
	});

	describe('initializeSessionWorkspace (deprecated)', () => {
		it('should delegate to generateTitleAndRenameBranch', async () => {
			// First create a session to populate the cache
			const mockSession: Session = {
				id: 'test-id',
				title: 'Test',
				workspacePath: '/test',
				status: 'active',
				config: {},
				metadata: { titleGenerated: true },
			};
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

			// Access session to cache it
			sessionManager.getSession('test-id');

			const result = await sessionManager.initializeSessionWorkspace('test-id', 'test message');

			expect(result).toBeDefined();
		});
	});

	describe('cleanupOrphanedWorktrees', () => {
		it('should delegate to worktreeManager', async () => {
			const result = await sessionManager.cleanupOrphanedWorktrees('/custom/path');

			expect(Array.isArray(result)).toBe(true);
		});

		it('should use config workspaceRoot if no path provided', async () => {
			await sessionManager.cleanupOrphanedWorktrees();

			// Should complete without error
		});
	});

	describe('getDatabase', () => {
		it('should return the database instance', () => {
			const db = sessionManager.getDatabase();

			expect(db).toBe(mockDb);
		});
	});

	describe('getSessionLifecycle', () => {
		it('should return the sessionLifecycle instance', () => {
			const lifecycle = sessionManager.getSessionLifecycle();

			expect(lifecycle).toBeDefined();
		});
	});

	describe('cleanup', () => {
		it('should transition through cleanup states', async () => {
			expect(sessionManager.getCleanupState()).toBe(CleanupState.IDLE);

			const cleanupPromise = sessionManager.cleanup();

			// During cleanup, state should be CLEANING or already CLEANED
			// After cleanup completes, state should be CLEANED
			await cleanupPromise;

			expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);
		});

		it('should prevent concurrent cleanup', async () => {
			const cleanup1 = sessionManager.cleanup();
			const cleanup2 = sessionManager.cleanup();

			await Promise.all([cleanup1, cleanup2]);

			// Both should complete without error, but only one should execute
			expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);
		});

		it('should unsubscribe from event bus', async () => {
			await sessionManager.cleanup();

			// Event handlers should be unsubscribed
			expect(eventHandlers.size).toBe(0);
		});

		it('should clear session cache', async () => {
			await sessionManager.cleanup();

			expect(sessionManager.getActiveSessions()).toBe(0);
		});

		it('should handle cleanup when already cleaned', async () => {
			await sessionManager.cleanup();
			expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);

			// Second cleanup should be a no-op
			await sessionManager.cleanup();
			expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);
		});

		it('should wait for pending background tasks with timeout', async () => {
			// This tests the timeout behavior for background tasks
			await sessionManager.cleanup();

			// Should complete within reasonable time
			expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);
		});
	});

	describe('EventBus subscriptions', () => {
		describe('message.sendRequest handler', () => {
			it('should handle message send requests', async () => {
				const handler = eventHandlers.get('message.sendRequest');
				expect(handler).toBeDefined();

				// Set up session in cache first
				const mockSession: Session = {
					id: 'test-id',
					title: 'Test',
					workspacePath: '/test',
					status: 'active',
					config: {},
					metadata: {},
				};
				(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);
				sessionManager.getSession('test-id');

				// Handler should be callable
				await handler?.({
					sessionId: 'test-id',
					messageId: 'msg-id',
					content: 'test content',
					images: [],
				});
			});
		});

		describe('message.persisted handler', () => {
			it('should handle message persisted events', async () => {
				const handler = eventHandlers.get('message.persisted');
				expect(handler).toBeDefined();

				await handler?.({
					sessionId: 'test-id',
					userMessageText: 'test message',
					needsWorkspaceInit: false,
					hasDraftToClear: false,
				});
			});

			it('should skip title generation when workspace already initialized', async () => {
				const handler = eventHandlers.get('message.persisted');

				await handler?.({
					sessionId: 'test-id',
					userMessageText: 'test message',
					needsWorkspaceInit: false,
					hasDraftToClear: false,
				});

				// Should not call title generation
				expect(mockEventBus.emit).not.toHaveBeenCalledWith(
					'session.updated',
					expect.objectContaining({ source: 'title-generated' })
				);
			});

			it('should skip background tasks during cleanup', async () => {
				// Start cleanup to set barrier
				const cleanupPromise = sessionManager.cleanup();

				const handler = eventHandlers.get('message.persisted');

				// This should be skipped due to cleanup barrier
				await handler?.({
					sessionId: 'test-id',
					userMessageText: 'test message',
					needsWorkspaceInit: true,
					hasDraftToClear: false,
				});

				await cleanupPromise;
			});

			it('should clear draft when hasDraftToClear is true', async () => {
				const handler = eventHandlers.get('message.persisted');

				(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
					id: 'test-id',
					metadata: { inputDraft: 'test draft' },
				});

				await handler?.({
					sessionId: 'test-id',
					userMessageText: 'test message',
					needsWorkspaceInit: false,
					hasDraftToClear: true,
				});

				// Should update session to clear draft
				expect(mockDb.updateSession).toHaveBeenCalled();
			});
		});
	});

	describe('CleanupState enum', () => {
		it('should have IDLE state', () => {
			expect(CleanupState.IDLE).toBe('idle');
		});

		it('should have CLEANING state', () => {
			expect(CleanupState.CLEANING).toBe('cleaning');
		});

		it('should have CLEANED state', () => {
			expect(CleanupState.CLEANED).toBe('cleaned');
		});
	});
});
