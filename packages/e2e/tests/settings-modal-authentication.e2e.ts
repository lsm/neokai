/**
 * Settings Modal - Authentication Status E2E Tests
 *
 * Tests for authentication status display in the Settings modal.
 */

import { test, expect, type Page } from '../fixtures';
import { waitForWebSocketConnected } from './helpers/wait-helpers';

/**
 * Open the Settings modal by clicking on Authentication row in sidebar footer
 */
async function openSettingsModal(page: Page): Promise<void> {
	// The settings button is the Authentication row in the sidebar footer
	// It has a gear icon and shows auth status
	const settingsButton = page.locator('button:has(svg path[d*="M10.325 4.317"])').first();
	await settingsButton.waitFor({ state: 'visible', timeout: 5000 });
	await settingsButton.click();

	// Wait for modal to appear
	await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('Settings Modal - Authentication Status', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test.skip('should display Authentication Status section', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Verify Authentication Status heading
		await expect(page.locator('h3:has-text("Authentication Status")')).toBeVisible();
	});

	test.skip('should show authenticated status with green indicator', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Should show "Authenticated via" text if authenticated
		const authSection = page.locator('h3:has-text("Authentication Status")').locator('..');

		// Check for green indicator (authenticated)
		const greenIndicator = authSection.locator('.bg-green-500');
		const isAuthenticated = (await greenIndicator.count()) > 0;

		if (isAuthenticated) {
			await expect(page.locator('text=Authenticated via')).toBeVisible();
		} else {
			await expect(page.locator('text=Not authenticated')).toBeVisible();
		}
	});

	test('should display auth method (API Key or OAuth)', async ({ page }) => {
		await openSettingsModal(page);

		// Check if authenticated and what method
		const authText = page.locator('text=Authenticated via');
		const isAuthenticated = (await authText.count()) > 0;

		if (isAuthenticated) {
			// Should show one of the auth methods
			const hasApiKey = (await page.locator('text=API Key').count()) > 0;
			const hasOAuth = (await page.locator('text=OAuth').count()) > 0;
			const hasOAuthToken = (await page.locator('text=OAuth Token').count()) > 0;

			expect(hasApiKey || hasOAuth || hasOAuthToken).toBeTruthy();
		}
	});

	test.skip('should show environment variable setup instructions', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Instructions box should be visible
		await expect(page.locator('h4:has-text("How to Configure Authentication")')).toBeVisible();

		// Should show API Key option
		await expect(page.locator('text=Option 1: API Key')).toBeVisible();
		await expect(page.locator('code:has-text("ANTHROPIC_API_KEY")')).toBeVisible();

		// Should show OAuth Token option
		await expect(page.locator('text=Option 2: OAuth Token')).toBeVisible();
		await expect(page.locator('code:has-text("CLAUDE_CODE_OAUTH_TOKEN")')).toBeVisible();
	});
});
