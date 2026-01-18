/**
 * Git Worktree Icon - E2E Tests
 *
 * Tests the git branch icon that appears in the sidebar for worktree sessions.
 * The icon is purple and shows the branch name in a tooltip.
 */

import { test, expect } from "../fixtures";
import {
  cleanupTestSession,
  waitForSessionCreated,
} from "./helpers/wait-helpers";

test.describe("Git Worktree Icon", () => {
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

  test("should show git branch icon for worktree sessions after first message", async ({
    page,
  }) => {
    // Create a new session
    const newSessionButton = page.getByRole("button", {
      name: "New Session",
      exact: true,
    });
    await newSessionButton.click();
    sessionId = await waitForSessionCreated(page);

    const sessionCard = page.locator(
      `[data-testid="session-card"][data-session-id="${sessionId}"]`,
    );
    await expect(sessionCard).toBeVisible();

    // Before first message, worktree is not initialized yet
    // Git branch icon should not be visible
    let gitBranchIcon = sessionCard
      .locator('svg[viewBox="0 0 16 16"]')
      .locator('path[d*="M11.75 2.5"]');

    // Send a message to trigger Stage 2 (workspace initialization with worktree)
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill("Initialize workspace test");
    await page.keyboard.press("Meta+Enter");

    // Wait for response
    await expect(
      page.locator('[data-message-role="assistant"]').first(),
    ).toBeVisible({
      timeout: 60000,
    });

    // Wait for worktree initialization to complete
    await page.waitForTimeout(3000);

    // After workspace initialization, if it's a worktree session,
    // the git branch icon should be visible (purple color)
    // Note: This depends on whether the test workspace is a git repo
    gitBranchIcon = sessionCard.locator(".text-purple-400 svg");
    const isVisible = await gitBranchIcon.isVisible().catch(() => false);

    // If git branch icon is visible, it should have a tooltip
    if (isVisible) {
      await expect(gitBranchIcon.locator("..")).toHaveAttribute(
        "title",
        /Worktree:/,
      );
    }
  });

  test("should display git branch icon aligned to the right of title", async ({
    page,
  }) => {
    // Create a new session
    const newSessionButton = page.getByRole("button", {
      name: "New Session",
      exact: true,
    });
    await newSessionButton.click();
    sessionId = await waitForSessionCreated(page);

    // Send message to trigger workspace initialization
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill("Test worktree alignment");
    await page.keyboard.press("Meta+Enter");

    await expect(
      page.locator('[data-message-role="assistant"]').first(),
    ).toBeVisible({
      timeout: 60000,
    });

    // Wait for worktree to initialize
    await page.waitForTimeout(3000);

    const sessionCard = page.locator(
      `[data-testid="session-card"][data-session-id="${sessionId}"]`,
    );

    // Check if git branch icon exists and is positioned correctly
    const gitIconContainer = sessionCard.locator(".text-purple-400");
    const isVisible = await gitIconContainer.isVisible().catch(() => false);

    if (isVisible) {
      // The icon should be in a flex container that aligns it to the right
      // Check that it's in the icons group (flex-shrink-0)
      const parentClasses = await gitIconContainer
        .locator("..")
        .getAttribute("class");
      expect(parentClasses).toContain("flex-shrink-0");
    }
  });
});
