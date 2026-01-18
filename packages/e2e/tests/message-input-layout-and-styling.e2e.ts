/**
 * Message Input Layout and Styling E2E Tests
 *
 * Tests for message input layout, alignment, and visual styling:
 * - Send button alignment with multiline input
 * - Larger stop button icon
 * - No standalone autoscroll button
 * - Send button size consistency
 */

import { test, expect } from "../fixtures";
import {
  setupMessageHubTesting,
  waitForSessionCreated,
  waitForElement,
  cleanupTestSession,
} from "./helpers/wait-helpers";

test.describe("Message Input Layout and Styling", () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test("should align send button to bottom with multiline input", async ({
    page,
  }) => {
    // Create a session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    const sessionId = await waitForSessionCreated(page);

    // Type multiline text to expand textarea
    const messageInput = await waitForElement(page, "textarea");
    const multilineText = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    await messageInput.fill(multilineText);

    // Wait for textarea to auto-resize
    await page.waitForTimeout(500);

    // Get bounding boxes
    const textareaBox = await messageInput.boundingBox();
    const sendButton = page.locator('[data-testid="send-button"]');
    const sendButtonBox = await sendButton.boundingBox();

    expect(textareaBox).not.toBeNull();
    expect(sendButtonBox).not.toBeNull();

    if (textareaBox && sendButtonBox) {
      // Send button bottom should be near textarea bottom (within 10px)
      const textareaBottom = textareaBox.y + textareaBox.height;
      const sendButtonBottom = sendButtonBox.y + sendButtonBox.height;

      const verticalDistance = Math.abs(textareaBottom - sendButtonBottom);

      // Send button should be positioned at bottom of textarea (within 10px tolerance)
      expect(verticalDistance).toBeLessThan(10);

      // Additionally verify textarea expanded (height > 40px)
      expect(textareaBox.height).toBeGreaterThan(40);
    }

    await cleanupTestSession(page, sessionId);
  });

  test("should show larger interrupt button icon", async ({ page }) => {
    // Create a session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    const sessionId = await waitForSessionCreated(page);

    // Send a message to trigger processing
    const messageInput = await waitForElement(page, "textarea");
    await messageInput.fill(
      "Write a comprehensive guide to distributed systems.",
    );
    await page.click('[data-testid="send-button"]');

    // Wait for processing to start
    await page.waitForTimeout(1000);

    // Stop button should appear
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Get the SVG inside stop button
    const svg = stopButton.locator("svg").first();
    await expect(svg).toBeVisible();

    // Verify SVG has w-4 h-4 class (not w-3.5 h-3.5)
    const svgClasses = await svg.getAttribute("class");
    expect(svgClasses).toContain("w-4");
    expect(svgClasses).toContain("h-4");
    expect(svgClasses).not.toContain("w-3.5");
    expect(svgClasses).not.toContain("h-3.5");

    // Interrupt to clean up
    await stopButton.click();
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });

  test.skip("should not show standalone autoscroll button", async ({
    page,
  }) => {
    // Create a session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    const sessionId = await waitForSessionCreated(page);

    // Wait for input to be ready
    await waitForElement(page, "textarea");

    // Look for standalone autoscroll button (should NOT exist)
    // The old implementation had a button with title containing "Auto-scroll" outside the menu
    const standaloneAutoScrollButton = page.locator(
      'button[title*="Auto-scroll"]:not(:has-text("More options"))',
    );

    // Count should be 0 (no standalone button)
    const count = await standaloneAutoScrollButton.count();
    expect(count).toBe(0);

    // Open plus menu
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();
    await page.waitForTimeout(200);

    // Autoscroll toggle should exist INSIDE the menu
    const autoScrollInMenu = page.locator('button:has-text("Auto-scroll")');
    await expect(autoScrollInMenu).toBeVisible();

    await cleanupTestSession(page, sessionId);
  });

  test.skip("should maintain send button size consistency across states", async ({
    page,
  }) => {
    // Create a session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    const sessionId = await waitForSessionCreated(page);

    const messageInput = await waitForElement(page, "textarea");

    // Get send button dimensions when disabled (no content)
    const sendButtonDisabled = page.locator('[data-testid="send-button"]');
    const disabledBox = await sendButtonDisabled.boundingBox();

    // Type content to enable send button
    await messageInput.fill("Test message");
    await page.waitForTimeout(200);

    // Get send button dimensions when enabled
    const enabledBox = await sendButtonDisabled.boundingBox();

    expect(disabledBox).not.toBeNull();
    expect(enabledBox).not.toBeNull();

    if (disabledBox && enabledBox) {
      // Dimensions should be consistent (w-7 h-7 = 28px)
      expect(disabledBox.width).toBeCloseTo(enabledBox.width, 1);
      expect(disabledBox.height).toBeCloseTo(enabledBox.height, 1);

      // Should be roughly 28px (7 * 4px)
      expect(enabledBox.width).toBeGreaterThanOrEqual(26);
      expect(enabledBox.width).toBeLessThanOrEqual(30);
      expect(enabledBox.height).toBeGreaterThanOrEqual(26);
      expect(enabledBox.height).toBeLessThanOrEqual(30);
    }

    // Send message and check stop button dimensions
    await page.click('[data-testid="send-button"]');
    await page.waitForTimeout(1000);

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    const stopButtonBox = await stopButton.boundingBox();
    expect(stopButtonBox).not.toBeNull();

    if (stopButtonBox && enabledBox) {
      // Stop button should have same dimensions as send button
      expect(stopButtonBox.width).toBeCloseTo(enabledBox.width, 1);
      expect(stopButtonBox.height).toBeCloseTo(enabledBox.height, 1);
    }

    // Interrupt to clean up
    await stopButton.click();
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });
});
