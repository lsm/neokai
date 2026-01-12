/**
 * E2E test for the draft clearing bug fix
 *
 * Bug: Sent messages would reappear in the textarea after page reload or session switching
 * Root cause: Race condition where debounced draft save (250ms) would fire after message send
 * Fix: Immediately save empty draft when content is cleared (no debounce)
 */

import { test, expect } from '../fixtures';
import { cleanupTestSession } from './helpers/wait-helpers';

test.describe('Draft Clearing Bug Fix', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('http://localhost:9283');
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });
	});

	test('should NOT restore sent message as draft after session switch', async ({ page }) => {
		// Create first session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

		// Type and send message
		const messageText = 'This message should not reappear';
		const textarea = page.locator('textarea[placeholder*="Ask"]');

		await textarea.fill(messageText);
		await page.click('button[aria-label*="Send message"]');

		// Textarea should clear immediately
		await expect(textarea).toHaveValue('', { timeout: 2000 });

		// Wait for message to appear in chat
		await page.waitForSelector(`text=${messageText}`, { timeout: 10000 });

		// Get the first session's data-session-id attribute
		const firstSessionButton = page.locator('[data-session-id]').first();
		const firstSessionId = await firstSessionButton.getAttribute('data-session-id');

		// Create another session to switch away
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });
		await page.waitForTimeout(500);

		// Get second session ID for cleanup
		const secondSessionButton = page.locator('[data-session-id]').first();
		const secondSessionId = await secondSessionButton.getAttribute('data-session-id');

		// Navigate back to the original session by clicking its button
		await page.click(`[data-session-id="${firstSessionId}"]`);
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });
		await page.waitForTimeout(500);

		// CRITICAL: Textarea should STILL be empty (not showing the sent message)
		await expect(textarea).toHaveValue('');

		// Cleanup
		await cleanupTestSession(page, firstSessionId || '');
		await cleanupTestSession(page, secondSessionId || '');
	});

	test('should NOT restore sent message as draft after page reload', async ({ page }) => {
		// Create new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

		// Type and send message
		const messageText = 'Message for reload test';
		const textarea = page.locator('textarea[placeholder*="Ask"]');

		await textarea.fill(messageText);
		await page.click('button[aria-label*="Send message"]');

		// Wait for message to appear
		await page.waitForSelector(`text=${messageText}`, { timeout: 10000 });

		// Get the session ID before reload
		const sessionButton = page.locator('[data-session-id]').first();
		const sessionId = await sessionButton.getAttribute('data-session-id');

		// Reload the page
		await page.reload();
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });
		await page.waitForTimeout(500);

		// Navigate to the session by clicking its button
		await page.click(`[data-session-id="${sessionId}"]`);
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });
		await page.waitForTimeout(500);

		// CRITICAL: Textarea should be empty after reload
		const textareaAfterReload = page.locator('textarea[placeholder*="Ask"]');
		await expect(textareaAfterReload).toHaveValue('');

		// Cleanup
		await cleanupTestSession(page, sessionId || '');
	});

	test('should handle rapid send without draft race condition', async ({ page }) => {
		// Create new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

		const textarea = page.locator('textarea[placeholder*="Ask"]');

		// Get the session ID
		const sessionButton = page.locator('[data-session-id]').first();
		const firstSessionId = await sessionButton.getAttribute('data-session-id');

		// Send message quickly (before 250ms debounce)
		await textarea.fill('Quick message');
		await page.click('button[aria-label*="Send message"]');

		// Should clear immediately
		await expect(textarea).toHaveValue('', { timeout: 2000 });

		// Switch away and back quickly
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await page.waitForTimeout(100);

		// Get second session ID for cleanup
		const secondSessionButton = page.locator('[data-session-id]').first();
		const secondSessionId = await secondSessionButton.getAttribute('data-session-id');

		await page.click(`[data-session-id="${firstSessionId}"]`);
		await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });
		await page.waitForTimeout(500);

		// Should STILL be empty (no race condition)
		const textareaAfter = page.locator('textarea[placeholder*="Ask"]');
		await expect(textareaAfter).toHaveValue('');

		// Cleanup
		await cleanupTestSession(page, firstSessionId || '');
		await cleanupTestSession(page, secondSessionId || '');
	});
});
