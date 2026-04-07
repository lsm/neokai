/**
 * MissionDetail Page E2E Tests
 *
 * Tests the dedicated MissionDetail page at `/room/:roomId/mission/:goalId`.
 * This is distinct from the GoalsEditor accordion-style inline expanded view
 * tested in mission-detail.e2e.ts.
 *
 * Covers:
 * - Navigation from Missions tab → MissionDetail page (URL + render)
 * - Description section (with and without description)
 * - Progress section for one-shot missions
 * - Metrics section for measurable missions
 * - Linked Tasks section (cards, empty state, Link Task input)
 * - Schedule section for recurring missions
 * - Execution History section for recurring missions
 * - Back navigation returns to Missions tab
 *
 * Setup: rooms and goals created via RPC (infrastructure only).
 * All test actions and assertions go through the visible browser UI.
 * Cleanup: delete rooms via RPC in afterEach.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { createRoom, deleteRoom, createTask, openMissionsTab } from '../helpers/room-helpers';

// ─── RPC Setup Helpers ─────────────────────────────────────────────────────────

/**
 * Create a one-shot goal via RPC with optional description.
 * Returns { goalId, shortId }.
 */
async function createOneShotGoal(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	title: string,
	description = ''
): Promise<{ goalId: string; shortId: string }> {
	await waitForWebSocketConnected(page);
	return page.evaluate(
		async ({ rId, t, d }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('goal.create', {
				roomId: rId,
				title: t,
				description: d,
				priority: 'normal',
				missionType: 'one_shot',
			});
			const goal = (res as { goal: { id: string; shortId?: string } }).goal;
			return { goalId: goal.id, shortId: goal.shortId ?? '' };
		},
		{ rId: roomId, t: title, d: description }
	);
}

/**
 * Create a measurable goal with one metric via RPC.
 * Returns { goalId }.
 */
async function createMeasurableGoal(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	title: string
): Promise<{ goalId: string }> {
	await waitForWebSocketConnected(page);
	return page.evaluate(
		async ({ rId, t }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('goal.create', {
				roomId: rId,
				title: t,
				description: 'A measurable mission',
				priority: 'normal',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'Coverage', target: 80, current: 0, unit: '%' }],
			});
			const goal = (res as { goal: { id: string } }).goal;
			return { goalId: goal.id };
		},
		{ rId: roomId, t: title }
	);
}

/**
 * Create a measurable goal with no metrics via RPC.
 * Returns { goalId }.
 */
async function createMeasurableGoalNoMetrics(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	title: string
): Promise<{ goalId: string }> {
	await waitForWebSocketConnected(page);
	return page.evaluate(
		async ({ rId, t }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('goal.create', {
				roomId: rId,
				title: t,
				description: '',
				priority: 'normal',
				missionType: 'measurable',
				structuredMetrics: [],
			});
			const goal = (res as { goal: { id: string } }).goal;
			return { goalId: goal.id };
		},
		{ rId: roomId, t: title }
	);
}

/**
 * Create a recurring goal with daily schedule via RPC.
 * Returns { goalId }.
 */
async function createRecurringGoal(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	title: string
): Promise<{ goalId: string }> {
	await waitForWebSocketConnected(page);
	return page.evaluate(
		async ({ rId, t }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('goal.create', {
				roomId: rId,
				title: t,
				description: 'A recurring mission',
				priority: 'normal',
				missionType: 'recurring',
				schedule: { expression: '@daily', timezone: 'UTC' },
			});
			const goal = (res as { goal: { id: string } }).goal;
			return { goalId: goal.id };
		},
		{ rId: roomId, t: title }
	);
}

/**
 * Link a task to a goal via RPC.
 * For use in beforeEach setup only.
 */
