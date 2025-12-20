/**
 * Unit tests for 2-stage session creation
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SessionManager } from '../session-manager';
import { Database } from '../../storage/database';
import { MessageHub, EventBus } from '@liuboer/shared';
import type { AuthManager } from '../auth-manager';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

describe('2-Stage Session Creation', () => {
	let sessionManager: SessionManager;
	let db: Database;
	let messageHub: MessageHub;
	let eventBus: EventBus;
	let mockAuthManager: AuthManager;
	let testWorkspace: string;
	let dbPath: string;

	beforeEach(async () => {
		// Create temporary workspace and database
		testWorkspace = path.join(tmpdir(), `test-workspace-${Date.now()}`);
		dbPath = path.join(tmpdir(), `test-db-${Date.now()}.db`);

		fs.mkdirSync(testWorkspace, { recursive: true });

		// Initialize database
		db = new Database(dbPath);
		await db.initialize();

		// Initialize MessageHub
		messageHub = new MessageHub();

		// Initialize EventBus
		eventBus = new EventBus();

		// Mock AuthManager
		mockAuthManager = {
			getCurrentApiKey: async () => process.env.ANTHROPIC_API_KEY || null,
		} as AuthManager;

		// Mock SettingsManager
		const mockSettingsManager = {
			prepareSDKOptions: async () => ({}),
			getGlobalSettings: () => ({
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
				mcpServerSettings: {},
			}),
			listMcpServersFromSources: () => [],
		} as unknown as import('../settings-manager').SettingsManager;

		// Initialize SessionManager
		sessionManager = new SessionManager(
			db,
			messageHub,
			mockAuthManager,
			mockSettingsManager,
			eventBus,
			{
				defaultModel: 'claude-sonnet-4-5-20250929',
				maxTokens: 8192,
				temperature: 1.0,
				workspaceRoot: testWorkspace,
				disableWorktrees: true, // Disable for unit tests
			}
		);
	});

	afterEach(async () => {
		// Cleanup
		try {
			await sessionManager.cleanup();
		} catch {
			// Ignore cleanup errors
		}

		try {
			db.close();
		} catch {
			// Ignore if db is already closed
		}

		// Remove test files
		try {
			fs.rmSync(testWorkspace, { recursive: true, force: true });
			fs.rmSync(dbPath, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('Stage 1: Quick Session Creation', () => {
		test('createSession returns sessionId quickly', async () => {
			const start = Date.now();
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});
			const elapsed = Date.now() - start;

			expect(sessionId).toBeDefined();
			expect(typeof sessionId).toBe('string');
			expect(elapsed).toBeLessThan(100); // Should be very fast
		});

		test('session created with default title', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			const agentSession = sessionManager.getSession(sessionId);
			expect(agentSession).toBeDefined();

			const session = agentSession!.getSessionData();
			expect(session.title).toBe('New Session');
		});

		test('session created without worktree initially', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			expect(session.worktree).toBeUndefined();
			expect(session.metadata.workspaceInitialized).toBe(false);
		});

		test('session appears in database immediately', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			const dbSession = db.getSession(sessionId);
			expect(dbSession).toBeDefined();
			expect(dbSession!.id).toBe(sessionId);
			expect(dbSession!.title).toBe('New Session');
		});

		test('session has correct initial metadata', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			expect(session.metadata.messageCount).toBe(0);
			expect(session.metadata.totalTokens).toBe(0);
			expect(session.metadata.titleGenerated).toBe(false);
			expect(session.metadata.workspaceInitialized).toBe(false);
		});
	});

	describe('Branch Name Generation', () => {
		test('generateBranchName creates valid git branch names', () => {
			// Access private method via type assertion for testing
			const manager = sessionManager as unknown as Record<string, unknown>;

			const testCases = [
				{
					title: 'Fix login bug',
					sessionId: 'abc123',
					expected: 'session/fix-login-bug-abc123',
				},
				{
					title: 'Add dark mode feature',
					sessionId: 'def456',
					expected: 'session/add-dark-mode-feature-def456',
				},
				{
					title: 'Fix: Login Bug (URGENT!)',
					sessionId: 'ghi789',
					expected: 'session/fix-login-bug-urgent-ghi789',
				},
				{
					title: 'Update README.md',
					sessionId: 'jkl012',
					expected: 'session/update-readme-md-jkl012',
				},
			];

			for (const { title, sessionId, expected } of testCases) {
				const result = (manager.generateBranchName as (title: string, sessionId: string) => string)(
					title,
					sessionId
				);
				expect(result).toBe(expected);
			}
		});

		test('generateBranchName handles special characters', () => {
			const manager = sessionManager as unknown as Record<string, unknown>;

			const branchName = (
				manager.generateBranchName as (title: string, sessionId: string) => string
			)('Fix @#$%^&*() special chars!!!', 'abc123');

			// Should only contain lowercase alphanumeric and hyphens
			expect(branchName).toMatch(/^session\/[a-z0-9-]+-[a-z0-9]+$/);
			expect(branchName).toBe('session/fix-special-chars-abc123');
		});

		test('generateBranchName truncates long titles', () => {
			const manager = sessionManager as unknown as Record<string, unknown>;

			const longTitle =
				'This is a very long title that exceeds the maximum length allowed for git branch names and should be truncated appropriately';
			const branchName = (
				manager.generateBranchName as (title: string, sessionId: string) => string
			)(longTitle, 'abc123');

			// Branch name should be reasonable length
			expect(branchName.length).toBeLessThan(70); // 50 for slug + "session/" + "-abc123"
			expect(branchName).toContain('session/');
			expect(branchName).toContain('-abc123');
		});

		test('generateBranchName handles empty title', () => {
			const manager = sessionManager as unknown as Record<string, unknown>;

			const branchName = (
				manager.generateBranchName as (title: string, sessionId: string) => string
			)('', 'abc123');

			// Should still have session prefix and UUID
			expect(branchName).toBe('session/-abc123');
		});
	});

	describe('Stage 2: Workspace Initialization', () => {
		test('initializeSessionWorkspace marks session as initialized', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation to avoid API call
			const manager = sessionManager as unknown as Record<string, unknown>;
			const originalGenerate = manager.generateTitleFromMessage;
			manager.generateTitleFromMessage = async (text: string) => {
				return text.substring(0, 20);
			};

			await sessionManager.initializeSessionWorkspace(sessionId, 'Fix login bug');

			// Restore original method
			manager.generateTitleFromMessage = originalGenerate;

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			expect(session.metadata.workspaceInitialized).toBe(true);
		});

		test('initializeSessionWorkspace updates title', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			const userMessage = 'I need to fix the login bug';
			await sessionManager.initializeSessionWorkspace(sessionId, userMessage);

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Title should be first 50 chars of user message (temporary title)
			// Real title generation happens async via SimpleTitleQueue
			expect(session.title).toBe(userMessage);
			expect(session.metadata.workspaceInitialized).toBe(true);
		});

		test('initializeSessionWorkspace is idempotent', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Call twice with different messages
			await sessionManager.initializeSessionWorkspace(sessionId, 'Test message');
			await sessionManager.initializeSessionWorkspace(sessionId, 'Another message');

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Title should be from first call (idempotent)
			expect(session.title).toBe('Test message');
			expect(session.metadata.workspaceInitialized).toBe(true);
		});

		test('initializeSessionWorkspace handles title generation failure', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation to fail
			const manager = sessionManager as unknown as Record<string, unknown>;
			manager.generateTitleFromMessage = async () => {
				throw new Error('API error');
			};

			// Should not throw, should use fallback
			await sessionManager.initializeSessionWorkspace(
				sessionId,
				'This is a test message that should be used as fallback title'
			);

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Should use first 50 chars of message as fallback
			expect(session.title).toBe('This is a test message that should be used as fall');
			expect(session.metadata.workspaceInitialized).toBe(true);
			expect(session.metadata.titleGenerated).toBe(false);
		});

		test('initializeSessionWorkspace persists to database', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			const userMessage = 'Test message';
			await sessionManager.initializeSessionWorkspace(sessionId, userMessage);

			// Verify in database
			const dbSession = db.getSession(sessionId);
			expect(dbSession!.title).toBe(userMessage);
			expect(dbSession!.metadata.workspaceInitialized).toBe(true);
		});
	});

	describe('Error Handling', () => {
		test('throws error if session not found during initialization', async () => {
			await expect(
				sessionManager.initializeSessionWorkspace('nonexistent-id', 'Test message')
			).rejects.toThrow('Session nonexistent-id not found');
		});

		test('handles empty message gracefully', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation
			const manager = sessionManager as unknown as Record<string, unknown>;
			manager.generateTitleFromMessage = async (text: string) => {
				return text || 'New Session';
			};

			await sessionManager.initializeSessionWorkspace(sessionId, '');

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			expect(session.title).toBe('New Session');
			expect(session.metadata.workspaceInitialized).toBe(true);
		});
	});

	describe('Backward Compatibility', () => {
		test('sessions without workspaceInitialized flag work correctly', async () => {
			// Create session manually without the flag
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Remove the flag to simulate old session
			delete (session.metadata as unknown as Record<string, unknown>).workspaceInitialized;
			db.updateSession(sessionId, session);

			// Should still work
			await sessionManager.initializeSessionWorkspace(sessionId, 'Test message');

			const updatedSession = sessionManager.getSession(sessionId)!.getSessionData();
			expect(updatedSession.metadata.workspaceInitialized).toBe(true);
		});
	});
});
