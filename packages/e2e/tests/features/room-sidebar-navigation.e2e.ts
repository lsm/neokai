/**
 * Room Sidebar Navigation E2E Tests
 *
 * Verifies that all room sidebar navigation targets:
 * 1. Produce correct URLs
 * 2. Survive page refresh (URL persistence)
 *
 * Setup: creates a room via RPC in beforeEach (infrastructure pattern)
 * with tasks and goals for testing navigation.
 * Cleanup: deletes room via RPC in afterEach.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createRoom(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	defaultPath: string
): Promise<string> {
	return page.evaluate(async (path) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const res = await hub.request('room.create', {
			name: 'E2E Navigation Test Room',
			defaultPath: path,
		});
		return (res as { room: { id: string } }).room.id;
	}, defaultPath);
}

async function deleteRoom(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string
): Promise<void> {
	if (!roomId) return;
	try {
		await page.evaluate(async (id) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			await hub.request('room.delete', { roomId: id });
		}, roomId);
	} catch {
		// Best-effort cleanup
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Room Sidebar Navigation: URL persistence', () => {
	let roomId = '';
	let orphanTaskId = '';

	test.use({ viewport: { width: 1280, height: 720 } });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		const workspaceRoot = await getWorkspaceRoot(page);

		// Create room with a valid default path (required for session creation)
		roomId = await createRoom(page, workspaceRoot);
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
			orphanTaskId = '';
		}
	});

	test('Dashboard URL is /room/:id and survives page refresh', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Verify initial URL matches /room/<id>
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}$`));

		// Verify dashboard view is shown (room tab bar visible)
		await expect(page.locator('button:has-text("Overview")')).toBeVisible({ timeout: 10000 });

		// Reload page
		await page.reload();
		await waitForWebSocketConnected(page);

		// Verify URL is preserved after reload
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}$`));

		// Verify dashboard view is still shown
		await expect(page.locator('button:has-text("Overview")')).toBeVisible({ timeout: 10000 });
	});

	test('Room Agent URL is /room/:id/agent and survives page refresh', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Click "Room Agent" in sidebar
		const roomAgentButton = page.locator('button', { hasText: 'Room Agent' });
		await expect(roomAgentButton).toBeVisible({ timeout: 10000 });
		await roomAgentButton.click();

		// Verify URL changed to /room/:id/agent
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/agent$`), { timeout: 5000 });

		// Verify Room Agent chat view is shown (ChatContainer renders a textarea)
		await expect(page.locator('textarea').first()).toBeVisible({ timeout: 10000 });

		// Verify "Room Agent" sidebar item is highlighted
		await expect(page.locator('button', { hasText: 'Room Agent' })).toHaveClass(/bg-dark-700/, {
			timeout: 5000,
		});

		// Reload page
		await page.reload();
		await waitForWebSocketConnected(page);

		// Verify URL is preserved after reload
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/agent$`));

		// Verify Room Agent chat view is still shown
		await expect(page.locator('textarea').first()).toBeVisible({ timeout: 10000 });

		// Verify "Room Agent" sidebar item is still highlighted
		await expect(page.locator('button', { hasText: 'Room Agent' })).toHaveClass(/bg-dark-700/, {
			timeout: 5000,
		});
	});

	test('Task URL is /room/:id/task/:taskId and survives page refresh', async ({ page }) => {
		// Create a task via RPC (infrastructure) before navigating to the room
		orphanTaskId = await page.evaluate(async (rId) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('task.create', {
				roomId: rId,
				title: 'E2E Nav Task',
				description: 'Task for URL navigation test',
			});
			return (res as { task: { id: string } }).task.id;
		}, roomId);

		// Navigate directly to the task URL — equivalent to clicking the task in the sidebar
		// and tests the same URL-addressable navigation feature.
		await page.goto(`/room/${roomId}/task/${orphanTaskId}`);
		await waitForWebSocketConnected(page);

		// Verify initial URL matches /room/<id>/task/<taskId>
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/task/${orphanTaskId}$`));

		// Verify TaskView is shown — the h2 heading contains the task title
		await expect(page.locator('h2', { hasText: 'E2E Nav Task' })).toBeVisible({ timeout: 15000 });

		// Verify the sidebar task item is highlighted (selected state)
		await expect(page.locator('button.bg-dark-700', { hasText: 'E2E Nav Task' })).toBeVisible({
			timeout: 10000,
		});

		// Reload page
		await page.reload();
		await waitForWebSocketConnected(page);

		// Verify URL is preserved after reload
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/task/${orphanTaskId}$`));

		// Verify TaskView is still shown after reload
		await expect(page.locator('h2', { hasText: 'E2E Nav Task' })).toBeVisible({ timeout: 15000 });
	});

	test('Session URL is /room/:id/session/:sessionId and survives page refresh', async ({
		page,
	}) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Click the "+" button in the Sessions section header to create a session
		const createSessionButton = page.locator('button[aria-label="Create session"]');
		await expect(createSessionButton).toBeVisible({ timeout: 10000 });
		await createSessionButton.click();

		// Wait for URL to change to /room/:id/session/:sessionId
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/session/`), { timeout: 15000 });

		// Extract session ID from URL
		const sessionUrl = page.url();
		const sessionIdMatch = sessionUrl.match(/\/session\/([^/]+)$/);
		expect(sessionIdMatch).toBeTruthy();
		const sessionId = sessionIdMatch![1];

		// Verify session chat view is shown (ChatContainer renders a textarea)
		await expect(page.locator('textarea').first()).toBeVisible({ timeout: 10000 });

		// Reload page
		await page.reload();
		await waitForWebSocketConnected(page);

		// Verify URL is preserved after reload
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/session/${sessionId}$`));

		// Verify session chat view is still shown
		await expect(page.locator('textarea').first()).toBeVisible({ timeout: 10000 });
	});
});
