import { test, expect } from '@playwright/test';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

/**
 * Context Dropdown E2E Tests
 *
 * Tests the context usage dropdown in the status indicator.
 * - Context percentage display
 * - Dropdown visibility on click
 * - Context category breakdown
 */
test.describe('Context Dropdown', () => {
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

	test('should display context percentage after message exchange', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').click();
		sessionId = await waitForSessionCreated(page);

		// Send a test message
		const textarea = page.locator('textarea[placeholder*="message"]').first();
		await textarea.fill('Hello, what is 2+2?');
		await page.keyboard.press('Meta+Enter'); // Cmd+Enter on Mac

		// Wait for response to complete (look for the assistant message)
		await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });

		// Context percentage should be visible
		const contextPercentage = page.locator('.text-xs.font-medium:has-text("%")').first();
		await expect(contextPercentage).toBeVisible();
	});

	test('should open dropdown on context percentage click', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').click();
		sessionId = await waitForSessionCreated(page);

		// Send a test message
		const textarea = page.locator('textarea[placeholder*="message"]').first();
		await textarea.fill('Hello, what is 2+2?');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });

		// Click on context percentage to open dropdown
		const contextPercentage = page.locator('.text-xs.font-medium:has-text("%")').first();
		await expect(contextPercentage).toBeVisible();
		await contextPercentage.click();

		// Dropdown should appear with context categories
		// Look for common context categories like "System prompt", "Messages", etc.
		await expect(page.locator('text=System prompt').first()).toBeVisible({ timeout: 2000 });
	});

	test('should show context category breakdown in dropdown', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').click();
		sessionId = await waitForSessionCreated(page);

		// Send a test message
		const textarea = page.locator('textarea[placeholder*="message"]').first();
		await textarea.fill('Hello, what is 2+2?');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });

		// Click on context percentage
		const contextPercentage = page.locator('.text-xs.font-medium:has-text("%")').first();
		await expect(contextPercentage).toBeVisible();
		await contextPercentage.click();

		// Verify context categories are displayed
		// These are common categories from ContextInfo type
		await expect(page.locator('text=System prompt').first()).toBeVisible();
		await expect(page.locator('text=Messages').first()).toBeVisible();

		// Take screenshot for visual verification
		await page.screenshot({ path: 'test-results/context-dropdown.png', fullPage: true });
	});
});
