/**
 * LiveQuery Task/Goal Updates E2E Tests
 *
 * Verifies that the LiveQuery system delivers real-time updates for tasks and
 * goals to the browser UI without requiring a page reload:
 *
 * 1. Task created by RPC appears in the room UI immediately (LiveQuery delta)
 * 2. Switching rooms shows only the new room's tasks within one render cycle
 *    (stale-event guard ensures no cross-room task bleed)
 * 3. Goal deleted via RPC disappears from the Missions tab UI (LiveQuery removed)
 *
 * Setup: RPC is used only for test infrastructure (room/task/goal creation,
 *        teardown). All assertions are against visible DOM state.
 * Teardown: rooms deleted via RPC in afterEach.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

// ─── Infrastructure Helpers ───────────────────────────────────────────────────

async function createRoom(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	name: string
): Promise<string> {
	await waitForWebSocketConnected(page);
	return page.evaluate(async (roomName) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const res = await hub.request('room.create', { name: roomName });
		return (res as { room: { id: string } }).room.id;
	}, name);
}

async function createTask(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	title: string
): Promise<string> {
	return page.evaluate(
		async ({ rId, t }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('task.create', {
				roomId: rId,
				title: t,
				description: 'LiveQuery E2E test task',
			});
			return (res as { task: { id: string } }).task.id;
		},
		{ rId: roomId, t: title }
	);
}

async function createGoal(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	title: string
): Promise<string> {
	return page.evaluate(
		async ({ rId, t }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('goal.create', {
				roomId: rId,
				title: t,
				description: 'LiveQuery E2E test goal',
				priority: 'normal',
			});
			return (res as { goal: { id: string } }).goal.id;
		},
		{ rId: roomId, t: title }
	);
}

async function deleteGoal(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	goalId: string
): Promise<void> {
	await page.evaluate(
		async ({ rId, gId }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			await hub.request('goal.delete', { roomId: rId, goalId: gId });
		},
		{ rId: roomId, gId: goalId }
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('LiveQuery — task created by RPC appears in room UI without page reload', () => {
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

	test('task created via RPC appears in Active tab without page reload', async ({ page }) => {
		roomId = await createRoom(page, 'LiveQuery Task Appear Test Room');

		// Navigate to the room dashboard and wait for it to load
		await page.goto(`/room/${roomId}`);
		await expect(page.locator('text=LiveQuery Task Appear Test Room').first()).toBeVisible({
			timeout: 10000,
		});

		// Ensure the Active tab is selected and currently shows no tasks
		await page.getByRole('button', { name: /Active/ }).click();
		await expect(page.locator('text=No active tasks')).toBeVisible({ timeout: 5000 });

		// Create a task via RPC while the user is looking at the room dashboard
		await createTask(page, roomId, 'LiveQuery Created Task');

		// The task should appear in the Active tab WITHOUT a page reload
		await expect(page.locator('text=LiveQuery Created Task').first()).toBeVisible({
			timeout: 10000,
		});

		// Active tab count should update to reflect the new task
		await expect(page.getByRole('button', { name: /Active/ })).toContainText('1', {
			timeout: 5000,
		});
	});

	test('multiple tasks created via RPC all appear in Active tab', async ({ page }) => {
		roomId = await createRoom(page, 'LiveQuery Multi-Task Test Room');

		await page.goto(`/room/${roomId}`);
		await expect(page.locator('text=LiveQuery Multi-Task Test Room').first()).toBeVisible({
			timeout: 10000,
		});
		await page.getByRole('button', { name: /Active/ }).click();
		await expect(page.locator('text=No active tasks')).toBeVisible({ timeout: 5000 });

		// Create two tasks back-to-back via RPC
		await createTask(page, roomId, 'First LiveQuery Task');
		await createTask(page, roomId, 'Second LiveQuery Task');

		// Both must appear without a reload
		await expect(page.locator('text=First LiveQuery Task').first()).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('text=Second LiveQuery Task').first()).toBeVisible({
			timeout: 10000,
		});
	});
});

test.describe("LiveQuery — switching rooms shows only the new room's tasks", () => {
	let roomAId = '';
	let roomBId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });
		roomAId = '';
		roomBId = '';
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomAId);
		await deleteRoom(page, roomBId);
	});

	test('navigating from room A to room B shows only room B tasks', async ({ page }) => {
		// Set up room A with a task
		roomAId = await createRoom(page, 'LiveQuery Room A');
		await createTask(page, roomAId, 'Room A Exclusive Task');

		// Set up room B with a different task
		roomBId = await createRoom(page, 'LiveQuery Room B');
		await createTask(page, roomBId, 'Room B Exclusive Task');

		// Navigate to Room A first and confirm its task is visible
		await page.goto(`/room/${roomAId}`);
		await expect(page.locator('text=LiveQuery Room A').first()).toBeVisible({ timeout: 10000 });
		await page.getByRole('button', { name: /Active/ }).click();
		await expect(page.locator('text=Room A Exclusive Task').first()).toBeVisible({
			timeout: 10000,
		});

		// Switch to Room B
		await page.goto(`/room/${roomBId}`);
		await expect(page.locator('text=LiveQuery Room B').first()).toBeVisible({ timeout: 10000 });
		await page.getByRole('button', { name: /Active/ }).click();

		// Room B's task must appear
		await expect(page.locator('text=Room B Exclusive Task').first()).toBeVisible({
			timeout: 10000,
		});

		// Room A's task must NOT appear — stale-event guard prevents cross-room bleed
		await expect(page.locator('text=Room A Exclusive Task')).not.toBeVisible({ timeout: 3000 });
	});

	test('tasks created in room A do not appear while viewing room B', async ({ page }) => {
		roomAId = await createRoom(page, 'LiveQuery Isolation Room A');
		roomBId = await createRoom(page, 'LiveQuery Isolation Room B');

		// Navigate to Room B and wait for it to load (empty)
		await page.goto(`/room/${roomBId}`);
		await expect(page.locator('text=LiveQuery Isolation Room B').first()).toBeVisible({
			timeout: 10000,
		});
		await page.getByRole('button', { name: /Active/ }).click();
		await expect(page.locator('text=No active tasks')).toBeVisible({ timeout: 5000 });

		// Create a task in Room A while the user is viewing Room B
		await createTask(page, roomAId, 'Cross-Room Bleed Task');

		// Wait a moment for any potential bleed-through
		await page.waitForTimeout(2000);

		// Room B should still show no active tasks — the stale-event guard must stop bleed
		await expect(page.locator('text=No active tasks')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Cross-Room Bleed Task')).not.toBeVisible();
	});
});

test.describe('LiveQuery — goal deletion surfaces in Missions tab via removed delta', () => {
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

	test('goal deleted via RPC disappears from Missions tab without page reload', async ({
		page,
	}) => {
		roomId = await createRoom(page, 'LiveQuery Goal Deletion Test Room');
		const goalId = await createGoal(page, roomId, 'Mission To Delete');

		// Navigate to the room and open the Missions tab
		await page.goto(`/room/${roomId}`);
		await expect(page.locator('text=LiveQuery Goal Deletion Test Room').first()).toBeVisible({
			timeout: 10000,
		});

		const missionsTab = page.locator('button:has-text("Missions")');
		await expect(missionsTab).toBeVisible({ timeout: 10000 });
		await missionsTab.click();

		// The mission must be visible
		await expect(page.locator('text=Mission To Delete').first()).toBeVisible({ timeout: 10000 });

		// Delete the goal via RPC while the Missions tab is open
		await deleteGoal(page, roomId, goalId);

		// The goal must disappear from the UI WITHOUT a page reload
		await expect(page.locator('text=Mission To Delete')).not.toBeVisible({ timeout: 10000 });
	});

	test('remaining goals stay visible after one goal is deleted', async ({ page }) => {
		roomId = await createRoom(page, 'LiveQuery Partial Goal Delete Room');
		const goalToDeleteId = await createGoal(page, roomId, 'Goal That Will Be Deleted');
		await createGoal(page, roomId, 'Goal That Should Remain');

		// Navigate to the room and open the Missions tab
		await page.goto(`/room/${roomId}`);
		await expect(page.locator('text=LiveQuery Partial Goal Delete Room').first()).toBeVisible({
			timeout: 10000,
		});

		const missionsTab = page.locator('button:has-text("Missions")');
		await expect(missionsTab).toBeVisible({ timeout: 10000 });
		await missionsTab.click();

		// Both goals must be visible
		await expect(page.locator('text=Goal That Will Be Deleted').first()).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('text=Goal That Should Remain').first()).toBeVisible({
			timeout: 10000,
		});

		// Delete only the first goal via RPC
		await deleteGoal(page, roomId, goalToDeleteId);

		// The deleted goal must disappear
		await expect(page.locator('text=Goal That Will Be Deleted')).not.toBeVisible({
			timeout: 10000,
		});

		// The remaining goal must still be visible
		await expect(page.locator('text=Goal That Should Remain').first()).toBeVisible({
			timeout: 5000,
		});
	});
});
