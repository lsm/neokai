import { test, expect } from "@playwright/test";

test.describe("Home Page", () => {
  test("should display the welcome screen when no session is selected", async ({
    page,
  }) => {
    await page.goto("/");

    // Check for welcome message
    await expect(page.locator("text=Welcome to Liuboer")).toBeVisible();
    await expect(
      page.locator("text=Select a session or create a new one to get started"),
    ).toBeVisible();

    // Check for description
    await expect(
      page.locator("text=A modern wrapper around Claude Agent SDK"),
    ).toBeVisible();
  });

  test("should have a sidebar visible", async ({ page }) => {
    await page.goto("/");

    // Sidebar should be visible - look for the sidebar header
    const sidebarTitle = page.locator('h1:has-text("Liuboer")');
    await expect(sidebarTitle).toBeVisible();

    // Check for New Session button in sidebar
    await expect(page.locator("button:has-text('New Session')")).toBeVisible();
  });

  test("should have proper page title", async ({ page }) => {
    await page.goto("/");

    // Check page title
    await expect(page).toHaveTitle(/Liuboer/i);
  });

  test("should apply dark theme styles", async ({ page }) => {
    await page.goto("/");

    // Check that dark background is applied
    const mainContainer = page.locator(".bg-dark-950").first();
    await expect(mainContainer).toBeVisible();
  });

  test("should be responsive on mobile", async ({ page, isMobile }) => {
    await page.goto("/");

    // The page should load without errors on mobile
    await expect(page.locator("text=Welcome to Liuboer")).toBeVisible();

    // Check viewport is mobile-friendly
    if (isMobile) {
      const viewport = page.viewportSize();
      expect(viewport?.width).toBeLessThan(768);
    }
  });
});
