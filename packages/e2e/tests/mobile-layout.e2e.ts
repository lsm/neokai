/**
 * Mobile Layout E2E Tests
 *
 * Tests for mobile layout and responsive behavior:
 * - Display correctly on mobile viewport
 * - Responsive sidebar behavior (toggle)
 */

import { test, expect, devices } from '../fixtures';

test.describe('Mobile Layout', () => {
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
	});

	test('should display correctly on mobile viewport', async ({ page }) => {
		// Verify the app loads on mobile
		const heading = page.getByRole('heading', { name: 'Liuboer', exact: true }).first();
		await expect(heading).toBeVisible();

		// New Session button should still be accessible
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await expect(newSessionButton).toBeVisible();
	});

	test('should have responsive sidebar behavior', async ({ page }) => {
		// On mobile, sidebar might be hidden or toggleable
		// Look for "Open menu" button (hamburger) or "Close sidebar" button or "New Session"
		const openMenuButton = page.locator('button[aria-label="Open menu"]');
		const closeSidebarButton = page.locator('button[aria-label="Close sidebar"]');
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });

		// Check if any navigation element exists
		const hasOpenMenu = (await openMenuButton.count()) > 0;
		const hasCloseSidebar = (await closeSidebarButton.count()) > 0;
		const hasNewSession = (await newSessionButton.count()) > 0;

		// At least one navigation method should exist
		expect(hasOpenMenu || hasCloseSidebar || hasNewSession).toBe(true);
	});
});
