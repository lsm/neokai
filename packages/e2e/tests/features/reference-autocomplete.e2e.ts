/**
 * Reference Autocomplete E2E Tests (Tasks 5.3 + 5.4)
 *
 * Task 5.3 — Resolution and rendering:
 * - Selecting task/goal/file reference inserts @ref{type:id} into the input
 * - Message with references sends and renders as MentionToken pills
 * - Hover on token shows entity details popover
 * - Multiple references in a single message all render correctly
 * - Standalone sessions (no room) show only file/folder results
 *
 * Task 5.4 — Edge cases, mobile, accessibility:
 * - Empty search, rapid typing, deleted entities, many references,
 *   copy/paste @ref text, reference combined with slash command
 * - Mobile: autocomplete on small viewport, touch selection, dropdown bounds
 * - Accessibility: keyboard navigation, ARIA roles, focus management
 *
 * Setup: rooms/tasks/goals created via RPC (infrastructure exemption).
 * All test actions and assertions go through the browser UI.
 * Cleanup: rooms and sessions deleted via RPC in afterEach.
 */

import { test, expect, devices } from '../../fixtures';
import type { Page } from '@playwright/test';
import {
	waitForWebSocketConnected,
	createSessionViaUI,
	cleanupTestSession,
	waitForMessageSent,
} from '../helpers/wait-helpers';
import {
	createRoom,
	createRoomWithTask,
	createRoomWithGoal,
	createRoomWithTaskAndGoal,
	deleteRoom,
	createTask,
} from '../helpers/room-helpers';
import {
	typeInChatInput,
	waitForReferenceAutocomplete,
	getReferenceAutocompleteItems,
	selectReferenceByClick,
	selectReferenceByIndex,
} from '../helpers/reference-helpers';

// ─── Shared Infrastructure ────────────────────────────────────────────────────

/** Navigate to a room's agent chat and wait for the textarea to be ready. */
async function navigateToRoomChat(page: Page, roomId: string): Promise<void> {
	await page.goto(`/room/${roomId}/agent`);
	await waitForWebSocketConnected(page);
	const textarea = page.locator('textarea[placeholder*="Ask"]').first();
	await textarea.waitFor({ state: 'visible', timeout: 15000 });
	await expect(textarea).toBeEnabled({ timeout: 5000 });
}

/** Get the chat input textarea. */
function getChatInput(page: Page) {
	return page.locator('textarea[placeholder*="Ask"]').first();
}

/**
 * Press Enter to send and wait for the resulting user message bubble.
 * The textarea is expected to already contain the message text.
 */
async function sendCurrentInput(page: Page): Promise<void> {
	await getChatInput(page).press('Enter');
	await page.locator('[data-message-role="user"]').first().waitFor({
		state: 'visible',
		timeout: 10000,
	});
}

/**
 * Insert text into the chat textarea via keyboard.insertText() and send.
 * Uses insertText (dispatches browser input events, same path as a real paste)
 * rather than fill() so any future paste-event handlers are exercised.
 * Optionally waits for a specific string to appear in the user message echo.
 */
async function insertAndSend(page: Page, text: string, waitFor?: string): Promise<void> {
	const textarea = getChatInput(page);
	await textarea.focus();
	await page.keyboard.insertText(text);
	await page.keyboard.press('Meta+Enter');
	if (waitFor) {
		await waitForMessageSent(page, waitFor);
	}
}

// ─── Selectors (Task 5.4) ─────────────────────────────────────────────────────

const CHAT_INPUT_SELECTOR = 'textarea[placeholder*="Ask"]';
const MENTION_TOKEN_SELECTOR = '[data-testid="mention-token"]';
const MENTION_TOKEN_POPOVER_SELECTOR = '[data-testid="mention-token-popover"]';
const AUTOCOMPLETE_SELECTOR = '[role="listbox"]';

// ─── Test suite: Autocomplete appearance ─────────────────────────────────────

