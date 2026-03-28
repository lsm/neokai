/**
 * Neo Settings E2E Tests
 *
 * Tests the Neo settings section in Global Settings:
 * - Neo section is visible in Settings navigation
 * - Security mode selector changes and persists across page reload
 * - Model selector shows available models and persists selection
 * - Clear Session button shows confirmation dialog
 * - Confirming clear session resets the Neo chat (toast confirmation)
 * - Canceling clear session preserves the chat (dialog dismissed)
 *
 * Setup: no room needed; tests the Global Settings > Neo Agent panel directly.
 */

import { test, expect, type Page } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Open the Global Settings panel via the NavRail Settings button.
 */
async function openGlobalSettings(page: Page): Promise<void> {
	const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
	await settingsButton.waitFor({ state: 'visible', timeout: 5000 });
	await settingsButton.click();
	await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible({ timeout: 5000 });
}

/**
 * Navigate to the Neo Agent section inside the Global Settings panel.
 * Assumes Global Settings is already open.
 */
async function navigateToNeoSection(page: Page): Promise<void> {
	const neoNavButton = page.locator('nav button:has-text("Neo Agent")').first();
	await neoNavButton.waitFor({ state: 'visible', timeout: 5000 });
	await neoNavButton.click();
	await expect(page.locator('h3:has-text("Neo Agent")')).toBeVisible({ timeout: 5000 });
}

/**
 * Open Global Settings and navigate straight to the Neo Agent section.
 */
async function openNeoSettings(page: Page): Promise<void> {
	await openGlobalSettings(page);
	await navigateToNeoSection(page);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Neo Settings - Navigation', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should show Neo Agent section in Settings navigation', async ({ page }) => {
		await openGlobalSettings(page);

		// Neo Agent nav button should be visible in the settings sidebar
		await expect(page.getByRole('button', { name: 'Neo Agent', exact: true })).toBeVisible();
	});

	test('should display Neo Agent settings content when section is selected', async ({ page }) => {
		await openNeoSettings(page);

		// Section heading
		await expect(page.locator('h3:has-text("Neo Agent")')).toBeVisible();

		// All three setting rows should be present
		await expect(page.locator('text=Security Mode')).toBeVisible();
		await expect(page.locator('text=Model')).toBeVisible();
		await expect(page.locator('text=Clear Session')).toBeVisible();
	});
});

test.describe('Neo Settings - Security Mode', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);
	});

	test('should show security mode selector with expected options', async ({ page }) => {
		// First select in the Neo section is the Security Mode selector
		const securitySelect = page.locator('select').first();
		await expect(securitySelect).toBeVisible();

		// All three modes should be available as options
		await expect(securitySelect.locator('option:has-text("Conservative")')).toBeAttached();
		await expect(securitySelect.locator('option:has-text("Balanced (default)")')).toBeAttached();
		await expect(securitySelect.locator('option:has-text("Autonomous")')).toBeAttached();
	});

	test('should change security mode and show success toast', async ({ page }) => {
		const securitySelect = page.locator('select').first();

		// Change to Conservative
		await securitySelect.selectOption('conservative');

		// Should show success toast
		await expect(page.locator('text=Security mode updated')).toBeVisible({ timeout: 5000 });

		// Select should reflect the new value
		await expect(securitySelect).toHaveValue('conservative');
	});

	test('should persist security mode selection across page reload', async ({ page }) => {
		const securitySelect = page.locator('select').first();

		// Change to Autonomous
		await securitySelect.selectOption('autonomous');
		await expect(page.locator('text=Security mode updated')).toBeVisible({ timeout: 5000 });

		// Reload the page
		await page.reload();
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);

		// Value should be persisted
		await expect(page.locator('select').first()).toHaveValue('autonomous');

		// Reset to balanced (cleanup)
		await page.locator('select').first().selectOption('balanced');
		await expect(page.locator('text=Security mode updated')).toBeVisible({ timeout: 5000 });
	});
});

