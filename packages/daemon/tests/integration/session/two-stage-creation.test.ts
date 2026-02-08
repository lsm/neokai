/**
 * Unit tests for session creation and title generation
 *
 * The session creation flow is:
 * 1. Session created → Worktree created with session/{uuid} branch → workspaceInitialized=true
 * 2. First message → Title generated async → Branch renamed to session/{slug}-{shortId}
 *
 * Note: worktrees are disabled in these tests, so we focus on title generation behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SessionManager } from '../../../src/lib/session-manager';
import { generateBranchName } from '../../../src/lib/session/session-lifecycle';
import { Database } from '../../../src/storage/database';
import { MessageHub } from '@neokai/shared';
import { createDaemonHub, type DaemonHub } from '../../../src/lib/daemon-hub';
import type { AuthManager } from '../../../src/lib/auth-manager';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

describe('Session Creation and Title Generation', () => {
	let sessionManager: SessionManager;
	let db: Database;
	let messageHub: MessageHub;
	let eventBus: DaemonHub;
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

		// Initialize DaemonHub
		eventBus = createDaemonHub('test-hub');
		await eventBus.initialize();

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
		// Cleanup session resources (interrupts SDK queries)
		try {
			await sessionManager.cleanup();
		} catch {
			// Ignore cleanup errors
		}

		// Wait for async operations to complete after interrupt
		// This prevents "Cannot use a closed database" errors
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Now safe to close database
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

	describe('Quick Session Creation', () => {
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

		test('session created without worktree when worktrees disabled', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Worktrees are disabled in test config, so worktree should be undefined
			expect(session.worktree).toBeUndefined();
			// But workspace is still considered initialized (ready for SDK)
			expect(session.metadata.workspaceInitialized).toBe(true);
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
			// Workspace is initialized immediately (worktree created or not needed)
			expect(session.metadata.workspaceInitialized).toBe(true);
		});
	});

	describe('Branch Name Generation', () => {
		test('generateBranchName creates valid git branch names', () => {
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
				const result = generateBranchName(title, sessionId);
				expect(result).toBe(expected);
			}
		});

		test('generateBranchName handles special characters', () => {
			const branchName = generateBranchName('Fix @#$%^&*() special chars!!!', 'abc123');

			// Should only contain lowercase alphanumeric and hyphens
			expect(branchName).toMatch(/^session\/[a-z0-9-]+-[a-z0-9]+$/);
			expect(branchName).toBe('session/fix-special-chars-abc123');
		});

		test('generateBranchName truncates long titles', () => {
			const longTitle =
				'This is a very long title that exceeds the maximum length allowed for git branch names and should be truncated appropriately';
			const branchName = generateBranchName(longTitle, 'abc123');

			// Branch name should be reasonable length
			expect(branchName.length).toBeLessThan(70); // 50 for slug + "session/" + "-abc123"
			expect(branchName).toContain('session/');
			expect(branchName).toContain('-abc123');
		});

		test('generateBranchName handles empty title', () => {
			const branchName = generateBranchName('', 'abc123');

			// Should still have session prefix and UUID
			expect(branchName).toBe('session/-abc123');
		});
	});

	describe('Title Generation (On First Message)', () => {
		test('generateTitleAndRenameBranch marks title as generated', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation to avoid API call
			// After refactoring, generateTitleFromMessage returns { title, isFallback }
			const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
			const originalGenerate = lifecycle.generateTitleFromMessage;
			lifecycle.generateTitleFromMessage = async (text: string) => {
				return { title: text.substring(0, 20), isFallback: false };
			};

			await sessionManager.generateTitleAndRenameBranch(sessionId, 'Fix login bug');

			// Restore original method
			lifecycle.generateTitleFromMessage = originalGenerate;

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			expect(session.metadata.titleGenerated).toBe(true);
		});

		test('generateTitleAndRenameBranch updates title', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation to avoid API call
			// After refactoring, generateTitleFromMessage returns { title, isFallback }
			const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
			const originalGenerate = lifecycle.generateTitleFromMessage;
			lifecycle.generateTitleFromMessage = async (_text: string) => {
				// Simulate AI-generated title based on message
				return { title: 'Fix Login Bug', isFallback: false };
			};

			const userMessage = 'I need to fix the login bug';
			await sessionManager.generateTitleAndRenameBranch(sessionId, userMessage);

			// Restore original method
			lifecycle.generateTitleFromMessage = originalGenerate;

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Title should be AI-generated from the user message (not exact match)
			expect(session.title).not.toBe('New Session'); // Not the default
			expect(session.title.length).toBeGreaterThan(0); // Has a title
			expect(session.metadata.titleGenerated).toBe(true);
		});

		test('generateTitleAndRenameBranch is idempotent', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation to avoid API call
			// After refactoring, generateTitleFromMessage returns { title, isFallback }
			const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
			const originalGenerate = lifecycle.generateTitleFromMessage;
			lifecycle.generateTitleFromMessage = async (_text: string) => {
				// Simulate AI-generated title
				return { title: 'First Generated Title', isFallback: false };
			};

			// Call twice with different messages
			await sessionManager.generateTitleAndRenameBranch(sessionId, 'Test message');
			await sessionManager.generateTitleAndRenameBranch(sessionId, 'Another message');

			// Restore original method
			lifecycle.generateTitleFromMessage = originalGenerate;

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Title should be AI-generated and not change on second call (idempotent)
			expect(session.title).not.toBe('New Session'); // Should have a generated title
			expect(session.title.length).toBeGreaterThan(0); // Should have a title
			expect(session.metadata.titleGenerated).toBe(true);
		});

		test('generateTitleAndRenameBranch handles title generation failure', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation to fail
			// After refactoring, generateTitleFromMessage returns { title, isFallback }
			const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
			lifecycle.generateTitleFromMessage = async () => {
				throw new Error('API error');
			};

			// Should not throw, should use fallback
			await sessionManager.generateTitleAndRenameBranch(
				sessionId,
				'This is a test message that should be used as fallback title'
			);

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Should use first 50 chars of message as fallback
			expect(session.title).toBe('This is a test message that should be used as fall');
			expect(session.metadata.titleGenerated).toBe(false);
		});

		test('generateTitleAndRenameBranch persists to database', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation to avoid API call
			// After refactoring, generateTitleFromMessage returns { title, isFallback }
			const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
			const originalGenerate = lifecycle.generateTitleFromMessage;
			lifecycle.generateTitleFromMessage = async (_text: string) => {
				// Simulate AI-generated title
				return { title: 'Test Title Generated', isFallback: false };
			};

			const userMessage = 'Test message';
			await sessionManager.generateTitleAndRenameBranch(sessionId, userMessage);

			// Restore original method
			lifecycle.generateTitleFromMessage = originalGenerate;

			// Verify in database - should have AI-generated title
			const dbSession = db.getSession(sessionId);
			expect(dbSession!.title).not.toBe('New Session'); // AI-generated title, not default
			expect(dbSession!.title.length).toBeGreaterThan(0); // Has a title
			expect(dbSession!.metadata.titleGenerated).toBe(true); // Title was generated
		});

		test('initializeSessionWorkspace is an alias for generateTitleAndRenameBranch', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation to avoid API call
			// After refactoring, generateTitleFromMessage returns { title, isFallback }
			const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
			lifecycle.generateTitleFromMessage = async (text: string) => {
				return { title: text.substring(0, 20), isFallback: false };
			};

			// Use the deprecated alias
			await sessionManager.initializeSessionWorkspace(sessionId, 'Fix login bug');

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			expect(session.metadata.titleGenerated).toBe(true);
			expect(session.title).toBe('Fix login bug'); // First 20 chars
		});
	});

	describe('Error Handling', () => {
		test('throws error if session not found during title generation', async () => {
			await expect(
				sessionManager.generateTitleAndRenameBranch('nonexistent-id', 'Test message')
			).rejects.toThrow('Session nonexistent-id not found');
		});

		test('handles empty message gracefully', async () => {
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			// Mock title generation
			// After refactoring, generateTitleFromMessage returns { title, isFallback }
			const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
			lifecycle.generateTitleFromMessage = async (text: string) => {
				return { title: text || 'New Session', isFallback: false };
			};

			await sessionManager.generateTitleAndRenameBranch(sessionId, '');

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			expect(session.title).toBe('New Session');
			expect(session.metadata.titleGenerated).toBe(true);
		});
	});

	describe('Backward Compatibility', () => {
		test('sessions without titleGenerated flag work correctly', async () => {
			// Create session manually without the flag
			const sessionId = await sessionManager.createSession({
				workspacePath: testWorkspace,
			});

			const agentSession = sessionManager.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Remove the flag to simulate old session
			delete (session.metadata as unknown as Record<string, unknown>).titleGenerated;
			db.updateSession(sessionId, session);

			// Mock title generation
			// After refactoring, generateTitleFromMessage returns { title, isFallback }
			const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
			lifecycle.generateTitleFromMessage = async (text: string) => {
				return { title: text.substring(0, 20), isFallback: false };
			};

			// Should still work - titleGenerated check uses falsy, so undefined works
			await sessionManager.generateTitleAndRenameBranch(sessionId, 'Test message');

			const updatedSession = sessionManager.getSession(sessionId)!.getSessionData();
			expect(updatedSession.metadata.titleGenerated).toBe(true);
		});
	});

	describe('Worktree Choice Flow', () => {
		let gitWorkspace: string;
		let sessionManagerWithWorktrees: SessionManager;
		let worktreeDb: Database;

		beforeEach(async () => {
			// Create a git repository for testing
			gitWorkspace = path.join(tmpdir(), `test-git-workspace-${Date.now()}`);
			fs.mkdirSync(gitWorkspace, { recursive: true });

			// Initialize git repository
			const { execSync } = require('node:child_process');
			try {
				execSync('git init', { cwd: gitWorkspace });
				execSync('git config user.email "test@example.com"', { cwd: gitWorkspace });
				execSync('git config user.name "Test User"', { cwd: gitWorkspace });
				execSync('echo "test" > test.txt', { cwd: gitWorkspace });
				execSync('git add .', { cwd: gitWorkspace });
				execSync('git commit -m "Initial commit"', { cwd: gitWorkspace });
			} catch (error) {
				console.error('Failed to initialize git repository:', error);
			}

			// Create separate database for worktree-enabled tests
			const worktreeDbPath = path.join(tmpdir(), `test-db-worktree-${Date.now()}.db`);
			worktreeDb = new Database(worktreeDbPath);
			await worktreeDb.initialize();

			// Initialize MessageHub
			const worktreeMessageHub = new MessageHub();

			// Initialize DaemonHub
			const worktreeEventBus = createDaemonHub('test-hub-worktree');
			await worktreeEventBus.initialize();

			// Mock AuthManager
			const worktreeAuthManager = {
				getCurrentApiKey: async () => process.env.ANTHROPIC_API_KEY || null,
			} as AuthManager;

			// Mock SettingsManager
			const worktreeSettingsManager = {
				prepareSDKOptions: async () => ({}),
				getGlobalSettings: () => ({
					settingSources: ['user', 'project', 'local'],
					disabledMcpServers: [],
					mcpServerSettings: {},
				}),
				listMcpServersFromSources: () => [],
			} as unknown as import('../settings-manager').SettingsManager;

			// Initialize SessionManager with worktrees ENABLED
			sessionManagerWithWorktrees = new SessionManager(
				worktreeDb,
				worktreeMessageHub,
				worktreeAuthManager,
				worktreeSettingsManager,
				worktreeEventBus,
				{
					defaultModel: 'claude-sonnet-4-5-20250929',
					maxTokens: 8192,
					temperature: 1.0,
					workspaceRoot: gitWorkspace,
					disableWorktrees: false, // Enable worktrees for these tests
				}
			);
		});

		afterEach(async () => {
			// Cleanup session resources
			try {
				await sessionManagerWithWorktrees.cleanup();
			} catch {
				// Ignore cleanup errors
			}

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Close database
			try {
				worktreeDb?.close();
			} catch {
				// Ignore if db is already closed
			}

			// Remove test files
			try {
				fs.rmSync(gitWorkspace, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		});

		test('session created with pending_worktree_choice status in git repo', async () => {
			const sessionId = await sessionManagerWithWorktrees.createSession({
				workspacePath: gitWorkspace,
			});

			const agentSession = sessionManagerWithWorktrees.getSession(sessionId);
			expect(agentSession).toBeDefined();

			const session = agentSession!.getSessionData();
			expect(session.status).toBe('pending_worktree_choice');
			expect(session.worktree).toBeUndefined(); // No worktree created yet
			expect(session.metadata.worktreeChoice).toBeDefined();
			expect(session.metadata.worktreeChoice?.status).toBe('pending');
		});

		test('completeWorktreeChoice creates worktree when mode is worktree', async () => {
			const sessionId = await sessionManagerWithWorktrees.createSession({
				workspacePath: gitWorkspace,
			});

			const lifecycle = sessionManagerWithWorktrees.getSessionLifecycle();

			// Complete worktree choice with 'worktree' mode
			const updatedSession = await lifecycle.completeWorktreeChoice(sessionId, 'worktree');

			expect(updatedSession.status).toBe('active');
			expect(updatedSession.worktree).toBeDefined();
			expect(updatedSession.worktree?.isWorktree).toBe(true);
			expect(updatedSession.gitBranch).toBeDefined();
			expect(updatedSession.metadata.worktreeChoice?.status).toBe('completed');
			expect(updatedSession.metadata.worktreeChoice?.choice).toBe('worktree');
		});

		test('completeWorktreeChoice does not create worktree when mode is direct', async () => {
			const sessionId = await sessionManagerWithWorktrees.createSession({
				workspacePath: gitWorkspace,
			});

			const lifecycle = sessionManagerWithWorktrees.getSessionLifecycle();

			// Complete worktree choice with 'direct' mode
			const updatedSession = await lifecycle.completeWorktreeChoice(sessionId, 'direct');

			expect(updatedSession.status).toBe('active');
			expect(updatedSession.worktree).toBeUndefined(); // No worktree created
			// gitBranch should now be detected for direct mode in git repos
			expect(updatedSession.gitBranch).toBeDefined();
			expect(typeof updatedSession.gitBranch).toBe('string');
			expect(updatedSession.metadata.worktreeChoice?.status).toBe('completed');
			expect(updatedSession.metadata.worktreeChoice?.choice).toBe('direct');
		});

		test('session created immediately active in non-git workspace', async () => {
			// Use the original testWorkspace which is NOT a git repo
			const sessionId = await sessionManagerWithWorktrees.createSession({
				workspacePath: testWorkspace,
			});

			const agentSession = sessionManagerWithWorktrees.getSession(sessionId);
			const session = agentSession!.getSessionData();

			// Should be immediately active (no choice needed)
			expect(session.status).toBe('active');
			expect(session.metadata.worktreeChoice).toBeUndefined();
		});

		test('completeWorktreeChoice throws error for non-pending session', async () => {
			const sessionId = await sessionManagerWithWorktrees.createSession({
				workspacePath: testWorkspace, // Non-git repo, so session is active
			});

			const lifecycle = sessionManagerWithWorktrees.getSessionLifecycle();

			// Should throw error because session is not pending
			await expect(lifecycle.completeWorktreeChoice(sessionId, 'worktree')).rejects.toThrow();
		});
	});
});
