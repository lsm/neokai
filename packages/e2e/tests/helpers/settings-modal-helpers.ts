/**
 * Settings Modal Test Helpers
 *
 * Shared utility functions for Settings modal E2E tests.
 */

import type { Page } from '@playwright/test';

/**
 * Open the Settings modal from the sidebar footer
 */
export async function openSettingsModal(page: Page): Promise<void> {
	// Find the settings button in the sidebar footer
	// It's a button with a gear/settings icon, containing the authentication status and settings icon
	const settingsButton = page
		.locator('button')
		.filter({ has: page.locator('svg[viewBox="0 0 24 24"]') })
		.filter({ hasText: /OAuth|API Key|Not configured/ })
		.first();

	await settingsButton.waitFor({ state: 'visible', timeout: 5000 });
	await settingsButton.click();

	// Wait for Settings modal to appear
	await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Close the Settings modal by clicking the close button
 */
export async function closeSettingsModal(page: Page): Promise<void> {
	// The Modal component has a close button with aria-label="Close modal"
	const closeButton = page.locator('button[aria-label="Close modal"]');
	await closeButton.click();

	// Wait for modal to close
	await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 5000 });
}
