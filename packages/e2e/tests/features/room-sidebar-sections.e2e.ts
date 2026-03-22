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
 * then creates goals/tasks/sessions via RPC (accepted infrastructure pattern —
 * same as room.create/room.delete in beforeEach/afterEach per CLAUDE.md).
 * Cleanup: deletes the room via RPC in afterEach.
 *
 * NOTE: Rooms auto-start a runtime on creation (room.created → createOrGetRuntime).
 * We stop the runtime and wait until it is confirmed stopped before creating goals,
 * so the agent cannot process goals and create unexpected extra tasks during the test.
 *
 * NOTE: The sessions list in the sidebar is populated via room.get on room load
 * (fetchInitialState). It does NOT update reactively after session.create — the
 * room.overview event is only emitted on task changes, not session creation. As a
 * workaround, a session is pre-created in beforeEach so it is present when the room
 * page first loads and fetchInitialState runs.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

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
 * Infrastructure helper — called only from beforeEach setup, not from test actions.
 */
async function setTaskStatus(
	page: Page,
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
			} else {
				throw new Error(`Unhandled target status in setTaskStatus: ${status}`);
			}
		},
		{ roomId, taskId, targetStatus }
	);
}

/**
 * Set up a room with:
 * - The runtime stopped and confirmed stopped (so agent doesn't process goals)
 * - 2 active goals (goalA with 1 linked pending task, goalB empty)
 * - 3 orphan tasks in active (in_progress), review, and completed statuses
 * - 1 pre-created session so the Sessions section has content on initial load
 */
async function setupRoomWithData(page: Page): Promise<SetupResult> {
	await waitForWebSocketConnected(page);

	const ids = await page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		// Create room
		const roomRes = await hub.request('room.create', { name: 'E2E Sidebar Test Room' });
		const roomId = (roomRes as { room: { id: string } }).room.id;

		// Stop the runtime and wait until it is actually stopped before creating goals.
		// Rooms auto-start a runtime on creation (room.created → createOrGetRuntime),
		// but the event is processed asynchronously, so we poll until the runtime is
		// confirmed stopped rather than fire-and-forget.
		for (let i = 0; i < 20; i++) {
			try {
				await hub.request('room.runtime.stop', { roomId });
			} catch {
				// Runtime may not exist yet — try again
			}
			const stateRes = await hub
				.request('room.runtime.state', { roomId })
				.catch(() => null as unknown);
			const state = (stateRes as { state?: string } | null)?.state;
			if (!state || state === 'stopped') break;
			// Wait 100 ms before retrying
			await new Promise((r) => setTimeout(r, 100));
		}

		// Create goal A (will have linked task)
		const goalRes = await hub.request('goal.create', {
			roomId,
			title: 'Ship Auth Feature',
		});
		const goalId = (goalRes as { goal: { id: string } }).goal.id;

		// Create a second goal (no linked tasks — used to verify count = 2)
		await hub.request('goal.create', { roomId, title: 'Fix CI Pipeline' });

		// Create linked task (stays pending — no status transition needed)
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

		// Pre-create a session so the Sessions section has content when the room loads.
		// The sessions signal populates via room.get (fetchInitialState) on room load —
		// session.create does NOT emit a room.overview event, so the list won't update
		// reactively after the page navigates to the room.
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

	// Transition orphan tasks to their target statuses (infrastructure — beforeEach only)
	await setTaskStatus(page, ids.roomId, ids.orphanActiveId, 'in_progress');
	await setTaskStatus(page, ids.roomId, ids.orphanReviewId, 'review');
	await setTaskStatus(page, ids.roomId, ids.orphanDoneId, 'completed');

	return ids;
}

/**
 * Navigate to the room and wait for the sidebar to be fully ready:
 * Goals section and Tasks section both visible, indicating the panel is mounted
 * and the collapsible sections have rendered.
 */
