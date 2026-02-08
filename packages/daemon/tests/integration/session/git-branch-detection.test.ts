/**
 * Git Branch Detection Tests
 *
 * Tests that session creation detects and stores the current git branch
 * for non-worktree sessions in git repositories.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import simpleGit from 'simple-git';
import { Database } from '../../../src/storage/database';
import { SessionManager } from '../../../src/lib/session-manager';
import { MessageHub } from '@neokai/shared';
import { createDaemonHub, type DaemonHub } from '../../../src/lib/daemon-hub';
import type { AuthManager } from '../../../src/lib/auth-manager';

describe('Git Branch Detection', () => {
	let tempDir: string;
	let db: Database;
	let sessionManager: SessionManager;
	let messageHub: MessageHub;
	let eventBus: DaemonHub;

	beforeEach(async () => {
		// Create temporary directory for test git repo
		tempDir = mkdtempSync(join(tmpdir(), 'neokai-git-branch-test-'));

		// Initialize git repo with a branch
		const git = simpleGit(tempDir);
		await git.init();
		await git.addConfig('user.email', 'test@example.com');
		await git.addConfig('user.name', 'Test User');

		// Create initial commit on main branch
		await git.checkoutLocalBranch('main');
		await git.raw(['commit', '--allow-empty', '-m', 'Initial commit']);

		// Create and checkout a feature branch
		await git.checkoutLocalBranch('feature/test-branch');

		// Setup database
		db = new Database(':memory:');
		await db.initialize();

		// Initialize MessageHub
		messageHub = new MessageHub();

		// Initialize DaemonHub
		eventBus = createDaemonHub('test-hub');
		await eventBus.initialize();

		// Mock AuthManager
		const mockAuthManager = {
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
		} as unknown as import('../../../src/lib/settings-manager').SettingsManager;

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
				temperature: 0.7,
				workspaceRoot: tempDir,
				disableWorktrees: true, // Disable worktrees for direct mode testing
			}
		);
	});

	afterEach(async () => {
		// Cleanup session resources
		try {
			await sessionManager.cleanup();
		} catch {
			// Ignore cleanup errors
		}

		// Wait for async operations to complete
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Close database
		try {
			db.close();
		} catch {
			// Ignore if db is already closed
		}

		// Remove temp directory
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('should detect and set gitBranch for non-worktree sessions in git repos', async () => {
		// Create session in git repo
		const sessionId = await sessionManager.createSession({
			workspacePath: tempDir,
		});

		// Get session from database
		const session = db.getSession(sessionId);

		// Verify gitBranch is set to the current branch
		expect(session).not.toBeNull();
		expect(session?.gitBranch).toBe('feature/test-branch');
	});

	it('should detect gitBranch on main branch', async () => {
		// Checkout main branch
		const git = simpleGit(tempDir);
		await git.checkout('main');

		// Create session
		const sessionId = await sessionManager.createSession({
			workspacePath: tempDir,
		});

		// Verify gitBranch is set to main
		const session = db.getSession(sessionId);
		expect(session?.gitBranch).toBe('main');
	});

	it('should not set gitBranch for non-git directories', async () => {
		// Create a new temp directory that's not a git repo
		const nonGitDir = mkdtempSync(join(tmpdir(), 'neokai-non-git-test-'));

		try {
			const sessionId = await sessionManager.createSession({
				workspacePath: nonGitDir,
			});

			const session = db.getSession(sessionId);
			expect(session?.gitBranch).toBeUndefined();
		} finally {
			rmSync(nonGitDir, { recursive: true, force: true });
		}
	});
});
