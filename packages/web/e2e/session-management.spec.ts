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

  test("should show empty state when no sessions exist", async ({
    page,
    context,
  }) => {
    // Mock API to return empty sessions
    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });

    await page.reload();

    // Wait for loading to finish
    await page.waitForTimeout(500);

    // Check for empty state
    await expect(page.locator("text=No sessions yet")).toBeVisible();
    await expect(
      page.locator("text=Create one to get started!"),
    ).toBeVisible();
  });

  test("should display loading skeletons while fetching sessions", async ({
    page,
  }) => {
    // Slow down the API response to see loading state
    await page.route("**/api/sessions", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });

    await page.reload();

    // Check for skeleton loaders
    const skeletons = page.locator('[class*="animate-pulse"]');
    await expect(skeletons.first()).toBeVisible();
  });

  test("should create a new session when clicking 'New Session'", async ({
    page,
  }) => {
    // Mock the create session API
    await page.route("**/api/sessions", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sessionId: "test-session-123",
            message: "Session created",
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sessions: [{
              id: "test-session-123",
              title: "New Session",
              lastActiveAt: new Date().toISOString(),
              metadata: { messageCount: 0 },
            }],
          }),
        });
      }
    });

    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();

    // Should show success toast
    await expect(
      page.locator("text=Session created successfully"),
    ).toBeVisible({ timeout: 5000 });
  });

  test("should display error message when session loading fails", async ({
    page,
  }) => {
    // Mock API to return error
    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });

    await page.reload();
    await page.waitForTimeout(500);

    // Should show error message
    await expect(
      page.locator("text=Failed to load sessions"),
    ).toBeVisible({ timeout: 5000 });

    // Should have retry button
    const retryButton = page.locator("button:has-text('Retry')");
    await expect(retryButton).toBeVisible();
  });

  test("should select a session when clicked", async ({ page }) => {
    // Mock sessions list
    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: "session-1",
              title: "Test Session 1",
              lastActiveAt: new Date().toISOString(),
              metadata: { messageCount: 5 },
            },
            {
              id: "session-2",
              title: "Test Session 2",
              lastActiveAt: new Date().toISOString(),
              metadata: { messageCount: 3 },
            },
          ],
        }),
      });
    });

    await page.reload();
    await page.waitForTimeout(500);

    // Click on first session
    const firstSession = page.locator("text=Test Session 1");
    await firstSession.click();

    // Check that session is highlighted/active
    const sessionContainer = page.locator(
      '[class*="bg-dark-850 border-l-2 border-l-blue-500"]',
    ).first();
    await expect(sessionContainer).toBeVisible();
  });

  test("should show session menu on hover", async ({ page }) => {
    // Mock sessions list
    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: "session-1",
              title: "Test Session",
              lastActiveAt: new Date().toISOString(),
              metadata: { messageCount: 5 },
            },
          ],
        }),
      });
    });

    await page.reload();
    await page.waitForTimeout(500);

    // Hover over session
    const session = page.locator("text=Test Session").locator("..");
    await session.hover();

    // Menu button should appear
    const menuButton = session.locator('button[title="Session options"]');
    await expect(menuButton).toBeVisible();
  });

  test("should open delete confirmation modal", async ({ page }) => {
    // Mock sessions list
    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: "session-1",
              title: "Test Session",
              lastActiveAt: new Date().toISOString(),
              metadata: { messageCount: 5 },
            },
          ],
        }),
      });
    });

    await page.reload();
    await page.waitForTimeout(500);

    // Click session to make it active and show menu
    const session = page.locator("text=Test Session").locator("..");
    await session.click();

    // Click menu button
    const menuButton = session.locator('button[title="Session options"]');
    await menuButton.click();

    // Click delete option
    await page.locator("text=Delete").last().click();

    // Modal should open
    await expect(page.locator("text=Delete Session")).toBeVisible();
    await expect(
      page.locator(
        "text=Are you sure you want to delete this session? This action cannot be undone.",
      ),
    ).toBeVisible();

    // Should have cancel and delete buttons
    await expect(page.locator("button:has-text('Cancel')")).toBeVisible();
    await expect(page.locator("button:has-text('Delete')")).toBeVisible();
  });

  test("should display session metadata correctly", async ({ page }) => {
    const now = new Date();

    // Mock sessions with metadata
    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: "session-1",
              title: "Test Session",
              lastActiveAt: now.toISOString(),
              metadata: { messageCount: 42 },
            },
          ],
        }),
      });
    });

    await page.reload();
    await page.waitForTimeout(500);

    // Check message count is displayed
    await expect(page.locator("text=42")).toBeVisible();

    // Check that time indicator is present (will show "just now" or similar)
    const timeIndicators = page.locator("text=/now|ago|second|minute/i");
    await expect(timeIndicators.first()).toBeVisible();
  });
});