async function navigateToRoomAndWaitForSidebar(page: Page, roomId: string): Promise<void> {
	await page.goto(`/room/${roomId}`);
	await waitForWebSocketConnected(page);
	// Wait for both Goals and Tasks section headers to be visible
	await expect(page.locator('button[aria-label="Goals section"]')).toBeVisible({ timeout: 10000 });
	await expect(page.locator('button[aria-label="Tasks section"]')).toBeVisible({ timeout: 5000 });
}

/**
 * Scope a locator to the collapsible section with the given title.
 * Uses the aria-label on the section toggle button.
 */
function getSidebarSection(page: Page, sectionTitle: string) {
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
		// Navigate to root first to establish a connected page before making RPC calls
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

		// Wait for goals to load (fetchGoals is called asynchronously on room init)
		await expect(goalsSection.getByText('Ship Auth Feature')).toBeVisible({ timeout: 15000 });

		// "Ship Auth Feature" goal button is visible in the Goals section
		const goalButton = goalsSection.locator('button').filter({ hasText: 'Ship Auth Feature' });
		await expect(goalButton).toBeVisible({ timeout: 5000 });

		// Linked task should NOT be visible yet (goal starts collapsed)
		await expect(goalsSection.getByText('Add Login Page')).not.toBeVisible();

		// Click the goal to expand it — linked task should now appear
		await goalButton.click();
		await expect(goalsSection.getByText('Add Login Page')).toBeVisible({ timeout: 5000 });

		// Click the goal again to collapse it — linked task should hide
		await goalButton.click();
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
		// The count badge in CollapsibleSection renders as "(2)"
		await expect(goalsSection.getByText('(2)')).toBeVisible({ timeout: 5000 });
	});

	// ── Tasks: tab filtering ────────────────────────────────────────────────

	test('Tasks section: Active tab is selected by default', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const tasksSection = getSidebarSection(page, 'Tasks');

		// "Orphan Active Task" (in_progress) should be visible in the default active tab
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

		// Click the Review tab — sidebar renders lowercase tab labels ("active"/"review"/"done")
		await tasksSection
			.locator('button')
			.filter({ hasText: /^review$/ })
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

		// Click the Done tab — sidebar renders lowercase tab labels
		await tasksSection
			.locator('button')
			.filter({ hasText: /^done$/ })
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

		// Switch to Review — sidebar uses lowercase tab labels
		await tasksSection
			.locator('button')
			.filter({ hasText: /^review$/ })
			.click();
		await expect(tasksSection.getByText('Orphan Review Task')).toBeVisible({ timeout: 5000 });
		await expect(tasksSection.getByText('Orphan Active Task')).not.toBeVisible();

		// Switch to Done
		await tasksSection
			.locator('button')
			.filter({ hasText: /^done$/ })
			.click();
		await expect(tasksSection.getByText('Orphan Done Task')).toBeVisible({ timeout: 5000 });
		await expect(tasksSection.getByText('Orphan Review Task')).not.toBeVisible();

		// Switch back to Active
		await tasksSection
			.locator('button')
			.filter({ hasText: /^active$/ })
			.click();
		await expect(tasksSection.getByText('Orphan Active Task')).toBeVisible({ timeout: 5000 });
		await expect(tasksSection.getByText('Orphan Done Task')).not.toBeVisible();
	});

	// ── Sessions: collapsible ───────────────────────────────────────────────

	test('Sessions section: collapsed by default, expands on click', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const sessionsToggle = page.locator('button[aria-label="Sessions section"]');
		await expect(sessionsToggle).toBeVisible({ timeout: 8000 });

		// Sessions section is collapsed by default (defaultExpanded=false in CollapsibleSection)
		await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'false');

		// The section body should not be rendered when collapsed
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

		// The [+] create session button lives in the header right slot of CollapsibleSection
		// and should be visible even when the section is collapsed
		const createBtn = page.locator('button[aria-label="Create session"]');
		await expect(createBtn).toBeVisible({ timeout: 8000 });
	});

	test('Sessions section: expand shows pre-existing sessions', async ({ page }) => {
		// The setup pre-creates a session titled "Pre-existing Session" so the sessions list
		// has content when the room page first loads (sessions populate via fetchInitialState).
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		// Expand the Sessions section
		const sessionsToggle = page.locator('button[aria-label="Sessions section"]');
		await sessionsToggle.click();
		await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'true');

		// The pre-created session should be visible by its title
		const sessionsSection = getSidebarSection(page, 'Sessions');
		await expect(sessionsSection.getByText('Pre-existing Session')).toBeVisible({
			timeout: 10000,
		});

		// "No sessions yet" message should not be showing
		await expect(sessionsSection.getByText('No sessions yet')).not.toBeVisible();
	});

	test('Sessions section: [+] button navigates to a new session', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const initialUrl = page.url();

		// Click [+] to create a session (UI action — no RPC)
		await page.locator('button[aria-label="Create session"]').click();

		// The page should navigate to the new session (URL changes from room dashboard)
		await expect(page).not.toHaveURL(initialUrl, { timeout: 10000 });

		// The main content should show the new session chat interface (empty state)
		await expect(page.getByText('No messages yet', { exact: true })).toBeVisible({
			timeout: 10000,
		});
	});

	// ── Goals: completed tasks toggle ─────────────────────────────────────────

	test('Goals section: completed tasks are hidden by default under expanded goals', async ({
		page,
	}) => {
		// Create an additional goal with a completed linked task
		const completedTaskRoomId = await page.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			const roomRes = await hub.request('room.create', {
				name: 'E2E Completed Tasks Toggle Room',
			});
			const roomId = (roomRes as { room: { id: string } }).room.id;

			// Stop runtime
			for (let i = 0; i < 20; i++) {
				try {
					await hub.request('room.runtime.stop', { roomId });
				} catch {}
				const stateRes = await hub
					.request('room.runtime.state', { roomId })
					.catch(() => null as unknown);
				const state = (stateRes as { state?: string } | null)?.state;
				if (!state || state === 'stopped') break;
				await new Promise((r) => setTimeout(r, 100));
			}

			// Create a goal
			const goalRes = await hub.request('goal.create', {
				roomId,
				title: 'Completed Tasks Test Goal',
			});
			const goalId = (goalRes as { goal: { id: string } }).goal.id;

			// Create a completed task and link it to the goal
			const taskRes = await hub.request('task.create', {
				roomId,
				title: 'Completed Linked Task',
			});
			const taskId = (taskRes as { task: { id: string } }).task.id;

			await hub.request('goal.linkTask', { roomId, goalId, taskId });

			// Transition task to completed
			await hub.request('task.setStatus', {
				roomId,
				taskId,
				status: 'in_progress',
			});
			await hub.request('task.setStatus', { roomId, taskId, status: 'completed' });

			return roomId;
		});

		await navigateToRoomAndWaitForSidebar(page, completedTaskRoomId);

		const goalsSection = getSidebarSection(page, 'Goals');
		await expect(goalsSection.getByText('Completed Tasks Test Goal')).toBeVisible({
			timeout: 15000,
		});

		// Expand the goal
		await goalsSection.locator('button').filter({ hasText: 'Completed Tasks Test Goal' }).click();

		// Completed task should NOT be visible by default
		await expect(goalsSection.getByText('Completed Linked Task')).not.toBeVisible();

		// Clean up
		await deleteRoom(page, completedTaskRoomId);
	});

	test('Goals section: toggle button shows completed tasks when clicked', async ({ page }) => {
		// Create a goal with completed task
		const completedTaskRoomId = await page.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			const roomRes = await hub.request('room.create', {
				name: 'E2E Show Completed Toggle Room',
			});
			const roomId = (roomRes as { room: { id: string } }).room.id;

			// Stop runtime
			for (let i = 0; i < 20; i++) {
				try {
					await hub.request('room.runtime.stop', { roomId });
				} catch {}
				const stateRes = await hub
					.request('room.runtime.state', { roomId })
					.catch(() => null as unknown);
				const state = (stateRes as { state?: string } | null)?.state;
				if (!state || state === 'stopped') break;
				await new Promise((r) => setTimeout(r, 100));
			}

			const goalRes = await hub.request('goal.create', {
				roomId,
				title: 'Toggle Show Goal',
			});
			const goalId = (goalRes as { goal: { id: string } }).goal.id;

			const taskRes = await hub.request('task.create', {
				roomId,
				title: 'Done Task',
			});
			const taskId = (taskRes as { task: { id: string } }).task.id;

			await hub.request('goal.linkTask', { roomId, goalId, taskId });

			await hub.request('task.setStatus', { roomId, taskId, status: 'in_progress' });
			await hub.request('task.setStatus', { roomId, taskId, status: 'completed' });

			return roomId;
		});

		await navigateToRoomAndWaitForSidebar(page, completedTaskRoomId);

		const goalsSection = getSidebarSection(page, 'Goals');
		await expect(goalsSection.getByText('Toggle Show Goal')).toBeVisible({ timeout: 15000 });

		// Expand the goal
		await goalsSection.locator('button').filter({ hasText: 'Toggle Show Goal' }).click();

		// Task should not be visible initially
		await expect(goalsSection.getByText('Done Task')).not.toBeVisible();

		// Click the show completed tasks toggle button
		await goalsSection.locator('button[aria-label="Show completed tasks"]').click();

		// Now completed task should be visible
		await expect(goalsSection.getByText('Done Task')).toBeVisible({ timeout: 5000 });

		// Clean up
		await deleteRoom(page, completedTaskRoomId);
	});

	test('Goals section: completed tasks toggle is persisted in localStorage', async ({ page }) => {
		// Create a goal with completed task
		const completedTaskRoomId = await page.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			const roomRes = await hub.request('room.create', {
				name: 'E2E Persistence Room',
			});
			const roomId = (roomRes as { room: { id: string } }).room.id;

			for (let i = 0; i < 20; i++) {
				try {
					await hub.request('room.runtime.stop', { roomId });
				} catch {}
				const stateRes = await hub
					.request('room.runtime.state', { roomId })
					.catch(() => null as unknown);
				const state = (stateRes as { state?: string } | null)?.state;
				if (!state || state === 'stopped') break;
				await new Promise((r) => setTimeout(r, 100));
			}

			const goalRes = await hub.request('goal.create', { roomId, title: 'Persist Toggle Goal' });
			const goalId = (goalRes as { goal: { id: string } }).goal.id;

			const taskRes = await hub.request('task.create', {
				roomId,
				title: 'Finished Task',
			});
			const taskId = (taskRes as { task: { id: string } }).task.id;

			await hub.request('goal.linkTask', { roomId, goalId, taskId });
			await hub.request('task.setStatus', { roomId, taskId, status: 'in_progress' });
			await hub.request('task.setStatus', { roomId, taskId, status: 'completed' });

			return roomId;
		});

		await navigateToRoomAndWaitForSidebar(page, completedTaskRoomId);

		const goalsSection = getSidebarSection(page, 'Goals');
		await expect(goalsSection.getByText('Persist Toggle Goal')).toBeVisible({ timeout: 15000 });

		// Expand goal and toggle to show completed
		await goalsSection.locator('button').filter({ hasText: 'Persist Toggle Goal' }).click();
		await goalsSection.locator('button[aria-label="Show completed tasks"]').click();
		await expect(goalsSection.getByText('Finished Task')).toBeVisible({ timeout: 5000 });

		// Reload the page to verify persistence
		await page.reload();
		await waitForWebSocketConnected(page);
		await expect(goalsSection.getByText('Persist Toggle Goal')).toBeVisible({ timeout: 15000 });

		// Expand the goal again - the toggle state should be remembered
		await goalsSection.locator('button').filter({ hasText: 'Persist Toggle Goal' }).click();

		// Task should still be visible (persisted)
		await expect(goalsSection.getByText('Finished Task')).toBeVisible({ timeout: 5000 });

		// Clean up
		await deleteRoom(page, completedTaskRoomId);
	});
});
