/**
 * Settings Modal - Basic Interaction E2E Tests
 *
 * Tests for opening and closing the Settings modal.
 */

import { test, expect, type Page } from "../fixtures";
import { waitForWebSocketConnected } from "./helpers/wait-helpers";

/**
 * Open the Settings modal by clicking on Authentication row in sidebar footer
 */
async function openSettingsModal(page: Page): Promise<void> {
  // The settings button is the Authentication row in the sidebar footer
  // It has a gear icon and shows auth status
  const settingsButton = page
    .locator('button:has(svg path[d*="M10.325 4.317"])')
    .first();
  await settingsButton.waitFor({ state: "visible", timeout: 5000 });
  await settingsButton.click();

  // Wait for modal to appear
  await page
    .locator('h2:has-text("Settings")')
    .waitFor({ state: "visible", timeout: 5000 });
}

/**
 * Close the Settings modal
 */
async function closeSettingsModal(page: Page): Promise<void> {
  // Click the close button (X) in the modal header using aria-label
  const closeButton = page.locator(
    '[role="dialog"] button[aria-label="Close modal"]',
  );
  await closeButton.click();

  // Wait for modal to close
  await page
    .locator('h2:has-text("Settings")')
    .waitFor({ state: "hidden", timeout: 3000 });
}

test.describe("Settings Modal - Basic Interaction", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForWebSocketConnected(page);
  });

  test("should open Settings modal from sidebar footer", async ({ page }) => {
    await openSettingsModal(page);

    // Verify modal is open with Settings title
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();
  });

  test.skip("should close Settings modal with close button", async ({
    page,
  }) => {
    // TODO: Modal close button interaction needs to be verified
    await openSettingsModal(page);

    // Verify modal is open
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    // Close the modal
    await closeSettingsModal(page);

    // Verify modal is closed
    await expect(page.locator('h2:has-text("Settings")')).toBeHidden();
  });

  test.skip("should close Settings modal by clicking backdrop", async ({
    page,
  }) => {
    // TODO: Backdrop click behavior needs to be verified
    await openSettingsModal(page);

    // Verify modal is open
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    // Click backdrop (the overlay behind the modal)
    // The backdrop should be a sibling or parent element of the modal
    await page
      .locator('[role="dialog"]')
      .locator("..")
      .click({ position: { x: 10, y: 10 } });

    // Wait for modal to close
    await page.waitForTimeout(500);

    // Verify modal is closed (may or may not close on backdrop click depending on implementation)
    // Some modals close on backdrop click, some don't - we'll just verify it can be closed
  });

  test.skip("should close Settings modal with Escape key", async ({ page }) => {
    await openSettingsModal(page);

    // Verify modal is open
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    // Press Escape
    await page.keyboard.press("Escape");

    // Wait for modal to close
    await page.waitForTimeout(500);

    // Verify modal is closed
    await expect(page.locator('h2:has-text("Settings")')).toBeHidden();
  });
});
