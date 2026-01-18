/**
 * Context Usage Display E2E Tests
 *
 * Tests for context usage indicator display:
 * - Context usage indicator visibility
 * - Loading state display
 * - Toggle dropdown when clicking indicator
 */

import { test, expect } from "../fixtures";
import {
  setupMessageHubTesting,
  waitForSessionCreated,
  cleanupTestSession,
  waitForAssistantResponse,
} from "./helpers/wait-helpers";

test.describe("Context Usage - Display", () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
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

  test("should display context usage indicator", async ({ page }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Context usage bar should be visible (the clickable indicator area)
    // Title is "Context data loading..." initially
    const contextIndicator = page.locator('[title="Context data loading..."]');
    await expect(contextIndicator).toBeVisible({ timeout: 10000 });
  });

  test("should show context loading state initially", async ({ page }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Initial state should show loading message
    const loadingIndicator = page.locator('[title="Context data loading..."]');
    await expect(loadingIndicator).toBeVisible({ timeout: 10000 });
  });

  test("should toggle dropdown when clicking indicator again", async ({
    page,
  }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill("Hello");
    await page.keyboard.press("Enter");

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Open context dropdown
    const contextIndicator = page.locator(
      '[title="Click for context details"]',
    );
    await expect(contextIndicator).toBeVisible({ timeout: 15000 });
    await contextIndicator.click();

    // Wait for dropdown to appear
    await expect(page.locator("text=Context Usage")).toBeVisible({
      timeout: 5000,
    });

    // Click indicator again to close
    await contextIndicator.click();

    // Dropdown should close
    await expect(page.locator("text=Context Usage")).not.toBeVisible({
      timeout: 3000,
    });
  });
});
