import { test, expect } from '@playwright/test';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

/**
 * Session Export E2E Tests
 *
 * Tests the session export functionality:
 * - Export option in session menu
 * - Markdown export format
 * - File download behavior
 * - Export with messages included
 */
test.describe('Session Export', () => {
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

	test('should show Export Chat option in session options menu', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open session options menu (3 dots button)
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await expect(optionsButton).toBeVisible();
		await optionsButton.click();

		// Check for Export Chat option
		await expect(page.locator('text=Export Chat')).toBeVisible();
	});

	test('should export session to Markdown file', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a test message to have content to export
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Hello, this is a test message for export.');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });

		// Setup download listener
		const downloadPromise = page.waitForEvent('download');

		// Open session options menu and click Export
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page.locator('text=Export Chat').click();

		// Verify download was triggered
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toContain('.md');
	});

	test('should include messages in exported Markdown', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a test message with unique content
		const testMessage = 'Unique export test message ' + Date.now();
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill(testMessage);
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });

		// Setup download listener
		const downloadPromise = page.waitForEvent('download');

		// Open session options menu and click Export
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page.locator('text=Export Chat').click();

		// Verify download and check content
		const download = await downloadPromise;
		const content = await download.createReadStream().then(async (stream) => {
			const chunks: Buffer[] = [];
			for await (const chunk of stream) {
				chunks.push(chunk);
			}
			return Buffer.concat(chunks).toString('utf-8');
		});

		// Verify the exported content includes our message
		expect(content).toContain(testMessage);
	});

	test('should show success toast after export', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a test message
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Test message for toast');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });

		// Setup download listener (need to handle download to complete export)
		const downloadPromise = page.waitForEvent('download');

		// Open session options menu and click Export
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page.locator('text=Export Chat').click();

		// Wait for download to complete
		await downloadPromise;

		// Check for success toast
		await expect(page.locator('text=Chat exported!')).toBeVisible({ timeout: 5000 });
	});

	test('should disable Export when disconnected', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open session options menu
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();

		// Export should be visible and enabled when connected
		const exportOption = page.locator('text=Export Chat');
		await expect(exportOption).toBeVisible();

		// Simulate disconnection
		await page.evaluate(() => {
			(
				window as unknown as { connectionManager: { simulateDisconnect: () => void } }
			).connectionManager.simulateDisconnect();
		});

		// Wait for offline state
		await expect(page.locator('text=Offline').first()).toBeVisible({ timeout: 10000 });

		// Reopen menu and check if Export is disabled
		// Close current dropdown first
		await page.keyboard.press('Escape');
		await page.waitForTimeout(500);

		// Reopen menu
		await optionsButton.click();

		// Export Chat option should be disabled (has disabled styling or aria-disabled)
		const exportButton = page.locator('[role="menuitem"]:has-text("Export Chat")');
		const isDisabled = await exportButton.evaluate((el) => {
			const classes = el.className;
			const ariaDisabled = el.getAttribute('aria-disabled');
			return (
				classes.includes('opacity-50') ||
				classes.includes('cursor-not-allowed') ||
				ariaDisabled === 'true'
			);
		});
		expect(isDisabled).toBe(true);
	});
});
