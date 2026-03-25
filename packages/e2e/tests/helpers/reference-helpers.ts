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
 * Uses `fill` for plain text and `pressSequentially` for sequences that include
 * the `@` trigger character so the React-like signal-based onChange fires.
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
 * Pressing ArrowDown `index + 1` times from the initial position selects the
 * desired item (the hook starts at index -1 / no selection before the first key).
 *
 * @param page - Playwright page
 * @param index - 0-based index of the item to select
 */
export async function selectReferenceByIndex(page: Page, index: number): Promise<void> {
	const textarea = page.locator(CHAT_INPUT_SELECTOR).first();
	// Press ArrowDown (index + 1) times to reach the target item
	for (let i = 0; i <= index; i++) {
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
 * Hover over a mention token in the chat textarea.
 *
 * Because `<textarea>` renders plain text without child DOM nodes, this helper
 * hovers over the textarea element itself (the only interactive target available).
 * Tests that need to verify tooltip/popover behaviour on tokens should use the
 * MentionToken component (M4) once it exists and renders rich DOM nodes.
 *
 * @param page - Playwright page
 * @param refId - Reference identifier (used to verify the token is present first)
 */
export async function hoverMentionToken(page: Page, refId: string): Promise<void> {
	await waitForMentionToken(page, refId);
	const textarea = page.locator(CHAT_INPUT_SELECTOR).first();
	await textarea.hover();
}
