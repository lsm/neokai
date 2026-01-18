/**
 * Slash Command Autocomplete - Edge Cases Tests
 *
 * Tests for edge cases and special scenarios.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../fixtures';
import {
	typeInMessageInput,
	getAutocompleteDropdown,
	getMessageInput,
	waitForSlashCommandsLoaded,
} from './helpers/slash-command-helpers';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Slash Command Autocomplete - Edge Cases', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		await waitForSlashCommandsLoaded(page);
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

	test('should not show autocomplete for / in middle of text', async ({ page }) => {
		// Type text with / in the middle
		await typeInMessageInput(page, 'Hello /world');

		// Dropdown should NOT appear (/ must be at start)
		await page.waitForTimeout(500);
		await expect(getAutocompleteDropdown(page)).toBeHidden();
	});

	test('should show autocomplete for / with leading whitespace', async ({ page }) => {
		// Type / with leading spaces (trimStart is used)
		await typeInMessageInput(page, '  /');

		// Dropdown SHOULD appear (trimStart handles leading whitespace)
		await expect(getAutocompleteDropdown(page)).toBeVisible({ timeout: 3000 });
	});

	test('should handle no matching commands', async ({ page }) => {
		// Type / with gibberish that won't match any commands
		await typeInMessageInput(page, '/xyzzyqwerty');

		// Dropdown should NOT appear (no matching commands)
		await page.waitForTimeout(500);
		await expect(getAutocompleteDropdown(page)).toBeHidden();
	});

	test('should handle rapid typing', async ({ page }) => {
		const textarea = getMessageInput(page);

		// Type rapidly (use merge-session which is available before SDK starts)
		await textarea.pressSequentially('/mer', { delay: 50 });

		// Dropdown should appear and filter correctly
		await expect(page.locator('button:has-text("merge-session")')).toBeVisible({
			timeout: 3000,
		});
	});

	test('should handle command selection followed by more typing', async ({ page }) => {
		const textarea = getMessageInput(page);
		await textarea.fill('/mer');

		// Wait for dropdown and select
		await expect(getAutocompleteDropdown(page)).toBeVisible();
		await page.keyboard.press('Enter');

		// Input should have command with space
		let inputValue = await textarea.inputValue();
		expect(inputValue).toBe('/merge-session ');

		// Type more text after the command
		await textarea.press('End');
		await textarea.type('with some additional context');

		// Should have the full message
		inputValue = await textarea.inputValue();
		expect(inputValue).toBe('/merge-session with some additional context');
	});
});