async function linkTaskToGoal(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	goalId: string,
	taskId: string
): Promise<void> {
	await waitForWebSocketConnected(page);
	await page.evaluate(
		async ({ rId, gId, tId }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			await hub.request('goal.linkTask', { roomId: rId, goalId: gId, taskId: tId });
		},
		{ rId: roomId, gId: goalId, tId: taskId }
	);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test.describe('MissionDetail Page — Navigation', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'E2E MissionDetail Navigation Room');
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('direct URL navigation renders MissionDetail', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'Direct Nav Mission');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('[data-testid="mission-detail-title"]')).toContainText(
			'Direct Nav Mission',
			{ timeout: 5000 }
		);
	});

	test('clicking goal title in Missions tab navigates to MissionDetail page', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'Click Nav Mission');

		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);

		// Find the goal card header containing the mission title
		const goalHeader = page
			.locator(`[data-testid="goal-item-header"]:has-text("Click Nav Mission")`)
			.first();
		await expect(goalHeader).toBeVisible({ timeout: 5000 });

		// After Task 6, clicking the title button (not h4 — it's now a <button>) navigates to detail.
		// The title button has stopPropagation so it navigates without expanding the accordion.
		const goalTitle = goalHeader.getByRole('button', { name: 'Click Nav Mission' });
		await goalTitle.click();

		// MissionDetail should render
		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 8000 });

		// URL should contain the mission route
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/mission/${goalId}`), {
			timeout: 5000,
		});
	});

	test('browser back from mission detail returns to Missions tab', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'Browser Back Mission');

		// Navigate to the room first to establish a history entry
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);

		// Navigate to mission detail via in-app click (creates a pushState history entry)
		const goalTitle = page
			.locator(`[data-testid="goal-item-header"]:has-text("Browser Back Mission")`)
			.first()
			.getByRole('button', { name: 'Browser Back Mission' });
		await expect(goalTitle).toBeVisible({ timeout: 5000 });
		await goalTitle.click();

		// Verify mission detail is showing
		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 8000 });
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/mission/${goalId}`), {
			timeout: 5000,
		});

		// Use browser back button to return
		await page.goBack();

		// Mission detail should be gone and we should be back at the room page
		await expect(page.locator('[data-testid="mission-detail"]')).not.toBeVisible({
			timeout: 8000,
		});
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}`), { timeout: 5000 });
	});

	test('back button returns to Missions tab', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'Back Button Mission');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 10000 });

		// Click back button
		await page.locator('[data-testid="mission-detail-back-button"]').click();

		// MissionDetail should be gone; Missions tab heading should show
		await expect(page.locator('[data-testid="mission-detail"]')).not.toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('h2:has-text("Missions")')).toBeVisible({ timeout: 5000 });
	});

	test('"Mission not found" shown for unknown goalId', async ({ page }) => {
		await page.goto(`/room/${roomId}/mission/nonexistent-goal-id`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-not-found"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('text=Mission not found')).toBeVisible({ timeout: 5000 });
	});

	test('mission detail overlay renders over tab content — tab navigation remains accessible', async ({
		page,
	}) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'Overlay Test Mission');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		// MissionDetail should be visible as an absolute overlay inside the tab content area
		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 10000 });

		// The back button at the top of the overlay should be interactive
		await expect(page.locator('[data-testid="mission-detail-back-button"]')).toBeVisible({
			timeout: 5000,
		});

		// The mission title in the overlay header should be visible
		await expect(page.locator('[data-testid="mission-detail-title"]')).toContainText(
			'Overlay Test Mission',
			{ timeout: 5000 }
		);

		// The desktop tab bar (Missions, Tasks, etc.) lives OUTSIDE the overlay's parent,
		// so it remains accessible even when the overlay is shown.
		// This confirms the overlay is scoped to the tab content area (absolute inset-0 within
		// the relative content div) and does not cover the room's tab navigation bar.
		await expect(page.getByRole('button', { name: 'Missions' })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('button', { name: 'Tasks' })).toBeVisible({ timeout: 5000 });
	});
});

test.describe('MissionDetail Page — Description Section', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'E2E MissionDetail Description Room');
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('shows goal description when set', async ({ page }) => {
		const { goalId } = await createOneShotGoal(
			page,
			roomId,
			'Described Mission',
			'This is the mission description.'
		);

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-description-section"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('[data-testid="mission-description-section"]')).toContainText(
			'This is the mission description.'
		);
	});

	test('shows "No description provided" empty state when no description', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'No Description Mission', '');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-description-section"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('[data-testid="mission-description-section"]')).toContainText(
			'No description provided'
		);
	});
});

test.describe('MissionDetail Page — Progress Section (one-shot)', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'E2E MissionDetail Progress Room');
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('shows progress section for one-shot missions', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'One Shot Progress Mission');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-progress-section"]')).toBeVisible({
			timeout: 10000,
		});
	});

	test('does not show metrics section for one-shot missions', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'No Metrics One Shot');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		// Wait for detail to load first
		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 10000 });
		await page.waitForTimeout(1000);

		await expect(page.locator('[data-testid="mission-metrics-section"]')).not.toBeVisible();
	});
});

test.describe('MissionDetail Page — Metrics Section (measurable)', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'E2E MissionDetail Metrics Room');
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('shows metrics section for measurable missions with metrics', async ({ page }) => {
		const { goalId } = await createMeasurableGoal(page, roomId, 'Measurable Metrics Mission');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-metrics-section"]')).toBeVisible({
			timeout: 10000,
		});
		// Should show the metric name
		await expect(page.locator('[data-testid="mission-metrics-section"]')).toContainText('Coverage');
	});

	test('shows "No metrics configured" empty state for measurable with no metrics', async ({
		page,
	}) => {
		const { goalId } = await createMeasurableGoalNoMetrics(
			page,
			roomId,
			'No Metrics Measurable Mission'
		);

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-metrics-section"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('[data-testid="mission-metrics-section"]')).toContainText(
			'No metrics configured'
		);
	});

	test('does not show progress section for measurable missions', async ({ page }) => {
		const { goalId } = await createMeasurableGoal(page, roomId, 'Measurable No Progress');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		// Wait for detail to load first
		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 10000 });
		await page.waitForTimeout(1000);

		await expect(page.locator('[data-testid="mission-progress-section"]')).not.toBeVisible();
	});
});

test.describe('MissionDetail Page — Linked Tasks Section', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'E2E MissionDetail Tasks Room');
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('shows "No tasks linked" empty state when no tasks linked', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'No Tasks Mission');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-linked-tasks-section"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('[data-testid="mission-linked-tasks-section"]')).toContainText(
			'No tasks linked'
		);
	});

	test('shows task cards when tasks are linked', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'Linked Tasks Mission');
		const taskId = await createTask(page, roomId, 'My E2E Task', 'task for mission');
		await linkTaskToGoal(page, roomId, goalId, taskId);

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-linked-tasks-section"]')).toBeVisible({
			timeout: 10000,
		});
		// Task card should be visible
		await expect(page.locator('[data-testid="linked-tasks-list"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator(`[data-testid="linked-task-${taskId}"]`)).toBeVisible({
			timeout: 5000,
		});
		// Task title should appear in the card
		await expect(page.locator(`[data-testid="linked-task-${taskId}"]`)).toContainText(
			'My E2E Task'
		);
	});

	test('shows Link Task input in linked tasks section', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'Link Task Input Mission');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-linked-tasks-section"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('[data-testid="link-task-input"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="link-task-button"]')).toBeVisible({ timeout: 5000 });
	});

	test('clicking linked task card navigates to task detail', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'Task Nav Mission');
		const taskId = await createTask(page, roomId, 'Navigate To Task', '');
		await linkTaskToGoal(page, roomId, goalId, taskId);

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator(`[data-testid="linked-task-${taskId}"]`)).toBeVisible({
			timeout: 10000,
		});
		await page.locator(`[data-testid="linked-task-${taskId}"]`).click();

		// Should navigate to the task detail URL
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/task/${taskId}`), { timeout: 8000 });
	});

	test('browser back from task detail (via mission detail) returns to mission detail', async ({
		page,
	}) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'Task Back To Mission');
		const taskId = await createTask(page, roomId, 'Back Link Task', '');
		await linkTaskToGoal(page, roomId, goalId, taskId);

		// Navigate to mission detail (creates a history entry)
		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		// Click linked task to navigate to task detail (creates another history entry)
		await expect(page.locator(`[data-testid="linked-task-${taskId}"]`)).toBeVisible({
			timeout: 10000,
		});
		await page.locator(`[data-testid="linked-task-${taskId}"]`).click();

		// Verify we reached task detail
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/task/${taskId}`), { timeout: 8000 });

		// Go back in browser history
		await page.goBack();

		// Should return to mission detail
		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 8000 });
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/mission/${goalId}`), {
			timeout: 5000,
		});
	});
});

