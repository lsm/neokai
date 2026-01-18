/**
 * Slash Command Autocomplete - Command Selection Tests
 *
 * Tests for selecting commands from the autocomplete dropdown.
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

test.describe('Slash Command Autocomplete - Command Selection', () => {
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

	test('should insert command with trailing space when selected', async ({ page }) => {
		const textarea = getMessageInput(page);
		await textarea.fill('/mer');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Select with Enter
		await page.keyboard.press('Enter');

		// Input should have command with trailing space
		const inputValue = await textarea.inputValue();
		expect(inputValue).toBe('/merge-session ');
	});

	test('should select command by clicking', async ({ page }) => {
		const textarea = getMessageInput(page);
		await textarea.fill('/');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Click on a command (merge-session is available before SDK starts)
		const mergeCommand = page.locator('button:has-text("merge-session")').first();
		await mergeCommand.click();

		// Dropdown should close
		await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

		// Input should have the selected command
		const inputValue = await textarea.inputValue();
		expect(inputValue).toBe('/merge-session ');
	});

	test('should close dropdown when clicking outside', async ({ page }) => {
		await typeInMessageInput(page, '/');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Click outside the dropdown (on the page body)
		await page.locator('body').click({ position: { x: 10, y: 10 } });

		// Dropdown should close
		await page.waitForTimeout(500);
		await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });
	});
});
