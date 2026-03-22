/**
 * LiveQuery Task/Goal Updates E2E Tests
 *
 * Verifies that the LiveQuery system delivers real-time updates for tasks and
 * goals to the browser UI without requiring a page reload:
 *
 * 1. Task created by RPC appears in the room UI immediately (LiveQuery delta)
 * 2. Switching rooms shows only the new room's tasks within one render cycle
 *    (stale-event guard ensures no cross-room task bleed)
 * 3. Goal deleted via RPC disappears from the Goals tab UI (LiveQuery removed)
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
	await waitForWebSocketConnected(page);
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
	await waitForWebSocketConnected(page);
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

	test('task created via RPC appears in task list without page reload', async ({ page }) => {
		roomId = await createRoom(page, 'LiveQuery Task Appear Test Room');

		// Navigate to the room dashboard and wait for it to fully load
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await expect(page.locator('text=LiveQuery Task Appear Test Room').first()).toBeVisible({
			timeout: 10000,
		});

		// When a room has no tasks, RoomTasks renders "No tasks yet" (not a tab bar)
		await expect(page.locator('text=No tasks yet')).toBeVisible({ timeout: 5000 });

		// Create a task via RPC while the user is looking at the room dashboard
		await createTask(page, roomId, 'LiveQuery Created Task');

		// The task should appear WITHOUT a page reload — LiveQuery delta delivers it
		await expect(page.locator('text=LiveQuery Created Task').first()).toBeVisible({
			timeout: 10000,
		});

		// The "No tasks yet" placeholder should be gone
		await expect(page.locator('text=No tasks yet')).not.toBeVisible({ timeout: 5000 });
	});

	test('multiple tasks created via RPC all appear in task list', async ({ page }) => {
		roomId = await createRoom(page, 'LiveQuery Multi-Task Test Room');

		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await expect(page.locator('text=LiveQuery Multi-Task Test Room').first()).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('text=No tasks yet')).toBeVisible({ timeout: 5000 });

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

	test('switching from room A to room B via rooms list shows only room B tasks', async ({
		page,
	}) => {
		// Set up room A with a task
		roomAId = await createRoom(page, 'LQ Switch Room A');
		await createTask(page, roomAId, 'Room A Exclusive Task');

		// Set up room B with a different task
		roomBId = await createRoom(page, 'LQ Switch Room B');
		await createTask(page, roomBId, 'Room B Exclusive Task');

		// Navigate to Room A and confirm its task is visible
		await page.goto(`/room/${roomAId}`);
		await waitForWebSocketConnected(page);
		await expect(page.locator('text=LQ Switch Room A').first()).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=Room A Exclusive Task').first()).toBeVisible({
			timeout: 10000,
		});

		// Navigate back to the Rooms list via the NavRail (in-page, no full reload).
		// While viewing a room detail page, the sidebar shows RoomContextPanel — not RoomList.
		// Clicking the "Rooms" NavRail button resets isRoomDetail and shows the rooms list.
		await page.getByRole('button', { name: 'Rooms' }).click();

		// RoomList is now visible — click Room B to switch to it (client-side navigation)
		await page.locator('button').filter({ hasText: 'LQ Switch Room B' }).first().click();

		// Wait for Room B's heading to appear — confirms the room switch has rendered
		await expect(page.locator('text=LQ Switch Room B').first()).toBeVisible({ timeout: 10000 });

		// Room B's task must appear
		await expect(page.locator('text=Room B Exclusive Task').first()).toBeVisible({
			timeout: 10000,
		});

		// Room A's task must NOT appear — stale-event guard prevents cross-room bleed
		await expect(page.locator('text=Room A Exclusive Task')).not.toBeVisible({ timeout: 3000 });
	});

	test('tasks created in room A do not bleed through while viewing room B', async ({ page }) => {
		roomAId = await createRoom(page, 'LQ Isolation Room A');
		roomBId = await createRoom(page, 'LQ Isolation Room B');

		// Navigate to Room B — empty, should show "No tasks yet"
		await page.goto(`/room/${roomBId}`);
		await waitForWebSocketConnected(page);
		await expect(page.locator('text=LQ Isolation Room B').first()).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('text=No tasks yet')).toBeVisible({ timeout: 5000 });

		// Create a task in Room A while the user is viewing Room B
		await createTask(page, roomAId, 'Cross-Room Bleed Task');

		// For negative assertions (proving something does NOT appear), a brief explicit
		// wait is the correct pattern: it gives any potential cross-room delta time to
		// propagate over WebSocket before we assert it is absent.
		await page.waitForTimeout(1500);

		// Room B should still show "No tasks yet" — the stale-event guard stopped bleed
		await expect(page.locator('text=No tasks yet')).toBeVisible();
		await expect(page.locator('text=Cross-Room Bleed Task')).not.toBeVisible();
	});
});

test.describe('LiveQuery — goal deletion surfaces in Goals tab via removed delta', () => {
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

	test('goal deleted via RPC disappears from Goals tab without page reload', async ({ page }) => {
		roomId = await createRoom(page, 'LiveQuery Goal Deletion Test Room');
		const goalId = await createGoal(page, roomId, 'Mission To Delete');

		// Navigate to the room and open the Goals tab
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await expect(page.locator('text=LiveQuery Goal Deletion Test Room').first()).toBeVisible({
			timeout: 10000,
		});

		const goalsTab = page.locator('button:has-text("Goals")');
		await expect(goalsTab).toBeVisible({ timeout: 10000 });
		await goalsTab.click();

		// The goal must be visible
		await expect(page.locator('text=Mission To Delete').first()).toBeVisible({ timeout: 10000 });

		// Delete the goal via RPC while the Goals tab is open
		await deleteGoal(page, roomId, goalId);

		// The goal must disappear from the UI WITHOUT a page reload
		await expect(page.locator('text=Mission To Delete')).not.toBeVisible({ timeout: 10000 });
	});

	test('remaining goals stay visible after one goal is deleted', async ({ page }) => {
		roomId = await createRoom(page, 'LiveQuery Partial Goal Delete Room');
		const goalToDeleteId = await createGoal(page, roomId, 'Goal That Will Be Deleted');
		await createGoal(page, roomId, 'Goal That Should Remain');

		// Navigate to the room and open the Goals tab
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await expect(page.locator('text=LiveQuery Partial Goal Delete Room').first()).toBeVisible({
			timeout: 10000,
		});

		const goalsTab = page.locator('button:has-text("Goals")');
		await expect(goalsTab).toBeVisible({ timeout: 10000 });
		await goalsTab.click();

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
