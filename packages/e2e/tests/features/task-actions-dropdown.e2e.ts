/**
 * Task Actions E2E Tests
 *
 * Tests the inline task action buttons in TaskView:
 * - "Cancel" button (data-testid="task-cancel-button") for pending/in_progress/review tasks
 * - "Complete" button (data-testid="task-complete-button") for in_progress tasks only
 *   (hidden for review status despite canComplete being true)
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
			description: 'Task for testing the action buttons',
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

test.describe('Task Action Buttons', () => {
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

	test('shows cancel button for pending task (no complete button)', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Pending task: cancel button visible with correct text, complete button not in DOM
		const cancelBtn = page.locator('[data-testid="task-cancel-button"]');
		await expect(cancelBtn).toBeVisible({ timeout: 5000 });
		await expect(cancelBtn).toHaveText(/Cancel/);
		await expect(page.locator('[data-testid="task-complete-button"]')).not.toBeAttached();
	});

	test('shows both cancel and complete buttons for in_progress task', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// In-progress task: both buttons visible
		await expect(page.locator('[data-testid="task-cancel-button"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[data-testid="task-complete-button"]')).toBeVisible({
			timeout: 5000,
		});
	});

	test('does NOT show action buttons for completed task', async ({ page }) => {
		// Create a task and transition to completed via RPC
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

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

		// Completed task: neither button should be in the DOM
		await expect(page.locator('[data-testid="task-cancel-button"]')).not.toBeAttached();
		await expect(page.locator('[data-testid="task-complete-button"]')).not.toBeAttached();
	});

	test('shows cancel but NOT complete for review task', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'review'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Review task: cancel visible, complete hidden despite canComplete being true
		await expect(page.locator('[data-testid="task-cancel-button"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[data-testid="task-complete-button"]')).not.toBeAttached();
	});

	test('opens cancel confirmation dialog on cancel button click', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Click the cancel button directly
		await page.locator('[data-testid="task-cancel-button"]').click();

		// Cancel dialog should appear with the task name
		const cancelDialog = page.locator('[role="dialog"]');
		await expect(cancelDialog.locator('[data-testid="cancel-task-confirm"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(cancelDialog.getByText(/E2E Test Task/)).toBeVisible();
		await expect(cancelDialog.getByText(/cannot be undone/i)).toBeVisible();
	});

	test('opens complete confirmation dialog on complete button click', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Click the complete button directly
		await page.locator('[data-testid="task-complete-button"]').click();

		// Complete dialog should appear with the task name
		const completeDialog = page.locator('[role="dialog"]');
		await expect(completeDialog.locator('[data-testid="complete-task-confirm"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(completeDialog.getByText(/E2E Test Task/)).toBeVisible();
	});

	test('can dismiss cancel dialog with Keep Task button', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Open cancel dialog
		await page.locator('[data-testid="task-cancel-button"]').click();
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).toBeVisible();

		// Dismiss with Keep Task button
		await page.getByRole('button', { name: /Keep Task/ }).click();

		// Dialog should close (modal unmounts entirely); task page should still be visible
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).not.toBeAttached();
		await expect(page.locator('text=E2E Test Task')).toBeVisible();
	});

	test('cancels task and navigates away on confirmation', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Click cancel button → confirm
		await page.locator('[data-testid="task-cancel-button"]').click();
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).toBeVisible();
		await page.locator('[data-testid="cancel-task-confirm"]').click();

		// Should navigate away from the task page (back to room)
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });
	});

	test('completes task and navigates away on confirmation', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Click complete button → confirm
		await page.locator('[data-testid="task-complete-button"]').click();
		await expect(page.locator('[data-testid="complete-task-confirm"]')).toBeVisible();
		await page.locator('[data-testid="complete-task-confirm"]').click();

		// Should navigate away from the task page (back to room)
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });
	});
});
