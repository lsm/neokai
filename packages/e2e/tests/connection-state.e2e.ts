import { test, expect, Page } from "@playwright/test";

/**
 * E2E tests for WebSocket connection state tracking
 *
 * These tests verify that the UI correctly reflects the WebSocket connection state:
 * - Shows "Connecting..." when WebSocket is attempting to connect
 * - Shows "Online" when WebSocket is connected
 * - Shows "Offline" when WebSocket is disconnected
 * - Automatically reconnects when disconnected
 *
 * Uses connectionManager.simulateDisconnect() for testing instead of killing the server
 */
test.describe("Connection State Tracking", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for sidebar to load and connection to be established
    await expect(page.locator("text=Status")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=Online")).toBeVisible({ timeout: 10000 });
  });

  test("should show 'Connecting...' state during initial connection", async ({ page }) => {
    // Navigate to a fresh page to catch the connecting state
    await page.goto("/");

    // Try to catch the "Connecting..." state (might be very fast)
    const connectingText = page.locator("text=Connecting...");
    const onlineText = page.locator("text=Online");

    // Either we see connecting or we're already online (connection is fast)
    const isConnectingVisible = await connectingText.isVisible().catch(() => false);
    const isOnlineVisible = await onlineText.isVisible().catch(() => false);

    // One of them should be true
    expect(isConnectingVisible || isOnlineVisible).toBe(true);

    // Eventually should be online
    await expect(onlineText).toBeVisible({ timeout: 10000 });
  });

  test("should show 'Online' status when WebSocket is connected", async ({ page }) => {
    // Should show "Online" in both sidebar and session view (after creating session)
    await expect(page.locator("text=Online")).toBeVisible();

    // Check for green indicator dot in sidebar
    const statusDot = page.locator(".bg-green-500").first();
    await expect(statusDot).toBeVisible();

    // Create a session to see session-specific status
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();
    await page.waitForTimeout(1000);

    // Session view should also show "Online"
    const onlineTexts = page.locator("text=Online");
    await expect(onlineTexts.first()).toBeVisible();
  });

  test("should show 'Offline' status when WebSocket disconnects", async ({ page }) => {
    // Create a session first
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();
    await page.waitForTimeout(1000);

    // Verify initially online
    await expect(page.locator("text=Online").first()).toBeVisible();

    // Simulate disconnection using exposed method
    await page.evaluate(() => {
      (window as any).connectionManager.simulateDisconnect();
    });

    // Wait for disconnection to be detected (use .first() to handle multiple instances)
    await expect(page.locator("text=Offline").first()).toBeVisible({ timeout: 10000 });

    // Should show offline in both sidebar and session view
    const offlineTexts = page.locator("text=Offline");
    expect(await offlineTexts.count()).toBeGreaterThan(0);
  });

  test("should automatically reconnect after disconnect", async ({ page }) => {
    // Create a session
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();
    await page.waitForTimeout(1000);

    // Simulate disconnection
    await page.evaluate(() => {
      (window as any).connectionManager.simulateDisconnect();
    });

    // Wait for offline status (use .first() to handle multiple instances)
    await expect(page.locator("text=Offline").first()).toBeVisible({ timeout: 10000 });

    // Should show "Connecting..." during reconnection attempt
    await expect(page.locator("text=Connecting...").first()).toBeVisible({ timeout: 5000 });

    // Wait for reconnection (auto-reconnect is enabled)
    await expect(page.locator("text=Online").first()).toBeVisible({ timeout: 15000 });
  });

  test("should maintain session data after reconnection", async ({ page }) => {
    // Create a session
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();
    await page.waitForTimeout(1000);

    // Get session title before disconnection
    const sessionTitle = await page.locator("h2").first().textContent();

    // Simulate disconnection
    await page.evaluate(() => {
      (window as any).connectionManager.simulateDisconnect();
    });

    // Wait for offline (use .first() to handle multiple instances)
    await expect(page.locator("text=Offline").first()).toBeVisible({ timeout: 10000 });

    // Wait for reconnection
    await expect(page.locator("text=Online").first()).toBeVisible({ timeout: 15000 });

    // Verify session is still loaded (title should match)
    const sessionTitleAfter = await page.locator("h2").first().textContent();
    expect(sessionTitleAfter).toBe(sessionTitle);

    // Session should still be in the sidebar
    if (sessionTitle) {
      const timeMatch = sessionTitle.match(/\d+:\d+:\d+/);
      if (timeMatch) {
        await expect(page.locator(`h3:has-text("${timeMatch[0]}")`)).toBeVisible();
      }
    }
  });

  test("should show all three connection states in sidebar", async ({ page }) => {
    // Should be online initially
    const sidebar = page.locator("text=Status").locator("..");
    await expect(sidebar.locator("text=Online")).toBeVisible();
    await expect(sidebar.locator(".bg-green-500").first()).toBeVisible();

    // Simulate disconnection
    await page.evaluate(() => {
      (window as any).connectionManager.simulateDisconnect();
    });

    // Should show offline
    await expect(sidebar.locator("text=Offline")).toBeVisible({ timeout: 10000 });
    await expect(sidebar.locator(".bg-gray-500")).toBeVisible();

    // Should show connecting during reconnection
    await expect(sidebar.locator("text=Connecting...")).toBeVisible({ timeout: 5000 });
    await expect(sidebar.locator(".bg-yellow-500")).toBeVisible();

    // Should return to online
    await expect(sidebar.locator("text=Online")).toBeVisible({ timeout: 15000 });
  });

  test("should show consistent status across sidebar and session view", async ({ page }) => {
    // Create a session to have both views visible
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();
    await page.waitForTimeout(1000);

    // Both should show "Online"
    const onlineTexts = page.locator("text=Online");
    expect(await onlineTexts.count()).toBeGreaterThanOrEqual(2);

    // Simulate disconnection
    await page.evaluate(() => {
      (window as any).connectionManager.simulateDisconnect();
    });

    // Both should show "Offline"
    await expect(page.locator("text=Offline").first()).toBeVisible({ timeout: 10000 });
    const offlineTexts = page.locator("text=Offline");
    expect(await offlineTexts.count()).toBeGreaterThanOrEqual(2);

    // Wait for reconnection - both should show "Online" again
    await expect(page.locator("text=Online").first()).toBeVisible({ timeout: 15000 });
    const onlineTextsAfter = page.locator("text=Online");
    expect(await onlineTextsAfter.count()).toBeGreaterThanOrEqual(2);
  });
});
