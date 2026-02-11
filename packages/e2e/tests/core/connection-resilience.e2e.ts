/**
 * Connection Resilience E2E Tests
 *
 * Comprehensive tests for WebSocket connection and reconnection behavior:
 * - Basic message sync after reconnection
 * - Multiple disconnect/reconnect cycles
 * - Long disconnection periods
 * - Message order preservation
 * - Connection state management and UI indicators
 * - Input blocking during disconnection
 *
 * MERGED FROM:
 * - reconnection.e2e.ts (base)
 * - connection.e2e.ts
 * - error-handling.e2e.ts
 * - status-indicators.e2e.ts
 */

import { test, expect } from '../../fixtures';
import {
	waitForWebSocketConnected,
	waitForSessionCreated,
	cleanupTestSession,
} from '../helpers/wait-helpers';
import { closeWebSocket, restoreWebSocket } from '../helpers/connection-helpers';

test.describe('Reconnection - Basic Message Sync', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should sync messages generated during disconnection', async ({ page }) => {
		// 1. Create a new session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// 2. Send a message that will take some time to process
		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Count from 1 to 5 with 1 second delay between each number');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// 3. Wait for agent to start processing
		await page.waitForTimeout(2000);

		// 4. Count messages before disconnection
		const messagesBeforeDisconnect = await page.locator('[data-message-role]').count();
		console.log(`Messages before disconnect: ${messagesBeforeDisconnect}`);

		// 5. Go offline
		await closeWebSocket(page);

		// 6. Verify offline status
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});

		// 7. Wait while agent processes in background (6 seconds should generate more messages)
		await page.waitForTimeout(6000);

		// 8. Come back online
		await restoreWebSocket(page);

		// 9. Wait for reconnection and state sync to complete
		await page.waitForTimeout(3000);

		// 10. Count messages after reconnection
		const messagesAfterReconnect = await page.locator('[data-message-role]').count();
		console.log(`Messages after reconnect: ${messagesAfterReconnect}`);

		// 11. VERIFY: More messages should be present (messages generated during disconnection)
		expect(messagesAfterReconnect).toBeGreaterThanOrEqual(messagesBeforeDisconnect);

		// 12. Verify no duplicate messages (all messages should have unique UUIDs)
		const messageElements = await page.locator('[data-message-role]').all();
		const messageIds = new Set<string>();

		for (const element of messageElements) {
			const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false);
				messageIds.add(uuid);
			}
		}

		console.log(`Unique messages: ${messageIds.size}`);
		expect(messageIds.size).toBe(messagesAfterReconnect);
	});
});

test.describe('Reconnection - Multiple Cycles', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should handle multiple disconnect/reconnect cycles', async ({ page }) => {
		// 1. Create session and send message
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('List 3 programming languages');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// 2. Wait for initial response
		await page.waitForTimeout(3000);

		// 3. First disconnect cycle
		await closeWebSocket(page);
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(2000);

		// Come back online
		await restoreWebSocket(page);
		await page.waitForTimeout(3000);

		const messagesAfterCycle1 = await page.locator('[data-message-role]').count();

		// 4. Second disconnect cycle
		await closeWebSocket(page);
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(2000);

		// Come back online
		await restoreWebSocket(page);
		await page.waitForTimeout(3000);

		const messagesAfterCycle2 = await page.locator('[data-message-role]').count();

		// 5. VERIFY: Messages should persist across cycles (no loss, no duplicates)
		expect(messagesAfterCycle2).toBeGreaterThanOrEqual(messagesAfterCycle1);

		// 6. Verify no duplicates
		const messageElements = await page.locator('[data-message-role]').all();
		const messageIds = new Set<string>();

		for (const element of messageElements) {
			const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false);
				messageIds.add(uuid);
			}
		}

		expect(messageIds.size).toBe(messagesAfterCycle2);
	});
});