test.describe('MissionDetail Page — Schedule & Execution History (recurring)', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'E2E MissionDetail Recurring Room');
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('shows schedule section for recurring missions', async ({ page }) => {
		const { goalId } = await createRecurringGoal(page, roomId, 'Recurring Schedule Mission');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-schedule-section"]')).toBeVisible({
			timeout: 10000,
		});
		// Schedule expression should show
		await expect(page.locator('[data-testid="mission-schedule-section"]')).toContainText('@daily');
	});

	test('shows execution history section for recurring missions', async ({ page }) => {
		const { goalId } = await createRecurringGoal(page, roomId, 'Recurring History Mission');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-execution-history-section"]')).toBeVisible({
			timeout: 10000,
		});
	});

	test('shows "No executions yet" for fresh recurring mission', async ({ page }) => {
		const { goalId } = await createRecurringGoal(page, roomId, 'Fresh Recurring');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('[data-testid="mission-execution-history-section"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('[data-testid="no-executions-message"]')).toBeVisible({
			timeout: 8000,
		});
	});

	test('does not show schedule section for one-shot missions', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'One Shot No Schedule');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		// Wait for detail to load first
		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 10000 });
		await page.waitForTimeout(1000);

		await expect(page.locator('[data-testid="mission-schedule-section"]')).not.toBeVisible();
	});

	test('does not show execution history section for one-shot missions', async ({ page }) => {
		const { goalId } = await createOneShotGoal(page, roomId, 'One Shot No History');

		await page.goto(`/room/${roomId}/mission/${goalId}`);
		await waitForWebSocketConnected(page);

		// Wait for detail to load first
		await expect(page.locator('[data-testid="mission-detail"]')).toBeVisible({ timeout: 10000 });
		await page.waitForTimeout(1000);

		await expect(
			page.locator('[data-testid="mission-execution-history-section"]')
		).not.toBeVisible();
	});
});
