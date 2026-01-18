/**
 * Context Usage Dropdown Close Behavior E2E Tests
 *
 * Tests for context usage dropdown close behaviors:
 * - Close dropdown when clicking close button
 * - Close dropdown with Escape key (skipped - not implemented)
 * - Close dropdown when clicking outside (skipped - not working reliably)
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	cleanupTestSession,
	waitForAssistantResponse,
} from './helpers/wait-helpers';

test.describe('Context Usage - Dropdown Close Behavior', () => {
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

	test('should close dropdown when clicking close button', async ({ page }) => {
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

		// Wait for dropdown to appear
		await expect(page.locator('text=Context Usage')).toBeVisible({
			timeout: 5000,
		});

		// Click close button (X button in dropdown header)
		const closeButton = page
			.locator('button')
			.filter({ has: page.locator('svg line') })
			.last();
		await closeButton.click();

		// Dropdown should close
		await expect(page.locator('text=Context Usage')).not.toBeVisible({
			timeout: 3000,
		});
	});

	test.skip('should close dropdown with Escape key', async ({ page }) => {
		// TODO: Escape key close not implemented in dropdown
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

		// Wait for dropdown to appear
		await expect(page.locator('text=Context Usage')).toBeVisible({
			timeout: 5000,
		});

		// Press Escape
		await page.keyboard.press('Escape');

		// Dropdown should close
		await expect(page.locator('text=Context Usage')).not.toBeVisible({
			timeout: 3000,
		});
	});

	test.skip('should close dropdown when clicking outside', async ({ page }) => {
		// TODO: Click outside close not working reliably
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

		// Wait for dropdown to appear
		await expect(page.locator('text=Context Usage')).toBeVisible({
			timeout: 5000,
		});

		// Click outside the dropdown by clicking at a fixed position on the page
		// Use mouse.click to click at coordinates in the center-left of the screen
		await page.mouse.click(100, 300);

		// Dropdown should close
		await expect(page.locator('text=Context Usage')).not.toBeVisible({
			timeout: 3000,
		});
	});
});
