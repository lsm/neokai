import { test, expect } from '@playwright/test';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

/**
 * Auto-Scroll Toggle E2E Tests
 *
 * Tests the auto-scroll toggle feature in the chat input toolbar.
 * - Toggle button visibility and state
 * - Persistence of setting across page reloads
 * - Visual feedback when enabled/disabled
 */
test.describe('Auto-Scroll Toggle', () => {
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

	test('should display auto-scroll toggle button in chat input toolbar', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').click();
		sessionId = await waitForSessionCreated(page);

		// The auto-scroll toggle button should be visible in the input toolbar
		// It has a title attribute for identification
		const autoScrollButton = page.locator('button[title*="Auto-scroll"]');
		await expect(autoScrollButton).toBeVisible();
	});

	test('should toggle auto-scroll state on click', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').click();
		sessionId = await waitForSessionCreated(page);

		const autoScrollButton = page.locator('button[title*="Auto-scroll"]');
		await expect(autoScrollButton).toBeVisible();

		// Initially disabled (gray color) - check title text
		await expect(autoScrollButton).toHaveAttribute('title', /disabled/i);

		// Click to enable
		await autoScrollButton.click();
		await page.waitForTimeout(500);

		// Should now show enabled state
		await expect(autoScrollButton).toHaveAttribute('title', /enabled/i);

		// Click again to disable
		await autoScrollButton.click();
		await page.waitForTimeout(500);

		// Should show disabled state again
		await expect(autoScrollButton).toHaveAttribute('title', /disabled/i);
	});

	test('should persist auto-scroll setting across page reload', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').click();
		sessionId = await waitForSessionCreated(page);

		const autoScrollButton = page.locator('button[title*="Auto-scroll"]');
		await expect(autoScrollButton).toBeVisible();

		// Enable auto-scroll
		await autoScrollButton.click();
		await page.waitForTimeout(500);

		// Verify enabled
		await expect(autoScrollButton).toHaveAttribute('title', /enabled/i);

		// Reload the page
		await page.reload();
		await page.waitForTimeout(1500);

		// Navigate back to the session (it should load from URL or sidebar)
		// The session should still be selected after reload
		const autoScrollButtonAfterReload = page.locator('button[title*="Auto-scroll"]');
		await expect(autoScrollButtonAfterReload).toBeVisible({ timeout: 5000 });

		// Setting should still be enabled
		await expect(autoScrollButtonAfterReload).toHaveAttribute('title', /enabled/i);
	});

	test('should have visual distinction between enabled and disabled states', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').click();
		sessionId = await waitForSessionCreated(page);

		const autoScrollButton = page.locator('button[title*="Auto-scroll"]');
		await expect(autoScrollButton).toBeVisible();

		// Get initial classes (disabled state)
		const disabledClasses = await autoScrollButton.getAttribute('class');
		expect(disabledClasses).toContain('text-gray-400');

		// Enable auto-scroll
		await autoScrollButton.click();
		await page.waitForTimeout(500);

		// Get enabled classes
		const enabledClasses = await autoScrollButton.getAttribute('class');
		expect(enabledClasses).toContain('text-blue-400');
	});

	test('should show appropriate icon (down arrow with line)', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').click();
		sessionId = await waitForSessionCreated(page);

		const autoScrollButton = page.locator('button[title*="Auto-scroll"]');
		await expect(autoScrollButton).toBeVisible();

		// Button should contain an SVG with the arrow icon
		const svg = autoScrollButton.locator('svg');
		await expect(svg).toBeVisible();

		// SVG should have path elements (the arrow and line)
		const paths = svg.locator('path');
		expect(await paths.count()).toBeGreaterThanOrEqual(2);
	});
});
