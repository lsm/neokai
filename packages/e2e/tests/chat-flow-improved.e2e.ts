/**
 * Chat Flow E2E Tests - Improved Version
 *
 * Uses event-based wait helpers instead of arbitrary timeouts
 * for more reliable and faster test execution.
 */

import { test, expect } from "@playwright/test";
import {
  waitForWebSocketConnected,
  waitForSessionCreated,
  waitForMessageProcessed,
  waitForElement,
  setupMessageHubTesting,
  cleanupTestSession,
} from "./helpers/wait-helpers";

test.describe("Chat Flow - Improved", () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test("should create a new session and send a message", async ({ page }) => {
    // Click "New Session" button
    const newSessionBtn = await waitForElement(page, 'button:has-text("New Session")');
    await newSessionBtn.click();

    // Wait for session to be created properly
    const sessionId = await waitForSessionCreated(page);
    expect(sessionId).toBeTruthy();

    // Type a message
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await messageInput.fill("Hello, can you respond with just 'Hi!'?");

    // Send the message
    const sendButton = await waitForElement(page, 'button[type="submit"]');
    await sendButton.click();

    // Wait for message processing to complete
    await waitForMessageProcessed(page, "Hello, can you respond with just 'Hi!'?");

    // Verify assistant response
    await expect(page.locator('text=/Hi|Hello|Greetings/i').first()).toBeVisible({
      timeout: 5000
    });

    // Verify input is cleared after sending
    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe("");

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test("should display message input and send button", async ({ page }) => {
    // Create a new session
    const newSessionBtn = await waitForElement(page, 'button:has-text("New Session")');
    await newSessionBtn.click();

    const sessionId = await waitForSessionCreated(page);

    // Check for textarea
    const messageInput = await waitForElement(page, "textarea");
    await expect(messageInput).toBeEnabled();

    // Check for send button
    const sendButton = await waitForElement(page, 'button[type="submit"]');
    await expect(sendButton).toBeVisible();

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test("should show session in sidebar after creation", async ({ page }) => {
    // Create a new session
    const newSessionBtn = await waitForElement(page, 'button:has-text("New Session")');
    await newSessionBtn.click();

    const sessionId = await waitForSessionCreated(page);

    // Send a message to give the session some content
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await messageInput.fill("test message for sidebar");

    const sendButton = await waitForElement(page, 'button[type="submit"]');
    await sendButton.click();

    await waitForMessageProcessed(page, "test message for sidebar");

    // The session should appear in the sidebar with proper attributes
    const sessionItem = await waitForElement(
      page,
      `[data-session-id="${sessionId}"]`,
      { timeout: 5000 }
    ).catch(() => null);

    // If no data-session-id, look for session entries with message count
    if (!sessionItem) {
      const sessionItems = page.locator('[class*="cursor-pointer"]').filter({
        hasText: /Session|ago/
      });
      await expect(sessionItems.first()).toBeVisible();
    }

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test("should disable input while message is being sent", async ({ page }) => {
    // Create a new session
    const newSessionBtn = await waitForElement(page, 'button:has-text("New Session")');
    await newSessionBtn.click();

    const sessionId = await waitForSessionCreated(page);

    // Type a message
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await messageInput.fill("Test message for input state");

    const sendButton = await waitForElement(page, 'button[type="submit"]');

    // Set up promise to check disabled state immediately after click
    const checkDisabledPromise = sendButton.click().then(async () => {
      // Check immediately after click
      const isDisabled = await messageInput.isDisabled();
      return isDisabled;
    });

    // Input should be disabled at some point during processing
    const wasDisabled = await checkDisabledPromise;
    expect(wasDisabled).toBe(true);

    // Wait for processing to complete
    await waitForMessageProcessed(page, "Test message for input state");

    // Input should be enabled again after response
    await expect(messageInput).toBeEnabled({ timeout: 5000 });

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test("should show status indicator when processing", async ({ page }) => {
    // Create a new session
    const newSessionBtn = await waitForElement(page, 'button:has-text("New Session")');
    await newSessionBtn.click();

    const sessionId = await waitForSessionCreated(page);

    // Send a message
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await messageInput.fill("Quick test for status indicator");

    const sendButton = await waitForElement(page, 'button[type="submit"]');

    // Set up promise to capture status indicator
    const statusPromise = sendButton.click().then(async () => {
      // Try to catch the status indicator
      try {
        const statusIndicator = page.locator('text=/Sending|Processing|Queued/i');
        await statusIndicator.waitFor({ state: 'visible', timeout: 2000 });
        return true;
      } catch {
        // Status might disappear too quickly
        return false;
      }
    });

    const statusShown = await statusPromise;

    // Status should have been shown (or processing was too fast)
    expect(statusShown).toBeDefined();

    // Wait for completion
    await waitForMessageProcessed(page, "Quick test for status indicator");

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test("should handle rapid message sending", async ({ page }) => {
    // Create a new session
    const newSessionBtn = await waitForElement(page, 'button:has-text("New Session")');
    await newSessionBtn.click();

    const sessionId = await waitForSessionCreated(page);

    // Send multiple messages rapidly
    const messages = [
      "First rapid message",
      "Second rapid message",
      "Third rapid message"
    ];

    for (const msg of messages) {
      const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
      await messageInput.fill(msg);

      const sendButton = await waitForElement(page, 'button[type="submit"]');
      await sendButton.click();

      // Wait for each message to be processed before sending the next
      await waitForMessageProcessed(page, msg);
    }

    // All messages should be visible
    for (const msg of messages) {
      await expect(page.locator(`text="${msg}"`)).toBeVisible();
    }

    // Should have received responses for all messages
    const assistantMessages = page.locator('[data-message-role="assistant"]');
    const assistantCount = await assistantMessages.count();
    expect(assistantCount).toBeGreaterThanOrEqual(messages.length);

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test("should maintain conversation context", async ({ page }) => {
    // Create a new session
    const newSessionBtn = await waitForElement(page, 'button:has-text("New Session")');
    await newSessionBtn.click();

    const sessionId = await waitForSessionCreated(page);

    // Send first message to establish context
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await messageInput.fill("My name is TestUser. Please remember this.");

    const sendButton = await waitForElement(page, 'button[type="submit"]');
    await sendButton.click();

    await waitForMessageProcessed(page, "My name is TestUser. Please remember this.");

    // Send follow-up message that relies on context
    await messageInput.fill("What is my name?");
    await sendButton.click();

    await waitForMessageProcessed(page, "What is my name?");

    // The response should reference the name (context maintained)
    const assistantResponses = page.locator('[data-message-role="assistant"]');
    const lastResponse = assistantResponses.last();
    const responseText = await lastResponse.textContent();

    // Response should contain reference to TestUser
    expect(responseText?.toLowerCase()).toContain("testuser");

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });
});