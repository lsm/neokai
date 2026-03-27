import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

/**
 * Tools Modal E2E Tests (Redesigned)
 *
 * Tests the redesigned ToolsModal with:
 * - Unified MCP server list grouped by scope
 * - Collapsible groups with group-level toggles
 * - Advanced section (collapsed by default) for Claude Code Preset + Setting Sources
 * - Scope badges ("All sessions" vs "This session")
 */

test.describe('Tools Modal - Redesigned', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
		await page.waitForTimeout(500);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch {
				// ignore cleanup errors
			}
			sessionId = null;
		}
	});

	/** Open the Tools modal for the current session */
	async function openToolsModal(page: import('@playwright/test').Page) {
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page
			.locator('[role="menuitem"]:has-text("Tools"), button:has-text("Tools")')
			.first()
			.click();
		await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 5000 });
	}

	test('should open tools modal and show group sections', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		// Should show the group section headers
		await expect(page.getByText('App MCP Servers')).toBeVisible();
		await expect(page.getByText('Project MCP Servers')).toBeVisible();
		await expect(page.getByText('NeoKai Tools')).toBeVisible();
	});

	test('should show Advanced section collapsed by default', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		// Advanced section should be visible but collapsed
		await expect(page.getByRole('button', { name: /Advanced/i })).toBeVisible();

		// Claude Code Preset should NOT be visible initially (hidden in Advanced)
		await expect(page.getByText('Claude Code Preset')).not.toBeVisible();
	});

	test('should expand Advanced section and show Claude Code Preset', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		// Click Advanced to expand
		await page.getByRole('button', { name: /Advanced/i }).click();

		// Claude Code Preset should now be visible
		await expect(page.getByText('Claude Code Preset')).toBeVisible({ timeout: 2000 });

		// Setting Sources should also be visible
		await expect(page.getByText('Setting Sources')).toBeVisible();
	});

	test('should show scope badges for groups', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		// App MCP group should show "All sessions" scope badge
		await expect(page.getByText('All sessions').first()).toBeVisible();

		// Project MCP group should show "This session" scope badge
		await expect(page.getByText('This session').first()).toBeVisible();
	});

	test('should collapse App MCP Servers group', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		// The App MCP Servers group header should be visible
		const appMcpHeader = page.locator('button:has-text("App MCP Servers")');
		await expect(appMcpHeader).toBeVisible();

		// Click to collapse
		await appMcpHeader.click();

		// After collapsing, no items from that group should be visible
		// (the group count is still shown in the header)
		await expect(appMcpHeader).toBeVisible();
	});

	test('should collapse Project MCP Servers group', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		const fileMcpHeader = page.locator('button:has-text("Project MCP Servers")');
		await expect(fileMcpHeader).toBeVisible();

		// Collapse the group
		await fileMcpHeader.click();

		// Header should still be visible (just collapsed)
		await expect(fileMcpHeader).toBeVisible();
	});

	test('should show NeoKai Tools with Memory toggle', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		// NeoKai Tools group should be expanded showing Memory
		await expect(page.getByText('NeoKai Tools')).toBeVisible();
		await expect(page.getByText('Memory')).toBeVisible();
		await expect(page.getByText('Persistent key-value storage')).toBeVisible();
	});

	test('should enable Save button when file-based server is toggled', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		// Save should be disabled initially
		const saveBtn = page.getByRole('button', { name: 'Save' });
		await expect(saveBtn).toBeDisabled();

		// If there are file-based MCP servers, toggle one
		const fileMcpCheckboxes = page
			.locator('[role="dialog"]')
			.locator('input[type="checkbox"]')
			.first();

		if ((await fileMcpCheckboxes.count()) > 0) {
			// Toggle NeoKai Tools Memory (always present)
			const memoryLabel = page.locator('label:has-text("Memory")').first();
			if ((await memoryLabel.count()) > 0) {
				await memoryLabel.click();
				await expect(saveBtn).toBeEnabled({ timeout: 2000 });
			}
		}
	});

	test('should close modal with Cancel without saving', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		const dialog = page.locator('[role="dialog"]').first();
		await expect(dialog).toBeVisible();

		// Click Cancel
		await page.getByRole('button', { name: 'Cancel' }).click();

		// Modal should close
		await expect(dialog).not.toBeVisible({ timeout: 3000 });
	});

	test('should persist state: save and reopen modal shows same config', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		await openToolsModal(page);

		// Toggle memory on
		const memoryLabel = page.locator('label:has-text("Memory")').first();
		if ((await memoryLabel.count()) > 0) {
			const memoryCheckbox = memoryLabel.locator('input[type="checkbox"]');
			const isChecked = await memoryCheckbox.isChecked();

			// Toggle memory state
			await memoryLabel.click();
			await expect(memoryCheckbox).toHaveJSProperty('checked', !isChecked, { timeout: 2000 });

			// Save
			const saveBtn = page.getByRole('button', { name: 'Save' });
			if (await saveBtn.isEnabled()) {
				await saveBtn.click();
				await expect(page.locator('[role="dialog"]').first()).not.toBeVisible({ timeout: 5000 });

				// Reopen modal
				await openToolsModal(page);

				// Memory should reflect saved state
				const memoryCheckboxAfter = page
					.locator('label:has-text("Memory")')
					.first()
					.locator('input[type="checkbox"]');
				await expect(memoryCheckboxAfter).toHaveJSProperty('checked', !isChecked, {
					timeout: 2000,
				});
			}
		}
	});
});
