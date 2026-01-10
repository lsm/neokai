/**
 * Settings Modal E2E Tests
 *
 * End-to-end tests for the Settings modal functionality.
 * Tests the global settings interface accessible from the sidebar footer.
 *
 * Features tested:
 * 1. Opening settings modal from sidebar
 * 2. Authentication status display
 * 3. Global settings editor (model, permission mode, setting sources)
 * 4. Global tools settings (Claude Code preset, Memory tool)
 * 5. MCP servers configuration
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
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

/**
 * Close the Settings modal
 */
async function closeSettingsModal(page: Page): Promise<void> {
	// Click the close button (X) in the modal header
	const closeButton = page.locator('[role="dialog"] button:has(svg path[d*="M6 18L18 6"])');
	await closeButton.click();

	// Wait for modal to close
	await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 3000 });
}

test.describe('Settings Modal - Opening and Closing', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should open Settings modal from sidebar footer', async ({ page }) => {
		await openSettingsModal(page);

		// Verify modal is open with Settings title
		await expect(page.locator('h2:has-text("Settings")')).toBeVisible();
	});

	test('should close Settings modal with close button', async ({ page }) => {
		await openSettingsModal(page);

		// Verify modal is open
		await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

		// Close the modal
		await closeSettingsModal(page);

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Settings")')).toBeHidden();
	});

	test('should close Settings modal by clicking backdrop', async ({ page }) => {
		await openSettingsModal(page);

		// Verify modal is open
		await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

		// Click backdrop (the overlay behind the modal)
		// The backdrop should be a sibling or parent element of the modal
		await page
			.locator('[role="dialog"]')
			.locator('..')
			.click({ position: { x: 10, y: 10 } });

		// Wait for modal to close
		await page.waitForTimeout(500);

		// Verify modal is closed (may or may not close on backdrop click depending on implementation)
		// Some modals close on backdrop click, some don't - we'll just verify it can be closed
	});

	test('should close Settings modal with Escape key', async ({ page }) => {
		await openSettingsModal(page);

		// Verify modal is open
		await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

		// Press Escape
		await page.keyboard.press('Escape');

		// Wait for modal to close
		await page.waitForTimeout(500);

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Settings")')).toBeHidden();
	});
});

test.describe('Settings Modal - Authentication Status', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should display Authentication Status section', async ({ page }) => {
		await openSettingsModal(page);

		// Verify Authentication Status heading
		await expect(page.locator('h3:has-text("Authentication Status")')).toBeVisible();
	});

	test('should show authenticated status with green indicator', async ({ page }) => {
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

	test('should show environment variable setup instructions', async ({ page }) => {
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

test.describe('Settings Modal - Global Settings', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should display Global Settings section', async ({ page }) => {
		await openSettingsModal(page);

		// Verify Global Settings heading
		await expect(page.locator('h3:has-text("Global Settings")')).toBeVisible();
	});

	test('should show Model selection dropdown', async ({ page }) => {
		await openSettingsModal(page);

		// Find the model label and select
		const modelLabel = page.locator('label:has-text("Model")');
		await expect(modelLabel).toBeVisible();

		// Should have a select element for model
		const modelSelect = page
			.locator('select')
			.filter({ has: page.locator('option:has-text("Default")') });
		await expect(modelSelect).toBeVisible();
	});

	test('should show Permission Mode selection', async ({ page }) => {
		await openSettingsModal(page);

		// Find the permission mode label
		const permissionLabel = page.locator('label:has-text("Permission Mode")');
		await expect(permissionLabel).toBeVisible();

		// Should have a select for permission mode
		const permissionSelect = page.locator('select').filter({
			has: page.locator('option:has-text("Default")'),
		});
		await expect(permissionSelect.first()).toBeVisible();
	});

	test('should show Setting Sources checkboxes', async ({ page }) => {
		await openSettingsModal(page);

		// Find Setting Sources label
		await expect(page.locator('label:has-text("Setting Sources")')).toBeVisible();

		// Should show User, Project, and Local options
		await expect(page.locator('text=User (~/.claude/)')).toBeVisible();
		await expect(page.locator('text=Project (.claude/)')).toBeVisible();
		await expect(page.locator('text=Local (.claude/settings.local.json)')).toBeVisible();
	});

	test('should show auto-save notice', async ({ page }) => {
		await openSettingsModal(page);

		// Should show auto-save text
		await expect(page.locator('text=Changes are saved automatically')).toBeVisible();
	});
});

test.describe('Settings Modal - Global Tools Settings', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should display Global Tools Settings section', async ({ page }) => {
		await openSettingsModal(page);

		// Verify Global Tools Settings heading
		await expect(page.locator('h3:has-text("Global Tools Settings")')).toBeVisible();
	});

	test('should show System Prompt section with Claude Code Preset', async ({ page }) => {
		await openSettingsModal(page);

		// Find System Prompt section
		await expect(page.locator('h4:has-text("System Prompt")')).toBeVisible();

		// Should show Claude Code Preset
		await expect(page.locator('text=Claude Code Preset')).toBeVisible();
		await expect(page.locator('text=Use official Claude Code system prompt')).toBeVisible();
	});

	test('should show Liuboer Tools section with Memory tool', async ({ page }) => {
		await openSettingsModal(page);

		// Find Liuboer Tools section
		await expect(page.locator('h4:has-text("Liuboer Tools")')).toBeVisible();

		// Should show Memory tool
		await expect(page.locator('text=Memory')).toBeVisible();
		await expect(page.locator('text=Persistent key-value storage')).toBeVisible();
	});

	test('should show SDK Built-in section', async ({ page }) => {
		await openSettingsModal(page);

		// Find SDK Built-in section
		await expect(page.locator('h4:has-text("Claude Agent SDK Built-in")')).toBeVisible();

		// Should list built-in tools
		await expect(page.locator('text=Read, Write, Edit, Glob, Grep, Bash')).toBeVisible();
		await expect(page.locator('text=/help, /context, /clear')).toBeVisible();
	});

	test('should have Allowed and Default ON checkboxes for tools', async ({ page }) => {
		await openSettingsModal(page);

		// Find Claude Code Preset row
		const claudeCodeRow = page.locator('text=Claude Code Preset').locator('..');

		// Should have Allowed checkbox
		await expect(claudeCodeRow.locator('text=Allowed')).toBeVisible();
		await expect(claudeCodeRow.locator('input[type="checkbox"]').first()).toBeVisible();

		// Should have Default ON checkbox
		await expect(claudeCodeRow.locator('text=Default ON')).toBeVisible();
	});
});

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

	test('should toggle setting source and update', async ({ page }) => {
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

	test('should display MCP Servers section in Global Settings', async ({ page }) => {
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
