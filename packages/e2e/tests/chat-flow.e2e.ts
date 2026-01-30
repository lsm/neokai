import { test, expect } from '../fixtures';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

/**
 * Chat Flow E2E Tests
 *
 * Tests the core chat functionality using the real app (no mocking).
 * These tests rely on the daemon and web server being running.
 */
test.describe('Chat Flow', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		// Navigate to home page
		await page.goto('/');

		// Wait for app to initialize (check for sidebar heading specifically)
		await expect(page.getByRole('heading', { name: 'NeoKai', exact: true }).first()).toBeVisible();
		await page.waitForTimeout(1000); // Wait for WebSocket connection

		sessionId = null; // Reset for each test
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

	test('should create a new session and send a message', async ({ page }) => {
		// Click "New Session" button
		const newSessionBtn = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await expect(newSessionBtn).toBeVisible();
		await newSessionBtn.click();

		// Wait for session to be created and loaded
		await page.waitForTimeout(1500);

		// Verify we're in a chat view (message input should be visible)
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible();
		await expect(messageInput).toBeEnabled();

		// Track session ID for cleanup
		sessionId = await page.evaluate(() => {
			const pathId = window.location.pathname.split('/').filter(Boolean)[0];
			return pathId && pathId !== 'undefined' ? pathId : null;
		});

		// Type a message
		await messageInput.fill("Hello, can you respond with just 'Hi!'?");

		// Send the message (click send button or press Cmd+Enter)
		const sendButton = page.locator('[data-testid="send-button"]').first();
		await expect(sendButton).toBeVisible();
		await expect(sendButton).toBeEnabled();
		await sendButton.click();

		// Wait for message to be sent and response to arrive
		// The user message should appear
		await expect(page.locator('text="Hello, can you respond with just \'Hi!\'?"')).toBeVisible({
			timeout: 5000,
		});

		// Wait for assistant response (this will take a few seconds for actual API call)
		await expect(page.locator('text=/Hi|Hello|Greetings/i').first()).toBeVisible({
			timeout: 15000,
		});

		// Verify input is cleared after sending
		const inputValue = await messageInput.inputValue();
		expect(inputValue).toBe('');
	});

	test('should display message input and send button', async ({ page }) => {
		// Create a new session first
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await page.waitForTimeout(1500);

		// Track session ID for cleanup
		sessionId = await page.evaluate(() => {
			const pathId = window.location.pathname.split('/').filter(Boolean)[0];
			return pathId && pathId !== 'undefined' ? pathId : null;
		});

		// Check for textarea
		const messageInput = page.locator('textarea').first();
		await expect(messageInput).toBeVisible();
		await expect(messageInput).toBeEnabled();

		// Check for send button
		const sendButton = page.locator('[data-testid="send-button"]').first();
		await expect(sendButton).toBeVisible();
	});

	test('should show session in sidebar after creation', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();

		// Wait for session to be created and get sessionId
		sessionId = await waitForSessionCreated(page);
		expect(sessionId).toBeTruthy();

		// The session should appear in the sidebar immediately after creation
		// Use data-session-id attribute to find the session
		const sessionCard = page.locator(`[data-session-id="${sessionId}"]`);
		await expect(sessionCard).toBeVisible({ timeout: 10000 });
	});

	test('should show stop button while message is being processed', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await page.waitForTimeout(1500);

		// Track session ID for cleanup
		sessionId = await page.evaluate(() => {
			const pathId = window.location.pathname.split('/').filter(Boolean)[0];
			return pathId && pathId !== 'undefined' ? pathId : null;
		});

		// Type and send a message
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Test message');

		const sendButton = page.locator('[data-testid="send-button"]').first();
		await sendButton.click();

		// Stop button should appear while processing
		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 2000 });

		// Wait for response to complete
		await page.waitForTimeout(5000);

		// Send button should reappear after response
		await expect(sendButton).toBeVisible({ timeout: 10000 });
	});

	test('should show status indicator when processing', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await page.waitForTimeout(1500);

		// Track session ID for cleanup
		sessionId = await page.evaluate(() => {
			const pathId = window.location.pathname.split('/').filter(Boolean)[0];
			return pathId && pathId !== 'undefined' ? pathId : null;
		});

		// Wait for textarea to be ready
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });
		await expect(messageInput).toBeEnabled({ timeout: 5000 });
		await messageInput.fill('Quick test');
		await page.locator('[data-testid="send-button"]').first().click();

		// Status should show processing state (Starting, Thinking, Streaming, etc.)
		await expect(page.locator('text=/Starting|Thinking|Streaming|Processing/i')).toBeVisible({
			timeout: 2000,
		});
	});
});
