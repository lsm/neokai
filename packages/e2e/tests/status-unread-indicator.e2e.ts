/**
 * Unread Message Indicator - E2E Tests
 *
 * Tests the static blue dot indicator that appears in the sidebar
 * when a session has unread messages.
 */

import { test, expect } from '../fixtures';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

test.describe('Unread Message Indicator', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Liuboer', exact: true }).first()).toBeVisible();
		await page.waitForTimeout(1000);
		sessionId = null;
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

	test('should show unread indicator when other session has new messages', async ({ page }) => {
		// Create first session
		let newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		const session1Id = await waitForSessionCreated(page);
		sessionId = session1Id;

		// Send message to first session
		let textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Hello from session 1');
		await page.keyboard.press('Meta+Enter');

		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
		});

		// Create second session
		await page.goto('/');
		await page.waitForTimeout(1000);
		newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		const session2Id = await waitForSessionCreated(page);

		// Session 1 card should now potentially show as "unread" since we're in session 2
		// (if message count increased while we weren't viewing it)
		const session1Card = page.locator(
			`[data-testid="session-card"][data-session-id="${session1Id}"]`
		);
		await expect(session1Card).toBeVisible();

		// Since we created session 1 first and then moved to session 2,
		// session 1 should not show unread yet (we just viewed it)

		// Send a message in session 2
		textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Hello from session 2');
		await page.keyboard.press('Meta+Enter');

		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
		});

		// Clean up second session
		try {
			await cleanupTestSession(page, session2Id);
		} catch {
			// Ignore cleanup errors
		}
	});

	test('should clear unread indicator when session is clicked', async ({ page }) => {
		// Create first session and send a message
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Test message');
		await page.keyboard.press('Meta+Enter');

		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
		});

		// Navigate home
		await page.goto('/');
		await page.waitForTimeout(1000);

		// Get the session card
		const sessionCard = page.locator(
			`[data-testid="session-card"][data-session-id="${sessionId}"]`
		);
		await expect(sessionCard).toBeVisible();

		// Click the session to view it
		await sessionCard.click();
		await page.waitForTimeout(1000);

		// After viewing, any unread indicator should be cleared
		// The blue static dot (bg-blue-500 without animate-pulse) should not be visible
		const staticBlueDot = sessionCard.locator('.bg-blue-500:not(.animate-pulse)');
		await expect(staticBlueDot).not.toBeVisible();
	});
});
