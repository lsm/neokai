/**
 * Room Sidebar Sections E2E Tests
 *
 * Verifies interactive sidebar features in the RoomContextPanel:
 * - Goals section: expand/collapse individual goals to show/hide linked tasks
 * - Tasks section: tab filtering (Active / Review / Done) for orphan tasks
 * - Sessions section: collapsed by default, expands on click, shows [+] button
 * - Goals section header shows correct active goal count
 *
 * Setup: creates a room, stops the auto-started runtime (prevents agent processing),
 * then creates goals/tasks via RPC (accepted infrastructure pattern).
 * Cleanup: deletes the room via RPC in afterEach.
 *
 * NOTE: Rooms auto-start a runtime on creation (room.created → createOrGetRuntime).
 * We stop the runtime immediately after room creation so the agent doesn't process
 * goals and create unexpected tasks during the test.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

// ─── Types ────────────────────────────────────────────────────────────────────

type TaskStatus =
	| 'pending'
	| 'in_progress'
	| 'review'
	| 'needs_attention'
	| 'completed'
	| 'cancelled';

interface SetupResult {
	roomId: string;
	goalId: string;
	linkedTaskId: string;
	orphanActiveId: string;
	orphanReviewId: string;
	orphanDoneId: string;
	sessionId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Set a task's status via RPC, transitioning through intermediate states as needed.
 */
async function setTaskStatus(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	taskId: string,
	targetStatus: TaskStatus
): Promise<void> {
	await page.evaluate(
		async ({ roomId: rId, taskId: tId, targetStatus: status }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			const setStatus = (s: string) =>
				hub.request('task.setStatus', { roomId: rId, taskId: tId, status: s });

			if (status === 'in_progress') {
				await setStatus('in_progress');
			} else if (status === 'review') {
				await setStatus('in_progress');
				await setStatus('review');
			} else if (status === 'completed') {
				await setStatus('in_progress');
				await setStatus('completed');
			} else if (status === 'cancelled') {
				await setStatus('cancelled');
			}
		},
		{ roomId, taskId, targetStatus }
	);
}

/**
 * Set up a room with:
 * - The runtime stopped immediately (so agent doesn't process goals)
 * - 2 active goals (goalA with 1 linked pending task, goalB empty)
 * - 3 orphan tasks in active (in_progress), review, and completed statuses
 */
async function setupRoomWithData(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<SetupResult> {
	await waitForWebSocketConnected(page);

	const ids = await page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		// Create room
		const roomRes = await hub.request('room.create', { name: 'E2E Sidebar Test Room' });
		const roomId = (roomRes as { room: { id: string } }).room.id;

		// Stop the runtime immediately so agent doesn't process goals and create extra tasks
		try {
			await hub.request('room.runtime.stop', { roomId });
		} catch {
			// Runtime may not have started yet — that's fine
		}

		// Create goal A (will have linked task)
		const goalRes = await hub.request('goal.create', {
			roomId,
			title: 'Ship Auth Feature',
		});
		const goalId = (goalRes as { goal: { id: string } }).goal.id;

		// Create a second goal (no linked tasks, to test count = 2)
		await hub.request('goal.create', { roomId, title: 'Fix CI Pipeline' });

		// Create linked task (stays pending)
		const linkedTaskRes = await hub.request('task.create', {
			roomId,
			title: 'Add Login Page',
		});
		const linkedTaskId = (linkedTaskRes as { task: { id: string } }).task.id;

		// Link task to goal A
		await hub.request('goal.linkTask', { roomId, goalId, taskId: linkedTaskId });

		// Create orphan tasks (not linked to any goal)
		const orphanActiveRes = await hub.request('task.create', {
			roomId,
			title: 'Orphan Active Task',
		});
		const orphanActiveId = (orphanActiveRes as { task: { id: string } }).task.id;

		const orphanReviewRes = await hub.request('task.create', {
			roomId,
			title: 'Orphan Review Task',
		});
		const orphanReviewId = (orphanReviewRes as { task: { id: string } }).task.id;

		const orphanDoneRes = await hub.request('task.create', {
			roomId,
			title: 'Orphan Done Task',
		});
		const orphanDoneId = (orphanDoneRes as { task: { id: string } }).task.id;

		// Create a pre-existing session so the Sessions section has content to show
		const sessionRes = await hub.request('session.create', {
			roomId,
			title: 'Pre-existing Session',
		});
		const sessionId = (sessionRes as { sessionId: string }).sessionId;

		return {
			roomId,
			goalId,
			linkedTaskId,
			orphanActiveId,
			orphanReviewId,
			orphanDoneId,
			sessionId,
		};
	});

	// Transition orphan tasks to their target statuses
	await setTaskStatus(page, ids.roomId, ids.orphanActiveId, 'in_progress');
	await setTaskStatus(page, ids.roomId, ids.orphanReviewId, 'review');
	await setTaskStatus(page, ids.roomId, ids.orphanDoneId, 'completed');

	return ids;
}