test.describe('Reference Autocomplete — Dropdown Appearance', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		({ roomId } = await createRoomWithTask(page, 'E2E Autocomplete Task'));
		await navigateToRoomChat(page, roomId);
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('shows autocomplete dropdown when @ is typed', async ({ page }) => {
		await typeInChatInput(page, '@');
		const dropdown = await waitForReferenceAutocomplete(page);
		await expect(dropdown).toBeVisible();
	});

	test('dropdown header reads "References" when task/goal results are present', async ({
		page,
	}) => {
		await typeInChatInput(page, '@');
		const dropdown = await waitForReferenceAutocomplete(page);
		// Scope to the listbox to avoid matching unrelated page text
		await expect(dropdown.locator('text=References')).toBeVisible({ timeout: 3000 });
	});

	test('shows navigation hints in dropdown footer', async ({ page }) => {
		await typeInChatInput(page, '@');
		const dropdown = await waitForReferenceAutocomplete(page);
		await expect(dropdown.locator('text=navigate')).toBeVisible();
		await expect(dropdown.locator('text=select')).toBeVisible();
		await expect(dropdown.locator('text=close')).toBeVisible();
	});

	test('hides autocomplete when Escape is pressed', async ({ page }) => {
		await typeInChatInput(page, '@');
		const dropdown = await waitForReferenceAutocomplete(page);
		await expect(dropdown).toBeVisible();
		await getChatInput(page).press('Escape');
		await expect(dropdown).toBeHidden({ timeout: 3000 });
	});

	test('hides autocomplete when the @ is deleted', async ({ page }) => {
		await typeInChatInput(page, '@');
		const dropdown = await waitForReferenceAutocomplete(page);
		await expect(dropdown).toBeVisible();
		await getChatInput(page).press('Backspace');
		await expect(dropdown).toBeHidden({ timeout: 3000 });
	});

	test('does not show autocomplete for plain text input', async ({ page }) => {
		await typeInChatInput(page, 'Hello world');
		await expect(page.locator('[role="listbox"]').first()).toBeHidden({ timeout: 2000 });
	});
});

// ─── Test suite: Reference Selection → Input Insertion ───────────────────────

test.describe('Reference Selection — Input Insertion', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		({ roomId } = await createRoomWithTaskAndGoal(page, 'Insert Task', 'Insert Goal'));
		await navigateToRoomChat(page, roomId);
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('clicking a task result inserts @ref{task:…} into the input', async ({ page }) => {
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);
		await selectReferenceByClick(page, 'Insert Task');

		const value = await getChatInput(page).inputValue();
		expect(value).toMatch(/@ref\{task:[^}]+\}/);
	});

	test('clicking a goal result inserts @ref{goal:…} into the input', async ({ page }) => {
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);
		await selectReferenceByClick(page, 'Insert Goal');

		const value = await getChatInput(page).inputValue();
		expect(value).toMatch(/@ref\{goal:[^}]+\}/);
	});

	test('keyboard navigation (Enter at index 0) selects the first result', async ({ page }) => {
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);
		// Index 0 is pre-selected; pressing Enter selects it without arrow keys
		await selectReferenceByIndex(page, 0);

		const value = await getChatInput(page).inputValue();
		expect(value).toMatch(/@ref\{[^}]+\}/);
		// Dropdown must close after selection
		await expect(page.locator('[role="listbox"]').first()).toBeHidden({ timeout: 3000 });
	});

	test('task and goal both appear in autocomplete results', async ({ page }) => {
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);

		const items = getReferenceAutocompleteItems(page);
		await expect(items.filter({ hasText: 'Insert Task' }).first()).toBeVisible();
		await expect(items.filter({ hasText: 'Insert Goal' }).first()).toBeVisible();
	});

	test('query filtering narrows results to matching items', async ({ page }) => {
		await typeInChatInput(page, '@Insert Task');
		await waitForReferenceAutocomplete(page);

		// The task must appear
		await expect(
			page.locator('[role="listbox"] [role="option"]').filter({ hasText: 'Insert Task' }).first()
		).toBeVisible();
	});

	test('selecting a file result inserts @ref{file:…} or @ref{folder:…}', async ({ page }) => {
		// package.json is always present in the workspace
		await typeInChatInput(page, '@package');
		await waitForReferenceAutocomplete(page);

		const item = page
			.locator('[role="listbox"] [role="option"]')
			.filter({ hasText: 'package' })
			.first();
		await expect(item).toBeVisible({ timeout: 8000 });
		await item.click();

		const value = await getChatInput(page).inputValue();
		expect(value).toMatch(/@ref\{(file|folder):[^}]+\}/);
	});
});

