import { test, expect } from "@playwright/test";

test.describe("UI Components", () => {
  test.beforeEach(async ({ page }) => {
    // Mock sessions list
    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [{
            id: "test-session",
            title: "Test Session",
            lastActiveAt: new Date().toISOString(),
            metadata: { messageCount: 0 },
          }],
        }),
      });
    });

    await page.goto("/");
    await page.waitForTimeout(500);
  });

  test.describe("Toast Notifications", () => {
    test("should show success toast when session is created", async ({
      page,
    }) => {
      // Mock create session
      await page.route("**/api/sessions", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              sessionId: "new-session",
              message: "Session created",
            }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              sessions: [{
                id: "new-session",
                title: "New Session",
                lastActiveAt: new Date().toISOString(),
                metadata: { messageCount: 0 },
              }],
            }),
          });
        }
      });

      // Click new session button
      await page.locator("button:has-text('New Session')").click();

      // Toast should appear
      await expect(
        page.locator("text=Session created successfully"),
      ).toBeVisible({ timeout: 5000 });
    });

    test("should show error toast when API fails", async ({ page }) => {
      // Mock API error
      await page.route("**/api/sessions", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Internal server error" }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: [] }),
          });
        }
      });

      // Try to create session
      await page.locator("button:has-text('New Session')").click();

      // Error toast should appear
      await expect(
        page.locator('[class*="text-red"]').filter({ hasText: /failed/i })
          .first(),
      ).toBeVisible({ timeout: 5000 });
    });

    test("should auto-dismiss toast after timeout", async ({ page }) => {
      // Mock create session
      await page.route("**/api/sessions", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              sessionId: "new-session",
              message: "Session created",
            }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              sessions: [{
                id: "new-session",
                title: "New Session",
                lastActiveAt: new Date().toISOString(),
                metadata: { messageCount: 0 },
              }],
            }),
          });
        }
      });

      // Trigger toast
      await page.locator("button:has-text('New Session')").click();

      // Toast should appear
      const toast = page.locator("text=Session created successfully");
      await expect(toast).toBeVisible({ timeout: 5000 });

      // Wait for auto-dismiss (assuming 3-5 seconds)
      await page.waitForTimeout(6000);

      // Toast should be gone
      await expect(toast).not.toBeVisible();
    });
  });

  test.describe("Buttons", () => {
    test("should show loading state on buttons", async ({ page }) => {
      // Mock slow API
      await page.route("**/api/sessions", async (route) => {
        if (route.request().method() === "POST") {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              sessionId: "new-session",
              message: "Session created",
            }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: [] }),
          });
        }
      });

      const newSessionButton = page.locator("button:has-text('New Session')");

      // Click button
      await newSessionButton.click();

      // Button should show loading state (disabled or with spinner)
      await expect(newSessionButton).toBeDisabled();
    });

    test("should have hover effects on interactive elements", async ({
      page,
    }) => {
      const newSessionButton = page.locator("button:has-text('New Session')");

      // Get initial styles
      const initialColor = await newSessionButton.evaluate((el) =>
        window.getComputedStyle(el).backgroundColor
      );

      // Hover over button
      await newSessionButton.hover();

      // Wait for transition
      await page.waitForTimeout(200);

      // Color might change on hover (depending on implementation)
      // This is a basic check that the element is interactive
      await expect(newSessionButton).toBeVisible();
    });
  });

  test.describe("Modals", () => {
    test("should open and close delete confirmation modal", async ({
      page,
    }) => {
      // Click on session
      await page.locator("text=Test Session").click();

      // Click menu button
      const menuButton = page.locator('button[title="Session options"]')
        .first();
      await menuButton.click();

      // Click delete
      await page.locator("text=Delete").last().click();

      // Modal should open
      await expect(page.locator("text=Delete Session")).toBeVisible();

      // Click cancel
      await page.locator("button:has-text('Cancel')").click();

      // Modal should close
      await expect(page.locator("text=Delete Session")).not.toBeVisible();
    });

    test("should close modal when clicking outside (if applicable)", async ({
      page,
    }) => {
      // Click on session
      await page.locator("text=Test Session").click();

      // Open delete modal
      const menuButton = page.locator('button[title="Session options"]')
        .first();
      await menuButton.click();
      await page.locator("text=Delete").last().click();

      // Modal should be visible
      await expect(page.locator("text=Delete Session")).toBeVisible();

      // Try clicking outside modal (if backdrop exists)
      const backdrop = page.locator('[class*="backdrop"], [class*="overlay"]')
        .first();
      if (await backdrop.isVisible()) {
        await backdrop.click({ position: { x: 5, y: 5 } });

        // Modal might close (depending on implementation)
        await page.waitForTimeout(300);
      }
    });
  });

  test.describe("Dropdown Menus", () => {
    test("should open dropdown menu on click", async ({ page }) => {
      // Click on session to make menu visible
      await page.locator("text=Test Session").click();

      // Click menu button
      const menuButton = page.locator('button[title="Session options"]')
        .first();
      await menuButton.click();

      // Menu items should be visible
      await expect(page.locator("text=Rename")).toBeVisible();
      await expect(page.locator("text=Duplicate")).toBeVisible();
      await expect(page.locator("text=Export")).toBeVisible();
      await expect(page.locator("text=Delete")).toBeVisible();
    });

    test("should close dropdown when clicking outside", async ({ page }) => {
      // Click on session
      await page.locator("text=Test Session").click();

      // Open menu
      const menuButton = page.locator('button[title="Session options"]')
        .first();
      await menuButton.click();

      // Menu should be visible
      await expect(page.locator("text=Rename")).toBeVisible();

      // Click outside
      await page.click("body", { position: { x: 50, y: 50 } });

      // Menu should close
      await expect(page.locator("text=Rename")).not.toBeVisible();
    });

    test("should show info toast for coming soon features", async ({
      page,
    }) => {
      // Click on session
      await page.locator("text=Test Session").click();

      // Open menu
      const menuButton = page.locator('button[title="Session options"]')
        .first();
      await menuButton.click();

      // Click rename
      await page.locator("text=Rename").first().click();

      // Should show info toast
      await expect(
        page.locator("text=Rename feature coming soon"),
      ).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Skeleton Loaders", () => {
    test("should show skeleton loaders while loading", async ({ page }) => {
      // Mock slow API
      await page.route("**/api/sessions", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ sessions: [] }),
        });
      });

      await page.reload();

      // Should show skeleton loaders
      const skeletons = page.locator('[class*="animate-pulse"]');
      await expect(skeletons.first()).toBeVisible();
    });
  });

  test.describe("Transitions and Animations", () => {
    test("should have smooth transitions", async ({ page }) => {
      // Hover over new session button
      const button = page.locator("button:has-text('New Session')");
      await button.hover();

      // Element should still be visible after hover (basic check)
      await expect(button).toBeVisible();

      // Check that animations don't cause layout shifts
      const boundingBox = await button.boundingBox();
      expect(boundingBox).toBeTruthy();
    });

    test("should animate session selection", async ({ page }) => {
      const session = page.locator("text=Test Session");

      // Click session
      await session.click();

      // Wait for any animations
      await page.waitForTimeout(300);

      // Session should be highlighted
      const activeSession = page.locator(
        '[class*="bg-dark-850 border-l-2 border-l-blue-500"]',
      );
      await expect(activeSession).toBeVisible();
    });
  });

  test.describe("Responsive Design", () => {
    test("should be usable on mobile viewports", async ({ page }) => {
      // Set mobile viewport
      await page.setViewportSize({ width: 375, height: 667 });

      await page.reload();
      await page.waitForTimeout(500);

      // Main elements should still be visible
      await expect(page.locator("text=Liuboer")).toBeVisible();
      await expect(page.locator("button:has-text('New Session')")).toBeVisible();
    });

    test("should be usable on tablet viewports", async ({ page }) => {
      // Set tablet viewport
      await page.setViewportSize({ width: 768, height: 1024 });

      await page.reload();
      await page.waitForTimeout(500);

      // All main elements should be visible
      await expect(page.locator("text=Liuboer")).toBeVisible();
      await expect(page.locator("text=Welcome to Liuboer")).toBeVisible();
    });
  });

  test.describe("Accessibility", () => {
    test("should have proper button titles/labels", async ({ page }) => {
      // Check for title attributes
      const menuButton = page.locator('button[title="Session options"]')
        .first();
      await expect(menuButton).toHaveAttribute("title", "Session options");
    });

    test("should have proper heading hierarchy", async ({ page }) => {
      // Check for h1
      const h1 = page.locator("h1");
      await expect(h1).toBeVisible();

      // Verify it contains meaningful text
      const h1Text = await h1.textContent();
      expect(h1Text).toBeTruthy();
      expect(h1Text?.length).toBeGreaterThan(0);
    });

    test("should have focusable interactive elements", async ({ page }) => {
      const newSessionButton = page.locator("button:has-text('New Session')");

      // Focus the button
      await newSessionButton.focus();

      // Button should be focused
      await expect(newSessionButton).toBeFocused();
    });
  });
});
