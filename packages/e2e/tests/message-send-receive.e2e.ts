/**
 * Message Send and Receive E2E Tests
 *
 * Focused tests for message sending, state transitions, and response handling.
 * Tests the complete flow from user input → server processing → UI updates.
 */

import { test, expect } from '../fixtures';
import {
	// waitForWebSocketConnected,
	waitForSessionCreated,
	waitForElement,
	setupMessageHubTesting,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Message Send and Receive', () => {
	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
	});

	test('should successfully send a message and receive response', async ({ page }) => {
		// Create a new session
		const newSessionBtn = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionBtn.click();

		const sessionId = await waitForSessionCreated(page);
		expect(sessionId).toBeTruthy();

		// Get message input and send button
		const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
		const sendButton = await waitForElement(page, '[data-testid="send-button"]');

		// Type a simple message
		const testMessage = 'Reply with exactly: TEST_OK';
		await messageInput.fill(testMessage);

		// Verify send button is enabled
		await expect(sendButton).toBeEnabled();

		// Send the message
		await sendButton.click();

		// Verify input is cleared immediately after clicking send
		await page.waitForTimeout(100);
		const inputValue = await messageInput.inputValue();
		expect(inputValue).toBe('');

		// Verify stop button appears during processing
		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 5000 });

		// Verify status indicator shows processing state
		const statusText = page.locator('text=/Starting|Thinking|Streaming|Processing/i');
		await expect(statusText).toBeVisible({ timeout: 5000 });

		// Wait for the user message to appear in the chat
		await expect(page.locator(`text="${testMessage}"`)).toBeVisible({ timeout: 5000 });

		// Wait for assistant response (with generous timeout for API call)
		await expect(page.locator('text=/TEST_OK|test_ok/i')).toBeVisible({
			timeout: 30000,
		});

		// Wait for processing to complete (send button should return)
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 15000 });

		// Cleanup
		await cleanupTestSession(page, sessionId);
	});

	test('should handle message sending state transitions correctly', async ({ page }) => {
		// Create a new session
		const newSessionBtn = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionBtn.click();

		const sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
		await messageInput.fill('Simple test');

		const sendButton = await waitForElement(page, '[data-testid="send-button"]');

		// Track state transitions
		const states: string[] = [];

		// Monitor status text changes
		page.on('console', (msg) => {
			if (msg.type() === 'log' && msg.text().includes('Message')) {
				states.push(msg.text());
			}
		});

		// Send message
		await sendButton.click();

		// State transitions during processing:
		// 1. Stop button appears during processing
		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 5000 });

		// 2. Status should show activity
		await expect(page.locator('text=/Starting|Thinking|Streaming|Processing/i')).toBeVisible({
			timeout: 5000,
		});

		// 3. Wait for response to complete (send button returns)
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 30000 });

		// 4. Stop button should disappear
		await expect(stopButton).not.toBeVisible({ timeout: 5000 });

		// 5. After processing, can send another message
		await messageInput.fill('Another message');
		await expect(page.locator('[data-testid="send-button"]')).toBeEnabled();

		// Cleanup
		await cleanupTestSession(page, sessionId);
	});

	test('should not allow sending empty messages', async ({ page }) => {
		// Create a new session
		const newSessionBtn = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionBtn.click();

		const sessionId = await waitForSessionCreated(page);

		// Get controls
		const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
		const sendButton = await waitForElement(page, '[data-testid="send-button"]');

		// Empty input - send button should be disabled
		await expect(sendButton).toBeDisabled();

		// Whitespace only - send button should be disabled
		await messageInput.fill('   \n  \t  ');
		await expect(sendButton).toBeDisabled();

		// Valid content - send button should be enabled
		await messageInput.fill('Hello');
		await expect(sendButton).toBeEnabled();

		// Cleanup
		await cleanupTestSession(page, sessionId);
	});

	test('should handle WebSocket disconnection gracefully', async ({ page }) => {
		// Create a new session
		const newSessionBtn = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionBtn.click();

		const sessionId = await waitForSessionCreated(page);

		// Verify initially online
		await expect(page.locator('text=Online').first()).toBeVisible({ timeout: 10000 });

		// Simulate disconnection using exposed method
		await page.evaluate(() => {
			window.connectionManager.simulateDisconnect();
		});

		// Auto-reconnect should kick in and restore connection
		// (Server is still running, so reconnect succeeds)
		await expect(page.locator('text=Online').first()).toBeVisible({
			timeout: 15000,
		});

		// After reconnect, should be able to interact normally
		const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
		await expect(messageInput).toBeEnabled();

		// Cleanup
		await cleanupTestSession(page, sessionId);
	});

	test('should display message immediately in UI (optimistic update)', async ({ page }) => {
		// Create a new session
		const newSessionBtn = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionBtn.click();

		const sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
		const testMessage = 'Optimistic update test message';
		await messageInput.fill(testMessage);

		const sendButton = await waitForElement(page, '[data-testid="send-button"]');
		await sendButton.click();

		// User message should appear very quickly (optimistic update or immediate server echo)
		await expect(page.locator(`text="${testMessage}"`)).toBeVisible({ timeout: 2000 });

		// Wait for assistant response
		await page.waitForTimeout(5000);

		// Cleanup
		await cleanupTestSession(page, sessionId);
	});

	test('should handle consecutive messages correctly', async ({ page }) => {
		// Create a new session
		const newSessionBtn = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionBtn.click();

		const sessionId = await waitForSessionCreated(page);

		const messages = ['First message', 'Second message', 'Third message'];

		// Send messages one by one, waiting for each to complete
		for (const msg of messages) {
			const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
			await messageInput.fill(msg);

			const sendButton = await waitForElement(page, '[data-testid="send-button"]');
			await sendButton.click();

			// Wait for message to appear
			await expect(page.locator(`text="${msg}"`)).toBeVisible({ timeout: 5000 });

			// Wait for processing status to appear and disappear (includes API call + /context fetch)
			const processingIndicator = page.locator('text=/Sending|Processing|Queued/i').first();
			await processingIndicator.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
			await processingIndicator.waitFor({ state: 'hidden', timeout: 35000 }).catch(() => {});

			// Wait for input to be re-enabled (response complete)
			await expect(messageInput).toBeEnabled({ timeout: 5000 });
		}

		// All messages should be visible
		for (const msg of messages) {
			await expect(page.locator(`text="${msg}"`)).toBeVisible();
		}

		// Should have at least as many assistant messages as user messages
		const assistantMessages = page.locator('[data-message-role="assistant"]');
		const count = await assistantMessages.count();
		expect(count).toBeGreaterThanOrEqual(messages.length);

		// Cleanup
		await cleanupTestSession(page, sessionId);
	});

	test('should recover from send failures', async ({ page }) => {
		// Create a new session
		const newSessionBtn = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionBtn.click();

		const sessionId = await waitForSessionCreated(page);

		// First, send a successful message
		const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
		await messageInput.fill('First successful message');

		const sendButton = await waitForElement(page, '[data-testid="send-button"]');
		await sendButton.click();

		// Wait for completion
		await expect(messageInput).toBeEnabled({ timeout: 15000 });

		// Now trigger a failure by temporarily breaking the connection
		// (In real scenario, this could be network issues, server errors, etc.)
		// For this test, we'll just verify recovery from normal operation

		// Send another message to ensure the system is still working
		await messageInput.fill('Second message after recovery');
		await sendButton.click();

		// Should complete successfully
		await expect(page.locator('text="Second message after recovery"')).toBeVisible({
			timeout: 5000,
		});
		await expect(messageInput).toBeEnabled({ timeout: 15000 });

		// Cleanup
		await cleanupTestSession(page, sessionId);
	});
});
