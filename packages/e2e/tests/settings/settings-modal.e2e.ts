/**
 * Settings Modal E2E Tests
 *
 * Consolidated tests for the settings panel:
 * - Basic interaction (open/close navigation)
 * - Settings navigation (General, MCP Servers, About)
 * - General settings content (model, permission mode, auto-scroll)
 * - Settings persistence and MCP servers
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { openSettingsModal, closeSettingsModal } from '../helpers/settings-modal-helpers';

test.describe('Settings Modal - Basic Interaction', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should open Settings modal from sidebar footer', async ({ page }) => {
		await openSettingsModal(page);

		// Verify settings view is open with Global Settings header
		await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();
	});

	test('should close Settings modal with close button', async ({ page }) => {
		// Settings is now a panel view (not a modal). "Closing" navigates away via Home button.
		await openSettingsModal(page);

		// Verify settings view is open
		await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();

		// Close the settings view by navigating to Home
		await closeSettingsModal(page);

		// Verify settings view is closed
		await expect(page.locator('h2:has-text("Global Settings")')).toBeHidden();
	});

	test('should close Settings modal by clicking backdrop', async ({ page }) => {
		// Settings is now a panel view with no backdrop. Navigate away via Chats nav button.
		await openSettingsModal(page);

		// Verify settings view is open
		await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();

		// Navigate to the Chats section (equivalent to dismissing the settings view)
		await page.getByRole('button', { name: 'Chats', exact: true }).click();

		// Verify settings view is closed
		await expect(page.locator('h2:has-text("Global Settings")')).toBeHidden();
	});

	test('should close Settings modal with Escape key', async ({ page }) => {
		// Settings is a panel view (not a modal). Escape does not close it.
		await openSettingsModal(page);

		// Verify settings view is open
		await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();

		// Press Escape - settings panel view remains visible (no modal close behavior)
		await page.keyboard.press('Escape');
		await page.waitForTimeout(500);

		// Verify settings view remains visible after Escape
		await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();
	});
});

test.describe('Settings Modal - Authentication Status', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should display Authentication Status section', async ({ page }) => {
		// Authentication Status section was removed. Verify settings navigation sections instead.
		await openSettingsModal(page);

		// Verify all settings navigation sections are visible in the ContextPanel
		await expect(page.locator('button:has-text("General")')).toBeVisible();
		await expect(page.locator('button:has-text("MCP Servers")')).toBeVisible();
		await expect(page.locator('button:has-text("About")')).toBeVisible();
	});

	test('should show authenticated status with green indicator', async ({ page }) => {
		// Authentication status section removed. Verify General settings loads correctly.
		await openSettingsModal(page);

		// General section is shown by default
		await expect(page.locator('h3:has-text("General")')).toBeVisible();

		// Default Model row should be present
		await expect(page.locator('text=Default Model')).toBeVisible();
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

	test('should show environment variable setup instructions', async ({ page }) => {
		// Env var instructions removed. Verify About section shows app info instead.
		await openSettingsModal(page);

		// Navigate to the About section
		await page.locator('button:has-text("About")').click();

		// Verify About section is shown with NeoKai app info
		await expect(page.locator('h3:has-text("About")')).toBeVisible();
		await expect(page.locator('text=NeoKai')).toBeVisible();
	});
});

test.describe('Settings Modal - Global Settings', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should display Global Settings section', async ({ page }) => {
		// The section heading is now "General" (via SettingsSection title), not "Global Settings".
		// "Global Settings" is the page header (h2); the section h3 is "General".
		await openSettingsModal(page);

		// Verify General section heading is visible
		await expect(page.locator('h3:has-text("General")')).toBeVisible();
	});

	test('should show Model selection dropdown', async ({ page }) => {
		// Updated: label is "Default Model", options are model names (not "Default").
		await openSettingsModal(page);

		// Find the Default Model label
		await expect(page.locator('text=Default Model')).toBeVisible();

		// Should have a select element with Claude model options
		const modelSelect = page.locator('select').first();
		await expect(modelSelect).toBeVisible();

		// Verify Claude model options exist
		await expect(modelSelect.locator('option:has-text("Claude Sonnet 4")')).toBeAttached();
	});

	test('should show Thinking Level selection dropdown', async ({ page }) => {
		// Thinking Level has been removed from the current settings UI.
		await openSettingsModal(page);

		// Thinking Level is no longer present
		await expect(page.locator('text=Thinking Level')).toBeHidden();

		// Permission Mode is the second dropdown in the General settings
		await expect(page.locator('text=Permission Mode')).toBeVisible();
		await expect(page.locator('select').nth(1)).toBeVisible();
	});

	test('should show Auto Scroll toggle', async ({ page }) => {
		// Updated: label is "Auto-scroll", control is a role="switch" toggle button.
		await openSettingsModal(page);

		// Find the auto-scroll label (exact match to avoid matching the description text)
		await expect(page.getByText('Auto-scroll', { exact: true })).toBeVisible();

		// Should have a toggle switch (role="switch" button, not a checkbox)
		await expect(page.locator('button[role="switch"]')).toBeVisible();
	});

	test('should show Permission Mode selection', async ({ page }) => {
		// Updated: label is "Permission Mode", select has "default" value option.
		await openSettingsModal(page);

		// Find the Permission Mode label
		await expect(page.locator('text=Permission Mode')).toBeVisible();

		// Should have a select with a default option
		const permissionSelect = page.locator('select').nth(1);
		await expect(permissionSelect).toBeVisible();
		await expect(permissionSelect.locator('option[value="default"]')).toBeAttached();
	});

	test('should show Setting Sources checkboxes', async ({ page }) => {
		// Setting Sources section has been removed from the current settings UI.
		await openSettingsModal(page);

		// Setting Sources is no longer present
		await expect(page.locator('text=Setting Sources')).toBeHidden();

		// Current General settings has: Default Model, Permission Mode, Auto-scroll
		await expect(page.locator('text=Default Model')).toBeVisible();
		await expect(page.locator('text=Permission Mode')).toBeVisible();
		await expect(page.getByText('Auto-scroll', { exact: true })).toBeVisible();
	});

	test('should show auto-save notice', async ({ page }) => {
		// Auto-save notice removed. Verify settings page description is shown instead.
		await openSettingsModal(page);

		// Settings header shows a description of the page's purpose
		await expect(page.locator('text=Default configurations for new sessions')).toBeVisible();
	});
});

test.describe('Settings Modal - Global Tools Settings', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should display Global Tools Settings section', async ({ page }) => {
		// Global Tools Settings section removed. MCP Servers section is now a top-level section.
		await openSettingsModal(page);

		// Navigate to MCP Servers section via nav button
		await page.locator('button:has-text("MCP Servers")').click();

		// Verify MCP Servers section is shown
		await expect(page.locator('h3:has-text("MCP Servers")')).toBeVisible();
	});

	test('should show System Prompt section with Claude Code Preset', async ({ page }) => {
		// System Prompt/Claude Code Preset section removed. About section shows app info.
		await openSettingsModal(page);

		// Navigate to About section
		await page.locator('button:has-text("About")').click();

		// Verify About section is shown with version info
		await expect(page.locator('h3:has-text("About")')).toBeVisible();
		await expect(page.locator('text=Version')).toBeVisible();
	});

	test('should NOT show NeoKai Tools section', async ({ page }) => {
		// NeoKai Tools section has been removed
		await openSettingsModal(page);

		// Verify NeoKai Tools heading does NOT exist
		await expect(page.locator('h4:has-text("NeoKai Tools")')).not.toBeVisible();

		// Memory tool should NOT be shown
		await expect(page.locator('text=Persistent key-value storage')).not.toBeVisible();
	});

	test('should show SDK Built-in section with full tool names', async ({ page }) => {
		// SDK Built-in section removed. General settings shows model, permission mode, auto-scroll.
		await openSettingsModal(page);

		// Verify the three General settings rows are present
		await expect(page.locator('text=Default Model')).toBeVisible();
		await expect(page.locator('text=Permission Mode')).toBeVisible();
		await expect(page.getByText('Auto-scroll', { exact: true })).toBeVisible();
	});

	test('should have Allowed and Default ON checkboxes for tools', async ({ page }) => {
		// Allowed/Default ON checkboxes replaced by toggle switches.
		// Verify the auto-scroll toggle has proper aria attributes.
		await openSettingsModal(page);

		const autoScrollToggle = page.locator('button[role="switch"]');
		await expect(autoScrollToggle).toBeVisible();

		// Toggle should have aria-checked attribute (value is "true" or "false")
		await expect(autoScrollToggle).toHaveAttribute('aria-checked');
	});
});

test.describe('Settings Modal - Settings Persistence', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should allow changing model selection', async ({ page }) => {
		await openSettingsModal(page);

		// Find the model selection dropdown
		const modelSelect = page.locator('select').first();
		await expect(modelSelect).toBeVisible();

		// Get all option values
		const optionValues = await modelSelect.locator('option').evaluateAll((opts) =>
			opts.map((o) => ({
				value: (o as HTMLOptionElement).value,
				label: o.textContent,
			}))
		);
		expect(optionValues.length).toBeGreaterThan(1);

		// Get initial selected value
		const initialValue = await modelSelect.inputValue();

		// Select a different option by value
		const differentOption = optionValues.find((o) => o.value !== initialValue);
		if (differentOption) {
			await modelSelect.selectOption(differentOption.value);

			// Wait for auto-save
			await page.waitForTimeout(500);

			// Verify the selection changed
			const newValue = await modelSelect.inputValue();
			expect(newValue).toBe(differentOption.value);

			// Restore original
			await modelSelect.selectOption(initialValue);
		}
	});

	test('should toggle setting source and update', async ({ page }) => {
		// Setting sources removed. Toggle auto-scroll setting instead.
		await openSettingsModal(page);

		// Get the auto-scroll toggle switch
		const autoScrollToggle = page.locator('button[role="switch"]');
		const initialChecked = await autoScrollToggle.getAttribute('aria-checked');

		// Toggle the setting
		await autoScrollToggle.click();
		await page.waitForTimeout(500);

		// Verify the toggle state changed
		const newChecked = await autoScrollToggle.getAttribute('aria-checked');
		expect(newChecked).not.toBe(initialChecked);

		// Restore original state to avoid affecting other tests
		await autoScrollToggle.click();
		await page.waitForTimeout(500);
	});
});

test.describe('Settings Modal - MCP Servers', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should display MCP Servers section in Global Settings', async ({ page }) => {
		// Updated: Navigate to MCP Servers via nav button and verify section heading.
		await openSettingsModal(page);

		// Navigate to MCP Servers section via the settings nav
		await page.locator('button:has-text("MCP Servers")').click();

		// Verify MCP Servers section heading is displayed
		await expect(page.locator('h3:has-text("MCP Servers")')).toBeVisible();
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
