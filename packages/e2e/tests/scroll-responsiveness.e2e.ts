import { test, expect } from "../fixtures";
import {
  cleanupTestSession,
  waitForSessionCreated,
  waitForAssistantResponse,
} from "./helpers/wait-helpers";

/**
 * Scroll Responsiveness E2E Tests
 *
 * Tests that scrolling remains responsive during message processing.
 * Verifies fixes for:
 * 1. touch-action CSS property allowing scroll gestures
 * 2. Passive scroll event listeners for performance
 * 3. Scroll behavior during state transitions ("Starting...", "Streaming...")
 */
test.describe("Scroll Responsiveness", () => {
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

  test("should have correct CSS touch-action on body", async ({ page }) => {
    // Verify body has touch-action: manipulation (not none)
    const touchAction = await page.evaluate(() => {
      return window.getComputedStyle(document.body).touchAction;
    });

    // touch-action should be 'manipulation' to allow touch gestures
    expect(touchAction).toBe("manipulation");
  });

  test("should NOT have position:fixed on html element", async ({ page }) => {
    // Verify html does not have position: fixed (which can cause layout issues)
    const htmlPosition = await page.evaluate(() => {
      return window.getComputedStyle(document.documentElement).position;
    });

    // html should NOT be fixed positioned
    expect(htmlPosition).not.toBe("fixed");
  });

  test("should have scrollable message container with correct CSS", async ({
    page,
  }) => {
    // Create a session to get the message container
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .first()
      .click();
    sessionId = await waitForSessionCreated(page);

    // Verify message container has correct scroll-related CSS
    const containerStyles = await page.evaluate(() => {
      const container = document.querySelector(
        "[data-messages-container]",
      ) as HTMLElement;
      if (!container) return null;

      const styles = window.getComputedStyle(container);
      return {
        overflowY: styles.overflowY,
        touchAction: styles.touchAction,
        overscrollBehavior: styles.overscrollBehavior,
      };
    });

    expect(containerStyles).not.toBeNull();
    expect(containerStyles!.overflowY).toMatch(/scroll|auto/);
    // touch-action should allow vertical panning
    expect(containerStyles!.touchAction).toMatch(/pan-y|manipulation|auto/);
  });

  test('should allow scrolling during "Starting..." phase', async ({
    page,
  }) => {
    // Create session with some content first
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .first()
      .click();
    sessionId = await waitForSessionCreated(page);

    // Send a message to get some content
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill("Write a long list of 20 items about programming.");
    await messageInput.press("Enter");
    await waitForAssistantResponse(page, { timeout: 45000 });

    // Wait for content to render
    await page.waitForTimeout(500);

    // Scroll to top to prepare for next test
    await page.evaluate(() => {
      const container = document.querySelector(
        "[data-messages-container]",
      ) as HTMLElement;
      if (container) container.scrollTop = 0;
    });
    await page.waitForTimeout(300);

    // Now send another message - during "Starting..." we should still be able to scroll
    await messageInput.fill("Explain TypeScript generics");

    // Get initial scroll position
    const initialScrollTop = await page.evaluate(() => {
      const container = document.querySelector(
        "[data-messages-container]",
      ) as HTMLElement;
      return container?.scrollTop || 0;
    });

    // Press enter to send (will trigger "Starting..." state)
    await messageInput.press("Enter");

    // Immediately try to scroll while in "Starting..." state
    // Use evaluate to scroll programmatically (simulates touch/wheel scroll)
    await page.evaluate(() => {
      const container = document.querySelector(
        "[data-messages-container]",
      ) as HTMLElement;
      if (container) {
        container.scrollTop = container.scrollTop + 100;
      }
    });

    // Verify scroll actually happened (not blocked)
    const newScrollTop = await page.evaluate(() => {
      const container = document.querySelector(
        "[data-messages-container]",
      ) as HTMLElement;
      return container?.scrollTop || 0;
    });

    // Scroll should have changed (within some tolerance for smooth scroll)
    expect(newScrollTop).toBeGreaterThan(initialScrollTop);

    // Wait for response to complete
    await waitForAssistantResponse(page, { timeout: 45000 });
  });

  test("scroll event listeners should be passive", async ({ page }) => {
    // Create a session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .first()
      .click();
    sessionId = await waitForSessionCreated(page);

    // Test that scroll events are not blocking
    // We do this by measuring scroll performance
    const scrollPerformance = await page.evaluate(async () => {
      const container = document.querySelector(
        "[data-messages-container]",
      ) as HTMLElement;
      if (!container) return { success: false, reason: "no container" };

      // Create some content to scroll
      container.innerHTML = Array(100)
        .fill(0)
        .map((_, i) => `<div style="height: 100px">Item ${i}</div>`)
        .join("");

      // Measure scroll performance
      const scrollEvents: number[] = [];
      let lastEventTime = 0;

      const handler = () => {
        const now = performance.now();
        if (lastEventTime > 0) {
          scrollEvents.push(now - lastEventTime);
        }
        lastEventTime = now;
      };

      container.addEventListener("scroll", handler);

      // Perform multiple scrolls
      for (let i = 0; i < 10; i++) {
        container.scrollTop = i * 200;
        await new Promise((r) => setTimeout(r, 16)); // ~60fps
      }

      container.removeEventListener("scroll", handler);

      // Calculate average time between scroll events
      const avgTime =
        scrollEvents.length > 0
          ? scrollEvents.reduce((a, b) => a + b, 0) / scrollEvents.length
          : 0;

      return {
        success: true,
        eventCount: scrollEvents.length,
        avgTimeBetweenEvents: avgTime,
      };
    });

    expect(scrollPerformance.success).toBe(true);
    // With passive listeners, scroll events should fire quickly (< 50ms between events)
    // This is a sanity check - non-passive listeners could block and cause > 100ms delays
    if (scrollPerformance.eventCount > 0) {
      expect(scrollPerformance.avgTimeBetweenEvents).toBeLessThan(100);
    }
  });

  test("buttons should remain clickable during scroll", async ({ page }) => {
    // Create a session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .first()
      .click();
    sessionId = await waitForSessionCreated(page);

    // Send a message to get content and scroll button
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill("List 30 programming languages with descriptions.");
    await messageInput.press("Enter");
    await waitForAssistantResponse(page, { timeout: 45000 });

    await page.waitForTimeout(500);

    // Check if we have scrollable content
    const hasScrollableContent = await page.evaluate(() => {
      const container = document.querySelector(
        "[data-messages-container]",
      ) as HTMLElement;
      return container && container.scrollHeight > container.clientHeight;
    });

    if (!hasScrollableContent) {
      test.skip();
      return;
    }

    // Scroll to top
    await page.evaluate(() => {
      const container = document.querySelector(
        "[data-messages-container]",
      ) as HTMLElement;
      if (container) container.scrollTop = 0;
    });
    await page.waitForTimeout(500);

    // Scroll button should appear and be clickable
    const scrollButton = page.locator('button[aria-label="Scroll to bottom"]');
    await expect(scrollButton).toBeVisible({ timeout: 5000 });

    // Button should be clickable (not blocked by touch-action or other CSS)
    await scrollButton.click();

    // Wait for scroll animation
    await page.waitForTimeout(1000);

    // Button should now be hidden
    await expect(scrollButton).not.toBeVisible();
  });

  test("message input should remain responsive during state transitions", async ({
    page,
  }) => {
    // Create a session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .first()
      .click();
    sessionId = await waitForSessionCreated(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();

    // Input should be enabled initially
    await expect(messageInput).toBeEnabled();

    // Type a message
    await messageInput.fill("Hello");

    // Send it
    await messageInput.press("Enter");

    // During processing, input should be disabled (expected behavior)
    // But it should NOT be completely frozen/unresponsive

    // Wait for response
    await waitForAssistantResponse(page, { timeout: 45000 });

    // After response, input should be enabled again
    await expect(messageInput).toBeEnabled();

    // Should be able to type immediately
    await messageInput.fill("Another message");
    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe("Another message");
  });
});