// ─── Test suite: MentionToken Rendering in Sent Messages ─────────────────────

test.describe('Reference Token Rendering in Sent Messages', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		({ roomId } = await createRoomWithTaskAndGoal(page, 'Render Task', 'Render Goal'));
		await navigateToRoomChat(page, roomId);
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('task reference renders as a pill token in the sent message', async ({ page }) => {
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);
		await selectReferenceByClick(page, 'Render Task');

		await sendCurrentInput(page);

		const token = page
			.locator('[data-message-role="user"] [data-testid="mention-token"][data-ref-type="task"]')
			.first();
		await expect(token).toBeVisible({ timeout: 10000 });
		await expect(token).toContainText('Render Task');
	});

	test('goal reference renders as a pill token in the sent message', async ({ page }) => {
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);
		await selectReferenceByClick(page, 'Render Goal');

		await sendCurrentInput(page);

		const token = page
			.locator('[data-message-role="user"] [data-testid="mention-token"][data-ref-type="goal"]')
			.first();
		await expect(token).toBeVisible({ timeout: 10000 });
		await expect(token).toContainText('Render Goal');
	});

	test('hover on task token triggers the entity-detail popover', async ({ page }) => {
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);
		await selectReferenceByClick(page, 'Render Task');

		await sendCurrentInput(page);

		const token = page
			.locator('[data-message-role="user"] [data-testid="mention-token"][data-ref-type="task"]')
			.first();
		await expect(token).toBeVisible({ timeout: 10000 });
		await token.hover();

		const popover = page.locator('[data-testid="mention-token-popover"]').first();
		await expect(popover).toBeVisible({ timeout: 5000 });
	});

	test('message with both task and goal references renders both tokens', async ({ page }) => {
		// Select task reference
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);
		await selectReferenceByClick(page, 'Render Task');

		// Append text then select goal reference
		const input = getChatInput(page);
		await input.focus();
		await input.press('End');
		await input.pressSequentially(' and @', { delay: 30 });
		await waitForReferenceAutocomplete(page);
		await selectReferenceByClick(page, 'Render Goal');

		// Both @ref tokens must be present in the textarea value before sending
		const value = await input.inputValue();
		expect(value).toMatch(/@ref\{task:[^}]+\}/);
		expect(value).toMatch(/@ref\{goal:[^}]+\}/);

		await sendCurrentInput(page);

		await expect(
			page
				.locator('[data-message-role="user"] [data-testid="mention-token"][data-ref-type="task"]')
				.first()
		).toBeVisible({ timeout: 10000 });
		await expect(
			page
				.locator('[data-message-role="user"] [data-testid="mention-token"][data-ref-type="goal"]')
				.first()
		).toBeVisible({ timeout: 10000 });
	});
});

// ─── Test suite: Entity-Specific Title Rendering ──────────────────────────────

test.describe('Reference Token — Entity-Specific Title Rendering', () => {
	let roomId = '';

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('task token shows the task title from referenceMetadata', async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		({ roomId } = await createRoomWithTask(page, 'Unique Task ABC-999'));
		await navigateToRoomChat(page, roomId);

		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);
		await selectReferenceByClick(page, 'Unique Task ABC-999');
		await sendCurrentInput(page);

		const token = page
			.locator('[data-message-role="user"] [data-testid="mention-token"][data-ref-type="task"]')
			.first();
		await expect(token).toBeVisible({ timeout: 10000 });
		await expect(token).toContainText('Unique Task ABC-999');
	});

	test('goal token shows the goal title from referenceMetadata', async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		({ roomId } = await createRoomWithGoal(page, 'Unique Goal XYZ-777'));
		await navigateToRoomChat(page, roomId);

		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);
		await selectReferenceByClick(page, 'Unique Goal XYZ-777');
		await sendCurrentInput(page);

		const token = page
			.locator('[data-message-role="user"] [data-testid="mention-token"][data-ref-type="goal"]')
			.first();
		await expect(token).toBeVisible({ timeout: 10000 });
		await expect(token).toContainText('Unique Goal XYZ-777');
	});
});

// ─── Test suite: Standalone Session (no room) ─────────────────────────────────

