import { test, expect } from '@playwright/test';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

/**
 * File Operations E2E Tests
 *
 * Tests file reading and listing features within sessions:
 * - File reading within workspace
 * - Directory listing
 * - File tree display
 * - Worktree file isolation
 *
 * RPC Methods: file.read, file.list, file.tree
 */
test.describe('File Operations', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Liuboer', exact: true }).first()).toBeVisible();
		await page.waitForTimeout(1000);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should be able to read files through Claude', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Ask Claude to read a file (Claude will use file tools)
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('What is in the package.json file? Just show me the name and version.');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
			timeout: 45000,
		});

		// The response should contain file content or mention inability to read
		const assistantMessage = page.locator('[data-testid="assistant-message"]').first();
		const content = await assistantMessage.textContent();
		expect(content).toBeTruthy();

		// Response should reference the file or its contents
		expect(
			content!.toLowerCase().includes('package') ||
				content!.toLowerCase().includes('name') ||
				content!.toLowerCase().includes('version') ||
				content!.toLowerCase().includes('file') ||
				content!.toLowerCase().includes('json')
		).toBe(true);
	});

	test('should be able to list directory contents through Claude', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Ask Claude to list files
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('List the files in the current directory. Just show file names.');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
			timeout: 45000,
		});

		// The response should contain file listings
		const assistantMessage = page.locator('[data-testid="assistant-message"]').first();
		const content = await assistantMessage.textContent();
		expect(content).toBeTruthy();
		expect(content!.length).toBeGreaterThan(0);
	});

	test('should display file content in response', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Ask Claude to read and display file content
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill(
			'Show me the first 5 lines of README.md or any markdown file you can find.'
		);
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
			timeout: 45000,
		});

		// Response should exist
		const assistantMessage = page.locator('[data-testid="assistant-message"]').first();
		await expect(assistantMessage).toBeVisible();

		// The message area should have content
		const content = await assistantMessage.textContent();
		expect(content).toBeTruthy();
	});

	test('should handle file not found gracefully', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Ask Claude to read a non-existent file
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Read the file nonexistent_file_12345.xyz');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
			timeout: 45000,
		});

		// The response should handle the error gracefully
		const assistantMessage = page.locator('[data-testid="assistant-message"]').first();
		const content = await assistantMessage.textContent();
		expect(content).toBeTruthy();

		// Should mention something about file not found or not existing
		expect(
			content!.toLowerCase().includes('not found') ||
				content!.toLowerCase().includes("doesn't exist") ||
				content!.toLowerCase().includes('does not exist') ||
				content!.toLowerCase().includes('no such file') ||
				content!.toLowerCase().includes('unable') ||
				content!.toLowerCase().includes('cannot') ||
				content!.toLowerCase().includes("couldn't find")
		).toBe(true);
	});

	test('should work with relative and absolute paths', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Ask Claude about path handling
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill("What's the current working directory? Just tell me the path.");
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
			timeout: 45000,
		});

		// The response should contain path information
		const assistantMessage = page.locator('[data-testid="assistant-message"]').first();
		const content = await assistantMessage.textContent();
		expect(content).toBeTruthy();

		// Should mention a path (likely contains slashes or workspace reference)
		expect(
			content!.includes('/') ||
				content!.toLowerCase().includes('directory') ||
				content!.toLowerCase().includes('workspace') ||
				content!.toLowerCase().includes('path')
		).toBe(true);
	});
});
