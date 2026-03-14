/**
 * Task Actions Dropdown E2E Tests
 *
 * Tests the task completion/cancellation UX redesign:
 * - Three-dot dropdown menu replaces the old cancel button
 * - "Mark as Complete" option for in_progress/review tasks
 * - "Cancel Task" option for pending/in_progress/review tasks
 * - Confirmation dialogs for both operations
 *
 * Setup: creates a real room+task via RPC (infrastructure), then tests UI.
 * Cleanup: deletes the room via RPC in afterEach.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createRoomAndTask(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	taskStatus: 'pending' | 'in_progress' | 'review' = 'pending'
): Promise<{ roomId: string; taskId: string }> {
	await waitForWebSocketConnected(page);

	return page.evaluate(async (status) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		// Create room
		const roomRes = await hub.request('room.create', {
			name: 'E2E Test Room — Task Actions',
		});
		const roomId = (roomRes as { room: { id: string } }).room.id;

		// Create task in pending state
		const taskRes = await hub.request('task.create', {
			roomId,
			title: 'E2E Test Task',
			description: 'Task for testing the actions dropdown',
		});
		const taskId = (taskRes as { task: { id: string } }).task.id;

		// Transition to requested status if not pending
		if (status !== 'pending') {
			await hub.request('task.setStatus', {
				roomId,
				taskId,
				status: 'in_progress',
				result: undefined,
				error: undefined,
			});
			if (status === 'review') {
				await hub.request('task.setStatus', {
					roomId,
					taskId,
					status: 'review',
					result: undefined,
					error: undefined,
				});
			}
		}

		return { roomId, taskId };
	}, taskStatus);
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

test.describe('Task Actions Dropdown', () => {
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

	test('shows task options menu for pending task (cancel only)', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Dropdown trigger should be visible for pending task (cancel is available)
		const menuButton = page.locator('[data-testid="task-options-menu"]');
		await expect(menuButton).toBeVisible({ timeout: 5000 });
	});

	test('shows task options menu for in_progress task (complete + cancel)', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		const menuButton = page.locator('[data-testid="task-options-menu"]');
		await expect(menuButton).toBeVisible({ timeout: 5000 });
	});

	test('does NOT show task options menu for completed task', async ({ page }) => {
		// Create a pending task then transition to completed via in_progress
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		// Complete the task via RPC (infrastructure)
		await page.evaluate(
			async ({ rId, tId }) => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub?.request) throw new Error('MessageHub not available');
				await hub.request('task.setStatus', { roomId: rId, taskId: tId, status: 'completed' });
			},
			{ rId: roomId, tId: taskId }
		);

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// No dropdown for completed tasks
		const menuButton = page.locator('[data-testid="task-options-menu"]');
		await expect(menuButton).not.toBeVisible();
	});

	test('opens dropdown and shows Cancel Task item', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Click the three-dot menu
		await page.locator('[data-testid="task-options-menu"]').click();

		// Cancel Task item should be visible
		await expect(page.getByRole('menuitem', { name: /Cancel Task/ })).toBeVisible({
			timeout: 5000,
		});
	});

	test('shows Mark as Complete for in_progress task', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Click the three-dot menu
		await page.locator('[data-testid="task-options-menu"]').click();

		// Both options should be visible
		await expect(page.getByRole('menuitem', { name: /Mark as Complete/ })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByRole('menuitem', { name: /Cancel Task/ })).toBeVisible({
			timeout: 5000,
		});
	});

	test('opens cancel confirmation dialog on Cancel Task click', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Open dropdown and click Cancel Task
		await page.locator('[data-testid="task-options-menu"]').click();
		await page.getByRole('menuitem', { name: /Cancel Task/ }).click();

		// Cancel dialog should appear with the task name
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByText(/E2E Test Task/)).toBeVisible();
		await expect(page.getByText(/cannot be undone/i)).toBeVisible();
	});

	test('opens complete confirmation dialog on Mark as Complete click', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Open dropdown and click Mark as Complete
		await page.locator('[data-testid="task-options-menu"]').click();
		await page.getByRole('menuitem', { name: /Mark as Complete/ }).click();

		// Complete dialog should appear
		await expect(page.locator('[data-testid="complete-task-confirm"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByText(/E2E Test Task/)).toBeVisible();
	});

	test('can dismiss cancel dialog with Keep Task button', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Open dialog
		await page.locator('[data-testid="task-options-menu"]').click();
		await page.getByRole('menuitem', { name: /Cancel Task/ }).click();
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).toBeVisible();

		// Dismiss with Keep Task button
		await page.getByRole('button', { name: /Keep Task/ }).click();

		// Dialog should close; task page should still be visible
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).not.toBeVisible();
		await expect(page.locator('text=E2E Test Task')).toBeVisible();
	});

	test('cancels task and navigates away on confirmation', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Open dropdown → Cancel Task → confirm
		await page.locator('[data-testid="task-options-menu"]').click();
		await page.getByRole('menuitem', { name: /Cancel Task/ }).click();
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).toBeVisible();
		await page.locator('[data-testid="cancel-task-confirm"]').click();

		// Should navigate away from the task page (back to room)
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });
	});

	test('completes task and navigates away on confirmation', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Open dropdown → Mark as Complete → confirm
		await page.locator('[data-testid="task-options-menu"]').click();
		await page.getByRole('menuitem', { name: /Mark as Complete/ }).click();
		await expect(page.locator('[data-testid="complete-task-confirm"]')).toBeVisible();
		await page.locator('[data-testid="complete-task-confirm"]').click();

		// Should navigate away from the task page (back to room)
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });
	});
});
