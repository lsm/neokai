/**
 * Task Message Streaming E2E Tests
 *
 * Verifies that the TaskConversationRenderer correctly displays messages
 * via the LiveQuery subscription without requiring a page refresh.
 *
 * Tests:
 * - Messages from the initial LiveQuery snapshot appear in TaskView
 * - New messages injected after page load appear via LiveQuery delta (no refresh)
 * - Switching between two tasks shows correct messages for each task
 *
 * Setup: Creates rooms and tasks via RPC in beforeEach (infrastructure).
 *        Message injection via task.group.addMessage (admin RPC).
 * Cleanup: Deletes rooms via RPC in afterEach.
 *
 * E2E Rules:
 * - All test actions go through the UI (clicks, navigation)
 * - All assertions check visible DOM state
 * - RPC is used only in beforeEach/afterEach for test infrastructure
 *   Exception: task.group.addMessage is called via page.evaluate() in test body
 *   to simulate agent message delivery (no UI equivalent for injecting agent messages)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── RPC Setup Helpers ─────────────────────────────────────────────────────────

async function createRoomWithTask(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	taskTitle: string
): Promise<{ roomId: string; taskId: string }> {
	await waitForWebSocketConnected(page);

	return page.evaluate(async (title) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		const roomRes = await hub.request('room.create', { name: 'E2E Streaming Test Room' });
		const roomId = (roomRes as { room: { id: string } }).room.id;

		const taskRes = await hub.request('task.create', {
			roomId,
			title,
			description: 'Task for E2E message streaming tests',
		});
		const taskId = (taskRes as { task: { id: string } }).task.id;

		return { roomId, taskId };
	}, taskTitle);
}

async function createGroupForTask(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	taskId: string,
	roomId: string
): Promise<{ groupId: string; workerSessionId: string; leaderSessionId: string }> {
	return page.evaluate(
		async ({ tId, rId }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			const res = await hub.request('task.group.create', { taskId: tId, roomId: rId });
			return res as { groupId: string; workerSessionId: string; leaderSessionId: string };
		},
		{ tId: taskId, rId: roomId }
	);
}

async function injectMessage(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	groupId: string,
	content: string,
	messageType: string = 'status'
): Promise<void> {
	await page.evaluate(
		async ({ gId, c, mt }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			await hub.request('task.group.addMessage', {
				groupId: gId,
				role: mt === 'status' ? 'system' : 'coder',
				messageType: mt,
				content: c,
			});
		},
		{ gId: groupId, c: content, mt: messageType }
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('TaskView — Message Streaming', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let roomId = '';
	let taskId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });
		roomId = '';
		taskId = '';
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
	});

	test('messages pre-loaded in DB appear in TaskView on initial load', async ({ page }) => {
		({ roomId, taskId } = await createRoomWithTask(page, 'E2E Streaming Task 1'));

		// Create group and inject messages BEFORE navigating to the task view
		const { groupId } = await createGroupForTask(page, taskId, roomId);
		await injectMessage(page, groupId, 'Agent started working', 'status');
		await injectMessage(page, groupId, 'Completed first step', 'status');

		// Navigate to the task view — LiveQuery snapshot should deliver the pre-existing messages
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Streaming Task 1')).toBeVisible({ timeout: 10000 });

		// Both status messages should appear via the initial snapshot
		await expect(page.locator('text=Agent started working')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=Completed first step')).toBeVisible({ timeout: 10000 });
	});

	test('new message injected after page load appears via LiveQuery without refresh', async ({
		page,
	}) => {
		({ roomId, taskId } = await createRoomWithTask(page, 'E2E Streaming Task 2'));

		// Create group before navigating
		const { groupId } = await createGroupForTask(page, taskId, roomId);

		// Navigate to the task view
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Streaming Task 2')).toBeVisible({ timeout: 10000 });

		// Wait for the task view conversation area to be rendered
		// (shows "Waiting for agent activity…" when empty)
		await expect(page.locator('text=Waiting for agent activity')).toBeVisible({ timeout: 8000 });

		// Inject a message AFTER the page is loaded — should arrive via LiveQuery delta
		await injectMessage(page, groupId, 'Live streaming message arrived', 'status');

		// The new message should appear in the conversation without a page refresh
		await expect(page.locator('text=Live streaming message arrived')).toBeVisible({
			timeout: 8000,
		});
	});

	test('switching between two tasks shows correct messages for each task', async ({ page }) => {
		({ roomId, taskId } = await createRoomWithTask(page, 'E2E Streaming Task A'));

		// Create a second task in the same room
		const task2Id = await page.evaluate(
			async ({ rId }) => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub?.request) throw new Error('MessageHub not available');

				const taskRes = await hub.request('task.create', {
					roomId: rId,
					title: 'E2E Streaming Task B',
					description: 'Second task for switching test',
				});
				return (taskRes as { task: { id: string } }).task.id;
			},
			{ rId: roomId }
		);

		// Create groups for both tasks and inject distinct messages
		const { groupId: groupId1 } = await createGroupForTask(page, taskId, roomId);
		const { groupId: groupId2 } = await createGroupForTask(page, task2Id, roomId);

		await injectMessage(page, groupId1, 'Message for Task A only', 'status');
		await injectMessage(page, groupId2, 'Message for Task B only', 'status');

		// Navigate to Task A
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Streaming Task A')).toBeVisible({ timeout: 10000 });

		// Task A's message should be visible
		await expect(page.locator('text=Message for Task A only')).toBeVisible({ timeout: 10000 });
		// Task B's message should NOT be visible
		await expect(page.locator('text=Message for Task B only')).not.toBeVisible();

		// Navigate to Task B
		await page.goto(`/room/${roomId}/task/${task2Id}`);
		await expect(page.locator('text=E2E Streaming Task B')).toBeVisible({ timeout: 10000 });

		// Task B's message should be visible
		await expect(page.locator('text=Message for Task B only')).toBeVisible({ timeout: 10000 });
		// Task A's message should NOT be visible
		await expect(page.locator('text=Message for Task A only')).not.toBeVisible();
	});
});
