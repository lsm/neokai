import { test, expect } from '../fixtures';
import {
	waitForSessionCreated,
	waitForMessageProcessed,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Auto Title Generation', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
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

	test('should auto-generate title after first message exchange', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		// Wait for session to be created
		sessionId = await waitForSessionCreated(page);
		expect(sessionId).toBeTruthy();

		// Verify initial title is "New Session"
		const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
		await expect(sessionItem).toBeVisible();
		await expect(sessionItem.locator('h3')).toHaveText('New Session');

		// Send a message that should trigger title generation
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('What is the capital of France?');
		await messageInput.press('Enter');

		// Wait for the message to be processed and response received
		await waitForMessageProcessed(page, 'What is the capital of France?');

		// Wait for title to be generated (may take a few seconds)
		// Title should change from "New Session" to something else
		await page.waitForFunction(
			(sid) => {
				const sessionEl = document.querySelector(`[data-session-id="${sid}"]`);
				const titleEl = sessionEl?.querySelector('h3');
				const titleText = titleEl?.textContent || '';
				return titleText !== 'New Session' && titleText.length > 0;
			},
			sessionId,
			{ timeout: 15000 } // Give it 15 seconds for Haiku to generate title
		);

		// Verify the title has changed
		const newTitle = await sessionItem.locator('h3').textContent();
		expect(newTitle).not.toBe('New Session');
		expect(newTitle).toBeTruthy();

		// Title should be concise (3-7 words as per prompt)
		const wordCount = newTitle?.split(/\s+/).length || 0;
		expect(wordCount).toBeGreaterThan(0);
		expect(wordCount).toBeLessThanOrEqual(10); // Allow some flexibility
	});

	test('should not regenerate title for subsequent messages', async ({ page }) => {
		// This test sends 2 messages, so needs longer timeout
		test.setTimeout(120000);
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send first message
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Tell me about TypeScript');
		await messageInput.press('Enter');

		// Wait for first message and title generation
		await waitForMessageProcessed(page, 'Tell me about TypeScript');

		// Wait for title to be generated
		const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
		await page.waitForFunction(
			(sid) => {
				const sessionEl = document.querySelector(`[data-session-id="${sid}"]`);
				const titleEl = sessionEl?.querySelector('h3');
				const titleText = titleEl?.textContent || '';
				return titleText !== 'New Session' && titleText.length > 0;
			},
			sessionId,
			{ timeout: 15000 }
		);

		// Get the generated title
		const generatedTitle = await sessionItem.locator('h3').textContent();
		expect(generatedTitle).not.toBe('New Session');

		// Send a second message
		await messageInput.fill('What are its benefits?');
		await messageInput.press('Enter');

		// Wait for second message to be processed
		await waitForMessageProcessed(page, 'What are its benefits?');

		// Wait a bit to ensure title doesn't change
		await page.waitForTimeout(3000);

		// Verify title hasn't changed
		const titleAfterSecondMessage = await sessionItem.locator('h3').textContent();
		expect(titleAfterSecondMessage).toBe(generatedTitle);
	});

	test('should handle title generation failure gracefully', async ({ page }) => {
		// This test verifies that if title generation fails, the session still works
		// We can't easily simulate failure in E2E, but we can verify the session
		// continues to work even if title stays as "New Session"

		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Hello');
		await messageInput.press('Enter');

		// Wait for message to be processed
		await waitForMessageProcessed(page, 'Hello');

		// Verify session is still functional regardless of title
		const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
		await expect(sessionItem).toBeVisible();

		// Message input should still be enabled
		await expect(messageInput).toBeEnabled();
	});
});
