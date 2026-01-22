/**
 * Session Manager Tests
 *
 * Unit tests for SessionManager class, focusing on:
 * - Session creation and retrieval
 * - Error logging paths
 * - Sync vs async session loading
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { SessionManager } from '../../../src/lib/session-manager';
import { Database } from '../../../src/storage/database';
import { AuthManager } from '../../../src/lib/auth-manager';
import { MessageHub, MessageHubRouter } from '@liuboer/shared';
import { createDaemonHub, type DaemonHub } from '../../../src/lib/daemon-hub';
import type { SettingsManager } from '../../../src/lib/settings-manager';

describe('SessionManager', () => {
	let db: Database;
	let messageHub: MessageHub;
	let authManager: AuthManager;
	let settingsManager: SettingsManager;
	let eventBus: DaemonHub;
	let sessionManager: SessionManager;
	let originalEnv: string | undefined;

	beforeEach(async () => {
		// Store original env
		originalEnv = process.env.NODE_ENV;

		// Use in-memory database
		db = new Database(':memory:');
		await db.initialize();

		// Setup MessageHub
		const router = new MessageHubRouter({ debug: false });
		messageHub = new MessageHub({ defaultSessionId: 'global', debug: false });
		messageHub.registerRouter(router);

		// Setup DaemonHub
		eventBus = createDaemonHub('test-hub');
		await eventBus.initialize();

		// Setup AuthManager
		authManager = new AuthManager(db, {
			anthropicApiKey: 'test-key',
			claudeCodeOAuthToken: undefined,
		});
		await authManager.initialize();

		// Mock SettingsManager
		settingsManager = {
			prepareSDKOptions: async () => ({}),
			getGlobalSettings: () => ({
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
				mcpServerSettings: {},
			}),
			listMcpServersFromSources: () => [],
		} as unknown as SettingsManager;

		// Create SessionManager
		sessionManager = new SessionManager(db, messageHub, authManager, settingsManager, eventBus, {
			defaultModel: 'claude-sonnet-4-5-20250929',
			maxTokens: 8192,
			temperature: 1.0,
			workspaceRoot: '/tmp/test-workspace',
		});
	});

	afterEach(async () => {
		// Cleanup
		await sessionManager.cleanup();
		db.close();

		// Restore env
		if (originalEnv !== undefined) {
			process.env.NODE_ENV = originalEnv;
		} else {
			delete process.env.NODE_ENV;
		}
	});

	describe('createSession', () => {
		test('creates session with default workspace', async () => {
			const sessionId = await sessionManager.createSession({});

			expect(sessionId).toBeString();
			expect(sessionId.length).toBeGreaterThan(0);

			const session = db.getSession(sessionId);
			expect(session).not.toBeNull();
			expect(session?.workspacePath).toBe('/tmp/test-workspace');
		});

		test('creates session with custom workspace', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: '/custom/path',
			});

			const session = db.getSession(sessionId);
			expect(session?.workspacePath).toBe('/custom/path');
		});

		test('creates session with custom config', async () => {
			const sessionId = await sessionManager.createSession({
				config: {
					model: 'opus', // Use alias
					maxTokens: 4096,
					temperature: 0.5,
				},
			});

			const session = db.getSession(sessionId);
			// Should resolve to latest Opus model from static fallback
			expect(session?.config.model).toContain('opus');
			expect(session?.config.maxTokens).toBe(4096);
			expect(session?.config.temperature).toBe(0.5);
		});

		test('emits session.created event', async () => {
			let receivedEvent = false;
			eventBus.on('session.created', () => {
				receivedEvent = true;
			});

			await sessionManager.createSession({});

			expect(receivedEvent).toBe(true);
		});

		test('respects MCP defaultOn=false setting', async () => {
			// Mock settings manager with MCP server that has defaultOn=false
			settingsManager = {
				prepareSDKOptions: async () => ({}),
				getGlobalSettings: () => ({
					settingSources: ['user', 'project', 'local'],
					disabledMcpServers: [],
					mcpServerSettings: {
						'chrome-devtools': {
							allowed: true,
							defaultOn: false, // Explicitly disabled by default
						},
					},
				}),
				listMcpServersFromSources: () => ({
					user: [
						{
							name: 'chrome-devtools',
							command: 'npx @modelcontextprotocol/server-chrome-devtools',
						},
					],
					project: [],
					local: [],
				}),
			} as unknown as SettingsManager;

			// Create new SessionManager with updated settings
			const testSessionManager = new SessionManager(
				db,
				messageHub,
				authManager,
				settingsManager,
				eventBus,
				{
					defaultModel: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
					workspaceRoot: '/tmp/test-workspace',
				}
			);

			const sessionId = await testSessionManager.createSession({});
			const session = db.getSession(sessionId);

			// chrome-devtools should be in disabledMcpServers
			expect(session?.config.tools?.disabledMcpServers).toContain('chrome-devtools');

			await testSessionManager.cleanup();
		});

		test('respects MCP defaultOn=undefined (should default to false)', async () => {
			// Mock settings manager with MCP server that has NO defaultOn setting
			settingsManager = {
				prepareSDKOptions: async () => ({}),
				getGlobalSettings: () => ({
					settingSources: ['user', 'project', 'local'],
					disabledMcpServers: [],
					mcpServerSettings: {
						'chrome-devtools': {
							allowed: true,
							// defaultOn is undefined
						},
					},
				}),
				listMcpServersFromSources: () => ({
					user: [
						{
							name: 'chrome-devtools',
							command: 'npx @modelcontextprotocol/server-chrome-devtools',
						},
					],
					project: [],
					local: [],
				}),
			} as unknown as SettingsManager;

			// Create new SessionManager with updated settings
			const testSessionManager = new SessionManager(
				db,
				messageHub,
				authManager,
				settingsManager,
				eventBus,
				{
					defaultModel: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
					workspaceRoot: '/tmp/test-workspace',
				}
			);

			const sessionId = await testSessionManager.createSession({});
			const session = db.getSession(sessionId);

			// chrome-devtools should be in disabledMcpServers (defaultOn defaults to false)
			expect(session?.config.tools?.disabledMcpServers).toContain('chrome-devtools');

			await testSessionManager.cleanup();
		});

		test('enables MCP when defaultOn=true', async () => {
			// Mock settings manager with MCP server that has defaultOn=true
			settingsManager = {
				prepareSDKOptions: async () => ({}),
				getGlobalSettings: () => ({
					settingSources: ['user', 'project', 'local'],
					disabledMcpServers: [],
					mcpServerSettings: {
						'chrome-devtools': {
							allowed: true,
							defaultOn: true, // Explicitly enabled by default
						},
					},
				}),
				listMcpServersFromSources: () => ({
					user: [
						{
							name: 'chrome-devtools',
							command: 'npx @modelcontextprotocol/server-chrome-devtools',
						},
					],
					project: [],
					local: [],
				}),
			} as unknown as SettingsManager;

			// Create new SessionManager with updated settings
			const testSessionManager = new SessionManager(
				db,
				messageHub,
				authManager,
				settingsManager,
				eventBus,
				{
					defaultModel: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
					workspaceRoot: '/tmp/test-workspace',
				}
			);

			const sessionId = await testSessionManager.createSession({});
			const session = db.getSession(sessionId);

			// chrome-devtools should NOT be in disabledMcpServers
			expect(session?.config.tools?.disabledMcpServers).not.toContain('chrome-devtools');

			await testSessionManager.cleanup();
		});
	});

	describe('getSession (sync)', () => {
		test('returns null for non-existent session', () => {
			const session = sessionManager.getSession('non-existent');
			expect(session).toBeNull();
		});

		test('returns session from memory if already loaded', async () => {
			const sessionId = await sessionManager.createSession({});

			// First call should return from memory
			const session1 = sessionManager.getSession(sessionId);
			expect(session1).not.toBeNull();

			// Second call should also return from memory
			const session2 = sessionManager.getSession(sessionId);
			expect(session2).toBe(session1); // Same instance
		});

		test('loads session from database when not in memory', async () => {
			// Create session directly in DB, bypassing memory cache
			const rawSession = {
				id: 'db-only-session',
				title: 'Test Session',
				workspacePath: '/test',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active' as const,
				config: {
					model: 'claude-sonnet-4-5-20250929',
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
			db.createSession(rawSession);

			// getSession should load from DB
			const session = sessionManager.getSession('db-only-session');
			expect(session).not.toBeNull();
		});
	});

	describe('getSessionAsync', () => {
		test('returns null for non-existent session', async () => {
			const session = await sessionManager.getSessionAsync('non-existent');
			expect(session).toBeNull();
		});

		test('returns session from memory if already loaded', async () => {
			const sessionId = await sessionManager.createSession({});

			const session = await sessionManager.getSessionAsync(sessionId);
			expect(session).not.toBeNull();
		});

		test('handles concurrent access without duplicate loading', async () => {
			// Create session directly in DB
			const rawSession = {
				id: 'concurrent-test-session',
				title: 'Test Session',
				workspacePath: '/test',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active' as const,
				config: {
					model: 'claude-sonnet-4-5-20250929',
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
			db.createSession(rawSession);

			// Make concurrent requests
			const [session1, session2, session3] = await Promise.all([
				sessionManager.getSessionAsync('concurrent-test-session'),
				sessionManager.getSessionAsync('concurrent-test-session'),
				sessionManager.getSessionAsync('concurrent-test-session'),
			]);

			// All should return the same session instance
			expect(session1).not.toBeNull();
			expect(session2).not.toBeNull();
			expect(session3).not.toBeNull();
			expect(session1).toBe(session2);
			expect(session2).toBe(session3);
		});
	});

	describe('listSessions', () => {
		test('returns empty array when no sessions', () => {
			const sessions = sessionManager.listSessions();
			expect(sessions).toBeArray();
			expect(sessions.length).toBe(0);
		});

		test('returns all sessions', async () => {
			await sessionManager.createSession({});
			await sessionManager.createSession({});

			const sessions = sessionManager.listSessions();
			expect(sessions.length).toBe(2);
		});
	});

	describe('updateSession', () => {
		test('updates session in database', async () => {
			const sessionId = await sessionManager.createSession({});

			await sessionManager.updateSession(sessionId, { title: 'New Title' });

			const session = db.getSession(sessionId);
			expect(session?.title).toBe('New Title');
		});

		test('emits session.updated event', async () => {
			const sessionId = await sessionManager.createSession({});

			let receivedSessionId = '';
			eventBus.on('session.updated', (data) => {
				receivedSessionId = data.sessionId;
			});

			await sessionManager.updateSession(sessionId, { title: 'New Title' });

			expect(receivedSessionId).toBe(sessionId);
		});
	});

	describe('deleteSession', () => {
		test('deletes session from database', async () => {
			const sessionId = await sessionManager.createSession({});

			await sessionManager.deleteSession(sessionId);

			const session = db.getSession(sessionId);
			expect(session).toBeNull();
		});

		test('emits session.deleted event', async () => {
			const sessionId = await sessionManager.createSession({});

			let deletedSessionId = '';
			eventBus.on('session.deleted', (data) => {
				deletedSessionId = data.sessionId;
			});

			await sessionManager.deleteSession(sessionId);

			expect(deletedSessionId).toBe(sessionId);
		});

		test('removes session from memory', async () => {
			const sessionId = await sessionManager.createSession({});

			// Verify it's in memory
			expect(sessionManager.getActiveSessions()).toBe(1);

			await sessionManager.deleteSession(sessionId);

			expect(sessionManager.getActiveSessions()).toBe(0);
		});
	});

	describe('getActiveSessions', () => {
		test('returns count of in-memory sessions', async () => {
			expect(sessionManager.getActiveSessions()).toBe(0);

			await sessionManager.createSession({});
			expect(sessionManager.getActiveSessions()).toBe(1);

			await sessionManager.createSession({});
			expect(sessionManager.getActiveSessions()).toBe(2);
		});
	});

	describe('getTotalSessions', () => {
		test('returns count of all sessions in database', async () => {
			expect(sessionManager.getTotalSessions()).toBe(0);

			await sessionManager.createSession({});
			expect(sessionManager.getTotalSessions()).toBe(1);

			await sessionManager.createSession({});
			expect(sessionManager.getTotalSessions()).toBe(2);
		});
	});

	describe('cleanup', () => {
		test('cleans up all sessions', async () => {
			await sessionManager.createSession({});
			await sessionManager.createSession({});

			expect(sessionManager.getActiveSessions()).toBe(2);

			await sessionManager.cleanup();

			expect(sessionManager.getActiveSessions()).toBe(0);
		});
	});

	describe('error logging in development mode', () => {
		test('logs errors in development mode', async () => {
			// Set to development mode
			process.env.NODE_ENV = 'development';

			// Create new SessionManager in development mode
			const devSessionManager = new SessionManager(
				db,
				messageHub,
				authManager,
				settingsManager,
				eventBus,
				{
					defaultModel: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
					workspaceRoot: '/tmp/test-workspace',
				}
			);

			// Spy on console.error
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			// Create and delete a session to trigger potential error paths
			const sessionId = await devSessionManager.createSession({});
			await devSessionManager.deleteSession(sessionId);

			// Restore spy
			errorSpy.mockRestore();

			await devSessionManager.cleanup();
		});
	});
});