test.describe('Reference Autocomplete — Standalone Session', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		// createSessionViaUI is the established infrastructure helper for standalone sessions
		sessionId = await createSessionViaUI(page);
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			await cleanupTestSession(page, sessionId);
			sessionId = null;
		}
	});

	test('typing @ shows only file/folder results (no tasks or goals)', async ({ page }) => {
		await typeInChatInput(page, '@');
		const dropdown = await waitForReferenceAutocomplete(page);
		await expect(dropdown).toBeVisible();

		// Header must read "Files & Folders" — not "References"
		await expect(dropdown.locator('text=Files & Folders')).toBeVisible({ timeout: 5000 });
		// Task and Goal group labels must be absent
		await expect(dropdown.locator('text=Tasks')).toBeHidden({ timeout: 3000 });
		await expect(dropdown.locator('text=Goals')).toBeHidden({ timeout: 3000 });
	});
});

// ─── Test Group: Edge Cases — Autocomplete Behavior (Task 5.4) ────────────────

test.describe('Reference Autocomplete - Edge Cases: Autocomplete Behavior', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		// Create a room with a task so autocomplete has data to work with
		roomId = await createRoom(page, 'Edge Case Autocomplete Room');
		await createTask(page, roomId, 'Alpha Edge Task', 'Edge case test task');
		await navigateToRoomChat(page, roomId);
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('empty search query returns no autocomplete dropdown', async ({ page }) => {
		// Type a query that will never match any entity or file
		await typeInChatInput(page, '@zzznonexistent999xyz_abc');

		// The 300 ms debounce fires, the RPC returns 0 results, and the component
		// renders nothing (results.length === 0 → returns null). Wait longer than
		// debounce + a generous network round-trip to confirm the menu never appears.
		await expect(page.locator(AUTOCOMPLETE_SELECTOR).first()).toBeHidden({ timeout: 1500 });
	});

	test('rapid typing updates autocomplete correctly without duplicate menus', async ({ page }) => {
		// Type "@Al" quickly to trigger search for "Alpha Edge Task"
		await typeInChatInput(page, '@Al');

		// Autocomplete should appear with a single listbox, not duplicates
		await waitForReferenceAutocomplete(page);

		// There must be exactly one listbox at a time (no duplicate dropdowns)
		const listboxCount = await page.locator(AUTOCOMPLETE_SELECTOR).count();
		expect(listboxCount).toBe(1);

		// The item list should be non-empty (at least one result)
		const items = getReferenceAutocompleteItems(page);
		const count = await items.count();
		expect(count).toBeGreaterThan(0);
	});

	test('reference autocomplete works when combined with slash command text', async ({ page }) => {
		const textarea = getChatInput(page);

		// Type a slash command prefix character by character to populate input
		await textarea.pressSequentially('/merge-session ', { delay: 20 });

		// If slash autocomplete opened, dismiss it and wait for it to close —
		// we want to test @ behaviour without menu-overlap false positives.
		await page.keyboard.press('Escape');
		await expect(page.locator(AUTOCOMPLETE_SELECTOR).first()).toBeHidden({ timeout: 2000 });

		// Type @ to trigger reference autocomplete in the middle of existing text
		await textarea.pressSequentially('@', { delay: 30 });

		// Reference autocomplete should appear
		await waitForReferenceAutocomplete(page);

		// Select the first result
		await selectReferenceByIndex(page, 0);

		// Input must contain both the slash prefix and the @ref token
		const value = await textarea.inputValue();
		expect(value).toMatch(/\/merge-session @ref\{(task|goal|file|folder):/);
	});
});

// ─── Test Group: Edge Cases — Token Error States (Task 5.4) ──────────────────

