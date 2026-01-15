/**
 * Mobile Messages E2E Tests
 *
 * Tests for message display on mobile screens:
 * - Messages display correctly on narrow screens
 * - No horizontal overflow
 */

import { test, expect, devices } from '../fixtures';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

test.describe('Mobile Messages', () => {
	let sessionId: string | null = null;

	// Use iPhone 13 viewport for mobile tests
	test.use({
		viewport: { width: 390, height: 844 },
		userAgent: devices['iPhone 13'].userAgent,
		hasTouch: true,
		isMobile: true,
	});

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

	test('should display messages correctly on narrow screen', async ({ page }) => {
		// On mobile, ensure sidebar is accessible
		const openMenuButton = page.locator('button[aria-label="Open menu"]');
		const isSidebarClosed = (await openMenuButton.count()) > 0;
		if (isSidebarClosed) {
			await openMenuButton.first().click();
			await page.waitForTimeout(500);
		}

		// Create a session using dispatchEvent to bypass viewport checks
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await expect(newSessionButton).toBeVisible();
		await newSessionButton.dispatchEvent('click');
		sessionId = await waitForSessionCreated(page);

		// Close sidebar to see chat area
		const closeSidebarButton = page.locator('button[aria-label="Close sidebar"]');
		if (await closeSidebarButton.isVisible().catch(() => false)) {
			await closeSidebarButton.click();
			await page.waitForTimeout(300);
		}

		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
		await textarea.fill('Test message on mobile');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
		});

		// Check that messages don't overflow horizontally
		const messageContainer = page.locator('[data-message-role="assistant"]').first();
		const containerBox = await messageContainer.boundingBox();
		if (containerBox) {
			// Message should fit within viewport width
			expect(containerBox.width).toBeLessThanOrEqual(390);
		}
	});
});
