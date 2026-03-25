/**
 * Reference Autocomplete E2E Tests (Task 5.3)
 *
 * Tests reference resolution and message rendering:
 * - Selecting task/goal/file reference inserts @ref{type:id} into the input
 * - Message with references sends and renders as MentionToken pills
 * - Hover on token shows entity details popover
 * - Multiple references in a single message all render correctly
 * - Standalone sessions (no room) show only file/folder results
 *
 * Setup: rooms/tasks/goals created via RPC (infrastructure exemption).
 * Standalone sessions use createSessionViaUI (established infrastructure helper).
 * All test actions and assertions go through the browser UI.
 * Cleanup: rooms and sessions deleted via RPC in afterEach.
 */

import { test, expect } from '../../fixtures';
import {
	waitForWebSocketConnected,
	createSessionViaUI,
	cleanupTestSession,
} from '../helpers/wait-helpers';
import {
	createRoomWithTask,
	createRoomWithGoal,
	createRoomWithTaskAndGoal,
	deleteRoom,
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
async function navigateToRoomChat(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string
): Promise<void> {
	await page.goto(`/room/${roomId}/agent`);
	await waitForWebSocketConnected(page);
	const textarea = page.locator('textarea[placeholder*="Ask"]').first();
	await textarea.waitFor({ state: 'visible', timeout: 15000 });
	await expect(textarea).toBeEnabled({ timeout: 5000 });
}

/** Get the chat input textarea. */
function getChatInput(page: Parameters<typeof waitForWebSocketConnected>[0]) {
	return page.locator('textarea[placeholder*="Ask"]').first();
}

/**
 * Press Enter to send and wait for the resulting user message bubble.
 * The textarea is expected to already contain the message text.
 */
async function sendCurrentInput(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<void> {
	await getChatInput(page).press('Enter');
	await page.locator('[data-message-role="user"]').first().waitFor({
		state: 'visible',
		timeout: 10000,
	});
}

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
