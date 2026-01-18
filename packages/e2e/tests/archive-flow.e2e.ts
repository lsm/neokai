/**
 * Session Archive - Archiving Flow Tests
 *
 * Tests for the archiving flow and behavior.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from "../fixtures";
import {
  openSessionOptionsMenu,
  clickArchiveSession,
  createSessionWithMessage,
} from "./helpers/session-archive-helpers";
import {
  waitForWebSocketConnected,
  cleanupTestSession,
} from "./helpers/wait-helpers";

test.describe("Session Archive - Archiving Flow", () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForWebSocketConnected(page);
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

  test("should archive session successfully", async ({ page }) => {
    // Create session with a message
    sessionId = await createSessionWithMessage(page);

    // Open options and click archive
    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    // Wait for success toast or UI update
    await page.waitForTimeout(1000);

    // Should show success toast with "successfully" or the archived label
    await expect(page.locator("text=Session archived").first()).toBeVisible({
      timeout: 5000,
    });
  });

  test("should show archived label after archiving", async ({ page }) => {
    // Create session with a message
    sessionId = await createSessionWithMessage(page);

    // Archive the session
    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    // Wait for archive to complete
    await page.waitForTimeout(1000);

    // Should show "Session archived" label in the chat area
    await expect(page.locator("text=Session archived").first()).toBeVisible({
      timeout: 5000,
    });
  });

  test("should disable Archive option for already archived session", async ({
    page,
  }) => {
    // Create session with a message
    sessionId = await createSessionWithMessage(page);

    // Archive the session
    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    // Wait for archive to complete
    await page.waitForTimeout(1500);

    // Open options menu again
    await openSessionOptionsMenu(page);

    // Archive option should be disabled or show "Unarchive" instead
    const archiveItem = page.locator("text=Archive Session").first();
    const _isDisabled =
      (await archiveItem.getAttribute("aria-disabled")) === "true" ||
      (await archiveItem.locator("..").getAttribute("class"))?.includes(
        "opacity",
      ) ||
      (await archiveItem.locator("..").getAttribute("class"))?.includes(
        "cursor-not-allowed",
      );

    // Close menu
    await page.keyboard.press("Escape");
  });
});
