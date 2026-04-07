/**
 * Room LiveQuery Subscription E2E Tests
 *
 * Verifies that room LiveQuery subscriptions (tasks, goals, skills) work
 * correctly after the subscribeRoom refactor into per-query methods.
 *
 * Tests:
 * - Tasks load and display when viewing a room's Tasks tab
 * - Goals load and display when viewing the Missions tab
 * - Re-subscription after WebSocket reconnect delivers fresh snapshots
 *   (new entities created during disconnect appear after reconnect)
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

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function setupPage(page: import('@playwright/test').Page): Promise<void> {
	await page.goto('/');
	// Defensive: each test gets a fresh browser context (empty localStorage),
	// so this removeItem is a no-op in normal conditions. It guards against
	// future test-ordering issues if context isolation ever changes.
	await page.evaluate(() => localStorage.removeItem('neokai:room:taskFilterTab'));
	await page.getByRole('button', { name: 'New Session', exact: true }).waitFor({ timeout: 10000 });
}

/**
 * Create an entity via a raw WebSocket RPC — for use when the main
 * ConnectionManager's WebSocket is disconnected.
 *
 * Opens an independent WebSocket to the server, sends the given RPC,
 * and returns the entity ID extracted from the response.
 */
async function createEntityViaRawWs(
	page: import('@playwright/test').Page,
	method: string,
	data: Record<string, unknown>,
	responseKey: string
): Promise<string> {
	return page.evaluate(
		async ({ m, d, k }) => {
			const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
			const wsUrl = `${protocol}//${window.location.host}/ws`;
			const requestId = crypto.randomUUID();

			return new Promise<string>((resolve, reject) => {
				const ws = new WebSocket(wsUrl);
				const timeout = setTimeout(() => {
					ws.close();
					reject(new Error('Raw WS RPC timed out'));
				}, 10000);

				ws.addEventListener('message', (event) => {
					const msg = JSON.parse(event.data);
					if (msg.type === 'RSP' && msg.requestId === requestId) {
						clearTimeout(timeout);
						ws.close();
						if (msg.error) reject(new Error(msg.error));
						else resolve((msg.data as Record<string, { id: string }>)[k].id);
					}
				});

				ws.addEventListener('open', () => {
					ws.send(
						JSON.stringify({
							id: requestId,
							type: 'REQ',
							sessionId: 'global',
							method: m,
							data: d,
							timestamp: new Date().toISOString(),
							version: '1.0.0',
						})
					);
				});

				ws.addEventListener('error', () => {
					clearTimeout(timeout);
					reject(new Error('Raw WS connection failed'));
				});
			});
		},
		{ m: method, d: data, k: responseKey }
	);
}

async function createTaskViaRawWs(
	page: import('@playwright/test').Page,
	roomId: string,
	title: string,
	description = ''
): Promise<string> {
	return createEntityViaRawWs(
		page,
		'task.create',
		{ roomId, title, description, status: 'draft' },
		'task'
	);
}

async function createGoalViaRawWs(
	page: import('@playwright/test').Page,
	roomId: string,
	title: string,
	description = ''
): Promise<string> {
	return createEntityViaRawWs(
		page,
		'goal.create',
		{ roomId, title, description, priority: 'normal' },
		'goal'
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Room LiveQuery — Tasks Tab', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await setupPage(page);
		roomId = '';
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
	});

	test('displays tasks in the Tasks tab after room navigation', async ({ page }) => {
		// Setup: create room with tasks via RPC
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
		await setupPage(page);
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
		await setupPage(page);
		roomId = '';
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
	});

	test('re-subscribes to tasks after WebSocket disconnect and reconnect', async ({ page }) => {
		// Setup: create room with an initial task
		roomId = await createRoom(page, 'E2E Reconnect Tasks Room');
		await createTask(page, roomId, 'Reconnect Task One', 'Survives reconnect');

		// Navigate to room and open Tasks tab
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		const tasksTab = page.getByRole('button', { name: 'Tasks' });
		await tasksTab.click();
		await expect(tasksTab).toHaveClass(/border-blue-400/);

		// Verify initial task is loaded
		await expect(page.locator('h4:has-text("Reconnect Task One")')).toBeVisible({ timeout: 10000 });

		// Disconnect WebSocket
		await closeWebSocket(page);
		await waitForOfflineStatus(page);

		// Create a new task via raw WebSocket while disconnected (infrastructure).
		// This task was never seen before disconnect, so it can only appear
		// after reconnect if the LiveQuery re-subscribed and received a fresh snapshot.
		await createTaskViaRawWs(page, roomId, 'Reconnect Task New', 'Created during disconnect');

		// Reconnect WebSocket
		await restoreWebSocket(page);
		await waitForOnlineStatus(page);

		// The new task must appear — proving re-subscription delivered a fresh snapshot
		await expect(page.locator('h4:has-text("Reconnect Task New")')).toBeVisible({ timeout: 10000 });
	});

	test('re-subscribes to goals after WebSocket disconnect and reconnect', async ({ page }) => {
		// Setup: create room with an initial goal
		roomId = await createRoom(page, 'E2E Reconnect Goals Room');
		await createGoal(page, roomId, 'Reconnect Mission', 'Survives reconnect');

		// Navigate to room and open Missions tab
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		await openMissionsTab(page);

		// Verify initial goal is loaded
		await expect(page.getByRole('button', { name: 'Reconnect Mission' }).first()).toBeVisible({
			timeout: 10000,
		});

		// Disconnect WebSocket
		await closeWebSocket(page);
		await waitForOfflineStatus(page);

		// Create a new goal via raw WebSocket while disconnected (infrastructure).
		// This goal was never seen before disconnect, so it can only appear
		// after reconnect if the LiveQuery re-subscribed and received a fresh snapshot.
		await createGoalViaRawWs(page, roomId, 'Reconnect Goal New', 'Created during disconnect');

		// Reconnect WebSocket
		await restoreWebSocket(page);
		await waitForOnlineStatus(page);

		// The new goal must appear — proving re-subscription delivered a fresh snapshot
		await expect(page.getByRole('button', { name: 'Reconnect Goal New' }).first()).toBeVisible({
			timeout: 10000,
		});
	});
});
