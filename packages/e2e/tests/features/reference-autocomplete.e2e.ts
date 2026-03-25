/**
 * Reference Autocomplete E2E Tests
 *
 * Covers the @ reference autocomplete feature:
 * - Basic appearance and dropdown visibility
 * - Grouped results by type (Tasks, Goals)
 * - Filtering as user types
 * - Dismissal via Escape and input clear
 * - Works in the middle of text (not just at the start)
 * - Menu exclusivity (slash command and reference menus don't coexist)
 *
 * Setup: creates a room with a task and goal via RPC (infrastructure exemption),
 * then creates a session in that room so reference.search returns Tasks/Goals results.
 * Cleanup: deletes session and room in afterEach.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, cleanupTestSession } from '../helpers/wait-helpers';
import { createRoomWithTaskAndGoal, deleteRoom } from '../helpers/room-helpers';
import {
	getReferenceDropdown,
	waitForReferenceAutocomplete,
	typeInChatInput,
	getMessageInput,
	selectReferenceByClick,
	createRoomSession,
} from '../helpers/reference-helpers';

// ─── Test Data ────────────────────────────────────────────────────────────────

const TASK_TITLE = 'E2E Autocomplete Task';
const GOAL_TITLE = 'E2E Autocomplete Goal';

// Search prefix that matches both task and goal titles above
const SEARCH_QUERY = '@E2E';

// ─── Shared Test Setup ────────────────────────────────────────────────────────

/**
 * All reference autocomplete tests share the same setup:
 * a room session with a task and goal so reference.search returns typed results.
 */
