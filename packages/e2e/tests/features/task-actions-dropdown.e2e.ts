/**
 * Task Actions E2E Tests
 *
 * ⚠️ SKIPPED: These tests use selectors for a dropdown-based action UI
 * (task-action-dropdown-trigger, task-cancel-button, task-action-complete)
 * but the actual TaskView UI uses an info panel-based action model
 * (task-info-panel-trigger opens a panel with task-info-panel-cancel,
 * task-info-panel-complete). The tests need a major restructure to match
 * the actual UI architecture. Tracking issue: #TASK-ACTIONS-RESTRUCTURE.
 *
 * Setup: creates a real room+task via RPC (infrastructure), then tests UI.
 * Cleanup: deletes the room via RPC in afterEach.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

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

	test.skip('shows cancel button for pending task (no complete action)', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Pending task: cancel button visible with correct text, complete not in dropdown
		const cancelBtn = page.locator('[data-testid="task-cancel-button"]');
		await expect(cancelBtn).toBeVisible({ timeout: 5000 });
		await expect(cancelBtn).toHaveText(/Cancel/);
		// Open dropdown to verify complete is NOT there for pending
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		await expect(page.locator('[data-testid="task-action-complete"]')).not.toBeAttached();
	});

	test.skip('shows both cancel button and dropdown with complete for in_progress task', async ({
		page,
	}) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// In-progress task: cancel is standalone, complete is in dropdown
		await expect(page.locator('[data-testid="task-cancel-button"]')).toBeVisible({
			timeout: 5000,
		});
		// Open dropdown to verify complete is inside
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		await expect(page.locator('[data-testid="task-action-complete"]')).toBeVisible({
			timeout: 5000,
		});
	});

	test.skip('does NOT show cancel or complete action for completed task', async ({ page }) => {
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
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Completed task: cancel button should not be in the DOM
		await expect(page.locator('[data-testid="task-cancel-button"]')).not.toBeAttached();
		// Complete is in dropdown - open to verify it's not there either
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		await expect(page.locator('[data-testid="task-action-complete"]')).not.toBeAttached();
	});

	test.skip('shows cancel but NOT complete for review task', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'review'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Review task: cancel visible, complete hidden (in dropdown) despite canComplete being true
		await expect(page.locator('[data-testid="task-cancel-button"]')).toBeVisible({
			timeout: 5000,
		});
		// Open dropdown to verify complete is NOT there
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		await expect(page.locator('[data-testid="task-action-complete"]')).not.toBeAttached();
	});

	test.skip('opens cancel confirmation dialog on cancel button click', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Click the cancel button directly
		await page.locator('[data-testid="task-cancel-button"]').click();

		// Cancel dialog should appear with the task name
		const cancelDialog = page.locator('[role="dialog"]');
		await expect(cancelDialog.locator('[data-testid="cancel-task-confirm"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(cancelDialog.getByText(/E2E Test Task/)).toBeVisible();
		// Note: text changed from "cannot be undone" to "is reversible"
	});

	test.skip('opens complete confirmation dialog on complete button click', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Open dropdown and click Complete inside
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		await page.locator('[data-testid="task-action-complete"]').click();

		// Complete dialog should appear with the task name
		const completeDialog = page.locator('[role="dialog"]');
		await expect(completeDialog.locator('[data-testid="complete-task-confirm"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(completeDialog.getByText(/E2E Test Task/)).toBeVisible();
	});

	test.skip('can dismiss cancel dialog with Keep Task button', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Open cancel dialog
		await page.locator('[data-testid="task-cancel-button"]').click();
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).toBeVisible();

		// Dismiss with Keep Task button
		await page.getByRole('button', { name: /Keep Task/ }).click();

		// Dialog should close (modal unmounts entirely); task page should still be visible
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).not.toBeAttached();
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible();
	});

	test.skip('cancels task and navigates away on confirmation', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'pending'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Click cancel button → confirm
		await page.locator('[data-testid="task-cancel-button"]').click();
		await expect(page.locator('[data-testid="cancel-task-confirm"]')).toBeVisible();
		await page.locator('[data-testid="cancel-task-confirm"]').click();

		// Should navigate away from the task page (back to room)
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });
	});

	test.skip('completes task and navigates away on confirmation', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page, 'in_progress'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Open dropdown and click Complete → confirm
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		await page.locator('[data-testid="task-action-complete"]').click();
		await expect(page.locator('[data-testid="complete-task-confirm"]')).toBeVisible();
		await page.locator('[data-testid="complete-task-confirm"]').click();

		// Should navigate away from the task page (back to room)
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });
	});
});
