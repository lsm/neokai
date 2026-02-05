/**
 * Reconnection - Long Disconnection Period E2E Tests
 *
 * Tests for handling reconnection after long disconnection periods:
 * - Full sync fallback when lastSync is stale
 * - Messages preserved after long disconnection
 * - No duplicates after full sync
 */

import { test, expect } from '../fixtures';
import {
	waitForWebSocketConnected,
	waitForSessionCreated,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Reconnection - Long Disconnection Period', () => {
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

		// 4. Disconnect for extended period (> 5 minutes would trigger full sync)
		// For test purposes, we'll simulate the scenario by clearing lastSync
		await page.evaluate(() => {
			// Simulate very old lastSync timestamp (triggers full sync fallback)
			const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
			(
				window as unknown as {
					__stateChannels?: Map<string, { lastSync: { value: number } }>;
				}
			).__stateChannels?.forEach((channel) => {
				if (channel.lastSync) {
					channel.lastSync.value = staleTimestamp;
				}
			});

			// Then disconnect
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});

		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(3000);

		// 5. Wait for auto-reconnect (should trigger full sync with merge)
		await expect(page.locator('text=Online').first()).toBeVisible({
			timeout: 15000,
		});
		await page.waitForTimeout(2000);

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