test.describe('Reference Autocomplete', () => {
	let sessionId: string | null = null;
	let roomId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a room with task and goal — gives reference.search something to return.
		// Dev branch signature: (page, taskTitle, goalTitle, taskDesc?, goalDesc?)
		const result = await createRoomWithTaskAndGoal(
			page,
			TASK_TITLE,
			GOAL_TITLE,
			'E2E task for reference autocomplete testing',
			'E2E goal for reference autocomplete testing'
		);
		roomId = result.roomId;

		// Create a session scoped to the room so task/goal results appear
		sessionId = await createRoomSession(page, roomId);
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch {
				// Best-effort cleanup
			}
			sessionId = null;
		}
		if (roomId) {
			try {
				await deleteRoom(page, roomId);
			} catch {
				// Best-effort cleanup
			}
			roomId = null;
		}
	});

	// ─── Basic Functionality ───────────────────────────────────────────────────

	test.describe('Basic Functionality', () => {
		test('should show autocomplete dropdown when typing @query', async ({ page }) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);
			await expect(getReferenceDropdown(page)).toBeVisible();
		});

		test('should show navigation hints in dropdown footer', async ({ page }) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			// Footer keyboard hints are scoped within the dropdown
			const dropdown = getReferenceDropdown(page);
			await expect(dropdown.locator('text=navigate')).toBeVisible();
			await expect(dropdown.locator('text=select')).toBeVisible();
			await expect(dropdown.locator('text=close')).toBeVisible();
		});

		test('should show grouped results by type (Tasks and Goals)', async ({ page }) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			// Section headers for each type are scoped within the dropdown
			const dropdown = getReferenceDropdown(page);
			await expect(dropdown.locator('text=Tasks')).toBeVisible();
			await expect(dropdown.locator('text=Goals')).toBeVisible();
		});

		test('should show "References" header when task/goal results are present', async ({
			page,
		}) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			// aria-label is "References" (not "Files & Folders") when tasks/goals present
			await expect(getReferenceDropdown(page)).toHaveAttribute('aria-label', 'References');
		});

		test('should show task title in results', async ({ page }) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			await expect(
				getReferenceDropdown(page).locator('[role="option"]').filter({ hasText: TASK_TITLE })
			).toBeVisible();
		});

		test('should show goal title in results', async ({ page }) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			await expect(
				getReferenceDropdown(page).locator('[role="option"]').filter({ hasText: GOAL_TITLE })
			).toBeVisible();
		});

		test('should insert @ref token when an option is clicked', async ({ page }) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			await selectReferenceByClick(page, TASK_TITLE);

			// Dropdown closes after selection
			await expect(getReferenceDropdown(page)).toBeHidden({ timeout: 2000 });

			// The @query is replaced with an @ref{task:...} token (with trailing space)
			const inputValue = await getMessageInput(page).inputValue();
			expect(inputValue).toMatch(/@ref\{task:[^}]+\} /);
		});

		test('should filter results as user types after @', async ({ page }) => {
			// Show results for a matching query
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);
			await expect(getReferenceDropdown(page)).toBeVisible();

			// Switch to a query that matches nothing — dropdown should disappear
			await typeInChatInput(page, '@zzz_no_match_xyz_abc');
			await expect(getReferenceDropdown(page)).toBeHidden({ timeout: 5000 });
		});

		test('should hide autocomplete when Escape is pressed', async ({ page }) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			await page.keyboard.press('Escape');

			// Dropdown closes but input text is preserved
			await expect(getReferenceDropdown(page)).toBeHidden({ timeout: 2000 });
			const inputValue = await getMessageInput(page).inputValue();
			expect(inputValue).toBe(SEARCH_QUERY);
		});

		test('should hide autocomplete when input is cleared', async ({ page }) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			await typeInChatInput(page, '');
			await expect(getReferenceDropdown(page)).toBeHidden({ timeout: 3000 });
		});

		test('should not show autocomplete for non-@ input', async ({ page }) => {
			await typeInChatInput(page, 'hello world no at sign here');
			// toBeHidden retries — naturally waits past the 300ms debounce
			await expect(getReferenceDropdown(page)).toBeHidden({ timeout: 3000 });
		});

		test('should show autocomplete when @ query appears in the middle of text', async ({
			page,
		}) => {
			const textarea = getMessageInput(page);

			// Type prefix text, then append @query character-by-character at the cursor
			await textarea.fill('fix the bug ');
			await textarea.press('End');
			await textarea.pressSequentially('@E2E', { delay: 30 });

			// Dropdown appears even when @ is not at the start of the input
			await waitForReferenceAutocomplete(page);
			await expect(getReferenceDropdown(page)).toBeVisible();
		});
	});

	// ─── Menu Exclusivity ─────────────────────────────────────────────────────

	test.describe('Menu Exclusivity', () => {
		test('should show slash menu but not reference menu when / typed', async ({ page }) => {
			await typeInChatInput(page, '/');

			// Slash commands dropdown should appear
			await expect(page.locator('text=Slash Commands')).toBeVisible({ timeout: 10000 });

			// Reference dropdown must not appear simultaneously
			await expect(getReferenceDropdown(page)).toBeHidden();
		});

		test('should show reference menu but not slash menu when @query typed', async ({ page }) => {
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			// Reference dropdown visible
			await expect(getReferenceDropdown(page)).toBeVisible();

			// Slash commands must not appear simultaneously
			await expect(page.locator('text=Slash Commands')).toBeHidden();
		});

		test('should switch from slash menu to reference menu when input changes to @query', async ({
			page,
		}) => {
			// Open slash commands first
			await typeInChatInput(page, '/');
			await expect(page.locator('text=Slash Commands')).toBeVisible({ timeout: 10000 });

			// Replace input with an @ query
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);

			// Reference menu visible, slash menu gone
			await expect(getReferenceDropdown(page)).toBeVisible();
			await expect(page.locator('text=Slash Commands')).toBeHidden();
		});

		test('should switch from reference menu to slash menu when input changes to /', async ({
			page,
		}) => {
			// Open reference autocomplete first
			await typeInChatInput(page, SEARCH_QUERY);
			await waitForReferenceAutocomplete(page);
			await expect(getReferenceDropdown(page)).toBeVisible();

			// Replace input with / to trigger slash commands
			await typeInChatInput(page, '/');
			await expect(page.locator('text=Slash Commands')).toBeVisible({ timeout: 10000 });

			// Reference menu must be hidden now
			await expect(getReferenceDropdown(page)).toBeHidden();
		});
	});
});
