/**
 * Shared helpers for Neo panel E2E tests.
 *
 * These helpers encapsulate common Neo panel interactions used across multiple
 * test files. Keep only UI-driven actions here — no direct RPC calls.
 */

import type { Page } from '@playwright/test';

// ─── Test IDs ─────────────────────────────────────────────────────────────────

export const NEO_PANEL_TESTID = 'neo-panel';
export const NEO_CHAT_INPUT_TESTID = 'neo-chat-input';
export const NEO_SEND_BUTTON_TESTID = 'neo-send-button';
export const NEO_USER_MESSAGE_TESTID = 'neo-user-message';
export const NEO_ASSISTANT_MESSAGE_TESTID = 'neo-assistant-message';
export const NEO_ACTIVITY_VIEW_TESTID = 'neo-activity-view';
export const ACTIVITY_ENTRY_TESTID = 'activity-entry';

// ─── Panel helpers ────────────────────────────────────────────────────────────

/**
 * Open the Neo panel by clicking the Neo NavRail button.
 */
export async function openNeoPanel(page: Page): Promise<void> {
	const neoButton = page.getByRole('button', { name: 'Neo (⌘J)', exact: true });
	await neoButton.waitFor({ state: 'visible', timeout: 5000 });
	await neoButton.click();
	await page.getByTestId(NEO_PANEL_TESTID).waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Close the Neo panel via its close button.
 */
export async function closeNeoPanel(page: Page): Promise<void> {
	const closeButton = page.getByTestId('neo-panel-close');
	await closeButton.waitFor({ state: 'visible', timeout: 5000 });
	await closeButton.click();
	await page.getByTestId(NEO_PANEL_TESTID).waitFor({ state: 'hidden', timeout: 5000 });
}

// ─── Messaging helpers ────────────────────────────────────────────────────────

/**
 * Type a message in the Neo chat input and send it.
 */
export async function sendNeoMessage(page: Page, text: string): Promise<void> {
	const input = page.getByTestId(NEO_CHAT_INPUT_TESTID);
	await input.waitFor({ state: 'visible', timeout: 5000 });
	await input.fill(text);
	// Send via Enter key (matching the component's onKeyDown handler)
	await input.press('Enter');
}

/**
 * Wait for a new user message bubble to appear in the Neo chat.
 */
export async function waitForNeoUserMessage(page: Page, text: string): Promise<void> {
	await page
		.getByTestId(NEO_USER_MESSAGE_TESTID)
		.filter({ hasText: text })
		.first()
		.waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Wait for a new Neo assistant response to appear (any content).
 * Uses count-based detection so previous responses don't trigger a false positive.
 * Waits for the input to become re-enabled as the signal that streaming is complete.
 */
export async function waitForNeoAssistantResponse(
	page: Page,
	options: { timeout?: number } = {}
): Promise<void> {
	const timeout = options.timeout ?? 90000;
	const initialCount = await page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID).count();
	await page.waitForFunction(
		(expected) =>
			document.querySelectorAll('[data-testid="neo-assistant-message"]').length > expected,
		initialCount,
		{ timeout }
	);
	// Wait for the input to be re-enabled (disabled only while `sending` is true)
	await page.getByTestId(NEO_CHAT_INPUT_TESTID).waitFor({ state: 'enabled', timeout: 10000 });
}

// ─── Availability helpers ──────────────────────────────────────────────────────

/**
 * Check whether the Neo agent is provisioned (not showing an error card).
 * Must be called with the Neo panel already open so error cards are rendered.
 * Returns true if Neo appears functional.
 */
export async function isNeoAvailable(page: Page): Promise<boolean> {
	const hasNoCredentials = await page
		.getByTestId('neo-error-no-credentials')
		.isVisible()
		.catch(() => false);
	const hasProviderError = await page
		.getByTestId('neo-error-provider-unavailable')
		.isVisible()
		.catch(() => false);
	return !hasNoCredentials && !hasProviderError;
}
