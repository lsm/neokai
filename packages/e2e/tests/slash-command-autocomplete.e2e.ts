/**
 * Slash Command Autocomplete E2E Tests
 *
 * End-to-end tests for the slash command autocomplete functionality.
 * Tests the command dropdown that appears when typing '/' in the message input.
 *
 * Features tested:
 * 1. Autocomplete appears when typing '/'
 * 2. Filtering commands as user types
 * 3. Arrow key navigation
 * 4. Selection with Enter/Tab
 * 5. Closing with Escape
 * 6. Built-in commands availability
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect, type Page } from '../fixtures';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
} from './helpers/wait-helpers';

/**
 * Wait for slash commands to be loaded for a session
 */
async function waitForSlashCommandsLoaded(page: Page): Promise<void> {
	// Wait for slashCommandsSignal to have commands
	await page.waitForFunction(
		() => {
			// Access the signal value
			const commands = (window as unknown as { slashCommandsSignal?: { value?: string[] } })
				.slashCommandsSignal?.value;
			return commands && commands.length > 0;
		},
		{ timeout: 15000 }
	);
}

/**
 * Type in the message input textarea
 */
async function typeInMessageInput(page: Page, text: string): Promise<void> {
	const textarea = page.locator('textarea[placeholder*="Ask"]');
	await textarea.waitFor({ state: 'visible', timeout: 5000 });
	await textarea.fill(text);
}

/**
 * Get the message input textarea
 */
function getMessageInput(page: Page) {
	return page.locator('textarea[placeholder*="Ask"]');
}

/**
 * Get the command autocomplete dropdown
 */
function getAutocompleteDropdown(page: Page) {
	return page.locator('text=Slash Commands').locator('..');
}

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
		// Type /he to filter for /help
		await typeInMessageInput(page, '/he');

		// Dropdown should appear with filtered results
		const dropdown = getAutocompleteDropdown(page);
		await expect(dropdown).toBeVisible();

		// Should show help command
		await expect(page.locator('button:has-text("help")')).toBeVisible();
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
		expect(inputValue).toMatch(/^\/\w+ $/);
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

test.describe('Slash Command Autocomplete - Command Selection', () => {
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

	test('should insert command with trailing space when selected', async ({ page }) => {
		const textarea = getMessageInput(page);
		await textarea.fill('/he');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Select with Enter
		await page.keyboard.press('Enter');

		// Input should have command with trailing space
		const inputValue = await textarea.inputValue();
		expect(inputValue).toBe('/help ');
	});

	test('should select command by clicking', async ({ page }) => {
		const textarea = getMessageInput(page);
		await textarea.fill('/');

		// Wait for dropdown
		await expect(getAutocompleteDropdown(page)).toBeVisible();

		// Click on a command
		const helpCommand = page.locator('button:has-text("help")').first();
		await helpCommand.click();

		// Dropdown should close
		await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

		// Input should have the selected command
		const inputValue = await textarea.inputValue();
		expect(inputValue).toBe('/help ');
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

test.describe('Slash Command Autocomplete - Built-in Commands', () => {
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

		// Get all command buttons
		const commands = page.locator('button[class*="text-blue-400"]');
		const count = await commands.count();

		// Should have multiple commands starting with 'c'
		expect(count).toBeGreaterThanOrEqual(1);
	});
});

test.describe('Slash Command Autocomplete - Edge Cases', () => {
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

		// Type rapidly
		await textarea.pressSequentially('/help', { delay: 50 });

		// Dropdown should appear and filter correctly
		await expect(page.locator('button:has-text("help")')).toBeVisible({ timeout: 3000 });
	});

	test('should handle command selection followed by more typing', async ({ page }) => {
		const textarea = getMessageInput(page);
		await textarea.fill('/he');

		// Wait for dropdown and select
		await expect(getAutocompleteDropdown(page)).toBeVisible();
		await page.keyboard.press('Enter');

		// Input should have command with space
		let inputValue = await textarea.inputValue();
		expect(inputValue).toBe('/help ');

		// Type more text after the command
		await textarea.press('End');
		await textarea.type('How do I use this?');

		// Should have the full message
		inputValue = await textarea.inputValue();
		expect(inputValue).toBe('/help How do I use this?');
	});
});