test.describe('Reference Autocomplete - Edge Cases: Token Error States', () => {
	let sessionId: string | null = null;
	let roomId = '';

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
		if (sessionId) {
			await cleanupTestSession(page, sessionId);
			sessionId = null;
		}
	});

	test('mention token for non-existent task shows "Not found" on hover', async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		sessionId = await createSessionViaUI(page);

		// Use an ID that will never exist: t-99999
		const refText = '@ref{task:t-99999}';
		await insertAndSend(page, `${refText} check deleted`);

		// Wait for the user message echo with visible text
		const userMsg = page.locator('[data-message-role="user"]').filter({ hasText: 'check deleted' });
		await userMsg.first().waitFor({ state: 'visible', timeout: 10000 });

		// Verify the MentionToken was rendered inside the user message
		const token = userMsg.first().locator(MENTION_TOKEN_SELECTOR).first();
		await expect(token).toBeVisible({ timeout: 5000 });

		// Hover the token to trigger the lazy resolve RPC
		await token.hover();

		// Popover should appear and display "Not found" (resolved = null)
		const popover = page.locator(MENTION_TOKEN_POPOVER_SELECTOR).first();
		await expect(popover).toBeVisible({ timeout: 5000 });
		await expect(popover).toContainText('Not found');
	});

	test('mention token for non-existent file shows "Not found" on hover', async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		sessionId = await createSessionViaUI(page);

		// Use a file path that will never exist in the workspace
		const refText = '@ref{file:e2e-test-nonexistent/ghost-file-99999.ts}';
		await insertAndSend(page, `${refText} check missing file`);

		const userMsg = page
			.locator('[data-message-role="user"]')
			.filter({ hasText: 'check missing file' });
		await userMsg.first().waitFor({ state: 'visible', timeout: 10000 });

		const token = userMsg.first().locator(MENTION_TOKEN_SELECTOR).first();
		await expect(token).toBeVisible({ timeout: 5000 });

		await token.hover();

		const popover = page.locator(MENTION_TOKEN_POPOVER_SELECTOR).first();
		await expect(popover).toBeVisible({ timeout: 5000 });
		await expect(popover).toContainText('Not found');
	});

	test('mention token for deleted task shows "Not found" after room deletion', async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create room with a task, get task short ID
		roomId = await createRoom(page, 'Deleted Task Token Room');
		const taskId = await createTask(page, roomId, 'Task To Delete');

		await navigateToRoomChat(page, roomId);

		// Build message with the task's @ref token
		const refText = `@ref{task:${taskId}}`;
		await insertAndSend(page, `${refText} check after deletion`);

		// Wait for user message echo and verify the token is rendered
		const userMsg = page
			.locator('[data-message-role="user"]')
			.filter({ hasText: 'check after deletion' });
		await userMsg.first().waitFor({ state: 'visible', timeout: 10000 });

		const token = userMsg.first().locator(MENTION_TOKEN_SELECTOR).first();
		await expect(token).toBeVisible({ timeout: 5000 });

		// Delete the room via RPC — this cascades to delete the task.
		// NOTE: room deletion currently does NOT emit a session.deleted WebSocket event
		// (room-manager.deleteRoom() performs raw SQL deletes without broadcasting).
		// If that changes and the client navigates away, this test will need updating.
		await deleteRoom(page, roomId);
		roomId = ''; // Already deleted — skip afterEach cleanup

		// Confirm the token is still visible in the UI (page has not navigated away)
		await expect(token).toBeVisible({ timeout: 3000 });

		// Hover the token — reference.resolve now returns null for the deleted task
		await token.hover();

		const popover = page.locator(MENTION_TOKEN_POPOVER_SELECTOR).first();
		await expect(popover).toBeVisible({ timeout: 5000 });
		await expect(popover).toContainText('Not found');
	});
});

// ─── Test Group: Edge Cases — Input Scenarios (Task 5.4) ─────────────────────

