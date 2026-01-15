/**
 * Slash Command Autocomplete - Built-in Commands Tests
 *
 * Tests for built-in slash commands availability.
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
	waitForAssistantResponse,
} from './helpers/wait-helpers';

test.describe('Slash Command Autocomplete - Built-in Commands', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		await waitForSlashCommandsLoaded(page);

		// Send a simple message to trigger SDK query, which populates SDK commands
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		await textarea.waitFor({ state: 'visible', timeout: 5000 });
		await textarea.fill('hello');
		await page.keyboard.press('Enter');

		// Wait for assistant response (SDK is now running and commands are populated)
		await waitForAssistantResponse(page);

		// Wait a bit more for commands to be fully loaded in the signal
		await page.waitForTimeout(1000);
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

	test('should show /help command', async ({ page }) => {
		await typeInMessageInput(page, '/h');

		// Should show help command
		await expect(page.locator('button:has-text("help")')).toBeVisible();
	});

	test('should show /context command', async ({ page }) => {
		await typeInMessageInput(page, '/con');

		// Should show context command
		await expect(page.locator('button:has-text("context")')).toBeVisible();
	});

	test('should show /clear command', async ({ page }) => {
		await typeInMessageInput(page, '/cl');

		// Should show clear command
		await expect(page.locator('button:has-text("clear")')).toBeVisible();
	});

	test('should show multiple commands matching filter', async ({ page }) => {
		await typeInMessageInput(page, '/c');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Should show at least the clear command
		await expect(page.locator('button:has-text("clear")')).toBeVisible();
	});
});
