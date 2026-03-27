/**
 * Short ID Display and Copy E2E Tests
 *
 * Verifies the short ID badge behavior in the task card UI:
 * 1. Short ID badge (#t-1) appears in the task card after task creation
 * 2. Clicking the badge copies the short ID string to the clipboard
 * 3. Navigating to /room/{roomId}/task/t-1 loads the task detail page
 *
 * Setup: creates a room and task via RPC in beforeEach (accepted infrastructure
 *        pattern — room.create and task.create are both accepted for test isolation).
 * Cleanup: deletes the room via RPC in afterEach.
 *
 * All test actions go through the UI (navigation, clicks, assertions on DOM).
 * No direct RPC calls in test bodies.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

// ─── RPC Infrastructure Helpers ───────────────────────────────────────────────

/**
 * Create a room via RPC. For use in beforeEach setup only.
 */
async function createRoom(page: Parameters<typeof waitForWebSocketConnected>[0]): Promise<string> {
	await waitForWebSocketConnected(page);
	return page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const res = await hub.request('room.create', { name: 'E2E Short ID Display Test Room' });
		return (res as { room: { id: string } }).room.id;
	});
}

/**
 * Create a task via RPC and return both the UUID and the short ID.
 * For use in beforeEach setup only — accepted infrastructure extension for task isolation.
 */
async function createTask(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string
): Promise<{ taskId: string; shortId: string }> {
	await waitForWebSocketConnected(page);
	return page.evaluate(async (rId) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const res = await hub.request('task.create', {
			roomId: rId,
			title: 'Short ID E2E Test Task',
			description: 'Task used to verify short ID display and copy behavior',
			// Use 'draft' to prevent the scheduler from spawning a worktree
			// (the E2E workspace is not a git repo, so worktree creation fails).
			status: 'draft',
		});
		const task = (res as { task: { id: string; shortId?: string } }).task;
		if (!task.shortId)
			throw new Error('Task was created without a shortId — short ID feature not wired');
		return { taskId: task.id, shortId: task.shortId };
	}, roomId);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Short ID Display and Copy', () => {
	let roomId = '';
	let taskId = '';
	let shortId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Clear persisted tab selection so tasks (pending status → Active tab) are always visible
		await page.evaluate(() => localStorage.removeItem('neokai:room:taskFilterTab'));
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });

		roomId = await createRoom(page);
		({ taskId, shortId } = await createTask(page, roomId));
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
		taskId = '';
		shortId = '';
	});

	test('short ID badge appears in the task card', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Wait for the room to load
		await expect(page.locator('text=E2E Short ID Display Test Room').first()).toBeVisible({
			timeout: 10000,
		});

		// The short ID badge should be visible in the task card
		const badge = page.locator(`[data-testid="short-id-badge-${shortId}"]`);
		await expect(badge).toBeVisible({ timeout: 10000 });

		// Badge should display the short ID with a # prefix
		await expect(badge).toContainText(`#${shortId}`);
	});

	test('clicking the short ID badge copies the short ID to clipboard', async ({
		page,
		context,
	}) => {
		// Grant clipboard permissions so navigator.clipboard.readText() works
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);

		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Wait for the room to load
		await expect(page.locator('text=E2E Short ID Display Test Room').first()).toBeVisible({
			timeout: 10000,
		});

		// Wait for the short ID badge to appear
		const badge = page.locator(`[data-testid="short-id-badge-${shortId}"]`);
		await expect(badge).toBeVisible({ timeout: 10000 });

		// Click the badge — this should copy the short ID to the clipboard
		await badge.click();

		// Verify the clipboard now contains the short ID string
		const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboardText).toBe(shortId);

		// The badge should briefly show a "✓ copied" confirmation
		await expect(badge).toContainText('copied', { timeout: 2000 });
	});

	test('navigating to the short ID URL loads the task detail page', async ({ page }) => {
		// Navigate directly to the task detail page using the short ID URL pattern
		await page.goto(`/room/${roomId}/task/${shortId}`);
		await waitForWebSocketConnected(page);

		// The task title should be visible on the task detail page
		await expect(page.locator('text=Short ID E2E Test Task').first()).toBeVisible({
			timeout: 10000,
		});
	});
});
