import { test, expect, type Page } from '@playwright/test';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

// Test project configuration
test.use({
	storageState: undefined, // Start fresh for each test
});

test.describe('Git Worktree Integration', () => {
	const testRepoPath = join(process.cwd(), 'tmp', 'test-worktree-repo');

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
		await execAsync('git config user.email "test@example.com"', { cwd: testRepoPath });

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

	/**
	 * Helper: Create a session via UI and return session ID
	 */
	async function createSessionViaUI(page: Page): Promise<string> {
		// Click new session button
		await page.click('button:has-text("New Session")');

		// Wait for session to be created and navigate
		await page.waitForURL(/\//, { timeout: 10000 });

		// Extract session ID from success notification or URL
		// The session ID is in the URL or we can get it from the session list
		const sessionButton = page.locator('button[data-session-id]').first();
		const sessionId = await sessionButton.getAttribute('data-session-id');

		if (!sessionId) {
			throw new Error('Failed to get session ID after creation');
		}

		return sessionId;
	}

	/**
	 * Helper: Delete a session via UI
	 */
	async function deleteSessionViaUI(page: Page, sessionId: string) {
		// Find the session in sidebar
		const sessionButton = page.locator(`button[data-session-id="${sessionId}"]`);
		await sessionButton.waitFor({ state: 'visible', timeout: 5000 });

		// Click session options
		await page.click('button[aria-label="Session options"]');

		// Click delete option
		await page.click('text=Delete Session');

		// Confirm deletion
		await page.click('button:has-text("Delete")');

		// Wait for session to be removed from list
		await sessionButton.waitFor({ state: 'detached', timeout: 5000 });
	}

	/**
	 * Helper: Check if worktree exists using git command
	 */
	async function worktreeExists(sessionId: string): Promise<boolean> {
		try {
			const { stdout } = await execAsync('git worktree list --porcelain', { cwd: testRepoPath });
			return stdout.includes(`.worktrees/${sessionId}`);
		} catch {
			return false;
		}
	}

	/**
	 * Helper: Check if branch exists
	 */
	async function branchExists(branchName: string): Promise<boolean> {
		try {
			const { stdout } = await execAsync('git branch --list', { cwd: testRepoPath });
			return stdout.includes(branchName);
		} catch {
			return false;
		}
	}

	test.beforeAll(async () => {
		await createTestGitRepo();
	});

	test.afterAll(() => {
		cleanupTestRepo();
	});

	test('should create worktree for session in git repository', async ({ page }) => {
		await page.goto('/');

		// Wait for app to load
		await page.waitForSelector('button:has-text("New Session")');

		// Create new session
		const sessionId = await createSessionViaUI(page);

		// Verify session was created
		expect(sessionId).toBeTruthy();

		// Give server time to create worktree
		await page.waitForTimeout(1000);

		// Check if worktree was created
		const hasWorktree = await worktreeExists(sessionId);
		expect(hasWorktree).toBe(true);

		// Check if branch was created
		const hasBranch = await branchExists(`session/${sessionId}`);
		expect(hasBranch).toBe(true);

		// Verify worktree directory exists
		const worktreeDir = join(testRepoPath, '.worktrees', sessionId);
		expect(existsSync(worktreeDir)).toBe(true);

		// Clean up
		await deleteSessionViaUI(page, sessionId);
	});

	test('should show worktree badge in session list', async ({ page }) => {
		await page.goto('/');

		// Create new session
		const sessionId = await createSessionViaUI(page);

		// Wait for session to appear in sidebar
		await page.waitForSelector(`button[data-session-id="${sessionId}"]`);

		// Check for worktree badge (purple icon)
		const sessionItem = page.locator(`button[data-session-id="${sessionId}"]`);
		const worktreeBadge = sessionItem.locator('span[title*="Worktree:"]');

		// Verify badge is visible
		await expect(worktreeBadge).toBeVisible();

		// Verify tooltip shows branch name
		const title = await worktreeBadge.getAttribute('title');
		expect(title).toContain(`session/${sessionId}`);

		// Clean up
		await deleteSessionViaUI(page, sessionId);
	});

	test('should delete worktree when session is deleted', async ({ page }) => {
		await page.goto('/');

		// Create new session
		const sessionId = await createSessionViaUI(page);

		// Verify worktree exists
		await page.waitForTimeout(1000);
		let hasWorktree = await worktreeExists(sessionId);
		expect(hasWorktree).toBe(true);

		// Delete session
		await deleteSessionViaUI(page, sessionId);

		// Give server time to cleanup
		await page.waitForTimeout(1000);

		// Verify worktree was removed
		hasWorktree = await worktreeExists(sessionId);
		expect(hasWorktree).toBe(false);

		// Verify branch was deleted
		const hasBranch = await branchExists(`session/${sessionId}`);
		expect(hasBranch).toBe(false);

		// Verify directory was removed
		const worktreeDir = join(testRepoPath, '.worktrees', sessionId);
		expect(existsSync(worktreeDir)).toBe(false);
	});

	test('should handle multiple concurrent sessions with worktrees', async ({ page }) => {
		await page.goto('/');

		// Create three sessions
		const sessionId1 = await createSessionViaUI(page);
		await page.waitForTimeout(500);

		await page.click('button:has-text("New Session")');
		await page.waitForTimeout(500);
		const sessionButton2 = page.locator('button[data-session-id]').first();
		const sessionId2 = await sessionButton2.getAttribute('data-session-id');

		await page.click('button:has-text("New Session")');
		await page.waitForTimeout(500);
		const sessionButton3 = page.locator('button[data-session-id]').first();
		const sessionId3 = await sessionButton3.getAttribute('data-session-id');

		// Verify all worktrees exist
		await page.waitForTimeout(1500);
		expect(await worktreeExists(sessionId1!)).toBe(true);
		expect(await worktreeExists(sessionId2!)).toBe(true);
		expect(await worktreeExists(sessionId3!)).toBe(true);

		// Verify all branches exist
		expect(await branchExists(`session/${sessionId1}`)).toBe(true);
		expect(await branchExists(`session/${sessionId2}`)).toBe(true);
		expect(await branchExists(`session/${sessionId3}`)).toBe(true);

		// Verify all worktree badges are visible
		await expect(
			page.locator(`button[data-session-id="${sessionId1}"] span[title*="Worktree:"]`)
		).toBeVisible();
		await expect(
			page.locator(`button[data-session-id="${sessionId2}"] span[title*="Worktree:"]`)
		).toBeVisible();
		await expect(
			page.locator(`button[data-session-id="${sessionId3}"] span[title*="Worktree:"]`)
		).toBeVisible();

		// Clean up all sessions
		await deleteSessionViaUI(page, sessionId1!);
		await deleteSessionViaUI(page, sessionId2!);
		await deleteSessionViaUI(page, sessionId3!);

		// Verify all worktrees are removed
		await page.waitForTimeout(1500);
		expect(await worktreeExists(sessionId1!)).toBe(false);
		expect(await worktreeExists(sessionId2!)).toBe(false);
		expect(await worktreeExists(sessionId3!)).toBe(false);
	});

	test('should isolate file changes between worktree sessions', async ({ page }) => {
		await page.goto('/');

		// Create two sessions
		const sessionId1 = await createSessionViaUI(page);
		await page.waitForTimeout(500);

		await page.click('button:has-text("New Session")');
		await page.waitForTimeout(500);
		const sessionButton2 = page.locator('button[data-session-id]').first();
		const sessionId2 = await sessionButton2.getAttribute('data-session-id');

		await page.waitForTimeout(1000);

		// Create different files in each worktree
		const worktree1Path = join(testRepoPath, '.worktrees', sessionId1);
		const worktree2Path = join(testRepoPath, '.worktrees', sessionId2!);

		await execAsync(`echo "Session 1 file" > session1.txt`, { cwd: worktree1Path });
		await execAsync(`echo "Session 2 file" > session2.txt`, { cwd: worktree2Path });

		// Verify files are isolated
		expect(existsSync(join(worktree1Path, 'session1.txt'))).toBe(true);
		expect(existsSync(join(worktree1Path, 'session2.txt'))).toBe(false);

		expect(existsSync(join(worktree2Path, 'session2.txt'))).toBe(true);
		expect(existsSync(join(worktree2Path, 'session1.txt'))).toBe(false);

		// Clean up
		await deleteSessionViaUI(page, sessionId1);
		await deleteSessionViaUI(page, sessionId2!);
	});

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

		// Clean up
		await page.click('button[aria-label="Session options"]');
		await page.click('text=Delete Session');
		await page.click('button:has-text("Delete")');
	});
});

