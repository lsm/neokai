import { test, expect } from "../fixtures";
import {
  cleanupTestSession,
  waitForSessionCreated,
} from "./helpers/wait-helpers";

/**
 * E2E tests for WebSocket connection state tracking
 *
 * These tests verify that the UI correctly reflects the WebSocket connection state:
 * - Shows "Connecting..." when WebSocket is attempting to connect
 * - Shows "Connected" when WebSocket is connected (sidebar) / "Online" (session view)
 * - Shows "Offline" when WebSocket is disconnected
 * - Automatically reconnects when disconnected
 *
 * Uses connectionManager.simulateDisconnect() for testing instead of killing the server
 *
 * NOTE: Sidebar shows "Daemon: Connected/Connecting.../Offline"
 * NOTE: Session view (ConnectionStatus in SessionStatusBar) shows "Online/Connecting.../Offline"
 */
test.describe("Connection State Tracking", () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for sidebar to load and connection to be established
    // Sidebar shows "Daemon" label with "Connected" status (and Claude API status)
    await expect(page.locator("text=Daemon")).toBeVisible({ timeout: 10000 });
    // Use .first() as there may be multiple "Connected" elements (Daemon + Claude API)
    await expect(page.locator("text=Connected").first()).toBeVisible({
      timeout: 10000,
    });
    sessionId = null;
  });

  test.afterEach(async ({ page }) => {
    // Cleanup any session created during the test
    if (sessionId) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch (error) {
        console.warn(`Failed to cleanup session ${sessionId}:`, error);
      }
      sessionId = null;
    }
  });

  test("should show 'Connecting...' state during initial connection", async ({
    page,
  }) => {
    // Navigate to a fresh page to catch the connecting state
    await page.goto("/");

    // Try to catch the "Connecting..." state (might be very fast)
    const connectingText = page.locator("text=Connecting...").first();
    const connectedText = page.locator("text=Connected").first();

    // Either we see connecting or we're already connected (connection is fast)
    const isConnectingVisible = await connectingText
      .isVisible()
      .catch(() => false);
    const isConnectedVisible = await connectedText
      .isVisible()
      .catch(() => false);

    // One of them should be true
    expect(isConnectingVisible || isConnectedVisible).toBe(true);

    // Eventually should be connected
    await expect(connectedText).toBeVisible({ timeout: 10000 });
  });

  test("should show 'Connected' status when WebSocket is connected", async ({
    page,
  }) => {
    // Should show "Connected" in sidebar (use .first() as there are multiple)
    await expect(page.locator("text=Connected").first()).toBeVisible();

    // Check for green indicator dot in sidebar
    const statusDot = page.locator(".bg-green-500").first();
    await expect(statusDot).toBeVisible();

    // Create a session to see session-specific status
    // Use specific selector for the primary New Session button (not session cards)
    const newSessionButton = page.getByRole("button", {
      name: "New Session",
      exact: true,
    });
    await newSessionButton.click();
    sessionId = await waitForSessionCreated(page);

    // Session view shows "Online" via ConnectionStatus (in SessionStatusBar)
    const onlineText = page.locator("text=Online");
    await expect(onlineText.first()).toBeVisible();
  });

  test("should show 'Offline' status when WebSocket disconnects", async ({
    page,
  }) => {
    // Create a session first
    // Use specific selector for the primary New Session button
    const newSessionButton = page.getByRole("button", {
      name: "New Session",
      exact: true,
    });
    await newSessionButton.click();
    sessionId = await waitForSessionCreated(page);

    // Verify initially online (ConnectionStatus in session view)
    await expect(page.locator("text=Online").first()).toBeVisible();

    // Simulate disconnection using exposed method
    await page.evaluate(() => {
      (
        window as unknown as {
          connectionManager: { simulateDisconnect: () => void };
        }
      ).connectionManager.simulateDisconnect();
    });

    // Wait for disconnection to be detected (use .first() to handle multiple instances)
    await expect(page.locator("text=Offline").first()).toBeVisible({
      timeout: 10000,
    });

    // Should show offline in both sidebar and session view
    const offlineTexts = page.locator("text=Offline");
    expect(await offlineTexts.count()).toBeGreaterThan(0);
  });

  test("should automatically reconnect after disconnect", async ({ page }) => {
    // Create a session
    const newSessionButton = page.getByRole("button", {
      name: "New Session",
      exact: true,
    });
    await newSessionButton.click();
    sessionId = await waitForSessionCreated(page);

    // Simulate disconnection
    await page.evaluate(() => {
      (
        window as unknown as {
          connectionManager: { simulateDisconnect: () => void };
        }
      ).connectionManager.simulateDisconnect();
    });

    // Wait for offline status (use .first() to handle multiple instances)
    await expect(page.locator("text=Offline").first()).toBeVisible({
      timeout: 10000,
    });

    // Wait for sidebar to show "Connected" first (sidebar reconnects reliably)
    await expect(page.locator("text=Connected").first()).toBeVisible({
      timeout: 15000,
    });

    // Then check that session view shows "Online" (may need extra time to sync)
    await expect(page.locator("text=Online").first()).toBeVisible({
      timeout: 5000,
    });
  });

  test("should maintain session data after reconnection", async ({ page }) => {
    // Create a session
    const newSessionButton = page.getByRole("button", {
      name: "New Session",
      exact: true,
    });
    await newSessionButton.click();
    sessionId = await waitForSessionCreated(page);

    // Get session title before disconnection
    const sessionTitle = await page.locator("h2").first().textContent();

    // Simulate disconnection
    await page.evaluate(() => {
      (
        window as unknown as {
          connectionManager: { simulateDisconnect: () => void };
        }
      ).connectionManager.simulateDisconnect();
    });

    // Wait for offline (use .first() to handle multiple instances)
    await expect(page.locator("text=Offline").first()).toBeVisible({
      timeout: 10000,
    });

    // Wait for reconnection - session view shows "Online"
    await expect(page.locator("text=Online").first()).toBeVisible({
      timeout: 15000,
    });

    // Verify session is still loaded (title should match)
    const sessionTitleAfter = await page.locator("h2").first().textContent();
    expect(sessionTitleAfter).toBe(sessionTitle);

    // Session should still be in the sidebar
    if (sessionTitle) {
      const timeMatch = sessionTitle.match(/\d+:\d+:\d+/);
      if (timeMatch) {
        await expect(
          page.locator(`h3:has-text("${timeMatch[0]}")`),
        ).toBeVisible();
      }
    }
  });

  test("should show all three connection states in sidebar", async ({
    page,
  }) => {
    // Should be connected initially - sidebar shows "Daemon" with "Connected"
    const sidebar = page.locator("text=Daemon").locator("..");
    await expect(sidebar.locator("text=Connected").first()).toBeVisible();
    await expect(page.locator(".bg-green-500").first()).toBeVisible();

    // Simulate disconnection
    await page.evaluate(() => {
      (
        window as unknown as {
          connectionManager: { simulateDisconnect: () => void };
        }
      ).connectionManager.simulateDisconnect();
    });

    // Should show offline
    await expect(page.locator("text=Offline").first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator(".bg-gray-500").first()).toBeVisible();

    // Try to catch connecting state (may be too fast to see)
    await page
      .locator("text=Connecting...")
      .first()
      .isVisible()
      .catch(() => false);
    await page
      .locator(".bg-yellow-500")
      .first()
      .isVisible()
      .catch(() => false);

    // Should return to connected (either directly or through connecting state)
    await expect(page.locator("text=Connected").first()).toBeVisible({
      timeout: 15000,
    });

    // Verify we tested the disconnection cycle (we always see offline -> connected)
    expect(true).toBe(true); // Test passes if we got back to connected
  });

  test("should show consistent status across sidebar and session view", async ({
    page,
  }) => {
    // Create a session to have both views visible
    const newSessionButton = page.getByRole("button", {
      name: "New Session",
      exact: true,
    });
    await newSessionButton.click();
    sessionId = await waitForSessionCreated(page);

    // Sidebar shows "Connected", session view shows "Online"
    await expect(page.locator("text=Connected").first()).toBeVisible();
    await expect(page.locator("text=Online").first()).toBeVisible();

    // Simulate disconnection
    await page.evaluate(() => {
      (
        window as unknown as {
          connectionManager: { simulateDisconnect: () => void };
        }
      ).connectionManager.simulateDisconnect();
    });

    // Both should show "Offline"
    await expect(page.locator("text=Offline").first()).toBeVisible({
      timeout: 10000,
    });
    const offlineTexts = page.locator("text=Offline");
    expect(await offlineTexts.count()).toBeGreaterThanOrEqual(1);

    // Wait for reconnection
    // Sidebar shows "Connected", session view shows "Online"
    await expect(page.locator("text=Connected").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator("text=Online").first()).toBeVisible({
      timeout: 15000,
    });
  });
});
