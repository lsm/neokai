/**
 * Mobile-specific test helpers for sidebar/panel interactions.
 *
 * These replace fragile waitForTimeout-based sidebar toggling with
 * event-based waits that detect panel open/close via DOM state.
 */

import { expect, type Page } from '@playwright/test';

/** Locator for the mobile menu (hamburger) button that opens the context panel. */
const openMenuButton = (page: Page) => page.locator('button[aria-label="Open navigation menu"]');

/** Locator for the close button inside the context panel (mobile only). */
const closePanelButton = (page: Page) => page.locator('button[title="Close panel"]');

/**
 * Open the mobile context panel (sidebar/drawer) and wait for it to be ready.
 * If already open, this is a no-op.
 */
export async function openMobilePanel(page: Page): Promise<void> {
	const menuBtn = openMenuButton(page);
	const closeBtn = closePanelButton(page);

	// Panel is open if close button is visible
	if (await closeBtn.isVisible().catch(() => false)) {
		return;
	}

	await menuBtn.click();

	// Wait for close button to appear — confirms panel finished its open animation
	await expect(closeBtn).toBeVisible({ timeout: 5000 });
}

/**
 * Close the mobile context panel (sidebar/drawer) and wait for it to finish.
 * If already closed, this is a no-op.
 */
export async function closeMobilePanel(page: Page): Promise<void> {
	const closeBtn = closePanelButton(page);

	if (!(await closeBtn.isVisible().catch(() => false))) {
		return;
	}

	await closeBtn.click();

	// Wait for close button to disappear — confirms panel finished closing
	await expect(closeBtn).toBeHidden({ timeout: 5000 });
}
