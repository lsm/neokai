import { test, expect } from '@playwright/test';

/**
 * E2E tests for WebSocket reconnection message synchronization
 *
 * These tests verify that messages generated during disconnection are properly synced
 * when the client reconnects. This is critical for mobile Safari where the browser
 * goes to background and loses WebSocket connection.
 *
 * Scenario tested:
 * 1. User sends message, agent starts processing
 * 2. Client disconnects (simulates mobile Safari backgrounding)
 * 3. Agent continues processing while client is offline
 * 4. Client reconnects
 * 5. VERIFY: All messages generated during disconnection appear in UI
 */

test.describe('Reconnection Message Sync', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for connection to be established
		await expect(page.locator('text=Online')).toBeVisible({ timeout: 10000 });
	});

	test('should sync messages generated during disconnection', async ({ page }) => {
		// 1. Create a new session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();
		await page.waitForTimeout(1000);

		// 2. Send a message that will take some time to process
		const messageInput = page.locator('textarea[placeholder*="Type a message"]');
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
				window as unknown as { connectionManager: { simulateDisconnect: () => void } }
			).connectionManager.simulateDisconnect();
		});

		// 6. Verify offline status
		await expect(page.locator('text=Offline').first()).toBeVisible({ timeout: 5000 });

		// 7. Wait while agent processes in background (6 seconds should generate more messages)
		await page.waitForTimeout(6000);

		// 8. Reconnect (simulates user returning to app)
		await page.evaluate(() => {
			(
				window as unknown as { connectionManager: { simulateReconnect: () => void } }
			).connectionManager.simulateReconnect();
		});

		// 9. Verify reconnection
		await expect(page.locator('text=Online').first()).toBeVisible({ timeout: 10000 });

		// 10. Wait for state sync to complete
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
			const uuid = await element.getAttribute('data-message-uuid');
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false); // Should not be duplicate
				messageIds.add(uuid);
			}
		}

		console.log(`Unique messages: ${messageIds.size}`);
		expect(messageIds.size).toBe(messagesAfterReconnect);
	});

	test('should handle multiple disconnect/reconnect cycles', async ({ page }) => {
		// 1. Create session and send message
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();
		await page.waitForTimeout(1000);

		const messageInput = page.locator('textarea[placeholder*="Type a message"]');
		await messageInput.click();
		await messageInput.fill('List 3 programming languages');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// 2. Wait for initial response
		await page.waitForTimeout(3000);

		// 3. First disconnect cycle
		await page.evaluate(() => {
			(
				window as unknown as { connectionManager: { simulateDisconnect: () => void } }
			).connectionManager.simulateDisconnect();
		});
		await expect(page.locator('text=Offline').first()).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(2000);

		await page.evaluate(() => {
			(
				window as unknown as { connectionManager: { simulateReconnect: () => void } }
			).connectionManager.simulateReconnect();
		});
		await expect(page.locator('text=Online').first()).toBeVisible({ timeout: 10000 });
		await page.waitForTimeout(1000);

		const messagesAfterCycle1 = await page.locator('[data-message-role]').count();

		// 4. Second disconnect cycle
		await page.evaluate(() => {
			(
				window as unknown as { connectionManager: { simulateDisconnect: () => void } }
			).connectionManager.simulateDisconnect();
		});
		await expect(page.locator('text=Offline').first()).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(2000);

		await page.evaluate(() => {
			(
				window as unknown as { connectionManager: { simulateReconnect: () => void } }
			).connectionManager.simulateReconnect();
		});
		await expect(page.locator('text=Online').first()).toBeVisible({ timeout: 10000 });
		await page.waitForTimeout(1000);

		const messagesAfterCycle2 = await page.locator('[data-message-role]').count();

		// 5. VERIFY: Messages should persist across cycles (no loss, no duplicates)
		expect(messagesAfterCycle2).toBeGreaterThanOrEqual(messagesAfterCycle1);

		// 6. Verify no duplicates
		const messageElements = await page.locator('[data-message-role]').all();
		const messageIds = new Set<string>();

		for (const element of messageElements) {
			const uuid = await element.getAttribute('data-message-uuid');
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false);
				messageIds.add(uuid);
			}
		}

		expect(messageIds.size).toBe(messagesAfterCycle2);
	});

	test('should handle reconnection with long disconnection period', async ({ page }) => {
		// 1. Create session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();
		await page.waitForTimeout(1000);

		// 2. Send message
		const messageInput = page.locator('textarea[placeholder*="Type a message"]');
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
				window as unknown as { connectionManager: { simulateDisconnect: () => void } }
			).connectionManager.simulateDisconnect();
		});

		await expect(page.locator('text=Offline').first()).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(3000);

		// 5. Reconnect (should trigger full sync with merge)
		await page.evaluate(() => {
			(
				window as unknown as { connectionManager: { simulateReconnect: () => void } }
			).connectionManager.simulateReconnect();
		});

		await expect(page.locator('text=Online').first()).toBeVisible({ timeout: 10000 });
		await page.waitForTimeout(2000);

		// 6. Verify messages are still present
		const messageCount = await page.locator('[data-message-role]').count();
		expect(messageCount).toBeGreaterThan(0);

		// 7. Verify no duplicates
		const messageElements = await page.locator('[data-message-role]').all();
		const messageIds = new Set<string>();

		for (const element of messageElements) {
			const uuid = await element.getAttribute('data-message-uuid');
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false);
				messageIds.add(uuid);
			}
		}

		expect(messageIds.size).toBe(messageCount);
	});

	test('should preserve message order after reconnection', async ({ page }) => {
		// 1. Create session and send message
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();
		await page.waitForTimeout(1000);

		const messageInput = page.locator('textarea[placeholder*="Type a message"]');
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
				uuid: el.getAttribute('data-message-uuid'),
				timestamp: el.getAttribute('data-message-timestamp'),
			}));
		});

		// 4. Disconnect and reconnect
		await page.evaluate(() => {
			(
				window as unknown as { connectionManager: { simulateDisconnect: () => void } }
			).connectionManager.simulateDisconnect();
		});
		await expect(page.locator('text=Offline').first()).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(2000);

		await page.evaluate(() => {
			(
				window as unknown as { connectionManager: { simulateReconnect: () => void } }
			).connectionManager.simulateReconnect();
		});
		await expect(page.locator('text=Online').first()).toBeVisible({ timeout: 10000 });
		await page.waitForTimeout(2000);

		// 5. Get message timestamps after reconnect
		const timestampsAfterReconnect = await page.evaluate(() => {
			const messages = Array.from(document.querySelectorAll('[data-message-role]'));
			return messages.map((el) => ({
				uuid: el.getAttribute('data-message-uuid'),
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
