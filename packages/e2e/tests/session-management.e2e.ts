import { test, expect } from "@playwright/test";

test.describe("Session Management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("should display sidebar with branding", async ({ page }) => {
    // Check for Liuboer branding in sidebar
    await expect(page.locator("h1:has-text('Liuboer')")).toBeVisible();
    await expect(
      page.locator(".text-2xl:has-text('🤖')"),
    ).toBeVisible();
  });

  test("should have a 'New Session' button", async ({ page }) => {
    const newSessionButton = page.locator("button:has-text('New Session')");
    await expect(newSessionButton).toBeVisible();
    await expect(newSessionButton).toBeEnabled();
  });

  test("should display connection status in footer", async ({ page }) => {
    // Check for connection status indicator
    await expect(page.locator("text=Status")).toBeVisible();
    await expect(page.locator("text=Connected")).toBeVisible();

    // Check for green indicator dot
    const statusDot = page.locator(".bg-green-500").first();
    await expect(statusDot).toBeVisible();
  });

  test("should create a new session when clicking 'New Session'", async ({
    page,
  }) => {
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();

    // Wait for session creation
    await page.waitForTimeout(1000);

    // Should show success toast (if no errors)
    // Note: This test relies on real MessageHub connection and session creation
  });
});
