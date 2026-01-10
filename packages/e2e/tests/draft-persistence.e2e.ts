import { test, expect } from '../fixtures';

test.describe('Draft Persistence', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('http://localhost:9283');
		await page.waitForSelector('button:has-text("New Session")', { timeout: 10000 });
	});

	test('should save draft text while typing', async ({ page }) => {
		// Create new session
		await page.click('button:has-text("New Session")');
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

		// Type draft text
		const draftText = 'This is a draft message';
		await page.fill('textarea[placeholder*="Ask"]', draftText);

		// Wait for debounced save (250ms + buffer)
		await page.waitForTimeout(500);

		// Get the session ID from the URL or store the title
		const currentUrl = page.url();

		// Create another session to switch away
		await page.click('button:has-text("New Session")');
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });
		await page.waitForTimeout(500);

		// Navigate back to the first session
		await page.goto(currentUrl);
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });
		await page.waitForTimeout(500);

		// Draft should be restored
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		await expect(textarea).toHaveValue(draftText);
	});

	test('should clear draft after sending message', async ({ page }) => {
		// Create new session
		await page.click('button:has-text("New Session")');
		await page.waitForSelector('textarea[placeholder*="Ask"]');

		// Type and send message
		const messageText = 'Test message for draft clearing';
		await page.fill('textarea[placeholder*="Ask"]', messageText);
		await page.click('button[aria-label*="Send message"]');

		// Wait for message to be sent
		await page.waitForSelector(`text=${messageText}`, { timeout: 5000 });

		// Textarea should be empty
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		await expect(textarea).toHaveValue('');

		// Switch to another session
		await page.click('button:has-text("New Session")');
		await page.waitForTimeout(500);

		// Go back to test session
		const sessionButtons = await page
			.locator('button')
			.filter({ hasText: messageText.substring(0, 20) })
			.all();
		if (sessionButtons.length > 0) {
			await sessionButtons[0].click();
		}

		await page.waitForTimeout(500);

		// Textarea should STILL be empty (this is the bug we're testing)
		await expect(textarea).toHaveValue('');
	});

	test('should not restore sent message as draft after page reload', async ({ page }) => {
		// Create new session
		await page.click('button:has-text("New Session")');
		await page.waitForSelector('textarea[placeholder*="Ask"]');

		// Type and send message
		const messageText = 'Message that should not reappear';
		await page.fill('textarea[placeholder*="Ask"]', messageText);
		await page.click('button[aria-label*="Send message"]');

		// Wait for message to be sent
		await page.waitForSelector(`text=${messageText}`, { timeout: 5000 });

		// Reload the page
		await page.reload();
		await page.waitForSelector('button:has-text("New Session")', { timeout: 10000 });

		// Navigate back to the session
		const sessionButtons = await page
			.locator('button')
			.filter({ hasText: messageText.substring(0, 20) })
			.all();
		if (sessionButtons.length > 0) {
			await sessionButtons[0].click();
		}

		await page.waitForTimeout(500);

		// Textarea should be empty
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		await expect(textarea).toHaveValue('');
	});

	test('should clear draft when user manually deletes all text', async ({ page }) => {
		// Create new session
		await page.click('button:has-text("New Session")');
		await page.waitForSelector('textarea[placeholder*="Ask"]');

		// Type draft text
		const draftText = 'Draft to be deleted';
		await page.fill('textarea[placeholder*="Ask"]', draftText);

		// Wait for debounced save
		await page.waitForTimeout(500);

		// Clear the textarea
		await page.fill('textarea[placeholder*="Ask"]', '');

		// Wait for immediate save of empty draft
		await page.waitForTimeout(200);

		// Switch to another session and back
		await page.click('button:has-text("New Session")');
		await page.waitForTimeout(500);

		// Go back to first session
		const sessionButtons = await page
			.locator('button')
			.filter({ hasText: /^\s*0\s*$/ })
			.all();
		if (sessionButtons.length > 0) {
			await sessionButtons[0].click();
		}

		await page.waitForTimeout(500);

		// Textarea should remain empty
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		await expect(textarea).toHaveValue('');
	});

	test('should handle rapid typing and sending without draft interference', async ({ page }) => {
		// Create new session
		await page.click('button:has-text("New Session")');
		await page.waitForSelector('textarea[placeholder*="Ask"]');

		const textarea = page.locator('textarea[placeholder*="Ask"]');

		// Type quickly and send without waiting for debounce
		await textarea.fill('Quick message 1');
		await page.click('button[aria-label*="Send message"]');

		// Textarea should clear immediately
		await expect(textarea).toHaveValue('');

		// Wait for message to appear
		await page.waitForSelector('text=Quick message 1', { timeout: 5000 });

		// Type another message quickly
		await textarea.fill('Quick message 2');
		await page.click('button[aria-label*="Send message"]');

		// Textarea should clear again
		await expect(textarea).toHaveValue('');

		// Switch sessions
		await page.click('button:has-text("New Session")');
		await page.waitForTimeout(500);

		// Go back
		const sessionButtons = await page.locator('button').filter({ hasText: 'Quick message' }).all();
		if (sessionButtons.length > 0) {
			await sessionButtons[0].click();
		}

		await page.waitForTimeout(500);

		// Textarea should still be empty, not showing any sent messages
		await expect(textarea).toHaveValue('');
	});

	test('should preserve draft when switching sessions without sending', async ({ page }) => {
		// Create first session
		await page.click('button:has-text("New Session")');
		await page.waitForSelector('textarea[placeholder*="Ask"]');

		// Type draft in first session
		const draft1 = 'Draft for session 1';
		await page.fill('textarea[placeholder*="Ask"]', draft1);
		await page.waitForTimeout(500);

		// Create second session
		await page.click('button:has-text("New Session")');
		await page.waitForSelector('textarea[placeholder*="Ask"]');

		// Type draft in second session
		const draft2 = 'Draft for session 2';
		await page.fill('textarea[placeholder*="Ask"]', draft2);
		await page.waitForTimeout(500);

		// Go back to first session
		const sessionButtons = await page
			.locator('button')
			.filter({ hasText: /^\s*0\s*$/ })
			.all();
		if (sessionButtons.length >= 2) {
			await sessionButtons[1].click(); // Second "0 messages" session (first created)
		}

		await page.waitForTimeout(500);

		// Should show first draft
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		await expect(textarea).toHaveValue(draft1);

		// Go back to second session
		if (sessionButtons.length >= 2) {
			await sessionButtons[0].click(); // First "0 messages" session (most recent)
		}

		await page.waitForTimeout(500);

		// Should show second draft
		await expect(textarea).toHaveValue(draft2);
	});
});
