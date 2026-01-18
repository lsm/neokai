/**
 * Interrupt Error Bug E2E Tests
 *
 * Tests for interrupt-related bugs that should FAIL until fixed:
 * 1. Race condition requiring agent reset after interrupt (ISSUE 2)
 *
 * Root cause identified:
 * - Issue 2: ensureQueryStarted() checks queryPromise which still exists after handleInterrupt()
 *
 * Issue 1 (3 error notifications) appears to be intermittent and scenario-specific,
 * making it difficult to reliably reproduce in E2E tests. The primary focus is on
 * the race condition bug which is consistently reproduced.
 *
 * Reference: https://github.com/anthropics/liuboer/issues/XXX
 */

import { test, expect } from "../fixtures";
import {
  setupMessageHubTesting,
  waitForSessionCreated,
  waitForElement,
  cleanupTestSession,
  waitForSDKSystemInitMessage,
} from "./helpers/wait-helpers";

test.describe("Interrupt Error Bug", () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test.describe("Issue: Race Condition Requiring Reset", () => {
    test("should allow sending messages immediately after interrupt without reset", async ({
      page,
    }) => {
      // This test FAILS when race condition prevents message processing (the bug)
      // The bug: handleInterrupt() returns immediately without awaiting query cleanup,
      // so queryPromise still exists when user sends a new message, causing
      // ensureQueryStarted() to return early without starting a new query.

      // Create a session
      await page
        .getByRole("button", { name: "New Session", exact: true })
        .click();
      const sessionId = await waitForSessionCreated(page);

      // STEP 1: Send first message
      const messageInput = await waitForElement(page, "textarea");
      await messageInput.fill("Tell me about AI");
      await page.click('[data-testid="send-button"]');

      // STEP 2: Wait for SDK to accept the message (system:init message)
      // This indicates the SDK has received the message and started processing
      await waitForSDKSystemInitMessage(page);

      // STEP 3: Interrupt
      await page.locator('[data-testid="stop-button"]').click();
      // Wait for send button to appear (agent back to idle after interrupt)
      await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
        timeout: 5000,
      });

      // STEP 4: Send new message immediately after interrupt
      await messageInput.fill('Just say: "Hello after interrupt"');
      await page.click('[data-testid="send-button"]');

      // STEP 5: Wait for SDK to accept the second message (system:init message)
      await waitForSDKSystemInitMessage(page);

      // Wait for user message to appear
      await expect(page.locator("text=/Hello after interrupt/i")).toBeVisible({
        timeout: 5000,
      });

      // STEP 6: Wait for assistant response
      await expect(
        page.locator('[data-testid="assistant-message"]'),
      ).toBeVisible({
        timeout: 20000,
      });

      // Wait for send button to reappear (agent returns to idle)
      // If bug exists, agent gets stuck and send button never appears
      const sendButtonVisible = await page
        .locator('[data-testid="send-button"]')
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      // This assertion FAILS when agent is stuck (bug) - send button never reappears
      expect(sendButtonVisible).toBe(true);

      await cleanupTestSession(page, sessionId);
    });
  });
});
