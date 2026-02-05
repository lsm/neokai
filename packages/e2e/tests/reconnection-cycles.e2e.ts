/**
 * Reconnection - Multiple Cycles E2E Tests
 *
 * Tests for handling multiple disconnect/reconnect cycles:
 * - Messages persist across cycles
 * - No duplicates after multiple cycles
 */

import { test, expect } from '../fixtures';
import {
	waitForWebSocketConnected,
	waitForSessionCreated,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Reconnection - Multiple Cycles', () => {
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

		// 3. First disconnect cycle (auto-reconnect happens automatically)
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
		// Wait for WebSocket to be connected again
		await page.waitForFunction(
			() => {
				const hub = window.__messageHub || window.appState?.messageHub;
				return hub?.getState && hub.getState() === 'connected';
			},
			{ timeout: 15000 }
		);

		const messagesAfterCycle1 = await page.locator('[data-message-role]').count();

		// 4. Second disconnect cycle (auto-reconnect happens automatically)
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
		// Wait for WebSocket to be connected again
		await page.waitForFunction(
			() => {
				const hub = window.__messageHub || window.appState?.messageHub;
				return hub?.getState && hub.getState() === 'connected';
			},
			{ timeout: 15000 }
		);

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
