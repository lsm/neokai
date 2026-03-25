/**
 * Reference Autocomplete E2E Helpers
 *
 * Shared helper functions for @ reference autocomplete interactions in E2E tests.
 * All helpers interact through the browser UI (clicks, keyboard, DOM queries).
 * No direct state access is performed.
 */

import type { Page, Locator } from '@playwright/test';

// ─── Selectors ────────────────────────────────────────────────────────────────

/** The chat textarea that accepts user input */
const CHAT_INPUT_SELECTOR = 'textarea[placeholder*="Ask"]';

/** The reference autocomplete dropdown (role="listbox") */
const AUTOCOMPLETE_SELECTOR = '[role="listbox"]';

/** Individual reference items inside the autocomplete */
const AUTOCOMPLETE_ITEM_SELECTOR = '[role="option"]';

// ─── Autocomplete Helpers ─────────────────────────────────────────────────────

/**
 * Type text in the chat input field.
 *
 * Uses `pressSequentially` to dispatch individual keydown/input/keyup events,
 * which is necessary for the @ trigger detection in useReferenceAutocomplete.
 */
export async function typeInChatInput(page: Page, text: string): Promise<void> {
	const textarea = page.locator(CHAT_INPUT_SELECTOR).first();
	await textarea.waitFor({ state: 'visible', timeout: 5000 });
	// pressSequentially dispatches individual keydown/input/keyup events, which is
	// necessary for the @ trigger detection in useReferenceAutocomplete.
	await textarea.pressSequentially(text, { delay: 30 });
}

/**
 * Wait for the reference autocomplete dropdown to appear.
 *
 * The dropdown is rendered as a `role="listbox"` element by ReferenceAutocomplete.
 */
export async function waitForReferenceAutocomplete(page: Page): Promise<Locator> {
	const dropdown = page.locator(AUTOCOMPLETE_SELECTOR).first();
	await dropdown.waitFor({ state: 'visible', timeout: 5000 });
	return dropdown;
}

/**
 * Get all reference autocomplete items currently visible in the dropdown.
 *
 * Returns a Locator pointing to all `role="option"` elements inside the listbox.
 */
export function getReferenceAutocompleteItems(page: Page): Locator {
	return page.locator(`${AUTOCOMPLETE_SELECTOR} ${AUTOCOMPLETE_ITEM_SELECTOR}`);
}

/**
 * Navigate to an autocomplete item by index using keyboard and select it with Enter.
 *
 * Index is 0-based and maps to the global order of items across all groups.
 * The hook initializes `selectedIndex` to `0`, so index 0 is already selected
 * when the dropdown opens. Pressing ArrowDown N times moves to index N.
 *
 * @param page - Playwright page
 * @param index - 0-based index of the item to select
 */
export async function selectReferenceByIndex(page: Page, index: number): Promise<void> {
	const textarea = page.locator(CHAT_INPUT_SELECTOR).first();
	// Press ArrowDown `index` times — selectedIndex starts at 0, so N presses reaches index N.
	for (let i = 0; i < index; i++) {
		await textarea.press('ArrowDown');
	}
	await textarea.press('Enter');
}

/**
 * Click on a specific autocomplete item whose text contains `searchText`.
 *
 * @param page - Playwright page
 * @param searchText - Substring of the item's display text to match
 */
export async function selectReferenceByClick(page: Page, searchText: string): Promise<void> {
	const item = page
		.locator(`${AUTOCOMPLETE_SELECTOR} ${AUTOCOMPLETE_ITEM_SELECTOR}`)
		.filter({ hasText: searchText })
		.first();
	await item.waitFor({ state: 'visible', timeout: 5000 });
	await item.click();
}

// ─── Mention Token Helpers ────────────────────────────────────────────────────

/**
 * Build a CSS/text selector for a `@ref{type:id}` token inside the textarea value.
 *
 * Because the textarea is a plain `<textarea>` element, "tokens" are not rendered
 * as DOM nodes — the raw `@ref{type:id}` syntax is stored in the textarea value.
 * These helpers therefore check the textarea value for the expected token text.
 *
 * @param refId - Full reference token identifier, e.g. "task:t-3" or "goal:g-1"
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
 * Get the full text content of the chat input textarea.
 * Useful for asserting that a mention token (`@ref{type:id}`) is present after selection.
 *
 * @param page - Playwright page
 * @param refId - Reference identifier, e.g. "task:t-3"
 * @returns The portion of the textarea value that contains the token, or null if not found
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
 * position. Plain `<textarea>` elements render text as a single node with no
 * per-token child elements, so per-token hover targeting is not possible here.
 * Once the MentionToken component (M4) renders `@ref` tokens as rich DOM nodes,
 * this helper should be updated to target those nodes instead.
 *
 * @param page - Playwright page
 * @param refId - Reference identifier verified to be present before hovering
 */
export async function hoverMentionToken(page: Page, refId: string): Promise<void> {
	await waitForMentionToken(page, refId);
	const textarea = page.locator(CHAT_INPUT_SELECTOR).first();
	await textarea.hover();
}
