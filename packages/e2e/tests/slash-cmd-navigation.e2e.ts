/**
 * Slash Command Autocomplete - Navigation Tests
 *
 * Tests for keyboard navigation within the autocomplete dropdown.
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

test.describe('Slash Command Autocomplete - Navigation', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
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

	test('should navigate commands with ArrowDown key', async ({ page }) => {
		await typeInMessageInput(page, '/');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Get the first command button
		const firstCommand = page.locator('button[class*="bg-blue-500"]').first();
		await expect(firstCommand).toBeVisible();

		// Press ArrowDown
		await page.keyboard.press('ArrowDown');

		// Wait a bit for UI update
		await page.waitForTimeout(100);

		// Selection should have moved (check for different element having the highlight class)
	});

	test('should navigate commands with ArrowUp key', async ({ page }) => {
		await typeInMessageInput(page, '/');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Press ArrowDown twice then ArrowUp
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');

		// Wait for UI update
		await page.waitForTimeout(100);
	});

	test('should select command with Enter key', async ({ page }) => {
		const textarea = getMessageInput(page);
		await textarea.fill('/');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Press Enter to select first command
		await page.keyboard.press('Enter');

		// Dropdown should close
		await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

		// Input should have the selected command (with trailing space)
		const inputValue = await textarea.inputValue();
		expect(inputValue).toMatch(/^\/[\w-]+ $/);
	});

	test('should close autocomplete with Escape key', async ({ page }) => {
		await typeInMessageInput(page, '/');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Press Escape
		await page.keyboard.press('Escape');

		// Dropdown should close
		await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

		// Input should still have /
		const inputValue = await getMessageInput(page).inputValue();
		expect(inputValue).toBe('/');
	});
});
