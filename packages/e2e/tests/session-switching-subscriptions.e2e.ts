/**
 * Session Switching - Subscriptions E2E Tests
 *
 * Tests for subscription cleanup when switching sessions:
 * - Subscription count verification
 * - Proper cleanup when navigating away
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForElement,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Session Switching - Subscriptions', () => {
	test('should properly cleanup subscriptions when switching sessions', async ({ page }) => {
		await setupMessageHubTesting(page);

		// Get baseline subscription count
		const initialSubs = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// Create 2 sessions
		const sessionIds: string[] = [];
		for (let i = 0; i < 2; i++) {
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);
			sessionIds.push(sessionId);

			if (i < 1) {
				await page.click('h1:has-text("NeoKai")');
				await page.waitForTimeout(300);
			}
		}

		// Navigate to session 1
		await page.click(`[data-session-id="${sessionIds[0]}"]`);
		await waitForElement(page, 'textarea');
		await page.waitForTimeout(1000);

		// Get subscription count with session loaded
		const withSession1 = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// Switch to session 2 - this should trigger cleanup of session 1's subscriptions
		await page.click(`[data-session-id="${sessionIds[1]}"]`);
		await waitForElement(page, 'textarea');
		await page.waitForTimeout(1000);

		// Get subscription count with session 2 loaded
		const withSession2 = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// VERIFY: Subscription count should be similar (session 1 cleaned up, session 2 subscribed)
		// Allow for some variance (+/- 5) due to global subscriptions
		expect(Math.abs(withSession1 - withSession2)).toBeLessThanOrEqual(5);

		// Switch back to session 1
		await page.click(`[data-session-id="${sessionIds[0]}"]`);
		await waitForElement(page, 'textarea');
		await page.waitForTimeout(1000);

		// Get subscription count again
		const backToSession1 = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// VERIFY: Should be similar to first time we loaded session 1
		expect(Math.abs(withSession1 - backToSession1)).toBeLessThanOrEqual(5);

		// Go home - all session subscriptions should clean up
		await page.click('h1:has-text("NeoKai")');
		await page.waitForTimeout(1000);

		const backHome = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// VERIFY: Back at home, subscription count should be close to initial
		// (allowing for global subscriptions that stay active)
		expect(backHome).toBeLessThanOrEqual(initialSubs + 10);

		// Cleanup
		for (const sessionId of sessionIds) {
			await cleanupTestSession(page, sessionId);
		}
	});
});
