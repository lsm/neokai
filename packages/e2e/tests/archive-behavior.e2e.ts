/**
 * Session Archive - Archived Session Behavior Tests
 *
 * Tests for behavior of archived sessions (message prevention, indicators).
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../fixtures';
import {
	openSessionOptionsMenu,
	clickArchiveSession,
	createSessionWithMessage,
} from './helpers/session-archive-helpers';
import { waitForWebSocketConnected, cleanupTestSession } from './helpers/wait-helpers';

test.describe('Session Archive - Archived Session Behavior', () => {
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

	test('should prevent sending messages in archived session', async ({ page }) => {
		// Create session with a message
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// The message input should be replaced with an archived label
		// Check that textarea is not visible or is disabled
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		const isTextareaHidden = (await textarea.count()) === 0 || !(await textarea.isVisible());

		// Should show archived indicator instead of input
		const archivedIndicator = page.locator('text=Session archived');
		const hasArchivedLabel = (await archivedIndicator.count()) > 0;

		expect(isTextareaHidden || hasArchivedLabel).toBeTruthy();
	});

	test('should show archived indicator with icon', async ({ page }) => {
		// Create session with a message
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// Should show archived text
		await expect(page.locator('text=Session archived').first()).toBeVisible();

		// Should have archive icon (a box icon typically)
		const archiveIconSection = page.locator('text=Session archived').first().locator('..');
		await expect(archiveIconSection.locator('svg')).toBeVisible();
	});
});
