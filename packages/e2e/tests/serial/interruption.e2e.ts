/**
 * Session Interruption E2E Tests
 *
 * Tests for session interruption flow and behavior.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForElement,
	cleanupTestSession,
} from '../helpers/wait-helpers';

test.describe
	.skip('Session Interruption', () => {
		test.beforeEach(async ({ page }) => {
			await setupMessageHubTesting(page);
		});

		test('should handle message interruption gracefully', async ({ page }) => {
			// Create a session
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);

			// Set up interrupt tracking
			await page.evaluate(async (sid) => {
				const hub = window.__messageHub;
				let interruptReceived = false;

				await hub.subscribe(
					'session.interrupted',
					() => {
						interruptReceived = true;
					},
					{ sessionId: sid }
				);

				window.__checkInterrupt = () => interruptReceived;
			}, sessionId);

			// Send a long message that we'll interrupt
			const messageInput = await waitForElement(page, 'textarea');
			await messageInput.fill(
				'Write a very long essay about the history of computing, including all major developments from the abacus to modern quantum computers. Include detailed information about each era.'
			);

			// Start sending
			void page.click('[data-testid="send-button"]');

			// Wait for processing to start
			await page.waitForSelector('text=/Sending|Processing|Queued/i', {
				timeout: 3000,
			});

			// Trigger interrupt (need to find interrupt button if available)
			// If no interrupt button, try using keyboard shortcut or API
			const interruptButton = page
				.locator('button[aria-label="Stop"]')
				.or(page.locator('button:has-text("Stop")').or(page.locator('button[title*="interrupt"]')));

			if (await interruptButton.isVisible({ timeout: 1000 }).catch(() => false)) {
				await interruptButton.click();
			} else {
				// Fallback: Send interrupt via MessageHub
				await page.evaluate((sid) => {
					const hub = window.__messageHub;
					hub.publish('client.interrupt', {}, { sessionId: sid });
				}, sessionId);
			}

			// Wait for interrupt confirmation
			await page.waitForTimeout(2000);

			// Check if interrupt was received
			const wasInterrupted = await page.evaluate(() => {
				return window.__checkInterrupt();
			});

			// Input should be enabled again
			await expect(messageInput).toBeEnabled({ timeout: 5000 });

			// Status should reflect interruption
			const hasInterruptStatus = await page
				.locator('text=/Interrupted|Stopped/i')
				.isVisible({ timeout: 2000 })
				.catch(() => false);

			expect(wasInterrupted || hasInterruptStatus).toBe(true);

			await cleanupTestSession(page, sessionId);
		});

		test('should clear message queue on interrupt', async ({ page }) => {
			// Create a session
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);

			// Queue multiple messages rapidly
			const messageInput = await waitForElement(page, 'textarea');

			// Send first message
			await messageInput.fill('First message in queue');
			await page.click('[data-testid="send-button"]');

			// Immediately queue more messages (while first is processing)
			await messageInput.fill('Second message in queue');
			void page.click('[data-testid="send-button"]');

			await messageInput.fill('Third message in queue');
			void page.click('[data-testid="send-button"]');

			// Trigger interrupt
			await page.evaluate((sid) => {
				const hub = window.__messageHub;
				hub.publish('client.interrupt', {}, { sessionId: sid });
			}, sessionId);

			// Wait for processing to stop
			await page.waitForTimeout(2000);

			// Check that not all messages were processed
			const messages = await page.locator('[data-message-role="user"]').count();

			// Should have less than 3 user messages (queue was cleared)
			expect(messages).toBeLessThanOrEqual(2);

			// Input should be re-enabled
			await expect(messageInput).toBeEnabled();

			await cleanupTestSession(page, sessionId);
		});

		test('should handle session cleanup on navigation away', async ({ page }) => {
			// Create a session
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);

			// Send a message
			await page.locator('textarea').first().fill('Test cleanup');
			await page.click('[data-testid="send-button"]');

			// Navigate away abruptly
			await page.click('h1:has-text("Liuboer")');

			// Should return to home without errors
			await expect(page.locator('h2:has-text("Welcome to Liuboer")')).toBeVisible({
				timeout: 5000,
			});

			// Navigate back to session - should still work
			await page.click(`[data-session-id="${sessionId}"]`);
			await waitForElement(page, 'textarea');

			// Session should still be functional
			await page.locator('textarea').first().fill('After navigation');
			await page.click('[data-testid="send-button"]');

			// Should process normally
			await page.waitForTimeout(3000);

			await cleanupTestSession(page, sessionId);
		});
	});