test.describe('Worktree Manual Cleanup', () => {
	const testRepoPath = join(process.cwd(), 'tmp', 'test-cleanup-repo');

	async function createTestGitRepo() {
		if (existsSync(testRepoPath)) {
			rmSync(testRepoPath, { recursive: true, force: true });
		}

		mkdirSync(testRepoPath, { recursive: true });

		await execAsync('git init', { cwd: testRepoPath });
		await execAsync('git config user.name "Test User"', { cwd: testRepoPath });
		await execAsync('git config user.email "test@example.com"', { cwd: testRepoPath });
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

		// Call cleanup via browser console (simulating RPC call)
		await page.evaluate(async () => {
			// Access messageHub from global state
			const { messageHub } = await import('../packages/web/src/lib/state.ts');
			const result = await messageHub.call('worktree.cleanup', {});
			return result;
		});

		// Give time for cleanup to complete
		await page.waitForTimeout(2000);

		// Verify orphaned worktree was removed
		const { stdout } = await execAsync('git worktree list --porcelain', { cwd: testRepoPath });
		expect(stdout).not.toContain('.worktrees/orphaned-test-session');

		// Verify branch was deleted
		const { stdout: branches } = await execAsync('git branch --list', { cwd: testRepoPath });
		expect(branches).not.toContain('session/orphaned-test-session');
	});
});
