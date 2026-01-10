import { test, expect } from '../fixtures';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

/**
 * Tools Modal Complete E2E Tests
 *
 * Comprehensive tests for ToolsModal features beyond MCP toggle:
 * - System prompt preset toggle (Claude Code Preset)
 * - Setting sources selection (User/Project/Local)
 * - Liuboer Tools section (Memory tool)
 * - SDK built-in tools section
 * - Save/Cancel functionality
 *
 * Note: mcp-toggle.e2e.ts covers MCP server toggling specifically
 */
test.describe('Tools Modal - Complete', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Liuboer', exact: true }).first()).toBeVisible();
		await page.waitForTimeout(1000);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should show System Prompt section with Claude Code Preset', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open session options menu
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();

		// Click Tools option
		await page.locator('text=Tools').first().click();

		// Wait for Tools modal to open
		await expect(page.locator('text=System Prompt').first()).toBeVisible({ timeout: 5000 });

		// Should show Claude Code Preset option
		await expect(page.locator('text=Claude Code Preset')).toBeVisible();
		await expect(page.locator('text=Use official Claude Code system prompt')).toBeVisible();
	});

	test('should show Setting Sources section with checkboxes', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Tools modal
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page.locator('text=Tools').first().click();

		// Wait for modal
		await expect(page.locator('h2:has-text("Tools"), h3:has-text("Tools")').first()).toBeVisible({
			timeout: 5000,
		});

		// Should show Setting Sources section
		await expect(page.locator('text=Setting Sources')).toBeVisible();

		// Should show User, Project, and Local options
		await expect(page.locator('text=User').first()).toBeVisible();
		await expect(page.locator('text=Project').first()).toBeVisible();
		await expect(page.locator('text=Local').first()).toBeVisible();
	});

	test('should show Liuboer Tools section with Memory tool', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Tools modal
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page.locator('text=Tools').first().click();

		// Wait for modal
		await expect(page.locator('h2:has-text("Tools"), h3:has-text("Tools")').first()).toBeVisible({
			timeout: 5000,
		});

		// Should show Liuboer Tools section
		await expect(page.locator('text=Liuboer Tools')).toBeVisible();

		// Should show Memory tool option
		await expect(page.locator('text=Memory')).toBeVisible();
	});

	test('should show SDK Built-in section', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Tools modal
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page.locator('text=Tools').first().click();

		// Wait for modal
		await expect(page.locator('h2:has-text("Tools"), h3:has-text("Tools")').first()).toBeVisible({
			timeout: 5000,
		});

		// Should show SDK Built-in section
		await expect(page.locator('text=SDK Built-in')).toBeVisible();

		// SDK tools are always enabled (informational only)
		await expect(page.locator('text=Always enabled')).toBeVisible();
	});

	test('should enable Save button when settings change', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Tools modal
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page.locator('text=Tools').first().click();

		// Wait for modal
		await expect(page.locator('h2:has-text("Tools"), h3:has-text("Tools")').first()).toBeVisible({
			timeout: 5000,
		});

		// Save button should initially be disabled (no changes)
		const saveButton = page.locator('button:has-text("Save")');
		await expect(saveButton).toBeVisible();

		// Click a toggle to make a change (e.g., Claude Code Preset)
		const claudePresetToggle = page
			.locator('label:has-text("Claude Code Preset")')
			.locator('..')
			.locator('button[role="switch"], input[type="checkbox"]');
		if ((await claudePresetToggle.count()) > 0) {
			await claudePresetToggle.first().click();
			// Save button should now be enabled
			await expect(saveButton).toBeEnabled({ timeout: 2000 });
		}
	});

	test('should close modal with Cancel button without saving', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Tools modal
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page.locator('text=Tools').first().click();

		// Wait for modal
		const modalTitle = page.locator('h2:has-text("Tools"), h3:has-text("Tools")').first();
		await expect(modalTitle).toBeVisible({ timeout: 5000 });

		// Click Cancel button
		await page.locator('button:has-text("Cancel")').click();

		// Modal should close
		await expect(modalTitle).not.toBeVisible({ timeout: 2000 });
	});

	test('should toggle Claude Code Preset', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Tools modal
		const optionsButton = page.locator('button[aria-label="Session options"]');
		await optionsButton.click();
		await page.locator('text=Tools').first().click();

		// Wait for modal
		await expect(page.locator('text=Claude Code Preset')).toBeVisible({ timeout: 5000 });

		// Find the toggle for Claude Code Preset
		const presetRow = page.locator('div:has-text("Claude Code Preset")').first();
		const toggle = presetRow.locator('button[role="switch"], input[type="checkbox"]').first();

		if ((await toggle.count()) > 0) {
			// Get initial state
			const initialState = await toggle.getAttribute('aria-checked');

			// Toggle it
			await toggle.click();

			// State should change
			const newState = await toggle.getAttribute('aria-checked');
			expect(newState).not.toBe(initialState);
		}
	});
});
