/**
 * Reference Autocomplete E2E Helpers
 *
 * Shared helper functions for @ reference autocomplete interactions in E2E tests.
 * All helpers interact through the browser UI (clicks, keyboard, DOM queries).
 * No direct state access is performed.
 */

import { expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { waitForWebSocketConnected, getWorkspaceRoot } from './wait-helpers';
import { CHAT_INPUT_SELECTOR } from './selectors';

/** Individual reference items inside the autocomplete */
const AUTOCOMPLETE_ITEM_SELECTOR = '[role="option"]';

// ─── Autocomplete Helpers ─────────────────────────────────────────────────────

/**
 * Get the reference autocomplete dropdown locator.
 * Anchored on data-testid="reference-autocomplete" for robustness.
 */
export function getReferenceDropdown(page: Page) {
	return page.locator('[data-testid="reference-autocomplete"]');
}

/**
 * Wait for the reference autocomplete dropdown to appear.
 *
 * The dropdown is rendered as a `role="listbox"` element by ReferenceAutocomplete.
 */
export async function waitForReferenceAutocomplete(page: Page, timeout = 8000): Promise<Locator> {
	const dropdown = getReferenceDropdown(page);
	await dropdown.waitFor({ state: 'visible', timeout });
	return dropdown;
}

/**
 * Get the message input textarea.
 */
export function getMessageInput(page: Page) {
	return page.locator(CHAT_INPUT_SELECTOR).first();
}

/**
 * Type text in the chat input field.
 *
 * Clears existing content first, then uses `pressSequentially` to dispatch
 * individual keydown/input/keyup events, which is necessary for the
 * @ trigger detection in useReferenceAutocomplete. Passing an empty string
 * clears the input without typing anything further.
 */
export async function typeInChatInput(page: Page, text: string): Promise<void> {
	const textarea = getMessageInput(page);
	await textarea.waitFor({ state: 'visible', timeout: 5000 });
	// Clear first so subsequent calls replace content instead of appending
	await textarea.fill('');
	if (text) {
		await textarea.pressSequentially(text, { delay: 30 });
	}
}

/**
 * Get all visible autocomplete option items inside the reference dropdown.
 */
export function getReferenceAutocompleteItems(page: Page) {
	return getReferenceDropdown(page).locator(AUTOCOMPLETE_ITEM_SELECTOR);
}

/**
 * Select an autocomplete item by its index using keyboard Enter.
 * The item at the given index is already pre-selected when the dropdown opens.
 *
 * @param page - Playwright page
 * @param index - Zero-based index of the item to select
 */
export async function selectReferenceByIndex(page: Page, index: number): Promise<void> {
	const items = getReferenceAutocompleteItems(page);
	// Navigate to the target index with ArrowDown if needed
	for (let i = 0; i < index; i++) {
		await page.keyboard.press('ArrowDown');
	}
	await page.keyboard.press('Enter');
}

/**
 * Click on a specific autocomplete item whose text contains `searchText`.
 *
 * @param page - Playwright page
 * @param searchText - Substring of the item's display text to match
 * @param resultType - Optional result type to scope the selector (e.g. 'goal', 'task').
 *   When provided, the locator is restricted to items with a matching
 *   `data-result-type` attribute, preventing accidental clicks on items of the
 *   wrong type that happen to share text with the intended item.
 */
export async function selectReferenceByClick(
	page: Page,
	searchText: string,
	resultType?: 'task' | 'goal' | 'file' | 'folder'
): Promise<void> {
	const selector = resultType
		? `${AUTOCOMPLETE_ITEM_SELECTOR}[data-result-type="${resultType}"]`
		: AUTOCOMPLETE_ITEM_SELECTOR;
	const item = getReferenceDropdown(page)
		.locator(selector)
		.filter({ hasText: searchText })
		.first();
	await item.waitFor({ state: 'visible', timeout: 5000 });
	await item.click();
}

// ─── Mention Token Helpers ────────────────────────────────────────────────────

/**
 * Build the raw `@ref{type:id}` token string for a given reference identifier.
 */
function buildRefToken(refId: string): string {
	return `@ref{${refId}}`;
}

/**
 * Wait for a mention token to appear in the chat input textarea value.
 *
 * @param page - Playwright page
 * @param refId - Reference identifier, e.g. "task:t-3"
 */
export async function waitForMentionToken(page: Page, refId: string): Promise<void> {
	const token = buildRefToken(refId);
	await page.waitForFunction(
		({ selector, t }) => {
			const textarea = document.querySelector(selector) as HTMLTextAreaElement | null;
			return textarea?.value?.includes(t) ?? false;
		},
		{ selector: CHAT_INPUT_SELECTOR, t: token },
		{ timeout: 5000 }
	);
}

/**
 * Get the mention token text from the chat input if present.
 * Returns the token string if found in the textarea value, otherwise null.
 *
 * @param page - Playwright page
 * @param refId - Reference identifier, e.g. "task:t-3"
 */
export async function getMentionTokenText(page: Page, refId: string): Promise<string | null> {
	const token = buildRefToken(refId);
	const value = await page.evaluate(
		({ selector, t }) => {
			const textarea = document.querySelector(selector) as HTMLTextAreaElement | null;
			const v = textarea?.value ?? '';
			return v.includes(t) ? t : null;
		},
		{ selector: CHAT_INPUT_SELECTOR, t: token }
	);
	return value;
}

/**
 * Hover over the chat textarea after verifying a mention token is present.
 *
 * NOTE: This hovers over the entire `<textarea>` element, NOT a specific token
 * position. Once the MentionToken component (M4) renders `@ref` tokens as rich
 * DOM nodes, this helper should be updated to target those nodes instead.
 *
 * @param page - Playwright page
 * @param refId - Reference identifier verified to be present before hovering
 */
export async function hoverMentionToken(page: Page, refId: string): Promise<void> {
	await waitForMentionToken(page, refId);
	const textarea = getMessageInput(page);
	await textarea.hover();
}

// ─── Session Setup Helpers ────────────────────────────────────────────────────

/**
 * Create a session associated with a specific room, then navigate to it.
 * For use in test setup (beforeEach) only — uses RPC infrastructure exemption.
 * Returns the session ID.
 */
export async function createRoomSession(page: Page, roomId: string): Promise<string> {
	await waitForWebSocketConnected(page);

	const workspaceRoot = await getWorkspaceRoot(page);

	const sessionId = await page.evaluate(
		async ({ workspacePath, rId }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const response = await hub.request('session.create', {
				workspacePath,
				createdBy: 'human',
				roomId: rId,
			});
			return (response as { sessionId: string }).sessionId;
		},
		{ workspacePath: workspaceRoot, rId: roomId }
	);

	if (!sessionId) throw new Error('Failed to create room session');

	await page.goto(`/session/${sessionId}`);

	// Wait for the session to be ready
	const textarea = getMessageInput(page);
	await textarea.waitFor({ state: 'visible', timeout: 15000 });
	await expect(textarea).toBeEnabled({ timeout: 5000 });

	return sessionId;
}
