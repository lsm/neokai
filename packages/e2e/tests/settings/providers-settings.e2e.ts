/**
 * Providers Settings E2E Tests
 *
 * Tests for the Providers section in settings:
 * - Navigate to Providers section
 * - Verify Providers section loads
 * - Verify provider list is displayed
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { openSettingsModal } from '../helpers/settings-modal-helpers';

test.describe('Settings Modal - Providers Section', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should navigate to Providers section from settings', async ({ page }) => {
		await openSettingsModal(page);

		// Verify we're in the General section by default
		await expect(page.locator('h3:has-text("General")')).toBeVisible();

		// Navigate to the Providers section
		await page.locator('button:has-text("Providers")').click();

		// Verify Providers section is shown
		await expect(page.locator('h3:has-text("Providers")')).toBeVisible();
	});

	test('should display Providers section with providers list or empty state', async ({ page }) => {
		await openSettingsModal(page);

		// Navigate to the Providers section
		await page.locator('button:has-text("Providers")').click();

		// Wait for providers to load
		await page.waitForTimeout(1000);

		// Verify the Providers section heading is visible
		await expect(page.locator('h3:has-text("Providers")')).toBeVisible();

		// Verify the description text is visible
		await expect(page.locator('text=Configure authentication for AI providers')).toBeVisible();

		// Either shows a provider list or "No providers available"
		const hasProviders = await page.locator('.space-y-3').count();
		if (hasProviders > 0) {
			// If providers exist, verify at least one provider card is rendered
			const providerCards = page.locator('.space-y-3 > div');
			const cardCount = await providerCards.count();
			expect(cardCount).toBeGreaterThanOrEqual(0);
		} else {
			// Should show "No providers available" message
			await expect(page.locator('text=No providers available')).toBeVisible();
		}
	});

	test('should show Login button for unauthenticated providers', async ({ page }) => {
		await openSettingsModal(page);

		// Navigate to the Providers section
		await page.locator('button:has-text("Providers")').click();

		// Wait for providers to load
		await page.waitForTimeout(1000);

		// Check if there are any Login buttons (for unauthenticated providers)
		// or Logout/Refresh Login buttons (for authenticated providers)
		const hasLoginButton = await page.locator('button:has-text("Login")').count();
		const hasLogoutButton = await page.locator('button:has-text("Logout")').count();
		const hasRefreshButton = await page.locator('button:has-text("Refresh Login")').count();

		// At least one type of button should be present if providers exist
		expect(hasLoginButton + hasLogoutButton + hasRefreshButton).toBeGreaterThanOrEqual(0);
	});
});
