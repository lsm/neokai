import { test, expect } from "@playwright/test";

test.describe("Chat Functionality", () => {
  const mockSession = {
    id: "test-session-123",
    title: "Test Chat Session",
    lastActiveAt: new Date().toISOString(),
    metadata: {
      messageCount: 2,
      totalTokens: 150,
    },
  };

  const mockMessages = [
    {
      id: "msg-1",
      sessionId: "test-session-123",
      role: "user",
      content: "Hello, how are you?",
      timestamp: new Date(Date.now() - 60000).toISOString(),
    },
    {
      id: "msg-2",
      sessionId: "test-session-123",
      role: "assistant",
      content: "I'm doing well, thank you! How can I help you today?",
      timestamp: new Date().toISOString(),
    },
  ];

  test.beforeEach(async ({ page }) => {
    // Mock sessions list
    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [mockSession] }),
      });
    });

    // Mock get session
    await page.route(`**/api/sessions/${mockSession.id}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            session: mockSession,
            messages: mockMessages,
          }),
        });
      }
    });

    await page.goto("/");
    await page.waitForTimeout(500);

    // Select the test session
    await page.locator("text=Test Chat Session").click();
    await page.waitForTimeout(300);
  });

  test("should display chat header with session info", async ({ page }) => {
    // Check session title
    await expect(page.locator("h2:has-text('Test Chat Session')")).toBeVisible();

    // Check message count
    await expect(page.locator("text=2 messages")).toBeVisible();

    // Check token count
    await expect(page.locator("text=150 tokens")).toBeVisible();
  });

  test("should display existing messages", async ({ page }) => {
    // Check that both messages are visible
    await expect(
      page.locator("text=Hello, how are you?"),
    ).toBeVisible();
    await expect(
      page.locator("text=I'm doing well, thank you! How can I help you today?"),
    ).toBeVisible();
  });

  test("should have message input field", async ({ page }) => {
    // Check for textarea
    const messageInput = page.locator("textarea").first();
    await expect(messageInput).toBeVisible();
    await expect(messageInput).toBeEnabled();

    // Check for send button
    const sendButton = page.locator('button[type="submit"]').first();
    await expect(sendButton).toBeVisible();
  });

  test("should send a message when clicking send button", async ({ page }) => {
    let messageSent = false;

    // Mock send message API
    await page.route(
      `**/api/sessions/${mockSession.id}/messages`,
      async (route) => {
        messageSent = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
      },
    );

    // Type message
    const messageInput = page.locator("textarea").first();
    await messageInput.fill("This is a test message");

    // Click send button
    const sendButton = page.locator('button[type="submit"]').first();
    await sendButton.click();

    // Wait for API call
    await page.waitForTimeout(500);

    // Verify message was sent
    expect(messageSent).toBe(true);

    // Check that user message appears in the chat
    await expect(
      page.locator("text=This is a test message"),
    ).toBeVisible();
  });

  test("should send message with keyboard shortcut (Enter)", async ({
    page,
  }) => {
    let messageSent = false;

    // Mock send message API
    await page.route(
      `**/api/sessions/${mockSession.id}/messages`,
      async (route) => {
        messageSent = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
      },
    );

    // Type message and press Enter
    const messageInput = page.locator("textarea").first();
    await messageInput.fill("Test message with Enter key");
    await messageInput.press("Enter");

    // Wait for API call
    await page.waitForTimeout(500);

    // Verify message was sent
    expect(messageSent).toBe(true);
  });

  test("should disable input while sending message", async ({ page }) => {
    // Mock slow API response
    await page.route(
      `**/api/sessions/${mockSession.id}/messages`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
      },
    );

    // Send message
    const messageInput = page.locator("textarea").first();
    await messageInput.fill("Test message");
    await messageInput.press("Enter");

    // Input should be disabled while sending
    await expect(messageInput).toBeDisabled();
  });

  test("should show error message when send fails", async ({ page }) => {
    // Mock API error
    await page.route(
      `**/api/sessions/${mockSession.id}/messages`,
      async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Failed to send message" }),
        });
      },
    );

    // Send message
    const messageInput = page.locator("textarea").first();
    await messageInput.fill("Test message");
    await messageInput.press("Enter");

    // Wait for error
    await page.waitForTimeout(500);

    // Error should be displayed
    await expect(
      page.locator("text=Failed to send message"),
    ).toBeVisible({ timeout: 5000 });
  });

  test("should have session options menu in header", async ({ page }) => {
    // Click menu button in header
    const menuButton = page.locator('button[title="Session options"]').first();
    await menuButton.click();

    // Check menu items
    await expect(page.locator("text=Session Settings")).toBeVisible();
    await expect(page.locator("text=Export Chat")).toBeVisible();
    await expect(page.locator("text=Clear Chat")).toBeVisible();
  });

  test("should auto-scroll to bottom when new messages arrive", async ({
    page,
  }) => {
    // The messages container should scroll to bottom automatically
    const messagesContainer = page.locator('[class*="overflow-y-auto"]').nth(1);

    // Get scroll position
    const scrollTop = await messagesContainer.evaluate((el) => el.scrollTop);
    const scrollHeight = await messagesContainer.evaluate(
      (el) => el.scrollHeight,
    );
    const clientHeight = await messagesContainer.evaluate(
      (el) => el.clientHeight,
    );

    // Should be scrolled to bottom (with some tolerance)
    expect(scrollTop + clientHeight).toBeGreaterThanOrEqual(scrollHeight - 100);
  });

  test("should show scroll to bottom button when scrolled up", async ({
    page,
  }) => {
    // Add many messages to enable scrolling
    const manyMessages = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-${i}`,
      sessionId: mockSession.id,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: This is a test message with some content`,
      timestamp: new Date(Date.now() - 60000 * i).toISOString(),
    }));

    await page.route(`**/api/sessions/${mockSession.id}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: mockSession,
          messages: manyMessages,
        }),
      });
    });

    await page.reload();
    await page.waitForTimeout(500);

    // Scroll to top
    const messagesContainer = page.locator('[class*="overflow-y-auto"]').nth(1);
    await messagesContainer.evaluate((el) => el.scrollTo(0, 0));

    // Wait for scroll button to appear
    await page.waitForTimeout(300);

    // Scroll to bottom button should be visible
    const scrollButton = page.locator('button[title="Scroll to bottom"]');
    await expect(scrollButton).toBeVisible({ timeout: 2000 });
  });

  test("should load session data with loading state", async ({ page }) => {
    // Mock slow API response
    await page.route(`**/api/sessions/slow-session`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: mockSession,
          messages: mockMessages,
        }),
      });
    });

    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [{
            ...mockSession,
            id: "slow-session",
          }],
        }),
      });
    });

    await page.reload();
    await page.waitForTimeout(300);

    // Click on slow session
    const session = page.locator("text=Test Chat Session");
    await session.click();

    // Should show loading skeletons
    const skeletons = page.locator('[class*="animate-pulse"]');
    await expect(skeletons.first()).toBeVisible();
  });

  test("should show error state when session fails to load", async ({
    page,
  }) => {
    // Mock API error
    await page.route(`**/api/sessions/error-session`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });

    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [{
            ...mockSession,
            id: "error-session",
          }],
        }),
      });
    });

    await page.reload();
    await page.waitForTimeout(300);

    // Click on error session
    const session = page.locator("text=Test Chat Session");
    await session.click();

    await page.waitForTimeout(500);

    // Should show error state
    await expect(page.locator("text=Failed to load session")).toBeVisible();
    await expect(page.locator("button:has-text('Retry')")).toBeVisible();
  });

  test("should clear input after sending message", async ({ page }) => {
    // Mock send message API
    await page.route(
      `**/api/sessions/${mockSession.id}/messages`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
      },
    );

    // Type and send message
    const messageInput = page.locator("textarea").first();
    await messageInput.fill("Test message to clear");
    await messageInput.press("Enter");

    // Wait for send to complete
    await page.waitForTimeout(500);

    // Input should be cleared
    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe("");
  });
});
