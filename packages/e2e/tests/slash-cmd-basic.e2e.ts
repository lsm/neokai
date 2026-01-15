/**
 * Slash Command Autocomplete - Basic Functionality Tests
 *
 * Tests for basic autocomplete dropdown behavior.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../fixtures';
import {
	typeInMessageInput,
	getAutocompleteDropdown,
	waitForSlashCommandsLoaded,
} from './helpers/slash-command-helpers';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Slash Command Autocomplete - Basic Functionality', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Wait for commands to load
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

	test('should show autocomplete dropdown when typing /', async ({ page }) => {
		// Type / in the message input
		await typeInMessageInput(page, '/');

		// Autocomplete dropdown should appear
		const dropdown = getAutocompleteDropdown(page);
		await expect(dropdown).toBeVisible({ timeout: 3000 });

		// Should have "Slash Commands" header
		await expect(page.locator('text=Slash Commands')).toBeVisible();
	});

	test('should show navigation hints in dropdown footer', async ({ page }) => {
		await typeInMessageInput(page, '/');

		// Should show navigation hints
		await expect(page.locator('text=navigate')).toBeVisible();
		await expect(page.locator('text=select')).toBeVisible();
		await expect(page.locator('text=close')).toBeVisible();
	});

	test('should filter commands as user types', async ({ page }) => {
		// Type /me to filter for /merge-session
		await typeInMessageInput(page, '/me');

		// Dropdown should appear with filtered results
		const dropdown = getAutocompleteDropdown(page);
		await expect(dropdown).toBeVisible();

		// Should show merge-session command
		await expect(page.locator('button:has-text("merge-session")')).toBeVisible();
	});

	test('should hide autocomplete when input is empty', async ({ page }) => {
		// Type / first
		await typeInMessageInput(page, '/');

		// Dropdown should appear
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Clear the input
		await typeInMessageInput(page, '');

		// Dropdown should disappear
		await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });
	});

	test('should hide autocomplete for non-slash input', async ({ page }) => {
		// Type regular text
		await typeInMessageInput(page, 'Hello world');

		// Dropdown should not appear
		await expect(getAutocompleteDropdown(page)).toBeHidden();
	});
});
