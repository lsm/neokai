/**
 * Context Usage Dropdown E2E Tests
 *
 * Tests the context usage bar and dropdown in SessionStatusBar:
 * - Context usage indicator display (pie chart mobile, bar desktop)
 * - Dropdown open/close behaviors
 * - Escape key to close dropdown
 * - Click outside to close dropdown
 * - Breakdown categories display
 * - Close button functionality
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	cleanupTestSession,
	waitForAssistantResponse,
} from './helpers/wait-helpers';

test.describe('Context Usage Dropdown', () => {
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

	test('should display context usage indicator', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Context usage bar should be visible (the clickable indicator area)
		// Title is "Context data loading..." initially
		const contextIndicator = page.locator('[title="Context data loading..."]');
		await expect(contextIndicator).toBeVisible({ timeout: 10000 });
	});

	test('should show context loading state initially', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Initial state should show loading message
		const loadingIndicator = page.locator('[title="Context data loading..."]');
		await expect(loadingIndicator).toBeVisible({ timeout: 10000 });
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
		await expect(page.locator('text=Context Usage')).toBeVisible({ timeout: 5000 });
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
		await expect(page.locator('text=Context Window')).toBeVisible({ timeout: 5000 });
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
		await expect(page.locator('text=Context Usage')).toBeVisible({ timeout: 5000 });

		// Click close button (X button in dropdown header)
		const closeButton = page
			.locator('button')
			.filter({ has: page.locator('svg line') })
			.last();
		await closeButton.click();

		// Dropdown should close
		await expect(page.locator('text=Context Usage')).not.toBeVisible({ timeout: 3000 });
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
		await expect(page.locator('text=Context Usage')).toBeVisible({ timeout: 5000 });

		// Press Escape
		await page.keyboard.press('Escape');

		// Dropdown should close
		await expect(page.locator('text=Context Usage')).not.toBeVisible({ timeout: 3000 });
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
		await expect(page.locator('text=Context Usage')).toBeVisible({ timeout: 5000 });

		// Click outside the dropdown by clicking at a fixed position on the page
		// Use mouse.click to click at coordinates in the center-left of the screen
		await page.mouse.click(100, 300);

		// Dropdown should close
		await expect(page.locator('text=Context Usage')).not.toBeVisible({ timeout: 3000 });
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

	test('should toggle dropdown when clicking indicator again', async ({ page }) => {
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
		await expect(page.locator('text=Context Usage')).toBeVisible({ timeout: 5000 });

		// Click indicator again to close
		await contextIndicator.click();

		// Dropdown should close
		await expect(page.locator('text=Context Usage')).not.toBeVisible({ timeout: 3000 });
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
		await expect(page.locator('text=Context Usage')).toBeVisible({ timeout: 5000 });

		// The dropdown should have a progress bar (div with rounded-full and overflow-hidden)
		const progressBar = page.locator('.rounded-full.overflow-hidden').first();
		await expect(progressBar).toBeVisible();
	});
});
