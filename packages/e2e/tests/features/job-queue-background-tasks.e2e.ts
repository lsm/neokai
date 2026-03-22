import { test, expect } from '../../fixtures';
import {
	cleanupTestSession,
	createSessionViaUI,
	waitForAssistantResponse,
	waitForMessageSent,
} from '../helpers/wait-helpers';

/**
 * E2E tests for background job queue tasks.
 *
 * Verifies that background tasks (session title generation, etc.) are working
 * correctly from the user's perspective — i.e., through visible DOM state only.
 */
test.describe('Background Job Queue Tasks', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
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

	test('session title updates after first message (title generation job)', async ({ page }) => {
		// Create a new session
		sessionId = await createSessionViaUI(page);

		// Verify the session starts with the default "New Session" title in the chat header
		const chatHeader = page.locator('h2').filter({ hasText: 'New Session' }).first();
		await expect(chatHeader).toBeVisible({ timeout: 5000 });

		// Send a short message — this triggers the session.title_generation background job
		const testMessage = 'What is 2 + 2?';
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill(testMessage);
		await page.keyboard.press('Meta+Enter');

		// Verify user message appears in chat
		await waitForMessageSent(page, testMessage);

		// Wait for the assistant to respond (proves the agent ran end-to-end)
		await waitForAssistantResponse(page);

		// Wait for the session title to change from "New Session" to something
		// meaningful — this confirms the title generation background job ran
		// and persisted the new title back to the session.
		// Allow up to 30s after response for the job to complete and UI to update.
		await page.waitForFunction(
			() => {
				const h2 = document.querySelector('h2');
				return h2 && h2.textContent?.trim() !== '' && h2.textContent?.trim() !== 'New Session';
			},
			{ timeout: 30000 }
		);

		// Confirm the new title is displayed in the header
		const updatedTitle = await page.locator('h2').first().textContent();
		expect(updatedTitle?.trim()).toBeTruthy();
		expect(updatedTitle?.trim()).not.toBe('New Session');

		// Also verify the sidebar session card reflects the updated title
		// (the session list item should no longer show the default placeholder)
		const sessionCard = page.locator('[data-testid="session-card"]').first();
		const cardTitle = sessionCard.locator('h3').first();
		await expect(cardTitle).not.toHaveText('New Session', { timeout: 10000 });
	});
});
