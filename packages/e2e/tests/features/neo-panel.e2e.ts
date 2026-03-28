/**
 * Neo Panel E2E Tests
 *
 * Tests for the core Neo panel interaction flow:
 * - NavRail Neo button visibility, clickability, and active state
 * - Panel open/close behavior (button, close button, backdrop, Escape key)
 * - Tab switching (Chat / Activity)
 * - localStorage state persistence across page reload
 * - Cmd+J / Ctrl+J keyboard shortcut toggle
 */

import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Locate the Neo NavRail button by its aria-label */
function getNeoNavButton(page: Page) {
	return page.locator('button[aria-label="Neo (⌘J)"]');
}

/** Locate the Neo panel container */
function getNeoPanel(page: Page) {
	return page.locator('[data-testid="neo-panel"]');
}

/** Locate the Neo panel backdrop */
function getNeoBackdrop(page: Page) {
	return page.locator('[data-testid="neo-panel-backdrop"]');
}

/** Wait for the panel to be visible (translated into view) */
async function waitForPanelOpen(page: Page) {
	// Panel is open when -translate-x-full class is NOT applied
	await expect(getNeoPanel(page)).not.toHaveClass(/-translate-x-full/, { timeout: 3000 });
}

/** Wait for the panel to be hidden (translated out of view) */
async function waitForPanelClosed(page: Page) {
	await expect(getNeoPanel(page)).toHaveClass(/-translate-x-full/, { timeout: 3000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Neo Panel — Core Interaction', () => {
	test.use({ viewport: { width: 1280, height: 720 } });

	test.beforeEach(async ({ page }) => {
		// Navigate first so localStorage is accessible, then clear the persisted panel state.
		// Using page.evaluate() (not addInitScript) so that page.reload() calls inside tests
		// do NOT re-clear localStorage — the persistence test depends on this.
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await page.evaluate(() => localStorage.removeItem('neo:panelOpen'));
		// Reload so the app initialises with the cleared localStorage value
		await page.reload();
		await waitForWebSocketConnected(page);
	});

	// ── 1. NavRail Neo button visible ──────────────────────────────────────

	test('NavRail Neo button is visible', async ({ page }) => {
		await expect(getNeoNavButton(page)).toBeVisible({ timeout: 5000 });
	});

	// ── 2. NavRail button shows active state when panel is open ───────────

	test('NavRail Neo button shows active state (aria-pressed) when panel is open', async ({
		page,
	}) => {
		const btn = getNeoNavButton(page);
		await expect(btn).toHaveAttribute('aria-pressed', 'false');

		await btn.click();
		await waitForPanelOpen(page);
		await expect(btn).toHaveAttribute('aria-pressed', 'true');
	});

	// ── 3. Clicking button opens panel ────────────────────────────────────

	test('clicking Neo button opens the panel and focuses the close button', async ({ page }) => {
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		// NeoPanel.tsx focuses the close button via requestAnimationFrame for accessibility
		const closeBtn = page.locator('[data-testid="neo-panel-close"]');
		await expect(closeBtn).toBeVisible({ timeout: 3000 });
		await expect(closeBtn).toBeFocused({ timeout: 3000 });
	});

	// ── 4. Chat tab active by default ─────────────────────────────────────

	test('Neo panel displays with Chat tab active by default', async ({ page }) => {
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		const chatTab = page.locator('[data-testid="neo-tab-chat"]');
		await expect(chatTab).toBeVisible({ timeout: 3000 });
		await expect(chatTab).toHaveAttribute('aria-selected', 'true');

		const activityTab = page.locator('[data-testid="neo-tab-activity"]');
		await expect(activityTab).toHaveAttribute('aria-selected', 'false');

		// Chat view should be present
		await expect(page.locator('[data-testid="neo-chat-view"]')).toBeVisible({ timeout: 3000 });
	});

	// ── 5. Tab switching ───────────────────────────────────────────────────

	test('can switch between Chat and Activity tabs', async ({ page }) => {
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		// Switch to Activity tab
		const activityTab = page.locator('[data-testid="neo-tab-activity"]');
		await activityTab.click();
		await expect(activityTab).toHaveAttribute('aria-selected', 'true');
		await expect(page.locator('[data-testid="neo-tab-chat"]')).toHaveAttribute(
			'aria-selected',
			'false'
		);
		// Chat view is conditionally rendered — not present in DOM when Activity is active
		await expect(page.locator('[data-testid="neo-chat-view"]')).not.toBeVisible({ timeout: 2000 });

		// Switch back to Chat tab
		const chatTab = page.locator('[data-testid="neo-tab-chat"]');
		await chatTab.click();
		await expect(chatTab).toHaveAttribute('aria-selected', 'true');
		await expect(page.locator('[data-testid="neo-chat-view"]')).toBeVisible({ timeout: 2000 });
	});

	// ── 6. Close button dismisses panel ───────────────────────────────────

	test('close button dismisses the Neo panel', async ({ page }) => {
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		const closeBtn = page.locator('[data-testid="neo-panel-close"]');
		await expect(closeBtn).toBeVisible({ timeout: 3000 });
		await closeBtn.click();

		await waitForPanelClosed(page);
	});

	// ── 7. Escape key dismisses panel ─────────────────────────────────────

	test('Escape key dismisses the Neo panel', async ({ page }) => {
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		await page.keyboard.press('Escape');
		await waitForPanelClosed(page);
	});

	// ── 8. Click outside (backdrop) dismisses panel ────────────────────────

	test('clicking outside (backdrop) dismisses the Neo panel', async ({ page }) => {
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		// Click the backdrop overlay
		const backdrop = getNeoBackdrop(page);
		await expect(backdrop).toBeVisible({ timeout: 3000 });
		await backdrop.click({ position: { x: 5, y: 5 } });

		await waitForPanelClosed(page);
	});

	// ── 9. Panel state persists across page reload ─────────────────────────

	test('panel open state persists across page navigation via localStorage', async ({ page }) => {
		// Open the panel — DOM confirms it is open
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		// Reload (addInitScript does NOT run on reload, so localStorage survives)
		await page.reload();
		await waitForWebSocketConnected(page);

		// Panel should still be open after reload — DOM-based assertion
		await waitForPanelOpen(page);

		// Close the panel
		await page.locator('[data-testid="neo-panel-close"]').click();
		await waitForPanelClosed(page);

		// Reload again — panel should remain closed
		await page.reload();
		await waitForWebSocketConnected(page);

		await waitForPanelClosed(page);
	});

	// ── 10. Cmd+J / Ctrl+J keyboard shortcut toggles panel ────────────────

	test('Cmd+J / Ctrl+J keyboard shortcut toggles the Neo panel', async ({ page }) => {
		// Determine platform modifier (Meta on macOS, Control otherwise)
		const isMac = process.platform === 'darwin';
		const modifier = isMac ? 'Meta' : 'Control';

		// Ensure focus is not on an input element — the shortcut handler guards against
		// firing when focus is inside INPUT / TEXTAREA / contentEditable
		await page.locator('body').click();

		// Panel should start closed
		await waitForPanelClosed(page);

		// Press shortcut to open
		await page.keyboard.press(`${modifier}+j`);
		await waitForPanelOpen(page);

		// Press shortcut again to close (body has focus; panel close button had it — click body first)
		await page.locator('body').click();
		await page.keyboard.press(`${modifier}+j`);
		await waitForPanelClosed(page);
	});
});