test.describe('Neo Settings - Model Selector', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);
	});

	test('should show model selector with available options', async ({ page }) => {
		// Second select in the Neo section is the Model selector
		const modelSelect = page.locator('select').nth(1);
		await expect(modelSelect).toBeVisible();

		// All model options should be available
		await expect(modelSelect.locator('option:has-text("App default")')).toBeAttached();
		await expect(modelSelect.locator('option:has-text("Claude Sonnet 4")')).toBeAttached();
		await expect(modelSelect.locator('option:has-text("Claude Opus 4")')).toBeAttached();
		await expect(modelSelect.locator('option:has-text("Claude Haiku 3.5")')).toBeAttached();
	});

	test('should change model and show success toast', async ({ page }) => {
		const modelSelect = page.locator('select').nth(1);

		// Change to Sonnet
		await modelSelect.selectOption('sonnet');

		// Should show success toast
		await expect(page.locator('text=Model updated')).toBeVisible({ timeout: 5000 });

		// Select should reflect the new value
		await expect(modelSelect).toHaveValue('sonnet');
	});

	test('should persist model selection across page reload', async ({ page }) => {
		const modelSelect = page.locator('select').nth(1);

		// Change to Opus
		await modelSelect.selectOption('opus');
		await expect(page.locator('text=Model updated')).toBeVisible({ timeout: 5000 });

		// Reload the page
		await page.reload();
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);

		// Value should be persisted
		await expect(page.locator('select').nth(1)).toHaveValue('opus');

		// Reset to app default (cleanup)
		await page.locator('select').nth(1).selectOption('');
		await expect(page.locator('text=Model updated')).toBeVisible({ timeout: 5000 });
	});
});

test.describe('Neo Settings - Clear Session', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);
	});

	test('should show confirmation dialog when Clear Session is clicked', async ({ page }) => {
		// Click the Clear Session button
		await page.getByRole('button', { name: 'Clear Session', exact: true }).click();

		// Confirmation dialog should appear with "Are you sure?" text
		await expect(page.locator('text=Are you sure?')).toBeVisible({ timeout: 3000 });

		// Confirm and Cancel buttons should be visible
		await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();

		// Original "Clear Session" button should no longer be visible
		await expect(page.getByRole('button', { name: 'Clear Session', exact: true })).toBeHidden();
	});

	test('should clear Neo session and show success toast when Confirm is clicked', async ({
		page,
	}) => {
		// Open the confirmation dialog
		await page.getByRole('button', { name: 'Clear Session', exact: true }).click();
		await expect(page.locator('text=Are you sure?')).toBeVisible({ timeout: 3000 });

		// Click Confirm
		await page.getByRole('button', { name: 'Confirm', exact: true }).click();

		// Should show success toast
		await expect(page.locator('text=Neo session cleared')).toBeVisible({ timeout: 5000 });

		// Confirmation dialog should be dismissed
		await expect(page.locator('text=Are you sure?')).toBeHidden({ timeout: 3000 });

		// "Clear Session" button should be visible again (dialog closed)
		await expect(page.getByRole('button', { name: 'Clear Session', exact: true })).toBeVisible({
			timeout: 3000,
		});
	});

	test('should dismiss confirmation dialog when Cancel is clicked', async ({ page }) => {
		// Open the confirmation dialog
		await page.getByRole('button', { name: 'Clear Session', exact: true }).click();
		await expect(page.locator('text=Are you sure?')).toBeVisible({ timeout: 3000 });

		// Click Cancel
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();

		// Confirmation dialog should be dismissed
		await expect(page.locator('text=Are you sure?')).toBeHidden({ timeout: 3000 });

		// "Clear Session" button should be visible again
		await expect(page.getByRole('button', { name: 'Clear Session', exact: true })).toBeVisible({
			timeout: 3000,
		});

		// No success toast (session was not cleared)
		await expect(page.locator('text=Neo session cleared')).toBeHidden();
	});
});
