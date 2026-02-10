/**
 * Authentication Status E2E Test
 *
 * Tests that authentication status is visible in the UI.
 * Tests actual UI behavior through real user interactions only.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

test.describe('Authentication Status', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should show authentication status in sidebar', async ({ page }) => {
		// Check for auth status indicator
		const authStatus = page.locator('text=/OAuth Token|API Key|Not configured/i').first();
		await expect(authStatus).toBeVisible({ timeout: 5000 });

		// If authenticated, should show green indicator
		const isAuthenticated = await page
			.locator('.bg-green-500')
			.first()
			.isVisible()
			.catch(() => false);

		// If not authenticated, should show yellow indicator
		const notAuthenticated = await page
			.locator('.bg-yellow-500')
			.first()
			.isVisible()
			.catch(() => false);

		// Should have one or the other
		expect(isAuthenticated || notAuthenticated).toBe(true);
	});
});
