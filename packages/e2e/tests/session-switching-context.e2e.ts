/**
 * Session Switching - Context Preservation E2E Tests
 *
 * Tests for session context preservation during switching:
 * - Each session maintains its unique messages
 * - No message bleed between sessions
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForElement,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Session Switching - Context Preservation', () => {
	test('should maintain correct session context after multiple rapid switches', async ({
		page,
	}) => {
		await setupMessageHubTesting(page);

		// Create 3 sessions with unique messages
		const sessionData: Array<{ id: string; message: string }> = [];

		for (let i = 0; i < 3; i++) {
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);

			// Send unique message
			const message = `Unique message ${i + 1} - ${Math.random().toString(36).substring(7)}`;
			const textarea = await waitForElement(page, 'textarea');
			await textarea.fill(message);
			await page.click('[data-testid="send-button"]');

			// Wait for message to appear
			await expect(page.locator(`text="${message}"`)).toBeVisible({
				timeout: 5000,
			});

			sessionData.push({ id: sessionId, message });

			// Go home
			if (i < 2) {
				await page.click('h1:has-text("Liuboer")');
				await page.waitForTimeout(300);
			}
		}

		// Perform RAPID SWITCHING (10 iterations through all sessions)
		for (let iteration = 0; iteration < 10; iteration++) {
			for (const session of sessionData) {
				await page.click(`[data-session-id="${session.id}"]`);
				await page.waitForTimeout(100);
			}
		}

		// VERIFY: Each session still shows its correct unique message
		for (const session of sessionData) {
			await page.click(`[data-session-id="${session.id}"]`);
			await waitForElement(page, 'textarea');

			// Should show its own message
			await expect(page.locator(`text="${session.message}"`)).toBeVisible({
				timeout: 5000,
			});

			// Should NOT show other sessions' messages
			for (const otherSession of sessionData) {
				if (otherSession.id !== session.id) {
					await expect(page.locator(`text="${otherSession.message}"`)).not.toBeVisible();
				}
			}
		}

		// Cleanup
		for (const session of sessionData) {
			await cleanupTestSession(page, session.id);
		}
	});
});