test.describe('Reference Autocomplete - Edge Cases: Input Scenarios', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'Input Scenarios Room');
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('5+ references in a single message all render as mention tokens', async ({ page }) => {
		// Create 5 tasks
		const taskIds = await Promise.all([
			createTask(page, roomId, 'Multi-ref Task A'),
			createTask(page, roomId, 'Multi-ref Task B'),
			createTask(page, roomId, 'Multi-ref Task C'),
			createTask(page, roomId, 'Multi-ref Task D'),
			createTask(page, roomId, 'Multi-ref Task E'),
		]);

		await navigateToRoomChat(page, roomId);

		// Build a message with all 5 @ref tokens plus a unique anchor text
		const refs = taskIds.map((id) => `@ref{task:${id}}`).join(' ');
		const message = `${refs} all five refs`;

		await insertAndSend(page, message, 'all five refs');

		// Find the user message by anchor text
		const userMsg = page.locator('[data-message-role="user"]').filter({ hasText: 'all five refs' });
		await userMsg.first().waitFor({ state: 'visible', timeout: 10000 });

		// All 5 tokens must be rendered
		const tokens = userMsg.first().locator(MENTION_TOKEN_SELECTOR);
		await expect(tokens).toHaveCount(5, { timeout: 5000 });
	});

	test('pasting @ref{} text into input renders as mention token when sent', async ({ page }) => {
		const taskId = await createTask(page, roomId, 'Paste Ref Task');
		await navigateToRoomChat(page, roomId);

		// Use insertText to simulate a paste: it dispatches a browser `input` event
		// (same code path as Ctrl+V paste), unlike fill() which sets value directly.
		const rawRef = `@ref{task:${taskId}}`;
		await insertAndSend(page, `${rawRef} pasted reference`, 'pasted reference');

		const userMsg = page
			.locator('[data-message-role="user"]')
			.filter({ hasText: 'pasted reference' });
		await userMsg.first().waitFor({ state: 'visible', timeout: 10000 });

		// The raw @ref{} text must be rendered as a styled MentionToken, not plain text
		const token = userMsg.first().locator(MENTION_TOKEN_SELECTOR).first();
		await expect(token).toBeVisible({ timeout: 5000 });

		// The token carries the correct ref type and ID as data attributes
		await expect(token).toHaveAttribute('data-ref-type', 'task');
		await expect(token).toHaveAttribute('data-ref-id', taskId);
	});
});

// ─── Test Group: Mobile (Task 5.4) ───────────────────────────────────────────

test.describe('Reference Autocomplete - Mobile', () => {
	let roomId = '';

	test.use({
		viewport: { width: 390, height: 844 },
		userAgent: devices['iPhone 13'].userAgent,
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'Mobile Ref Room');
		await createTask(page, roomId, 'Mobile Test Task');
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('reference autocomplete appears on mobile viewport', async ({ page }) => {
		await navigateToRoomChat(page, roomId);

		// Type @ to trigger reference autocomplete
		await typeInChatInput(page, '@');

		// Autocomplete must appear on mobile
		await waitForReferenceAutocomplete(page);
		await expect(page.locator(AUTOCOMPLETE_SELECTOR).first()).toBeVisible();
	});

	test('touch tap selects a reference on mobile', async ({ page }) => {
		await navigateToRoomChat(page, roomId);

		// Trigger autocomplete
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);

		// Tap (not click) on the first result item
		const firstItem = getReferenceAutocompleteItems(page).first();
		await firstItem.waitFor({ state: 'visible', timeout: 5000 });
		await firstItem.tap();

		// Autocomplete should close after tap selection
		await expect(page.locator(AUTOCOMPLETE_SELECTOR).first()).toBeHidden({ timeout: 3000 });

		// Textarea should now contain the @ref token
		const value = await getChatInput(page).inputValue();
		expect(value).toMatch(/@ref\{(task|goal|file|folder):/);
	});

	test('autocomplete dropdown is visible within mobile viewport', async ({ page }) => {
		await navigateToRoomChat(page, roomId);

		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);

		const dropdown = page.locator(AUTOCOMPLETE_SELECTOR).first();
		await expect(dropdown).toBeVisible();

		// boundingBox() must return a real rect — null means the element is off-screen
		// or has no dimensions, which would invalidate the rest of the assertions.
		const box = await dropdown.boundingBox();
		const viewportSize = page.viewportSize();

		expect(box).not.toBeNull();
		expect(viewportSize).not.toBeNull();

		if (box && viewportSize) {
			// Dropdown must not extend below the bottom of the viewport
			expect(box.y + box.height).toBeLessThanOrEqual(viewportSize.height);
			// Dropdown must not extend beyond the right edge
			expect(box.x + box.width).toBeLessThanOrEqual(viewportSize.width);
		}
	});
});

// ─── Test Group: Accessibility (Task 5.4) ────────────────────────────────────

