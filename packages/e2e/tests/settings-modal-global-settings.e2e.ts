/**
 * Settings Modal - Global Settings E2E Tests
 *
 * Tests for global settings and tools settings in the Settings modal.
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

test.describe('Settings Modal - Global Settings', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test.skip('should display Global Settings section', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Verify Global Settings heading
		await expect(page.locator('h3:has-text("Global Settings")')).toBeVisible();
	});

	test.skip('should show Model selection dropdown', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
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

	test.skip('should show Thinking Level selection dropdown', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Find the thinking level label
		const thinkingLabel = page.locator('label:has-text("Thinking Level")');
		await expect(thinkingLabel).toBeVisible();

		// Should have a select for thinking level with all options
		const thinkingSelect = page.locator('select').filter({
			has: page.locator('option:has-text("Auto")'),
		});
		await expect(thinkingSelect.first()).toBeVisible();

		// Verify all thinking level options exist
		await expect(page.locator('option:has-text("Think 8k")')).toBeAttached();
		await expect(page.locator('option:has-text("Think 16k")')).toBeAttached();
		await expect(page.locator('option:has-text("Think 32k")')).toBeAttached();
	});

	test.skip('should show Auto Scroll toggle', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Find auto scroll label
		await expect(page.locator('label:has-text("Auto Scroll")')).toBeVisible();

		// Should show description
		await expect(
			page.locator('text=Auto-scroll to bottom when new messages arrive')
		).toBeVisible();

		// Should have a checkbox
		const autoScrollCheckbox = page
			.locator('label:has-text("Enabled")')
			.locator('input[type="checkbox"]');
		await expect(autoScrollCheckbox).toBeVisible();
	});

	test.skip('should show Permission Mode selection', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
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

	test.skip('should show Setting Sources checkboxes', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Find Setting Sources label
		await expect(page.locator('label:has-text("Setting Sources")')).toBeVisible();

		// Should show User, Project, and Local options
		await expect(page.locator('text=User (~/.claude/)')).toBeVisible();
		await expect(page.locator('text=Project (.claude/)')).toBeVisible();
		await expect(page.locator('text=Local (.claude/settings.local.json)')).toBeVisible();
	});

	test.skip('should show auto-save notice', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
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

	test.skip('should display Global Tools Settings section', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Verify Global Tools Settings heading
		await expect(page.locator('h3:has-text("Global Tools Settings")')).toBeVisible();
	});

	test.skip('should show System Prompt section with Claude Code Preset', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Find System Prompt section
		await expect(page.locator('h4:has-text("System Prompt")')).toBeVisible();

		// Should show Claude Code Preset
		await expect(page.locator('text=Claude Code Preset')).toBeVisible();
		await expect(page.locator('text=Use official Claude Code system prompt')).toBeVisible();
	});

	test.skip('should NOT show NeoKai Tools section', async ({ page }) => {
		// NeoKai Tools section has been removed
		await openSettingsModal(page);

		// Verify NeoKai Tools heading does NOT exist
		await expect(page.locator('h4:has-text("NeoKai Tools")')).not.toBeVisible();

		// Memory tool should NOT be shown
		await expect(page.locator('text=Persistent key-value storage')).not.toBeVisible();
	});

	test.skip('should show SDK Built-in section with full tool names', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
		await openSettingsModal(page);

		// Find SDK Built-in section
		await expect(page.locator('h4:has-text("Claude Agent SDK Built-in")')).toBeVisible();

		// Should list built-in tools without trailing "..."
		await expect(
			page.locator('text=Read, Write, Edit, Glob, Grep, Bash, NotebookEdit, TodoWrite')
		).toBeVisible();
		await expect(page.locator('text=/help, /context, /clear, /config, /bug')).toBeVisible();
		await expect(
			page.locator('text=Task agents (general-purpose, Explore, Plan, Bash)')
		).toBeVisible();
		await expect(page.locator('text=WebSearch, WebFetch')).toBeVisible();
	});

	test.skip('should have Allowed and Default ON checkboxes for tools', async ({ page }) => {
		// TODO: Update test to match current SettingsModal structure
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
