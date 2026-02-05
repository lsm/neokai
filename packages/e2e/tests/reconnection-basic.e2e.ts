/**
 * Reconnection - Basic Message Sync E2E Tests
 *
 * Basic tests for WebSocket reconnection message synchronization:
 * - Messages generated during disconnection are synced on reconnect
 * - No duplicate messages after reconnection
 */

import { test, expect } from '../fixtures';
import {
	waitForWebSocketConnected,
	waitForSessionCreated,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Reconnection - Basic Message Sync', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for WebSocket connection to be established
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

		// 5. Simulate disconnection (mobile Safari backgrounding)
		await page.evaluate(() => {
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});

		// 6. Verify offline status
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});

		// 7. Wait while agent processes in background (6 seconds should generate more messages)
		await page.waitForTimeout(6000);

		// 8. Wait for auto-reconnect to happen (simulateDisconnect triggers auto-reconnect)
		// Wait for WebSocket to be connected again
		await page.waitForFunction(
			() => {
				const hub = window.__messageHub || window.appState?.messageHub;
				return hub?.getState && hub.getState() === 'connected';
			},
			{ timeout: 15000 }
		);

		// 9. Wait for state sync to complete
		await page.waitForTimeout(2000);

		// 11. Count messages after reconnection
		const messagesAfterReconnect = await page.locator('[data-message-role]').count();
		console.log(`Messages after reconnect: ${messagesAfterReconnect}`);

		// 12. VERIFY: More messages should be present (messages generated during disconnection)
		expect(messagesAfterReconnect).toBeGreaterThan(messagesBeforeDisconnect);

		// 13. Verify no duplicate messages (all messages should have unique UUIDs)
		const messageElements = await page.locator('[data-message-role]').all();
		const messageIds = new Set<string>();

		for (const element of messageElements) {
			const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false); // Should not be duplicate
				messageIds.add(uuid);
			}
		}

		console.log(`Unique messages: ${messageIds.size}`);
		expect(messageIds.size).toBe(messagesAfterReconnect);
	});
});
