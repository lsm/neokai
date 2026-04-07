/**
 * Room LiveQuery Subscription E2E Tests
 *
 * Verifies that room LiveQuery subscriptions (tasks, goals, skills) work
 * correctly after the subscribeRoom refactor into per-query methods.
 *
 * Tests:
 * - Tasks load and display when viewing a room's Tasks tab
 * - Goals load and display when viewing the Missions tab
 * - Subscriptions survive a WebSocket reconnect — data is still visible after
 *   disconnecting and reconnecting
 *
 * Setup: RPC to create room, task, and goal (infrastructure).
 * Test actions and assertions: all through visible UI.
 * Teardown: RPC room delete.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import {
	createRoom,
	createTask,
	createGoal,
	deleteRoom,
	openMissionsTab,
} from '../helpers/room-helpers';
import {
	closeWebSocket,
	restoreWebSocket,
	waitForOfflineStatus,
	waitForOnlineStatus,
} from '../helpers/connection-helpers';

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Room LiveQuery — Tasks Tab', () => {
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

	test('displays tasks in the Tasks tab after room navigation', async ({ page }) => {
		// Setup: create room with a task via RPC
		roomId = await createRoom(page, 'E2E Tasks LiveQuery Room');
		await createTask(page, roomId, 'E2E Task Alpha', 'First test task');
		await createTask(page, roomId, 'E2E Task Beta', 'Second test task');

		// Navigate to the room
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Click the Tasks tab
		const tasksTab = page.getByRole('button', { name: 'Tasks' });
		await tasksTab.click();
		await expect(tasksTab).toHaveClass(/border-blue-400/);

		// Verify both tasks are visible
		await expect(page.locator('h4:has-text("E2E Task Alpha")')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('h4:has-text("E2E Task Beta")')).toBeVisible({ timeout: 5000 });
	});
});

test.describe('Room LiveQuery — Missions Tab', () => {
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

	test('displays goals in the Missions tab after room navigation', async ({ page }) => {
		// Setup: create room with a goal via RPC
		roomId = await createRoom(page, 'E2E Goals LiveQuery Room');
		await createGoal(page, roomId, 'E2E Mission Gamma', 'A test mission');

		// Navigate to the room
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Click the Missions tab
		await openMissionsTab(page);

		// Verify the mission is visible (rendered as <button> when onGoalClick is provided)
		await expect(page.getByRole('button', { name: 'E2E Mission Gamma' }).first()).toBeVisible({
			timeout: 10000,
		});
	});
});

test.describe('Room LiveQuery — WebSocket Reconnect Resilience', () => {
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

	test('tasks remain visible after WebSocket disconnect and reconnect', async ({ page }) => {
		// Setup: create room with tasks
		roomId = await createRoom(page, 'E2E Reconnect Tasks Room');
		await createTask(page, roomId, 'Reconnect Task One', 'Survives reconnect');
		await createTask(page, roomId, 'Reconnect Task Two', 'Also survives');

		// Navigate to room and open Tasks tab
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		const tasksTab = page.getByRole('button', { name: 'Tasks' });
		await tasksTab.click();
		await expect(tasksTab).toHaveClass(/border-blue-400/);

		// Verify tasks are loaded before disconnect
		await expect(page.locator('h4:has-text("Reconnect Task One")')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('h4:has-text("Reconnect Task Two")')).toBeVisible({ timeout: 5000 });

		// Disconnect WebSocket
		await closeWebSocket(page);
		await waitForOfflineStatus(page);

		// Reconnect WebSocket
		await restoreWebSocket(page);
		await waitForOnlineStatus(page);

		// Verify tasks are still visible after reconnect (LiveQuery re-subscribed)
		await expect(page.locator('h4:has-text("Reconnect Task One")')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('h4:has-text("Reconnect Task Two")')).toBeVisible({ timeout: 5000 });
	});

	test('goals remain visible after WebSocket disconnect and reconnect', async ({ page }) => {
		// Setup: create room with a goal
		roomId = await createRoom(page, 'E2E Reconnect Goals Room');
		await createGoal(page, roomId, 'Reconnect Mission', 'Survives reconnect');

		// Navigate to room and open Missions tab
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		await openMissionsTab(page);

		// Verify goal is loaded before disconnect
		await expect(page.getByRole('button', { name: 'Reconnect Mission' }).first()).toBeVisible({
			timeout: 10000,
		});

		// Disconnect WebSocket
		await closeWebSocket(page);
		await waitForOfflineStatus(page);

		// Reconnect WebSocket
		await restoreWebSocket(page);
		await waitForOnlineStatus(page);

		// Verify goal is still visible after reconnect (LiveQuery re-subscribed)
		await expect(page.getByRole('button', { name: 'Reconnect Mission' }).first()).toBeVisible({
			timeout: 10000,
		});
	});
});
