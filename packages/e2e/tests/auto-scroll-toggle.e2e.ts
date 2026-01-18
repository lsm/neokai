import { test, expect } from "../fixtures";
import {
  cleanupTestSession,
  waitForSessionCreated,
} from "./helpers/wait-helpers";

/**
 * Auto-Scroll Toggle E2E Tests
 *
 * Tests the auto-scroll toggle feature in the message input plus menu.
 * - Toggle visibility in plus menu
 * - Toggle state changes
 * - Persistence of setting across page reloads
 * - Visual feedback when enabled/disabled
 *
 * NOTE: The auto-scroll toggle is inside the plus menu dropdown, not a standalone button.
 */

/**
 * Open the plus menu in the message input
 */
async function openPlusMenu(
  page: import("@playwright/test").Page,
): Promise<void> {
  const plusButton = page.locator('button[title="More options"]');
  await plusButton.waitFor({ state: "visible", timeout: 5000 });
  await plusButton.click();
  // Wait for menu to animate in
  await page.waitForTimeout(300);
}

/**
 * Get the auto-scroll toggle button inside the menu
 */
function getAutoScrollToggle(page: import("@playwright/test").Page) {
  return page.locator('button:has-text("Auto-scroll")');
}

test.describe("Auto-Scroll Toggle", () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Liuboer", exact: true }).first(),
    ).toBeVisible();
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

  test("should display auto-scroll toggle in plus menu", async ({ page }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Open the plus menu
    await openPlusMenu(page);

    // The auto-scroll toggle should be visible in the menu
    const autoScrollToggle = getAutoScrollToggle(page);
    await expect(autoScrollToggle).toBeVisible();
  });

  test("should toggle auto-scroll state on click", async ({ page }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Open the plus menu
    await openPlusMenu(page);

    // Get the toggle
    const autoScrollToggle = getAutoScrollToggle(page);
    await expect(autoScrollToggle).toBeVisible();

    // Initially auto-scroll should be OFF (no checkmark visible)
    const checkmarkBefore = autoScrollToggle.locator(
      'svg[class*="text-blue-400"]',
    );
    const hasCheckmarkBefore = (await checkmarkBefore.count()) > 0;

    // Click to toggle
    await autoScrollToggle.click();
    await page.waitForTimeout(500);

    // Menu closes after click, reopen it
    await openPlusMenu(page);

    // State should have changed
    const checkmarkAfter = getAutoScrollToggle(page).locator(
      'svg[class*="text-blue-400"]',
    );
    const hasCheckmarkAfter = (await checkmarkAfter.count()) > 0;

    // The checkmark state should be different
    expect(hasCheckmarkAfter).not.toBe(hasCheckmarkBefore);
  });

  test("should persist auto-scroll setting across page reload", async ({
    page,
  }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Open the plus menu
    await openPlusMenu(page);

    // Get the toggle
    const autoScrollToggle = getAutoScrollToggle(page);
    await expect(autoScrollToggle).toBeVisible();

    // Check initial state - look for the blue checkmark SVG
    const initialHasCheckmark =
      (await autoScrollToggle.locator('svg[class*="text-blue-400"]').count()) >
      0;

    // Toggle to opposite state
    await autoScrollToggle.click();
    await page.waitForTimeout(500);

    // Reload the page
    await page.reload();
    await page.waitForTimeout(1500);

    // After reload, page goes to home. Click on the session card to re-select it
    const sessionCard = page.locator(
      `[data-testid="session-card"][data-session-id="${sessionId}"]`,
    );
    await expect(sessionCard).toBeVisible({ timeout: 5000 });
    await sessionCard.click();
    await page.waitForTimeout(1000);

    // Open the plus menu again
    await openPlusMenu(page);

    // Get the toggle after reload
    const autoScrollToggleAfterReload = getAutoScrollToggle(page);
    await expect(autoScrollToggleAfterReload).toBeVisible();

    // Check state - should be toggled (opposite of initial)
    const afterReloadHasCheckmark =
      (await autoScrollToggleAfterReload
        .locator('svg[class*="text-blue-400"]')
        .count()) > 0;

    // State should have persisted (opposite of initial)
    expect(afterReloadHasCheckmark).not.toBe(initialHasCheckmark);
  });

  test("should have visual distinction between enabled and disabled states", async ({
    page,
  }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Open the plus menu
    await openPlusMenu(page);

    // Get the toggle
    const autoScrollToggle = getAutoScrollToggle(page);
    await expect(autoScrollToggle).toBeVisible();

    // Get the icon SVG inside the toggle
    const iconSvg = autoScrollToggle.locator("svg").first();
    const initialClass = await iconSvg.getAttribute("class");

    // Toggle state
    await autoScrollToggle.click();
    await page.waitForTimeout(500);

    // Reopen menu
    await openPlusMenu(page);

    // Get the icon class again
    const toggledClass = await getAutoScrollToggle(page)
      .locator("svg")
      .first()
      .getAttribute("class");

    // The class should have changed (text-gray-400 vs text-blue-400)
    expect(initialClass).not.toBe(toggledClass);
  });

  test("should show checkmark when enabled", async ({ page }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Open the plus menu
    await openPlusMenu(page);

    // Get the toggle
    const autoScrollToggle = getAutoScrollToggle(page);
    await expect(autoScrollToggle).toBeVisible();

    // Check if initially enabled (has checkmark)
    const initialHasCheckmark =
      (await autoScrollToggle.locator('svg[class*="text-blue-400"]').count()) >
      0;

    // Toggle until enabled
    if (!initialHasCheckmark) {
      await autoScrollToggle.click();
      await page.waitForTimeout(500);
      await openPlusMenu(page);
    }

    // Now should have checkmark (use first() to avoid strict mode violation with multiple SVGs)
    const checkmark = getAutoScrollToggle(page)
      .locator('svg[class*="text-blue-400"]')
      .first();
    await expect(checkmark).toBeVisible();
  });
});
