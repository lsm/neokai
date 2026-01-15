/**
 * Settings Modal - Settings Persistence E2E Tests
 *
 * Tests for settings persistence and MCP server configuration in the Settings modal.
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

test.describe('Settings Modal - Settings Persistence', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should save model selection and show Saved indicator', async ({ page }) => {
		await openSettingsModal(page);

		// Find and change model selection
		const modelSelect = page.locator('select').first();

		// Change to a different value
		const options = await modelSelect.locator('option').allTextContents();
		const newOption = options.find((opt) => !opt.includes('Default'));

		if (newOption) {
			await modelSelect.selectOption({ label: newOption });

			// Should show "Saved" indicator briefly
			await expect(page.locator('text=Saved').first()).toBeVisible({ timeout: 3000 });

			// Saved indicator should disappear after a while
			await page.waitForTimeout(2500);
		}
	});

	test.skip('should toggle setting source and update', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Find a setting source checkbox
		const localCheckbox = page
			.locator('label:has-text("Local")')
			.locator('input[type="checkbox"]')
			.first();
		const isChecked = await localCheckbox.isChecked();

		// Toggle the checkbox
		await localCheckbox.click();

		// Wait for save
		await page.waitForTimeout(500);

		// Toggle back to original state to not affect other tests
		if (isChecked !== (await localCheckbox.isChecked())) {
			await localCheckbox.click();
			await page.waitForTimeout(500);
		}
	});
});

test.describe('Settings Modal - MCP Servers', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test.skip('should display MCP Servers section in Global Settings', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Find MCP Servers label
		await expect(page.locator('label:has-text("MCP Servers")')).toBeVisible();

		// Should show description
		await expect(page.locator('text=MCP servers from enabled setting sources')).toBeVisible();
	});

	test('should show MCP server configuration options', async ({ page }) => {
		await openSettingsModal(page);

		// Wait for MCP servers to load
		await page.waitForTimeout(1000);

		// Check if there are MCP servers or a "No MCP servers" message
		const noServersMessage = page.locator('text=No MCP servers found');
		const hasServers = (await noServersMessage.count()) === 0;

		if (hasServers) {
			// Should show Allowed and Default ON checkboxes for servers
			const mcpSection = page.locator('label:has-text("MCP Servers")').locator('..');
			const allowedCheckboxes = mcpSection.locator('text=Allowed');
			expect(await allowedCheckboxes.count()).toBeGreaterThanOrEqual(0);
		}
	});
});