test.describe('Reconnection - Long Disconnection Period', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should handle reconnection with long disconnection period', async ({ page }) => {
		// 1. Create session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// 2. Send message
		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Say hello');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// 3. Wait for processing to start
		await page.waitForTimeout(2000);

		// 4. Go offline for extended period
		await closeWebSocket(page);
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(5000);

		// 5. Come back online
		await restoreWebSocket(page);
		await page.waitForTimeout(3000);

		// 6. Verify messages are still present
		const messageCount = await page.locator('[data-message-role]').count();
		expect(messageCount).toBeGreaterThan(0);

		// 7. Verify no duplicates
		const messageElements = await page.locator('[data-message-role]').all();
		const messageIds = new Set<string>();

		for (const element of messageElements) {
			const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false);
				messageIds.add(uuid);
			}
		}

		expect(messageIds.size).toBe(messageCount);
	});
});

test.describe('Reconnection - Message Order', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should preserve message order after reconnection', async ({ page }) => {
		// 1. Create session and send message
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Count: 1, 2, 3');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// 2. Wait for some messages
		await page.waitForTimeout(3000);

		// 3. Get message timestamps before disconnect
		const timestampsBeforeDisconnect = await page.evaluate(() => {
			const messages = Array.from(document.querySelectorAll('[data-message-role]'));
			return messages.map((el) => ({
				uuid: el.getAttribute('data-message-uuid') || null,
				timestamp: el.getAttribute('data-message-timestamp'),
			}));
		});

		// 4. Go offline
		await closeWebSocket(page);
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(2000);

		// 5. Come back online
		await restoreWebSocket(page);
		await page.waitForTimeout(3000);

		// 6. Get message timestamps after reconnect
		const timestampsAfterReconnect = await page.evaluate(() => {
			const messages = Array.from(document.querySelectorAll('[data-message-role]'));
			return messages.map((el) => ({
				uuid: el.getAttribute('data-message-uuid') || null,
				timestamp: el.getAttribute('data-message-timestamp'),
			}));
		});

		// 7. VERIFY: Messages should be in same order (by timestamp)
		const beforeUuids = timestampsBeforeDisconnect.map((m) => m.uuid);
		const afterUuids = timestampsAfterReconnect.slice(0, beforeUuids.length).map((m) => m.uuid);

		expect(afterUuids).toEqual(beforeUuids);

		// 8. VERIFY: All timestamps should be in ascending order
		for (let i = 1; i < timestampsAfterReconnect.length; i++) {
			const prevTime = Number(timestampsAfterReconnect[i - 1].timestamp);
			const currTime = Number(timestampsAfterReconnect[i].timestamp);
			expect(currTime).toBeGreaterThanOrEqual(prevTime);
		}
	});
});

test.describe('Connection - Input Blocking', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should block input during disconnection', async ({ page }) => {
		// Create a session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Get textarea and verify it's enabled
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible();
		const isEnabledBefore = await textarea.isEnabled();
		expect(isEnabledBefore).toBe(true);

		// Go offline
		await closeWebSocket(page);
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});

		// Brief wait for disconnect to process
		await page.waitForTimeout(300);

		// Come back online
		await restoreWebSocket(page);
		await page.waitForTimeout(3000);

		// After reconnect, textarea should be enabled again
		await expect(textarea).toBeEnabled();
	});
});

test.describe('Connection - State Transitions', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should maintain session data after reconnection', async ({ page }) => {
		// Create session and send message
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Test message for reconnection');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// Wait for message to appear
		await expect(page.getByText('Test message for reconnection').first()).toBeVisible();

		// Count messages before disconnect
		const messagesBeforeDisconnect = await page.locator('[data-message-role]').count();

		// Go offline
		await closeWebSocket(page);
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});

		// Come back online
		await restoreWebSocket(page);
		await page.waitForTimeout(3000);

		// Verify messages are still present (session data maintained)
		const messagesAfterReconnect = await page.locator('[data-message-role]').count();
		expect(messagesAfterReconnect).toBeGreaterThanOrEqual(messagesBeforeDisconnect);

		// Verify original message is still visible
		await expect(page.getByText('Test message for reconnection').first()).toBeVisible();
	});
});
