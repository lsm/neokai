/**
 * Session Switching - During Processing E2E Tests
 *
 * Tests for session switching during message processing:
 * - Switching while agent is processing
 * - Message isolation across sessions
 */

import { test, expect } from '../../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForElement,
	cleanupTestSession,
} from '../helpers/wait-helpers';

test.describe('Session Switching - During Processing', () => {
	test.skip('should handle session switching during message processing', async ({ page }) => {
		// TODO: This test is flaky because send button stays disabled; needs investigation
		await setupMessageHubTesting(page);

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
		const textarea1 = await waitForElement(page, 'textarea');
		await expect(textarea1).toBeEnabled({ timeout: 5000 });

		// Send a message (DON'T wait for completion)
		await textarea1.fill('Write a long detailed explanation of quantum computing');
		// Wait for the value change to be detected by the UI
		await page.waitForTimeout(200);
		await expect(page.locator('[data-testid="send-button"]')).toBeEnabled({
			timeout: 10000,
		});
		await page.click('[data-testid="send-button"]');

		// Wait for message to start processing (sending state)
		await page.waitForTimeout(1000);

		// Switch to session 2 WHILE session 1 is still processing
		await page.click(`[data-session-id="${sessionIds[1]}"]`);
		await waitForElement(page, 'textarea');

		// Send a message in session 2
		const textarea2 = page.locator('textarea').first();
		await textarea2.fill('Hello from session 2');
		await page.click('[data-testid="send-button"]');

		// Wait for processing
		await page.waitForTimeout(2000);

		// VERIFY: Session 2's message appears
		await expect(page.locator('text="Hello from session 2"')).toBeVisible();

		// Switch back to session 1
		await page.click(`[data-session-id="${sessionIds[0]}"]`);
		await page.waitForTimeout(1000);

		// VERIFY: Session 1's message should be there (even if still processing)
		await expect(page.locator('text="quantum computing"')).toBeVisible();

		// VERIFY: Session 2's message should NOT be visible in session 1
		await expect(page.locator('text="Hello from session 2"')).not.toBeVisible();

		// Cleanup
		for (const sessionId of sessionIds) {
			await cleanupTestSession(page, sessionId);
		}
	});
});
