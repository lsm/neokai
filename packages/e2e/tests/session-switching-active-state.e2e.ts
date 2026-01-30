/**
 * Session Switching - Active State E2E Tests
 *
 * Tests for active state styling when switching sessions:
 * - Active session has correct styling
 * - Inactive sessions don't have active styling
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Session Switching - Active State', () => {
	test('should display correct active state styling when switching sessions', async ({ page }) => {
		await setupMessageHubTesting(page);

		// Create 3 sessions
		const sessionIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);
			sessionIds.push(sessionId);

			if (i < 2) {
				await page.click('h1:has-text("NeoKai")');
				await page.waitForTimeout(300);
			}
		}

		// Test active state for each session
		for (const activeSessionId of sessionIds) {
			// Click the session
			await page.click(`[data-session-id="${activeSessionId}"]`);
			await page.waitForTimeout(500);

			// VERIFY: Active session has active styling
			const activeCard = page.locator(`[data-session-id="${activeSessionId}"]`);

			// Check for active indicators (based on SessionListItem.tsx):
			// - bg-dark-850 background
			// - border-l-2 border-l-blue-500 (left border)
			await expect(activeCard).toHaveClass(/bg-dark-850/);
			await expect(activeCard).toHaveClass(/border-l-blue-500/);

			// VERIFY: Other sessions do NOT have active styling
			for (const otherSessionId of sessionIds) {
				if (otherSessionId !== activeSessionId) {
					const otherCard = page.locator(`[data-session-id="${otherSessionId}"]`);

					// Should NOT have active background
					await expect(otherCard).not.toHaveClass(/bg-dark-850/);
					// Should have hover state instead
					await expect(otherCard).toHaveClass(/hover:bg-dark-900/);
				}
			}
		}

		// Cleanup
		for (const sessionId of sessionIds) {
			await cleanupTestSession(page, sessionId);
		}
	});
});
