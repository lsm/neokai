/**
 * Task Goal Indicator E2E Tests
 *
 * Tests that tasks linked to a goal show the goal name badge:
 * - Goal badge appears in task list (RoomDashboard) when task is linked to a goal
 * - Goal badge appears in TaskView header when task is linked to a goal
 * - Clicking goal badge in task list switches to Missions tab
 * - Clicking goal badge in TaskView navigates back to room and switches to Missions tab
 * - Tasks without a goal do NOT show the badge
 *
 * Setup: RPC to create room, task, and goal and link them together (infrastructure).
 * Test actions and assertions: all through visible UI.
 * Teardown: RPC room delete.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

// ─── RPC Setup Helpers ────────────────────────────────────────────────────────

async function createRoomWithLinkedGoalAndTask(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<{ roomId: string; taskId: string; goalId: string }> {
	await waitForWebSocketConnected(page);

	return page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		// Create room
		const roomRes = await hub.request('room.create', {
			name: 'E2E Goal Indicator Test Room',
		});
		const roomId = (roomRes as { room: { id: string } }).room.id;

		// Create task
		const taskRes = await hub.request('task.create', {
			roomId,
			title: 'Goal-Linked Task',
			description: 'A task linked to a mission',
		});
		const taskId = (taskRes as { task: { id: string } }).task.id;

		// Create goal (mission)
		const goalRes = await hub.request('goal.create', {
			roomId,
			title: 'My Test Mission',
			description: 'A mission for testing goal indicators',
			priority: 'normal',
		});
		const goalId = (goalRes as { goal: { id: string } }).goal.id;

		// Link task to goal
		await hub.request('goal.linkTask', { roomId, goalId, taskId });

		return { roomId, taskId, goalId };
	});
}

async function createRoomWithUnlinkedTask(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<{ roomId: string; taskId: string }> {
	await waitForWebSocketConnected(page);

	return page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		const roomRes = await hub.request('room.create', {
			name: 'E2E Goal Indicator Unlinked Test Room',
		});
		const roomId = (roomRes as { room: { id: string } }).room.id;

		const taskRes = await hub.request('task.create', {
			roomId,
			title: 'Unlinked Task',
			description: 'A task with no mission',
		});
		const taskId = (taskRes as { task: { id: string } }).task.id;

		return { roomId, taskId };
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Task Goal Indicator — Task List', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });
		roomId = '';
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
	});

	test('shows goal badge on task linked to a mission', async ({ page }) => {
		const result = await createRoomWithLinkedGoalAndTask(page);
		roomId = result.roomId;

		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Should see the goal badge with mission title
		const badge = page.locator(`[data-testid="task-goal-badge-${result.taskId}"]`);
		await expect(badge).toBeVisible({ timeout: 10000 });
		await expect(badge).toContainText('My Test Mission');
	});

	test('does NOT show goal badge on task with no mission', async ({ page }) => {
		const result = await createRoomWithUnlinkedTask(page);
		roomId = result.roomId;

		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Ensure the task is visible first
		await expect(page.locator('h4:has-text("Unlinked Task")')).toBeVisible({ timeout: 10000 });

		// No goal badge should be present for this task
		const badge = page.locator(`[data-testid="task-goal-badge-${result.taskId}"]`);
		await expect(badge).not.toBeVisible();
	});

	test('clicking goal badge switches to Missions tab', async ({ page }) => {
		const result = await createRoomWithLinkedGoalAndTask(page);
		roomId = result.roomId;

		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Wait for and click the goal badge
		const badge = page.locator(`[data-testid="task-goal-badge-${result.taskId}"]`);
		await expect(badge).toBeVisible({ timeout: 10000 });
		await badge.click();

		// Should now be on the Missions tab
		await expect(page.locator('h2:has-text("Missions")')).toBeVisible({ timeout: 5000 });
	});
});

test.describe('Task Goal Indicator — TaskView', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });
		roomId = '';
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
	});

	test('shows goal badge in TaskView header for linked task', async ({ page }) => {
		const result = await createRoomWithLinkedGoalAndTask(page);
		roomId = result.roomId;

		await page.goto(`/room/${roomId}/task/${result.taskId}`);
		await waitForWebSocketConnected(page);

		// Wait for task to load
		await expect(page.locator('[data-testid="task-status-badge"]')).toBeVisible({
			timeout: 10000,
		});

		// Goal badge should be visible with mission title
		const badge = page.locator('[data-testid="task-view-goal-badge"]');
		await expect(badge).toBeVisible({ timeout: 5000 });
		await expect(badge).toContainText('My Test Mission');
	});

	test('does NOT show goal badge in TaskView for unlinked task', async ({ page }) => {
		const result = await createRoomWithUnlinkedTask(page);
		roomId = result.roomId;

		await page.goto(`/room/${roomId}/task/${result.taskId}`);
		await waitForWebSocketConnected(page);

		// Wait for task to load
		await expect(page.locator('[data-testid="task-status-badge"]')).toBeVisible({
			timeout: 10000,
		});

		// No goal badge should be visible
		const badge = page.locator('[data-testid="task-view-goal-badge"]');
		await expect(badge).not.toBeVisible();
	});

	test('clicking goal badge in TaskView navigates to room Missions tab', async ({ page }) => {
		const result = await createRoomWithLinkedGoalAndTask(page);
		roomId = result.roomId;

		await page.goto(`/room/${roomId}/task/${result.taskId}`);
		await waitForWebSocketConnected(page);

		// Wait for task to load and goal badge to appear
		await expect(page.locator('[data-testid="task-status-badge"]')).toBeVisible({
			timeout: 10000,
		});
		const badge = page.locator('[data-testid="task-view-goal-badge"]');
		await expect(badge).toBeVisible({ timeout: 5000 });

		// Click the badge — should navigate back to room and show Missions tab
		await badge.click();

		// Should be back at room overview showing Missions tab
		await expect(page.locator('h2:has-text("Missions")')).toBeVisible({ timeout: 5000 });
	});
});
