/**
 * Session Switching - Rapid Switching E2E Tests
 *
 * Tests for rapid session switching that stress test cleanup logic:
 * - Rapid switching without cleanup errors
 * - Console error verification during stress testing
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Session Switching - Rapid Switching', () => {
	test('should handle rapid session switching without cleanup errors', async ({ page }) => {
		await setupMessageHubTesting(page);

		// Track console errors (especially "cleanup is not a function")
		const consoleErrors: string[] = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				consoleErrors.push(msg.text());
			}
		});

		// Create 5 sessions
		const sessionIds: string[] = [];
		for (let i = 0; i < 5; i++) {
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);
			sessionIds.push(sessionId);

			// Go back to home to create next session
			if (i < 4) {
				await page.click('h1:has-text("NeoKai")');
				await page.waitForTimeout(300);
			}
		}

		// RAPID SWITCHING - click through all sessions as fast as possible
		// This stresses the cleanup logic and tests if async subscribe() is properly awaited
		for (let iteration = 0; iteration < 3; iteration++) {
			for (const sessionId of sessionIds) {
				await page.click(`[data-session-id="${sessionId}"]`);
				// Minimal wait - just enough to trigger component mount/unmount
				await page.waitForTimeout(50);
			}
		}

		// Wait a bit for any delayed cleanup errors to surface
		await page.waitForTimeout(1000);

		// VERIFY: No "cleanup is not a function" errors
		const cleanupErrors = consoleErrors.filter(
			(err) => err.includes('cleanup is not a function') || err.includes('not a function')
		);
		expect(cleanupErrors).toHaveLength(0);

		// VERIFY: All sessions still work - click each and verify chat interface loads
		for (const sessionId of sessionIds) {
			await page.click(`[data-session-id="${sessionId}"]`);
			await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeVisible({
				timeout: 5000,
			});
		}

		// Cleanup all sessions
		for (const sessionId of sessionIds) {
			await cleanupTestSession(page, sessionId);
		}
	});
});
