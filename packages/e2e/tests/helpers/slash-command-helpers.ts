/**
 * Slash Command Autocomplete Test Helpers
 *
 * Shared helper functions for slash command autocomplete E2E tests.
 */

import type { Page } from '@playwright/test';
import { waitForSessionCreated, waitForWebSocketConnected } from './wait-helpers';

/**
 * Wait for slash commands to be loaded for a session
 * NOTE: This waits for the session state to be fetched, which includes the commands.
 */
export async function waitForSlashCommandsLoaded(page: Page): Promise<void> {
	// Wait for the slashCommandsSignal to be exposed on window
	await page.waitForFunction(
		() => {
			return (
				typeof (window as unknown as { slashCommandsSignal?: unknown }).slashCommandsSignal !==
				'undefined'
			);
		},
		{ timeout: 5000 }
	);

	// Wait for commands to be populated (session state fetch)
	await page.waitForFunction(
		() => {
			const signal = (
				window as unknown as {
					slashCommandsSignal?: { value?: string[] };
				}
			).slashCommandsSignal;
			return signal && signal.value && signal.value.length > 0;
		},
		{ timeout: 10000 }
	);
}

/**
 * Type in the message input textarea
 */
export async function typeInMessageInput(page: Page, text: string): Promise<void> {
	const textarea = page.locator('textarea[placeholder*="Ask"]');
	await textarea.waitFor({ state: 'visible', timeout: 5000 });
	await textarea.fill(text);
}

/**
 * Get the message input textarea
 */
export function getMessageInput(page: Page) {
	return page.locator('textarea[placeholder*="Ask"]');
}

/**
 * Get the command autocomplete dropdown
 */
export function getAutocompleteDropdown(page: Page) {
	return page.locator('text=Slash Commands').locator('..');
}

/**
 * Setup: Go to home page, create session, wait for commands to load
 */
export async function setupSlashCommandSession(page: Page): Promise<string> {
	await page.goto('/');
	await waitForWebSocketConnected(page);

	// Create a new session
	const newSessionButton = page.getByRole('button', {
		name: 'New Session',
		exact: true,
	});
	await newSessionButton.click();
	const sessionId = await waitForSessionCreated(page);

	// Wait for commands to load
	await waitForSlashCommandsLoaded(page);

	return sessionId;
}
