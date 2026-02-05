/**
 * Reconnection - Message Order E2E Tests
 *
 * Tests for preserving message order after reconnection:
 * - Messages maintain their original order
 * - Timestamps remain in ascending order
 */

import { test, expect } from '../fixtures';
import {
	waitForWebSocketConnected,
	waitForSessionCreated,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Reconnection - Message Order', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for connection to be established
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

		// 4. Disconnect and wait for auto-reconnect
		await page.evaluate(() => {
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(2000);

		// Wait for auto-reconnect
		await expect(page.locator('text=Online').first()).toBeVisible({
			timeout: 15000,
		});
		await page.waitForTimeout(2000);

		// 5. Get message timestamps after reconnect
		const timestampsAfterReconnect = await page.evaluate(() => {
			const messages = Array.from(document.querySelectorAll('[data-message-role]'));
			return messages.map((el) => ({
				uuid: el.getAttribute('data-message-uuid') || null,
				timestamp: el.getAttribute('data-message-timestamp'),
			}));
		});

		// 6. VERIFY: Messages should be in same order (by timestamp)
		const beforeUuids = timestampsBeforeDisconnect.map((m) => m.uuid);
		const afterUuids = timestampsAfterReconnect.slice(0, beforeUuids.length).map((m) => m.uuid);

		expect(afterUuids).toEqual(beforeUuids);

		// 7. VERIFY: All timestamps should be in ascending order
		for (let i = 1; i < timestampsAfterReconnect.length; i++) {
			const prevTime = Number(timestampsAfterReconnect[i - 1].timestamp);
			const currTime = Number(timestampsAfterReconnect[i].timestamp);
			expect(currTime).toBeGreaterThanOrEqual(prevTime);
		}
	});
});
