/**
 * File Attachment Send E2E Tests
 *
 * Tests for sending messages with file attachments:
 * - Sending messages with single image
 * - Multiple image attachments
 * - Clearing attachments after sending
 */

import { test, expect } from "../fixtures";
import {
  cleanupTestSession,
  waitForSessionCreated,
} from "./helpers/wait-helpers";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create test image fixtures
const fixturesDir = path.join(__dirname, "fixtures", "images");
const testImagePath = path.join(fixturesDir, "test-image.png");

test.describe("File Attachment - Send", () => {
  let sessionId: string | null = null;

  test.beforeAll(() => {
    // Create fixtures directory
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    // Create a simple 1x1 PNG test image (valid PNG)
    const pngData = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52, // IHDR chunk
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01, // 1x1 pixels
      0x08,
      0x06,
      0x00,
      0x00,
      0x00,
      0x1f,
      0x15,
      0xc4,
      0x89, // etc.
      0x00,
      0x00,
      0x00,
      0x0a,
      0x49,
      0x44,
      0x41,
      0x54, // IDAT chunk
      0x78,
      0x9c,
      0x63,
      0x00,
      0x01,
      0x00,
      0x00,
      0x05,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x45,
      0x4e,
      0x44, // IEND chunk
      0xae,
      0x42,
      0x60,
      0x82,
    ]);

    fs.writeFileSync(testImagePath, pngData);
  });

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

  test("should send message with attached image", async ({ page }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Attach an image
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    await page.waitForTimeout(500);

    // Type a message
    const textarea = page.locator('textarea[placeholder*="Ask"]');
    await textarea.fill("Here is a test image");

    // Send the message
    const sendButton = page.locator('button[aria-label="Send message"]');
    await sendButton.click();

    // Wait for the message to appear
    await page.waitForTimeout(1000);

    // The user message should be visible with text
    const userMessage = page.locator('[data-message-role="user"]').last();
    await expect(userMessage).toContainText("Here is a test image");

    // The attached image should be visible in the sent message
    const sentImage = userMessage.locator('img[alt="Attached image"]');
    await expect(sentImage).toBeVisible();
  });

  test("should support multiple image attachments", async ({ page }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Attach multiple images at once
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;

    // Select same image twice (simulating multiple files)
    await fileChooser.setFiles([testImagePath, testImagePath]);

    await page.waitForTimeout(500);

    // Should show 2 attachment previews
    const previews = page.locator('img[src^="data:image"]');
    await expect(previews).toHaveCount(2);
  });

  test("should clear attachments after sending message", async ({ page }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Attach an image
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    await page.waitForTimeout(1000);

    // Verify attachment is shown via the remove button
    const removeButton = page.locator('button[aria-label="Remove attachment"]');
    await expect(removeButton).toBeVisible({ timeout: 10000 });

    // Type and send message
    const textarea = page.locator('textarea[placeholder*="Ask"]');
    await textarea.fill("Test message with image");

    const sendButton = page.locator('[data-testid="send-button"]');
    await sendButton.click();

    // Wait for message to be sent
    await page.waitForTimeout(2000);

    // Attachment preview should be cleared (remove button gone)
    await expect(removeButton).not.toBeVisible({ timeout: 5000 });
  });
});
