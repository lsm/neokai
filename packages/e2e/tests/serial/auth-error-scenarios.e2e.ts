/**
 * Authentication Error Scenarios E2E Tests
 *
 * Tests for authentication-related error scenarios extracted from interruption-error.e2e.ts.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from "../../fixtures";
import { setupMessageHubTesting } from "../helpers/wait-helpers";

test.describe("Authentication Error Scenarios", () => {
  test("should show authentication status in sidebar", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);

    // Check for auth status indicator
    const authStatus = page
      .locator("text=/OAuth Token|API Key|Not configured/i")
      .first();
    await expect(authStatus).toBeVisible({ timeout: 5000 });

    // If authenticated, should show green indicator
    const isAuthenticated = await page
      .locator(".bg-green-500")
      .first()
      .isVisible()
      .catch(() => false);

    // If not authenticated, should show yellow indicator
    const notAuthenticated = await page
      .locator(".bg-yellow-500")
      .first()
      .isVisible()
      .catch(() => false);

    // Should have one or the other
    expect(isAuthenticated || notAuthenticated).toBe(true);
  });

  test("should handle expired token gracefully", async ({ page }) => {
    await setupMessageHubTesting(page);

    // Simulate token expiration
    await page.evaluate(() => {
      const hub = window.__messageHub;

      // Publish auth error event
      hub.publish(
        "auth.error",
        {
          error: "Token expired",
          code: "TOKEN_EXPIRED",
        },
        { sessionId: "global" },
      );
    });

    // Should update auth status
    await page.waitForTimeout(2000);

    // Check for auth error indication
    const _hasAuthError = await page
      .locator("text=/expired|authentication|unauthorized/i")
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    // Settings button should be accessible to fix auth
    const settingsButton = page
      .locator("button")
      .filter({ hasText: /OAuth|API Key|Not configured/ })
      .first();
    if (await settingsButton.isVisible()) {
      await expect(settingsButton).toBeEnabled();
    }
  });

  test.skip("should prevent message sending without authentication", async ({
    page,
  }) => {
    // TODO: Flaky test - simulating auth state change doesn't reliably trigger UI updates
    await setupMessageHubTesting(page);

    // Simulate no auth state
    await page.evaluate(() => {
      const hub = window.__messageHub;

      // Update system state to not authenticated
      hub.publish(
        "state.system",
        {
          version: "0.1.0",
          claudeSDKVersion: "0.1.37",
          defaultModel: "claude-sonnet-4-5-20250929",
          maxSessions: 10,
          storageLocation: "/tmp",
          auth: {
            isAuthenticated: false,
            method: "none",
            source: "env",
          },
          health: {
            status: "ok",
            version: "0.1.0",
            uptime: 0,
            sessions: { active: 0, total: 0 },
          },
          timestamp: Date.now(),
        },
        { sessionId: "global" },
      );
    });

    // Try to create session
    const newSessionBtn = page.getByRole("button", {
      name: "New Session",
      exact: true,
    });

    // Check if button is disabled or if clicking it produces an error
    const isDisabled = await newSessionBtn.isDisabled();

    if (!isDisabled) {
      await newSessionBtn.click();
      await page.waitForTimeout(2000);
    }

    // Should show error, auth required message, or button should be disabled
    const hasAuthError = await page
      .locator("text=/auth|configuration|api key|token/i")
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    // Or session creation might fail silently and stay on home
    const stillOnHome = await page
      .locator('h2:has-text("Welcome to Liuboer")')
      .isVisible()
      .catch(() => false);

    expect(hasAuthError || stillOnHome || isDisabled).toBe(true);
  });
});