test.describe('Reference Autocomplete - Accessibility', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'Accessibility Ref Room');
		await createTask(page, roomId, 'Accessibility Test Task');
		await navigateToRoomChat(page, roomId);
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('keyboard-only navigation: ArrowDown moves selection and Enter selects', async ({
		page,
	}) => {
		// Type @ to open autocomplete
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);

		const listbox = page.getByRole('listbox').first();
		const options = listbox.getByRole('option');

		// First item starts selected (selectedIndex = 0)
		await expect(options.first()).toHaveAttribute('aria-selected', 'true', { timeout: 2000 });

		// Press ArrowDown — selection must visibly move to the second item
		await page.keyboard.press('ArrowDown');

		const optionCount = await options.count();
		if (optionCount >= 2) {
			await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 2000 });
			await expect(options.first()).toHaveAttribute('aria-selected', 'false');
		}

		// Press Enter to insert the currently highlighted item
		await page.keyboard.press('Enter');

		// Autocomplete must close after selection
		await expect(listbox).toBeHidden({ timeout: 3000 });

		// Textarea must contain the inserted @ref token
		const textarea = getChatInput(page);
		const value = await textarea.inputValue();
		expect(value).toMatch(/@ref\{(task|goal|file|folder):/);
	});

	test('Escape key dismisses autocomplete without clearing the @ query', async ({ page }) => {
		// Use a query that matches the task created in beforeEach so the dropdown
		// is guaranteed to open — avoiding a premature isVisible() race condition.
		await typeInChatInput(page, '@Accessibility');

		// The debounce fires and the dropdown must appear before we press Escape
		await waitForReferenceAutocomplete(page);
		const dropdown = page.locator(AUTOCOMPLETE_SELECTOR).first();
		await expect(dropdown).toBeVisible();

		// Press Escape to dismiss
		await page.keyboard.press('Escape');
		await expect(dropdown).toBeHidden({ timeout: 2000 });

		// The @ query must still be in the textarea (Escape does not clear)
		const textarea = getChatInput(page);
		const value = await textarea.inputValue();
		expect(value).toContain('@Accessibility');
	});

	test('ARIA: listbox role and option roles are present in autocomplete', async ({ page }) => {
		await typeInChatInput(page, '@');

		// Wait for autocomplete to open
		await waitForReferenceAutocomplete(page);

		// Verify listbox role via Playwright's accessibility helper
		const listbox = page.getByRole('listbox');
		await expect(listbox.first()).toBeVisible();

		// Verify option roles inside listbox
		const options = listbox.first().getByRole('option');
		const optionCount = await options.count();
		expect(optionCount).toBeGreaterThan(0);

		// Verify aria-selected attribute is present on at least one option
		// (the currently highlighted item should have aria-selected="true")
		const selectedOption = options.filter({ has: page.locator('[aria-selected="true"]') });
		const selectedCount = await selectedOption.count();
		expect(selectedCount).toBeGreaterThanOrEqual(1);
	});

	test('ARIA: sent mention token has correct data attributes for accessibility', async ({
		page,
	}) => {
		// Create a task in the room and get its ID
		const extraTaskId = await createTask(page, roomId, 'ARIA Label Task');

		// Send a message with the @ref token
		const refText = `@ref{task:${extraTaskId}}`;
		await insertAndSend(page, `${refText} aria label check`, 'aria label check');

		const userMsg = page
			.locator('[data-message-role="user"]')
			.filter({ hasText: 'aria label check' });
		await userMsg.first().waitFor({ state: 'visible', timeout: 10000 });

		// The rendered MentionToken should carry its type/id as data attributes
		const token = userMsg.first().locator(MENTION_TOKEN_SELECTOR).first();
		await expect(token).toBeVisible({ timeout: 5000 });
		await expect(token).toHaveAttribute('data-ref-type', 'task');
		await expect(token).toHaveAttribute('data-ref-id', extraTaskId);
	});

	test('focus stays in textarea after selecting a reference by keyboard', async ({ page }) => {
		await typeInChatInput(page, '@');
		await waitForReferenceAutocomplete(page);

		// Select first item with Enter
		await page.keyboard.press('Enter');

		// Autocomplete must close
		await expect(page.locator(AUTOCOMPLETE_SELECTOR).first()).toBeHidden({ timeout: 3000 });

		// Focus must remain on the textarea (not jump elsewhere)
		const isFocused = await page.evaluate((sel) => {
			const textarea = document.querySelector(sel);
			return document.activeElement === textarea;
		}, CHAT_INPUT_SELECTOR);

		expect(isFocused).toBe(true);
	});
});
