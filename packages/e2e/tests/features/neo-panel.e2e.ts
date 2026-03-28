/**
 * Neo Panel E2E Tests
 *
 * Tests for the core Neo panel interaction flow:
 * - NavRail Neo button visibility and clickability
 * - Panel open/close behavior
 * - Tab switching (Chat / Activity)
 * - Dismiss via close button and backdrop click
 * - localStorage state persistence across navigation
 * - Cmd+J / Ctrl+J keyboard shortcut toggle
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Locate the Neo NavRail button by its aria-label */
function getNeoNavButton(page: Parameters<typeof waitForWebSocketConnected>[0]) {
	return page.locator('button[aria-label="Neo (⌘J)"]');
}

/** Locate the Neo panel container */
function getNeoPanel(page: Parameters<typeof waitForWebSocketConnected>[0]) {
	return page.locator('[data-testid="neo-panel"]');
}

/** Locate the Neo panel backdrop */
function getNeoBackdrop(page: Parameters<typeof waitForWebSocketConnected>[0]) {
	return page.locator('[data-testid="neo-panel-backdrop"]');
}

/** Locate the Neo chat input */
function getNeoChatInput(page: Parameters<typeof waitForWebSocketConnected>[0]) {
	return page.locator('[data-testid="neo-chat-input"]');
}

/** Wait for the panel to be visible (translated into view) */
async function waitForPanelOpen(page: Parameters<typeof waitForWebSocketConnected>[0]) {
	const panel = getNeoPanel(page);
	// Panel is open when translate-x-0 class is applied (no negative transform)
	await expect(panel).not.toHaveClass(/\-translate-x-full/, { timeout: 3000 });
}

/** Wait for the panel to be hidden (translated out of view) */
async function waitForPanelClosed(page: Parameters<typeof waitForWebSocketConnected>[0]) {
	const panel = getNeoPanel(page);
	await expect(panel).toHaveClass(/-translate-x-full/, { timeout: 3000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Neo Panel — Core Interaction', () => {
	test.use({ viewport: { width: 1280, height: 720 } });

	test.beforeEach(async ({ page }) => {
		// Clear persisted panel state so tests start with a closed panel
		await page.goto('/');
		await page.evaluate(() => localStorage.removeItem('neo:panelOpen'));
		// Reload to apply cleared localStorage before WS connects
		await page.reload();
		await waitForWebSocketConnected(page);
	});

	// ── 1. NavRail Neo button visible ──────────────────────────────────────

	test('NavRail Neo button is visible', async ({ page }) => {
		const btn = getNeoNavButton(page);
		await expect(btn).toBeVisible({ timeout: 5000 });
	});

	// ── 2. Clicking button opens panel and focuses chat input ──────────────

	test('clicking Neo button opens the panel and focuses the chat input', async ({ page }) => {
		const btn = getNeoNavButton(page);
		await btn.click();

		await waitForPanelOpen(page);

		// Chat input should receive focus after opening
		const input = getNeoChatInput(page);
		await expect(input).toBeVisible({ timeout: 3000 });
		await expect(input).toBeFocused({ timeout: 3000 });
	});

	// ── 3. Chat tab active by default ─────────────────────────────────────

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

	// ── 4. Tab switching ───────────────────────────────────────────────────

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
		// Chat view hidden, activity view shown
		await expect(page.locator('[data-testid="neo-chat-view"]')).not.toBeVisible({ timeout: 2000 });

		// Switch back to Chat tab
		const chatTab = page.locator('[data-testid="neo-tab-chat"]');
		await chatTab.click();
		await expect(chatTab).toHaveAttribute('aria-selected', 'true');
		await expect(page.locator('[data-testid="neo-chat-view"]')).toBeVisible({ timeout: 2000 });
	});

	// ── 5. Close button dismisses panel ───────────────────────────────────

	test('close button dismisses the Neo panel', async ({ page }) => {
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		const closeBtn = page.locator('[data-testid="neo-panel-close"]');
		await expect(closeBtn).toBeVisible({ timeout: 3000 });
		await closeBtn.click();

		await waitForPanelClosed(page);
	});

	// ── 6. Click outside (backdrop) dismisses panel ────────────────────────

	test('clicking outside (backdrop) dismisses the Neo panel', async ({ page }) => {
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		// Click the backdrop overlay
		const backdrop = getNeoBackdrop(page);
		await expect(backdrop).toBeVisible({ timeout: 3000 });
		await backdrop.click({ position: { x: 5, y: 5 } });

		await waitForPanelClosed(page);
	});

	// ── 7. Panel state persists in localStorage across navigation ──────────

	test('panel open state persists across page navigation via localStorage', async ({ page }) => {
		// Open the panel
		await getNeoNavButton(page).click();
		await waitForPanelOpen(page);

		// Verify localStorage key is set to 'true'
		const stored = await page.evaluate(() => localStorage.getItem('neo:panelOpen'));
		expect(stored).toBe('true');

		// Reload the page — panel should still be open
		await page.reload();
		await waitForWebSocketConnected(page);

		await waitForPanelOpen(page);

		// Close the panel
		await page.locator('[data-testid="neo-panel-close"]').click();
		await waitForPanelClosed(page);

		// localStorage should now be 'false'
		const storedAfterClose = await page.evaluate(() => localStorage.getItem('neo:panelOpen'));
		expect(storedAfterClose).toBe('false');

		// Reload again — panel should remain closed
		await page.reload();
		await waitForWebSocketConnected(page);

		await waitForPanelClosed(page);
	});

	// ── 8. Cmd+J / Ctrl+J keyboard shortcut toggles panel ─────────────────

	test('Cmd+J / Ctrl+J keyboard shortcut toggles the Neo panel', async ({ page }) => {
		// Determine platform modifier (Meta on macOS, Control otherwise)
		const isMac = process.platform === 'darwin';
		const modifier = isMac ? 'Meta' : 'Control';

		// Panel should start closed
		await waitForPanelClosed(page);

		// Press shortcut to open
		await page.keyboard.press(`${modifier}+j`);
		await waitForPanelOpen(page);

		// Press shortcut again to close
		await page.keyboard.press(`${modifier}+j`);
		await waitForPanelClosed(page);
	});
});
