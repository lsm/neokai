/**
 * Session Archive - Edge Cases Tests
 *
 * Tests for edge cases like preserving messages and deleting archived sessions.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../fixtures';
import {
	openSessionOptionsMenu,
	clickArchiveSession,
	createSessionWithMessage,
} from './helpers/session-archive-helpers';
import {
	waitForWebSocketConnected,
	waitForAssistantResponse,
	waitForSessionCreated,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Session Archive - Edge Cases', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
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

	test('should preserve messages after archiving', async ({ page }) => {
		// Create session with a specific message
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		await textarea.fill('Unique test message 12345');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await waitForAssistantResponse(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// The original message should still be visible
		await expect(page.locator('text=Unique test message 12345').first()).toBeVisible();
	});

	test('should allow deleting archived session', async ({ page }) => {
		// Create session with a message
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// Open options and click delete
		await openSessionOptionsMenu(page);

		const deleteItem = page.locator('text=Delete Chat').first();
		await deleteItem.click();

		// Confirm deletion
		const confirmButton = page
			.locator('[data-testid="confirm-delete-session"], button:has-text("Delete")')
			.last();
		await confirmButton.click();

		// Wait for deletion
		await page.waitForTimeout(1000);

		// Session should be deleted (navigated away)
		sessionId = null; // Already deleted, don't try to cleanup
	});
});
