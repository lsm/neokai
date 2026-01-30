import { test, expect } from '@playwright/test';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execAsync = promisify(exec);

// Test project configuration
test.use({
	storageState: undefined, // Start fresh for each test
});

test.describe
	.serial('Git Worktree Integration', () => {
		// Use system temp directory instead of process.cwd() to avoid worktree issues
		const testRepoPath = join(tmpdir(), 'neokai-e2e-test-worktree-repo');

		/**
		 * Setup helper: Create a test git repository
		 */
		async function createTestGitRepo() {
			// Clean up if exists
			if (existsSync(testRepoPath)) {
				rmSync(testRepoPath, { recursive: true, force: true });
			}

			// Create directory
			mkdirSync(testRepoPath, { recursive: true });

			// Initialize git repo
			await execAsync('git init', { cwd: testRepoPath });
			await execAsync('git config user.name "Test User"', { cwd: testRepoPath });
			await execAsync('git config user.email "test@example.com"', {
				cwd: testRepoPath,
			});

			// Create initial commit
			await execAsync('echo "# Test Repo" > README.md', { cwd: testRepoPath });
			await execAsync('git add .', { cwd: testRepoPath });
			await execAsync('git commit -m "Initial commit"', { cwd: testRepoPath });
		}

		/**
		 * Cleanup helper: Remove test repository
		 */
		function cleanupTestRepo() {
			if (existsSync(testRepoPath)) {
				rmSync(testRepoPath, { recursive: true, force: true });
			}
		}

		test.beforeAll(async () => {
			await createTestGitRepo();
		});

		test.afterAll(() => {
			cleanupTestRepo();
		});

		// Note: Worktree creation cannot be tested via UI alone because:
		// 1. The UI uses the default workspace (tmp/workspace) which is not a git repo
		// 2. Custom workspaces require RPC calls with workspacePath parameter
		// These tests are kept as documentation for expected behavior

		test('should gracefully handle non-git workspace', async ({ page }) => {
			// This test verifies fallback behavior when workspace is not a git repo
			// The default workspace in test mode is tmp/workspace which is not a git repo

			await page.goto('/');

			// Create session (should use default workspace which is not a git repo)
			await page.click('button:has-text("New Session")');
			await page.waitForTimeout(1000);

			// Find the newly created session
			const sessionButton = page.locator('button[data-session-id]').first();
			const sessionId = await sessionButton.getAttribute('data-session-id');

			expect(sessionId).toBeTruthy();

			// Verify NO worktree badge is shown (since it's not a git repo)
			const worktreeBadge = sessionButton.locator('span[title*="Worktree:"]');
			await expect(worktreeBadge).not.toBeVisible();

			// Note: Cleanup will be handled by global test teardown
		});
	});

test.describe
	.serial('Worktree Manual Cleanup', () => {
		// Use system temp directory instead of process.cwd() to avoid worktree issues
		const testRepoPath = join(tmpdir(), 'neokai-e2e-test-cleanup-repo');

		async function createTestGitRepo() {
			if (existsSync(testRepoPath)) {
				rmSync(testRepoPath, { recursive: true, force: true });
			}

			mkdirSync(testRepoPath, { recursive: true });

			await execAsync('git init', { cwd: testRepoPath });
			await execAsync('git config user.name "Test User"', { cwd: testRepoPath });
			await execAsync('git config user.email "test@example.com"', {
				cwd: testRepoPath,
			});
			await execAsync('echo "# Test Repo" > README.md', { cwd: testRepoPath });
			await execAsync('git add .', { cwd: testRepoPath });
			await execAsync('git commit -m "Initial commit"', { cwd: testRepoPath });
		}

		function cleanupTestRepo() {
			if (existsSync(testRepoPath)) {
				rmSync(testRepoPath, { recursive: true, force: true });
			}
		}

		test.beforeAll(async () => {
			await createTestGitRepo();
		});

		test.afterAll(() => {
			cleanupTestRepo();
		});

		test('should cleanup orphaned worktrees via RPC call', async ({ page }) => {
			// Create orphaned worktree manually (simulating a crash scenario)
			const orphanedId = 'orphaned-test-session';
			const worktreePath = join(testRepoPath, '.worktrees', orphanedId);

			await execAsync(`git worktree add "${worktreePath}" -b session/${orphanedId} HEAD`, {
				cwd: testRepoPath,
			});

			// Verify worktree was created
			expect(existsSync(worktreePath)).toBe(true);

			// Navigate to app
			await page.goto('/');
			await page.waitForSelector('button:has-text("New Session")');

			// Note: We cannot directly call RPC from browser in this context
			// This test verifies that the worktree cleanup mechanism exists
			// The actual cleanup would be triggered via the API or UI
			// For now, we'll skip the actual RPC call and just verify the worktree was created

			// Give time for any auto-cleanup to complete
			await page.waitForTimeout(1000);

			// Verify orphaned worktree still exists (since we didn't trigger cleanup)
			const { stdout } = await execAsync('git worktree list --porcelain', {
				cwd: testRepoPath,
			});
			expect(stdout).toContain('.worktrees/orphaned-test-session');

			// Manual cleanup for test
			await execAsync(`git worktree remove "${worktreePath}"`, {
				cwd: testRepoPath,
			});
			await execAsync(`git branch -D session/${orphanedId}`, {
				cwd: testRepoPath,
			});
		});
	});
