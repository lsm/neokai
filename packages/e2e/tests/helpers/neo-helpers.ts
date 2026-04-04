/**
 * Shared helpers for Neo panel E2E tests.
 *
 * These helpers encapsulate common Neo panel interactions used across multiple
 * test files. The primary rule is that test actions and assertions must go
 * through the UI. The one allowed exception is `isNeoAvailable()`, which is an
 * infrastructure probe (analogous to a `beforeEach` guard) — it calls the
 * `neo.isProvisioned` RPC via `page.evaluate()` to determine whether the
 * daemon has real LLM credentials configured, so that AI-dependent scenarios
 * can be skipped cleanly in no-LLM CI instead of timing out.
 */

import { expect, type Page } from '@playwright/test';

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
 *
 * The panel uses CSS transform (`-translate-x-full` when closed, `translate-x-0` when open).
 * It is always present in the DOM, so we check class-based state rather than
 * Playwright's `state: 'visible'` which would be true even when the panel is off-screen.
 */
export async function openNeoPanel(page: Page): Promise<void> {
	const neoButton = page.getByRole('button', { name: 'Neo (⌘J)', exact: true });
	await neoButton.waitFor({ state: 'visible', timeout: 5000 });
	await neoButton.click();
	// Wait for the panel to slide into view: -translate-x-full class is removed when open
	await expect(page.getByTestId(NEO_PANEL_TESTID)).not.toHaveClass(/-translate-x-full/, {
		timeout: 5000,
	});
}

/**
 * Close the Neo panel via its close button.
 *
 * The panel slides off-screen via `-translate-x-full` (not display:none), so we
 * use a class-based assertion instead of Playwright's `state: 'hidden'` which
 * would never resolve for a CSS-transformed element.
 */
export async function closeNeoPanel(page: Page): Promise<void> {
	const closeButton = page.getByTestId('neo-panel-close');
	await closeButton.waitFor({ state: 'visible', timeout: 5000 });
	await closeButton.click();
	// Wait for the panel to slide out of view: -translate-x-full class is applied when closed
	await expect(page.getByTestId(NEO_PANEL_TESTID)).toHaveClass(/-translate-x-full/, {
		timeout: 5000,
	});
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
