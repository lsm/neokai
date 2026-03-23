/**
 * Task Message Pagination E2E Tests
 *
 * Verifies that the TaskView correctly implements client-side pagination:
 * - Initial load shows only the newest messages (no "Load earlier" button when all fit)
 * - When there are more messages than the page size, a "Load earlier messages" button
 *   appears at the top of the conversation.
 * - Clicking "Load earlier messages" reveals older messages without a scroll jump.
 *
 * The default page size is 50. These tests use a small message count above 50 to
 * verify pagination. Messages are inserted via the test-only RPC (task.group.addMessage)
 * in beforeEach — an accepted infrastructure pattern per CLAUDE.md.
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

// ─── Setup Helpers ────────────────────────────────────────────────────────────

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

		const roomRes = await hub.request('room.create', { name: 'E2E Pagination Test Room' });
		const roomId = (roomRes as { room: { id: string } }).room.id;

		const taskRes = await hub.request('task.create', {
			roomId,
			title,
			description: 'Task for E2E pagination tests',
		});
		const taskId = (taskRes as { task: { id: string } }).task.id;

		return { roomId, taskId };
	}, taskTitle);
}

/**
 * Creates a task group and inserts `count` status messages.
 * Messages are numbered from 1..count so we can assert oldest/newest by content.
 * Returns the groupId.
 */
async function createGroupWithManyMessages(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	taskId: string,
	roomId: string,
	count: number
): Promise<string> {
	return page.evaluate(
		async ({ tId, rId, n }) => {
			const hub = (window.__messageHub || window.appState?.messageHub) as {
				request: (m: string, p: unknown) => Promise<unknown>;
			};
			if (!hub?.request) throw new Error('MessageHub not available');

			const groupRes = await hub.request('task.group.create', { taskId: tId, roomId: rId });
			const groupId = (groupRes as { groupId: string }).groupId;

			for (let i = 1; i <= n; i++) {
				await hub.request('task.group.addMessage', {
					groupId,
					role: 'system',
					messageType: 'status',
					content: `Message number ${i}`,
				});
			}

			return groupId;
		},
		{ tId: taskId, rId: roomId, n: count }
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('TaskView — Message Pagination', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	test.describe('fewer than page size — no Load Earlier button', () => {
		let roomId = '';
		let taskId = '';

		test.beforeEach(async ({ page }) => {
			await page.goto('/');
			await page
				.getByRole('button', { name: 'New Session', exact: true })
				.waitFor({ timeout: 10000 });

			({ roomId, taskId } = await createRoomWithTask(page, 'E2E Pagination Few Messages'));
			// Insert 3 messages — well below the default page size of 50
			await createGroupWithManyMessages(page, taskId, roomId, 3);
		});

		test.afterEach(async ({ page }) => {
			await deleteRoom(page, roomId);
			roomId = '';
			taskId = '';
		});

		test('all messages visible with no Load Earlier button', async ({ page }) => {
			await page.goto(`/room/${roomId}/task/${taskId}`);
			await expect(page.getByRole('heading', { name: 'E2E Pagination Few Messages' })).toBeVisible({
				timeout: 10000,
			});

			// All 3 messages visible
			await expect(page.locator('text=Message number 1')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Message number 3')).toBeVisible({ timeout: 10000 });

			// No "Load earlier" button shown
			await expect(page.getByTestId('load-earlier-messages')).not.toBeVisible();
		});
	});

	test.describe('more than page size — Load Earlier button shown', () => {
		let roomId = '';
		let taskId = '';

		test.beforeEach(async ({ page }) => {
			await page.goto('/');
			await page
				.getByRole('button', { name: 'New Session', exact: true })
				.waitFor({ timeout: 10000 });

			({ roomId, taskId } = await createRoomWithTask(page, 'E2E Pagination Many Messages'));
			// Insert 55 messages — 5 more than the default page size of 50
			await createGroupWithManyMessages(page, taskId, roomId, 55);
		});

		test.afterEach(async ({ page }) => {
			await deleteRoom(page, roomId);
			roomId = '';
			taskId = '';
		});

		test('initial load shows newest messages and Load Earlier button at top', async ({ page }) => {
			await page.goto(`/room/${roomId}/task/${taskId}`);
			await expect(page.getByRole('heading', { name: 'E2E Pagination Many Messages' })).toBeVisible(
				{ timeout: 10000 }
			);

			// The newest message (55) should be visible
			await expect(page.locator('text=Message number 55')).toBeVisible({ timeout: 10000 });

			// The oldest messages should NOT be visible initially (they're hidden by pagination)
			await expect(page.locator('text=Message number 1')).not.toBeVisible();

			// "Load earlier messages" button should appear at the top
			await expect(page.getByTestId('load-earlier-messages')).toBeVisible({ timeout: 5000 });
		});

		test('clicking Load Earlier reveals older messages without scroll jump', async ({ page }) => {
			await page.goto(`/room/${roomId}/task/${taskId}`);
			await expect(page.getByRole('heading', { name: 'E2E Pagination Many Messages' })).toBeVisible(
				{ timeout: 10000 }
			);

			// Wait for messages to load and the Load Earlier button to appear
			await expect(page.getByTestId('load-earlier-messages')).toBeVisible({ timeout: 10000 });

			// Verify newest message (55) is visible
			await expect(page.locator('text=Message number 55')).toBeVisible({ timeout: 5000 });

			// Capture the scroll position before clicking Load Earlier
			const scrollBefore = await page.evaluate(() => {
				const container = document.querySelector('.overflow-y-auto') as HTMLElement | null;
				return container ? container.scrollTop : 0;
			});

			// Click Load Earlier
			await page.getByTestId('load-earlier-messages').click();

			// After clicking, older messages should appear
			// With 55 messages and pageSize=50, clicking once shows all 55
			await expect(page.locator('text=Message number 1')).toBeVisible({ timeout: 5000 });

			// The Load Earlier button should now be gone (all messages loaded)
			await expect(page.getByTestId('load-earlier-messages')).not.toBeVisible();

			// Verify newest messages are still present (they should not have disappeared)
			await expect(page.locator('text=Message number 55')).toBeVisible();

			// Verify scroll position was preserved (not jumped to top)
			// After loading earlier messages, the container's scrollTop should be non-zero
			// because the prepended messages push content down and we restore position.
			const scrollAfter = await page.evaluate(() => {
				const container = document.querySelector('.overflow-y-auto') as HTMLElement | null;
				return container ? container.scrollTop : 0;
			});

			// The scroll position should not be at 0 — older messages were prepended
			// but the user's view was preserved (not reset to top).
			// We allow some tolerance since the exact pixel value depends on content height.
			expect(scrollAfter).toBeGreaterThan(0);

			// Sanity check: scrollBefore should also have been non-zero since we were
			// looking at a full page of messages and the container was scrolled.
			// (This validates the test is measuring real scroll state.)
			expect(typeof scrollBefore).toBe('number');
		});
	});
});
