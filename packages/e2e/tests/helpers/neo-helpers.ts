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
 *
 * Note: `sending` in NeoChatView goes false after the initial `neo.send` RPC
 * resolves, not after the assistant message is streamed. The count-based
 * `waitForFunction` is therefore the authoritative wait signal here.
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
}

// ─── Availability helpers ──────────────────────────────────────────────────────

/**
 * Wait for the Neo chat panel content to reach a stable state after opening.
 * Resolves once the empty state or an error card is attached to the DOM,
 * preventing a race between `isNeoAvailable` and async store initialisation.
 */
export async function waitForNeoChatReady(page: Page): Promise<void> {
	await page
		.locator(
			'[data-testid="neo-empty-state"], [data-testid="neo-error-no-credentials"], [data-testid="neo-error-provider-unavailable"]'
		)
		.first()
		.waitFor({ state: 'attached', timeout: 10000 })
		.catch(() => {
			// Tolerate timeout — isNeoAvailable will return false below, which is safe
		});
}

/**
 * Check whether the Neo agent is provisioned (credentials configured and session active).
 *
 * Uses the `neo.isProvisioned` RPC endpoint for a reliable, synchronous check.
 * This avoids the previous approach of waiting for error cards that only appear
 * after a failed send attempt — meaning `isNeoAvailable` always returned `true`
 * in CI environments without LLM credentials, causing AI-dependent tests to
 * proceed and time out (90s) waiting for an LLM response.
 *
 * The Neo panel does not need to be open for this call to work.
 */
export async function isNeoAvailable(page: Page): Promise<boolean> {
	const result = await page
		.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return { provisioned: false };
			try {
				const response = await hub.request('neo.isProvisioned', {});
				return response as { provisioned: boolean };
			} catch {
				return { provisioned: false };
			}
		})
		.catch(() => ({ provisioned: false }));
	return result.provisioned;
}
