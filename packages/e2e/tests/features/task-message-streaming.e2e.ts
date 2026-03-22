/**
 * Task Message Streaming E2E Tests
 *
 * Verifies that the TaskConversationRenderer correctly displays messages
 * via the LiveQuery subscription.
 *
 * Tests:
 * - Messages from the initial LiveQuery snapshot appear in TaskView on load
 * - Switching between two tasks shows correct messages for each task
 *
 * Note on "live delta without refresh" testing: injecting a message after page
 * navigation requires calling hub.request() inside the test body, which violates
 * CLAUDE.md's E2E rule that prohibits non-lifecycle RPC calls. That scenario
 * (liveQuery.delta delivery) is fully exercised by the useGroupMessages unit tests
 * in packages/web/src/hooks/__tests__/useGroupMessages.test.ts and does not need
 * an E2E test.
 *
 * Setup: Creates rooms, tasks, session groups, and messages via RPC in beforeEach
 *        (accepted infrastructure pattern per CLAUDE.md).
 * Cleanup: Deletes rooms via RPC in afterEach.
 *
 * E2E Rules:
 * - All test actions go through the UI (clicks, navigation)
 * - All assertions check visible DOM state
 * - RPC is used only in beforeEach/afterEach for test infrastructure
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── RPC Setup Helpers (beforeEach/afterEach infrastructure only) ─────────────

type Hub = { request: (method: string, params: unknown) => Promise<unknown> };

function getHub(w: Window & typeof globalThis): Hub {
	const hub = (w as unknown as Record<string, unknown>).__messageHub as Hub | undefined;
	if (hub?.request) return hub;
	const appState = (w as unknown as Record<string, unknown>).appState as
		| { messageHub?: Hub }
		| undefined;
	if (appState?.messageHub?.request) return appState.messageHub;
	throw new Error('MessageHub not available');
}

async function createRoomWithTask(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	taskTitle: string
): Promise<{ roomId: string; taskId: string }> {
	await waitForWebSocketConnected(page);

	return page.evaluate(async (title) => {
		const hub = (window.__messageHub || window.appState?.messageHub) as {
			request: (m: string, p: unknown) => Promise<unknown>;
		};
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

async function createGroupWithMessages(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	taskId: string,
	roomId: string,
	messages: string[]
): Promise<string> {
	return page.evaluate(
		async ({ tId, rId, msgs }) => {
			const hub = (window.__messageHub || window.appState?.messageHub) as {
				request: (m: string, p: unknown) => Promise<unknown>;
			};
			if (!hub?.request) throw new Error('MessageHub not available');

			const groupRes = await hub.request('task.group.create', { taskId: tId, roomId: rId });
			const groupId = (groupRes as { groupId: string }).groupId;

			for (const content of msgs) {
				await hub.request('task.group.addMessage', {
					groupId,
					role: 'system',
					messageType: 'status',
					content,
				});
			}

			return groupId;
		},
		{ tId: taskId, rId: roomId, msgs: messages }
	);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test.describe('TaskView — Message Streaming via LiveQuery', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	// ── Test 1: initial snapshot ───────────────────────────────────────────────

	test.describe('initial snapshot display', () => {
		let roomId = '';
		let taskId = '';

		test.beforeEach(async ({ page }) => {
			await page.goto('/');
			await page
				.getByRole('button', { name: 'New Session', exact: true })
				.waitFor({ timeout: 10000 });

			// Create room, task, group, and pre-load messages — all infrastructure
			({ roomId, taskId } = await createRoomWithTask(page, 'E2E Streaming Task 1'));
			await createGroupWithMessages(page, taskId, roomId, [
				'Agent started working',
				'Completed first step',
			]);
		});

		test.afterEach(async ({ page }) => {
			await deleteRoom(page, roomId);
			roomId = '';
			taskId = '';
		});

		test('messages pre-loaded in DB appear in TaskView on initial load', async ({ page }) => {
			// Navigate to the task view — LiveQuery snapshot delivers the pre-existing messages
			await page.goto(`/room/${roomId}/task/${taskId}`);
			await expect(page.locator('text=E2E Streaming Task 1')).toBeVisible({ timeout: 10000 });

			// Both status messages should appear via the initial snapshot (no refresh needed)
			await expect(page.locator('text=Agent started working')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Completed first step')).toBeVisible({ timeout: 10000 });
		});
	});

	// ── Test 2: task switching ─────────────────────────────────────────────────

	test.describe('task switching shows correct messages', () => {
		let roomId = '';
		let taskId = '';
		let task2Id = '';

		test.beforeEach(async ({ page }) => {
			await page.goto('/');
			await page
				.getByRole('button', { name: 'New Session', exact: true })
				.waitFor({ timeout: 10000 });

			// Create room, two tasks with distinct messages — all infrastructure
			({ roomId, taskId } = await createRoomWithTask(page, 'E2E Streaming Task A'));

			task2Id = await page.evaluate(
				async ({ rId }) => {
					const hub = (window.__messageHub || window.appState?.messageHub) as {
						request: (m: string, p: unknown) => Promise<unknown>;
					};
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

			await createGroupWithMessages(page, taskId, roomId, ['Message for Task A only']);
			await createGroupWithMessages(page, task2Id, roomId, ['Message for Task B only']);
		});

		test.afterEach(async ({ page }) => {
			await deleteRoom(page, roomId);
			roomId = '';
			taskId = '';
			task2Id = '';
		});

		test('switching between two tasks shows correct messages for each task', async ({ page }) => {
			// Navigate to Task A
			await page.goto(`/room/${roomId}/task/${taskId}`);
			await expect(page.locator('text=E2E Streaming Task A')).toBeVisible({ timeout: 10000 });

			// Task A's message visible; Task B's is not
			await expect(page.locator('text=Message for Task A only')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Message for Task B only')).not.toBeVisible();

			// Navigate to Task B
			await page.goto(`/room/${roomId}/task/${task2Id}`);
			await expect(page.locator('text=E2E Streaming Task B')).toBeVisible({ timeout: 10000 });

			// Task B's message visible; Task A's is not
			await expect(page.locator('text=Message for Task B only')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Message for Task A only')).not.toBeVisible();

			// Navigate back to Task A — subscription must re-establish correctly
			await page.goto(`/room/${roomId}/task/${taskId}`);
			await expect(page.locator('text=E2E Streaming Task A')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Message for Task A only')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Message for Task B only')).not.toBeVisible();
		});
	});
});
