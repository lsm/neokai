import { test, expect } from "@playwright/test";

/**
 * Chat Flow E2E Tests
 *
 * Tests the core chat functionality using the real app (no mocking).
 * These tests rely on the daemon and web server being running.
 */
test.describe("Chat Flow", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to home page
    await page.goto("/");

    // Wait for app to initialize (check for sidebar heading specifically)
    await expect(page.getByRole('heading', { name: 'Liuboer', exact: true }).first()).toBeVisible();
    await page.waitForTimeout(1000); // Wait for WebSocket connection
  });

  test("should create a new session and send a message", async ({ page }) => {
    // Click "New Session" button
    const newSessionBtn = page.locator('button:has-text("New Session")');
    await expect(newSessionBtn).toBeVisible();
    await newSessionBtn.click();

    // Wait for session to be created and loaded
    await page.waitForTimeout(1500);

    // Verify we're in a chat view (message input should be visible)
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible();
    await expect(messageInput).toBeEnabled();

    // Type a message
    await messageInput.fill("Hello, can you respond with just 'Hi!'?");

    // Send the message (click send button or press Cmd+Enter)
    const sendButton = page.locator('button[type="submit"]').first();
    await expect(sendButton).toBeVisible();
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    // Wait for message to be sent and response to arrive
    // The user message should appear
    await expect(page.locator('text="Hello, can you respond with just \'Hi!\'?"')).toBeVisible({ timeout: 5000 });

    // Wait for assistant response (this will take a few seconds for actual API call)
    await expect(page.locator('text=/Hi|Hello|Greetings/i').first()).toBeVisible({ timeout: 15000 });

    // Verify input is cleared after sending
    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe("");
  });

  test("should display message input and send button", async ({ page }) => {
    // Create a new session first
    await page.locator('button:has-text("New Session")').click();
    await page.waitForTimeout(1500);

    // Check for textarea
    const messageInput = page.locator("textarea").first();
    await expect(messageInput).toBeVisible();
    await expect(messageInput).toBeEnabled();

    // Check for send button
    const sendButton = page.locator('button[type="submit"]').first();
    await expect(sendButton).toBeVisible();
  });

  test("should show session in sidebar after creation", async ({ page }) => {
    // Create a new session
    await page.locator('button:has-text("New Session")').click();
    await page.waitForTimeout(1500);

    // Send a message to give the session some content
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill("test");
    await page.locator('button[type="submit"]').first().click();

    await page.waitForTimeout(2000);

    // The session should appear in the sidebar
    // Look for session entries with message count
    const sessionItems = page.locator('[class*="cursor-pointer"]').filter({ hasText: /Session|ago/ });
    await expect(sessionItems.first()).toBeVisible();
  });

  test("should disable input while message is being sent", async ({ page }) => {
    // Create a new session
    await page.locator('button:has-text("New Session")').click();
    await page.waitForTimeout(1500);

    // Type and send a message
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill("Test message");

    const sendButton = page.locator('button[type="submit"]').first();
    await sendButton.click();

    // Input should be disabled immediately after clicking send
    await expect(messageInput).toBeDisabled({ timeout: 1000 });

    // Wait for response
    await page.waitForTimeout(5000);

    // Input should be enabled again after response
    await expect(messageInput).toBeEnabled({ timeout: 10000 });
  });

  test("should show status indicator when processing", async ({ page }) => {
    // Create a new session
    await page.locator('button:has-text("New Session")').click();
    await page.waitForTimeout(1500);

    // Send a message
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill("Quick test");
    await page.locator('button[type="submit"]').first().click();

    // Status should show "Sending..." or processing state
    await expect(page.locator('text=/Sending|Processing|Queued/i')).toBeVisible({ timeout: 2000 });
  });
});
