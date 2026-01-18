/**
 * Context Usage Dropdown Content E2E Tests
 *
 * Tests for context usage dropdown content:
 * - Opening dropdown after message exchange
 * - Context window percentage display
 * - Breakdown section display
 * - Model information display
 * - Token counts in breakdown
 * - Progress bar in context window section
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	cleanupTestSession,
	waitForAssistantResponse,
} from './helpers/wait-helpers';

test.describe('Context Usage - Dropdown Content', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
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

	test('should open dropdown when clicking context indicator after message exchange', async ({
		page,
	}) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to populate context data
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');

		// Wait for assistant response (this populates context data)
		await waitForAssistantResponse(page);

		// Now click on context indicator (should have "Click for context details" title)
		const contextIndicator = page.locator('[title="Click for context details"]');
		await expect(contextIndicator).toBeVisible({ timeout: 15000 });
		await contextIndicator.click();

		// Dropdown should appear with "Context Usage" header
		await expect(page.locator('text=Context Usage')).toBeVisible({
			timeout: 5000,
		});
	});

	test('should show context window percentage in dropdown', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to populate context data
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');

		// Wait for assistant response
		await waitForAssistantResponse(page);

		// Open context dropdown
		const contextIndicator = page.locator('[title="Click for context details"]');
		await expect(contextIndicator).toBeVisible({ timeout: 15000 });
		await contextIndicator.click();

		// Should show "Context Window" label
		await expect(page.locator('text=Context Window')).toBeVisible({
			timeout: 5000,
		});
	});

	test('should show breakdown section in dropdown', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to populate context data
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');

		// Wait for assistant response
		await waitForAssistantResponse(page);

		// Open context dropdown
		const contextIndicator = page.locator('[title="Click for context details"]');
		await expect(contextIndicator).toBeVisible({ timeout: 15000 });
		await contextIndicator.click();

		// Should show "Breakdown" section header
		await expect(page.locator('text=Breakdown')).toBeVisible({ timeout: 5000 });
	});

	test('should show model information in dropdown', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to populate context data
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');

		// Wait for assistant response
		await waitForAssistantResponse(page);

		// Open context dropdown
		const contextIndicator = page.locator('[title="Click for context details"]');
		await expect(contextIndicator).toBeVisible({ timeout: 15000 });
		await contextIndicator.click();

		// Should show "Model:" label
		await expect(page.locator('text=Model:')).toBeVisible({ timeout: 5000 });
	});

	test('should display token counts in breakdown', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to populate context data
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');

		// Wait for assistant response
		await waitForAssistantResponse(page);

		// Open context dropdown
		const contextIndicator = page.locator('[title="Click for context details"]');
		await expect(contextIndicator).toBeVisible({ timeout: 15000 });
		await contextIndicator.click();

		// Wait for breakdown section
		await expect(page.locator('text=Breakdown')).toBeVisible({ timeout: 5000 });

		// Check that percentage values are displayed (format: X.X%)
		const percentagePattern = page.locator('text=/%$/');
		await expect(percentagePattern.first()).toBeVisible();
	});

	test('should show progress bar in context window section', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to populate context data
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');

		// Wait for assistant response
		await waitForAssistantResponse(page);

		// Open context dropdown
		const contextIndicator = page.locator('[title="Click for context details"]');
		await expect(contextIndicator).toBeVisible({ timeout: 15000 });
		await contextIndicator.click();

		// Wait for dropdown
		await expect(page.locator('text=Context Usage')).toBeVisible({
			timeout: 5000,
		});

		// The dropdown should have a progress bar (div with rounded-full and overflow-hidden)
		const progressBar = page.locator('.rounded-full.overflow-hidden').first();
		await expect(progressBar).toBeVisible();
	});
});