async function deleteRoom(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string
): Promise<void> {
	if (!roomId) return;
	try {
		await page.evaluate(async (id) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			await hub.request('room.delete', { roomId: id });
		}, roomId);
	} catch {
		// Best-effort cleanup
	}
}

/**
 * Navigate to the room and wait for the sidebar to be ready with goals loaded.
 */
async function navigateToRoomAndWaitForSidebar(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string
): Promise<void> {
	await page.goto(`/room/${roomId}`);
	await waitForWebSocketConnected(page);
	// Wait for the Goals section header to be visible
	await expect(page.locator('button[aria-label="Goals section"]')).toBeVisible({ timeout: 10000 });
}

/**
 * Scope a locator to the collapsible section with the given title.
 * Uses the aria-label on the section toggle button.
 */
function getSidebarSection(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	sectionTitle: string
) {
	return page.locator('.collapsible-section').filter({
		has: page.locator(`button[aria-label="${sectionTitle} section"]`),
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Room Sidebar Sections', () => {
	let setup: SetupResult = {
		roomId: '',
		goalId: '',
		linkedTaskId: '',
		orphanActiveId: '',
		orphanReviewId: '',
		orphanDoneId: '',
		sessionId: '',
	};

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		setup = await setupRoomWithData(page);
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, setup.roomId);
		setup = {
			roomId: '',
			goalId: '',
			linkedTaskId: '',
			orphanActiveId: '',
			orphanReviewId: '',
			orphanDoneId: '',
			sessionId: '',
		};
	});

	// ── Goals: expand / collapse ────────────────────────────────────────────

	test('Goals section: expand a goal shows linked tasks, collapse hides them', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const goalsSection = getSidebarSection(page, 'Goals');

		// Wait for goals to load (may take a moment after fetchGoals)
		await expect(goalsSection.getByText('Ship Auth Feature')).toBeVisible({ timeout: 15000 });

		// "Ship Auth Feature" goal should be visible in the Goals section
		const goalButton = goalsSection.locator('button').filter({ hasText: 'Ship Auth Feature' });
		await expect(goalButton).toBeVisible({ timeout: 5000 });

		// Linked task should NOT be visible yet (goal is collapsed by default)
		await expect(goalsSection.getByText('Add Login Page')).not.toBeVisible();

		// Click the goal to expand it
		await goalButton.click();

		// Linked task should now be visible
		await expect(goalsSection.getByText('Add Login Page')).toBeVisible({ timeout: 5000 });

		// Click the goal again to collapse it
		await goalButton.click();

		// Linked task should be hidden again
		await expect(goalsSection.getByText('Add Login Page')).not.toBeVisible();
	});

	test('Goals section: expanded goal shows linked task as clickable button', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const goalsSection = getSidebarSection(page, 'Goals');

		// Wait for goals to load
		await expect(goalsSection.getByText('Ship Auth Feature')).toBeVisible({ timeout: 15000 });

		// Expand the goal
		await goalsSection.locator('button').filter({ hasText: 'Ship Auth Feature' }).click();

		// The linked task should be visible as a button inside the goals section
		const linkedTaskBtn = goalsSection.locator('button').filter({ hasText: 'Add Login Page' });
		await expect(linkedTaskBtn).toBeVisible({ timeout: 5000 });
	});

	// ── Goals: header count ────────────────────────────────────────────────

	test('Goals section: header shows correct active goal count', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const goalsSection = getSidebarSection(page, 'Goals');

		// Wait for goals to load — title text should appear
		await expect(goalsSection.getByText('Ship Auth Feature')).toBeVisible({ timeout: 15000 });

		// We created 2 active goals: "Ship Auth Feature" and "Fix CI Pipeline"
		// The count badge shows "(2)"
		await expect(goalsSection.locator('text=(2)')).toBeVisible({ timeout: 5000 });
	});

	// ── Tasks: tab filtering ────────────────────────────────────────────────

	test('Tasks section: Active tab is selected by default', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const tasksSection = getSidebarSection(page, 'Tasks');

		// "Orphan Active Task" (in_progress) should be visible in the active tab
		await expect(tasksSection.getByText('Orphan Active Task')).toBeVisible({ timeout: 8000 });

		// Review and done orphan tasks should NOT be visible under active tab
		await expect(tasksSection.getByText('Orphan Review Task')).not.toBeVisible();
		await expect(tasksSection.getByText('Orphan Done Task')).not.toBeVisible();
	});

	test('Tasks section: Review tab shows only review-status tasks', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const tasksSection = getSidebarSection(page, 'Tasks');

		// Verify active tab shows the active task first
		await expect(tasksSection.getByText('Orphan Active Task')).toBeVisible({ timeout: 8000 });

		// Click the Review tab
		await tasksSection
			.locator('button')
			.filter({ hasText: /^review$/i })
			.click();

		// Only "Orphan Review Task" (review status) should be visible
		await expect(tasksSection.getByText('Orphan Review Task')).toBeVisible({ timeout: 5000 });

		// Active and Done orphan tasks should not be visible
		await expect(tasksSection.getByText('Orphan Active Task')).not.toBeVisible();
		await expect(tasksSection.getByText('Orphan Done Task')).not.toBeVisible();
	});

	test('Tasks section: Done tab shows only completed/cancelled tasks', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const tasksSection = getSidebarSection(page, 'Tasks');

		// Verify active tab first
		await expect(tasksSection.getByText('Orphan Active Task')).toBeVisible({ timeout: 8000 });

		// Click the Done tab
		await tasksSection
			.locator('button')
			.filter({ hasText: /^done$/i })
			.click();

		// Only "Orphan Done Task" (completed) should be visible
		await expect(tasksSection.getByText('Orphan Done Task')).toBeVisible({ timeout: 5000 });

		// Active and Review orphan tasks should not be visible
		await expect(tasksSection.getByText('Orphan Active Task')).not.toBeVisible();
		await expect(tasksSection.getByText('Orphan Review Task')).not.toBeVisible();
	});

	test('Tasks section: switching tabs updates visible tasks', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const tasksSection = getSidebarSection(page, 'Tasks');

		// Start on Active tab: see in_progress orphan
		await expect(tasksSection.getByText('Orphan Active Task')).toBeVisible({ timeout: 8000 });

		// Switch to Review
		await tasksSection
			.locator('button')
			.filter({ hasText: /^review$/i })
			.click();
		await expect(tasksSection.getByText('Orphan Review Task')).toBeVisible({ timeout: 5000 });
		await expect(tasksSection.getByText('Orphan Active Task')).not.toBeVisible();

		// Switch to Done
		await tasksSection
			.locator('button')
			.filter({ hasText: /^done$/i })
			.click();
		await expect(tasksSection.getByText('Orphan Done Task')).toBeVisible({ timeout: 5000 });
		await expect(tasksSection.getByText('Orphan Review Task')).not.toBeVisible();

		// Switch back to Active
		await tasksSection
			.locator('button')
			.filter({ hasText: /^active$/i })
			.click();
		await expect(tasksSection.getByText('Orphan Active Task')).toBeVisible({ timeout: 5000 });
		await expect(tasksSection.getByText('Orphan Done Task')).not.toBeVisible();
	});

	// ── Sessions: collapsible ───────────────────────────────────────────────

	test('Sessions section: collapsed by default, expands on click', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const sessionsToggle = page.locator('button[aria-label="Sessions section"]');
		await expect(sessionsToggle).toBeVisible({ timeout: 8000 });

		// Sessions section is collapsed by default (defaultExpanded=false)
		await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'false');

		// The section body should not be rendered
		await expect(
			getSidebarSection(page, 'Sessions').locator('.collapsible-section-body')
		).not.toBeVisible();

		// Click to expand
		await sessionsToggle.click();

		// aria-expanded should now be "true"
		await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'true');

		// Section body should now be visible
		await expect(
			getSidebarSection(page, 'Sessions').locator('.collapsible-section-body')
		).toBeVisible({
			timeout: 5000,
		});
	});

	test('Sessions section: [+] create button is visible in section header', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		// The [+] create session button should always be visible (even when collapsed)
		const createBtn = page.locator('button[aria-label="Create session"]');
		await expect(createBtn).toBeVisible({ timeout: 8000 });
	});

	test('Sessions section: expand shows pre-existing sessions', async ({ page }) => {
		// The setup pre-creates a session so the sessions list has content on load.
		// The sessions list is populated via room.get on room load (fetchInitialState).
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		// Expand the Sessions section
		const sessionsToggle = page.locator('button[aria-label="Sessions section"]');
		await sessionsToggle.click();
		await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'true');

		// The pre-existing session should be visible in the sessions section
		const sessionsSection = getSidebarSection(page, 'Sessions');
		await expect(
			sessionsSection.locator('.collapsible-section-body').getByRole('button').first()
		).toBeVisible({ timeout: 10000 });

		// "No sessions yet" message should not be showing
		await expect(sessionsSection.getByText('No sessions yet')).not.toBeVisible();
	});

	test('Sessions section: [+] button navigates to a new session', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const initialUrl = page.url();

		// Click [+] to create a session
		await page.locator('button[aria-label="Create session"]').click();

		// The page should navigate to the new session (URL changes from room dashboard)
		await expect(page).not.toHaveURL(initialUrl, { timeout: 10000 });

		// The main content should show the new session chat interface
		await expect(page.locator('text=No messages yet')).toBeVisible({ timeout: 10000 });
	});
});
