/**
 * Room Sidebar Sections E2E Tests
 *
 * Verifies interactive sidebar features in the RoomContextPanel:
 * - Task stats strip: shows active/review counts, navigates to Tasks tab
 * - Pinned items: Overview and Coordinator navigation buttons
 * - Missions section: CollapsibleSection with active goals list and count badge
 * - Sessions section: collapsed by default, expands on click, shows [+] button
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

		const systemState = await hub.request('state.system', {});
		const workspaceRoot = (systemState as { workspaceRoot: string }).workspaceRoot;

		// Create room
		const roomRes = await hub.request('room.create', {
			name: 'E2E Sidebar Test Room',
			defaultPath: workspaceRoot,
		});
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
 * Missions section visible, indicating the panel is mounted
 * and the collapsible sections have rendered.
 */
async function navigateToRoomAndWaitForSidebar(page: Page, roomId: string): Promise<void> {
	await page.goto(`/room/${roomId}`);
	await waitForWebSocketConnected(page);
	// Wait for Missions section header to be visible (sidebar is mounted)
	await expect(page.locator('button[aria-label="Missions section"]')).toBeVisible({
		timeout: 10000,
	});
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

/**
 * Get a locator for the top tab bar button with the given label.
 * Scopes to the Room component's root div (bg-dark-900) to exclude sidebar
 * buttons (ContextPanel w-70), which render before Room in DOM order.
 * Uses substring matching so it works even when a badge (e.g. "Tasks1") is appended.
 */
function getTopTabButton(page: Page, label: string) {
	return page
		.locator('.flex-1.flex.bg-dark-900.overflow-hidden')
		.locator('button')
		.filter({ hasText: label });
}

/**
 * Assert that the top tab bar button with the given label has the full active styling:
 * text-blue-400 (text color) + border-b-2 border-blue-400 (bottom border indicator).
 * Uses separate assertions for each class to avoid false positives from partial matches.
 * Each assertion auto-retries on failure, handling Preact signal propagation timing.
 */
async function expectTopTabActive(page: Page, label: string) {
	const tab = getTopTabButton(page, label);
	await expect(tab).toHaveClass(/text-blue-400/, { timeout: 5000 });
	await expect(tab).toHaveClass(/border-b-2/, { timeout: 5000 });
	await expect(tab).toHaveClass(/border-blue-400/, { timeout: 5000 });
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

	// ── Task stats strip ───────────────────────────────────────────────────

	test('Task stats strip: shows active and review counts', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		// The task stats strip should show "X active · Y review"
		// We have several active tasks (pending + in_progress) and 1 review task
		await expect(page.locator('text=/\\d+ active/').first()).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=/\\d+ review/').first()).toBeVisible({ timeout: 5000 });
	});

	test('Task stats strip: navigates to Tasks tab on click', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		// Click the task stats strip button (scope to sidebar to avoid matching tab bar)
		const sidebar = page.locator('.w-70');
		const statsButton = sidebar
			.locator('button')
			.filter({ hasText: /active/ })
			.first();
		await expect(statsButton).toBeVisible({ timeout: 10000 });
		await statsButton.click();

		// The Tasks tab should become active — expectTopTabActive checks both the
		// text color (text-blue-400) and the bottom border indicator (border-b-2
		// border-blue-400). Each assertion auto-retries to handle Preact signal
		// propagation timing (client-side only, no network request).
		await expectTopTabActive(page, 'Tasks');
	});

	// ── Pinned items ──────────────────────────────────────────────────────

	test('Pinned items: Overview button is visible', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		// Scope to the sidebar panel (.w-70) to avoid matching the top tab bar button
		const sidebar = page.locator('.w-70');
		const overviewBtn = sidebar.locator('button').filter({ hasText: 'Overview' });
		await expect(overviewBtn).toBeVisible({ timeout: 5000 });
	});

	test('Pinned items: Coordinator button is visible', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		// Scope to the sidebar panel (.w-70) to avoid matching the top tab bar button
		const sidebar = page.locator('.w-70');
		const coordinatorBtn = sidebar.locator('button').filter({ hasText: 'Coordinator' });
		await expect(coordinatorBtn).toBeVisible({ timeout: 5000 });
	});

	test('Pinned items: Coordinator button navigates to Coordinator tab', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		// Click Coordinator in the sidebar — triggers navigateToRoomAgent which
		// changes the URL and sets currentRoomAgentActiveSignal → active tab = 'chat'
		const sidebar = page.locator('.w-70');
		const coordinatorBtn = sidebar.locator('button').filter({ hasText: 'Coordinator' });
		await coordinatorBtn.click();

		// The Coordinator tab should become active in the top tab bar
		await expectTopTabActive(page, 'Coordinator');
	});

	// ── Missions section ──────────────────────────────────────────────────

	test('Missions section: shows active goals as navigation items', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const missionsSection = getSidebarSection(page, 'Missions');

		// Wait for goals to load (fetchGoals is called asynchronously on room init)
		await expect(missionsSection.getByText('Ship Auth Feature')).toBeVisible({ timeout: 15000 });

		// Both goals should be visible in the sidebar
		await expect(missionsSection.getByText('Fix CI Pipeline')).toBeVisible({ timeout: 5000 });
	});

	test('Missions section: header shows correct active goal count', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const missionsSection = getSidebarSection(page, 'Missions');

		// Wait for goals to load
		await expect(missionsSection.getByText('Ship Auth Feature')).toBeVisible({ timeout: 15000 });

		// We created 2 active goals: "Ship Auth Feature" and "Fix CI Pipeline"
		// The count badge in CollapsibleSection renders as "(2)"
		await expect(missionsSection.getByText('(2)')).toBeVisible({ timeout: 5000 });
	});

	test('Missions section: clicking a goal navigates to Missions tab', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const missionsSection = getSidebarSection(page, 'Missions');
		await expect(missionsSection.getByText('Ship Auth Feature')).toBeVisible({ timeout: 15000 });

		// Click a goal in the sidebar
		await missionsSection.locator('button').filter({ hasText: 'Ship Auth Feature' }).click();

		// The Missions tab should become active in the top tab bar
		await expectTopTabActive(page, 'Missions');
	});

	test('Missions section: expand and collapse', async ({ page }) => {
		await navigateToRoomAndWaitForSidebar(page, setup.roomId);

		const missionsToggle = page.locator('button[aria-label="Missions section"]');
		await expect(missionsToggle).toBeVisible({ timeout: 10000 });

		// Missions section is expanded by default
		await expect(missionsToggle).toHaveAttribute('aria-expanded', 'true');

		// Goal items should be visible when expanded
		const missionsSection = getSidebarSection(page, 'Missions');
		await expect(missionsSection.getByText('Ship Auth Feature')).toBeVisible({ timeout: 15000 });

		// Click to collapse
		await missionsToggle.click();
		await expect(missionsToggle).toHaveAttribute('aria-expanded', 'false');

		// Goal items should no longer be visible when collapsed
		await expect(missionsSection.getByText('Ship Auth Feature')).not.toBeVisible();

		// Click to expand again
		await missionsToggle.click();
		await expect(missionsToggle).toHaveAttribute('aria-expanded', 'true');
		await expect(missionsSection.getByText('Ship Auth Feature')).toBeVisible({ timeout: 5000 });
	});

	// ── Sessions: collapsible ─────────────────────────────────────────────

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

		// Click [+] to create a session (UI action — no RPC)
		await page.locator('button[aria-label="Create session"]').click();

		// The page should navigate to the new session URL (/room/{id}/session/{id})
		await page.waitForURL(/\/session\//, { timeout: 10000 });

		// The main content should show the new session chat interface (empty state)
		await expect(page.getByText('No messages yet', { exact: true })).toBeVisible({
			timeout: 10000,
		});
	});
});
