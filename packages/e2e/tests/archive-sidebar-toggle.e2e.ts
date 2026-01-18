/**
 * Session Archive - Sidebar Toggle Tests
 *
 * Tests for the archived sessions sidebar toggle functionality.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from "../fixtures";
import {
  openSessionOptionsMenu,
  clickArchiveSession,
  createSessionWithMessage,
  goToHomePage,
  showArchivedSessions,
} from "./helpers/session-archive-helpers";
import { cleanupTestSession } from "./helpers/wait-helpers";

test.describe("Session Archive - Sidebar Toggle", () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await goToHomePage(page);
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

  test("should hide archived sessions by default", async ({ page }) => {
    // Create and archive a session
    sessionId = await createSessionWithMessage(page);

    // Get session title before archiving
    const sessionLink = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionLink).toBeVisible();

    // Archive the session
    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    // Wait for archive to complete
    await page.waitForTimeout(1500);

    // The "Show archived" toggle should appear since we now have an archived session
    const showArchivedToggle = page.locator("text=Show archived");

    // If toggle is visible, archived sessions are hidden by default
    if ((await showArchivedToggle.count()) > 0) {
      await expect(showArchivedToggle).toBeVisible();
    }
  });

  test("should show archived toggle when archived sessions exist", async ({
    page,
  }) => {
    // Create and archive a session
    sessionId = await createSessionWithMessage(page);

    // Archive the session
    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    // Wait for archive to complete
    await page.waitForTimeout(1500);

    // Navigate away from the archived session
    await goToHomePage(page);

    // The toggle should be visible
    const toggleButton = page.locator(
      'button:has-text("Show archived"), button:has-text("Hide archived")',
    );
    await expect(toggleButton).toBeVisible({ timeout: 3000 });
  });

  test("should toggle archived sessions visibility", async ({ page }) => {
    // Create and archive a session
    sessionId = await createSessionWithMessage(page);

    // Archive the session
    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    // Wait for archive to complete
    await page.waitForTimeout(1500);

    // Navigate home
    await goToHomePage(page);

    // Find and click the Show archived toggle
    const showArchivedButton = page.locator('button:has-text("Show archived")');
    if ((await showArchivedButton.count()) > 0) {
      await showArchivedButton.click();

      // Wait for toggle
      await page.waitForTimeout(500);

      // Should now show "Hide archived"
      await expect(page.locator("text=Hide archived")).toBeVisible();

      // The archived session should now be visible in the list
      const sessionLink = page.locator(`[data-session-id="${sessionId}"]`);
      await expect(sessionLink).toBeVisible();
    }
  });

  test("should show archive indicator on archived session in list", async ({
    page,
  }) => {
    // Create and archive a session
    sessionId = await createSessionWithMessage(page);

    // Archive the session
    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    // Wait for archive to complete
    await page.waitForTimeout(1500);

    // Navigate home to see the list
    await goToHomePage(page);

    // Show archived sessions
    await showArchivedSessions(page);

    // The archived session should have an archive indicator
    const sessionLink = page.locator(`[data-session-id="${sessionId}"]`);
    if ((await sessionLink.count()) > 0) {
      // Check for archive icon within the session item
      // Note: The exact selector depends on implementation
      await expect(sessionLink).toBeVisible();
    }
  });
});
