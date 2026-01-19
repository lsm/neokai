/**
 * Session Archive Test Helpers
 *
 * Shared helper functions for session archive E2E tests.
 */

import type { Page } from '@playwright/test';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	waitForAssistantResponse,
} from './wait-helpers';

/**
 * Open the Session options dropdown menu
 */
export async function openSessionOptionsMenu(page: Page): Promise<void> {
	// Click the session options button (gear icon in chat header)
	const optionsButton = page.locator('button[aria-label="Session options"]').first();
	await optionsButton.waitFor({ state: 'visible', timeout: 5000 });
	await optionsButton.click();

	// Wait for menu to appear
	await page.waitForTimeout(300);
}

/**
 * Click Archive Session in the dropdown menu
 */
export async function clickArchiveSession(page: Page): Promise<void> {
	const archiveItem = page.locator('text=Archive Session').first();
	await archiveItem.waitFor({ state: 'visible', timeout: 3000 });
	await archiveItem.click();
}

/**
 * Create a session with a message to have content
 */
export async function createSessionWithMessage(page: Page): Promise<string> {
	// Create new session
	const newSessionButton = page.getByRole('button', {
		name: 'New Session',
		exact: true,
	});
	await newSessionButton.click();
	const sessionId = await waitForSessionCreated(page);

	// Send a simple message
	const textarea = page.locator('textarea[placeholder*="Ask"]');
	await textarea.fill('Hello, say "test message acknowledged"');
	await page.keyboard.press('Meta+Enter');

	// Wait for response
	await waitForAssistantResponse(page);

	return sessionId;
}

/**
 * Archive a given session
 */
export async function archiveSession(page: Page, sessionId: string): Promise<void> {
	// Navigate to the session
	await page.goto(`/${sessionId}`);
	await waitForWebSocketConnected(page);

	// Archive the session
	await openSessionOptionsMenu(page);
	await clickArchiveSession(page);

	// Wait for archive to complete
	await page.waitForTimeout(1500);
}

/**
 * Navigate to home page and wait for WebSocket connection
 */
export async function goToHomePage(page: Page): Promise<void> {
	await page.goto('/');
	await waitForWebSocketConnected(page);
}

/**
 * Click the "Show archived" button to show archived sessions
 */
export async function showArchivedSessions(page: Page): Promise<void> {
	const showArchivedButton = page.locator('button:has-text("Show archived")');
	if ((await showArchivedButton.count()) > 0) {
		await showArchivedButton.click();
		await page.waitForTimeout(500);
	}
}
