/**
 * Session Archive - Menu Option Tests
 *
 * Tests for the Archive Session option in the session options menu.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../fixtures';
import { openSessionOptionsMenu } from './helpers/session-archive-helpers';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Session Archive - Menu Option', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);
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

	test('should show Archive Session option in session options menu', async ({ page }) => {
		await openSessionOptionsMenu(page);

		// Should show Archive Session option
		await expect(page.locator('text=Archive Session')).toBeVisible();
	});

	test('should show Tools, Export, Archive, and Delete options in menu', async ({ page }) => {
		await openSessionOptionsMenu(page);

		// Should show all expected options
		await expect(page.locator('text=Tools')).toBeVisible();
		await expect(page.locator('text=Export Chat')).toBeVisible();
		await expect(page.locator('text=Archive Session')).toBeVisible();
		await expect(page.locator('text=Delete Chat')).toBeVisible();
	});
});
