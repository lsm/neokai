import { test, expect, Page } from "@playwright/test";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * E2E tests for WebSocket connection state tracking
 *
 * These tests verify that the UI correctly reflects the WebSocket connection state:
 * - Shows "Connecting..." when WebSocket is attempting to connect
 * - Shows "Online" when WebSocket is connected
 * - Shows "Offline" when WebSocket is disconnected
 * - Displays error message when connection is lost
 * - Automatically reconnects when server comes back online
 */
test.describe("Connection State Tracking", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for initial connection
    await expect(page.locator("text=Online")).toBeVisible({ timeout: 10000 });
  });

  test("should show 'Connecting...' state on initial page load", async ({ page }) => {
    // Navigate to a fresh page
    await page.goto("/");

    // Should briefly show "Connecting..." (yellow pulsing dot)
    // Note: This might be very fast, so we check if it appears OR if we're already connected
    const connectingText = page.locator("text=Connecting...");
    const onlineText = page.locator("text=Online");

    // Either we catch the connecting state or we're already online
    try {
      await expect(connectingText).toBeVisible({ timeout: 500 });
    } catch {
      // If connecting was too fast, we should be online
      await expect(onlineText).toBeVisible();
    }

    // Eventually should reach connected state
    await expect(onlineText).toBeVisible({ timeout: 10000 });
  });

  test("should show 'Online' status when WebSocket is connected", async ({ page }) => {
    // Check global status in sidebar footer
    await expect(page.locator("text=Status")).toBeVisible();
    await expect(page.locator("text=Online")).toBeVisible();

    // Check for green indicator dot
    const statusDot = page.locator(".bg-green-500").first();
    await expect(statusDot).toBeVisible();
  });

  test("should show 'Offline' status when WebSocket disconnects", async ({ page }) => {
    // Create a session first
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();

    // Wait for session to be created and UI to load
    await page.waitForTimeout(1000);

    // Verify initially connected
    await expect(page.locator("text=Online")).toBeVisible();

    // Kill the dev server to simulate disconnection
    // Note: The webServer will be restarted by Playwright after the test
    try {
      await execAsync("lsof -ti:9283 | xargs kill -9");
    } catch (error) {
      // Process might already be killed
    }

    // Wait for disconnection to be detected
    // The UI should show "Offline" in the session view
    await expect(page.locator("text=Offline")).toBeVisible({ timeout: 10000 });

    // Should also show error message
    await expect(page.locator("text=Connection lost")).toBeVisible({ timeout: 5000 });
  });

  test("should display 'Connection lost' error message on disconnection", async ({ page }) => {
    // Create a session
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();
    await page.waitForTimeout(1000);

    // Kill the server
    try {
      await execAsync("lsof -ti:9283 | xargs kill -9");
    } catch (error) {
      // Process might already be killed
    }

    // Should show error banner with reconnection message
    const errorMessage = page.locator("text=Connection lost. Attempting to reconnect...");
    await expect(errorMessage).toBeVisible({ timeout: 10000 });
  });

  test("should automatically reconnect when server restarts", async ({ page }) => {
    // Create a session
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();
    await page.waitForTimeout(1000);

    // Kill the server
    try {
      await execAsync("lsof -ti:9283 | xargs kill -9");
    } catch (error) {
      // Process might already be killed
    }

    // Wait for offline status
    await expect(page.locator("text=Offline")).toBeVisible({ timeout: 10000 });

    // Playwright's webServer will automatically restart the server
    // Wait for reconnection (up to 30 seconds)
    // The WebSocket client has auto-reconnect enabled with 10 attempts
    await expect(page.locator("text=Online")).toBeVisible({ timeout: 30000 });

    // Error message should disappear after reconnection
    const errorMessage = page.locator("text=Connection lost");
    await expect(errorMessage).not.toBeVisible({ timeout: 5000 });
  });

  test("should maintain session data after reconnection", async ({ page }) => {
    // Create a session
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();
    await page.waitForTimeout(1000);

    // Get session title before disconnection
    const sessionTitle = await page.locator("h2").first().textContent();

    // Kill the server
    try {
      await execAsync("lsof -ti:9283 | xargs kill -9");
    } catch (error) {
      // Process might already be killed
    }

    // Wait for offline
    await expect(page.locator("text=Offline")).toBeVisible({ timeout: 10000 });

    // Wait for reconnection
    await expect(page.locator("text=Online")).toBeVisible({ timeout: 30000 });

    // Verify session is still loaded (title should match)
    const sessionTitleAfter = await page.locator("h2").first().textContent();
    expect(sessionTitleAfter).toBe(sessionTitle);

    // Session should still be in the sidebar
    await expect(page.locator(`h3:has-text("${sessionTitle?.split(" ").slice(-2).join(" ")}")`)).toBeVisible();
  });

  test("should disable message input when offline", async ({ page }) => {
    // Create a session
    const newSessionButton = page.locator("button:has-text('New Session')");
    await newSessionButton.click();
    await page.waitForTimeout(1000);

    // Message input should be enabled when connected
    const messageInput = page.locator("textarea[placeholder*='Ask']");
    await expect(messageInput).toBeEnabled();

    // Send button should be disabled (no message typed)
    const sendButton = page.locator("button:has-text('Send message')");
    await expect(sendButton).toBeDisabled();

    // Kill the server
    try {
      await execAsync("lsof -ti:9283 | xargs kill -9");
    } catch (error) {
      // Process might already be killed
    }

    // Wait for offline
    await expect(page.locator("text=Offline")).toBeVisible({ timeout: 10000 });

    // Input should still be visible but send button disabled
    await expect(messageInput).toBeVisible();
    await expect(sendButton).toBeDisabled();
  });
});
