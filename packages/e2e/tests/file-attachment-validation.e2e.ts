/**
 * File Attachment Validation E2E Tests
 *
 * Tests for file attachment validation:
 * - File size validation (reject > 5MB)
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
const largeImagePath = path.join(fixturesDir, "large-image.png");

test.describe("File Attachment - Validation", () => {
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

    // Create a large image (> 5MB) for validation testing
    // Repeat the PNG data to make it larger than 5MB
    const largeData = Buffer.concat([
      pngData,
      Buffer.alloc(6 * 1024 * 1024, 0x00),
    ]);
    fs.writeFileSync(largeImagePath, largeData);
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

  test("should validate file size (reject > 5MB)", async ({ page }) => {
    // Create a new session
    await page
      .getByRole("button", { name: "New Session", exact: true })
      .click();
    sessionId = await waitForSessionCreated(page);

    // Try to attach a large file
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(largeImagePath);

    await page.waitForTimeout(1000);

    // Should show an error toast (look for error message)
    const errorToast = page.locator("text=/must be under.*5MB/i");
    await expect(errorToast).toBeVisible({ timeout: 3000 });

    // Attachment should not be added (no remove button visible)
    const removeButton = page.locator('button[aria-label="Remove attachment"]');
    await expect(removeButton).not.toBeVisible();
  });
});
