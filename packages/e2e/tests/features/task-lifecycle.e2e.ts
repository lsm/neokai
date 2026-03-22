/**
 * Task Lifecycle E2E Tests
 *
 * Tests the reactivate and archive UI actions for tasks:
 * - Reactivate: completed/cancelled → in_progress via button in TaskView
 * - Archive: completed/cancelled/needs_attention → archived via button + confirmation dialog
 * - Archived tab: archived tasks appear in Archived tab, not Done tab
 * - Archive dialog content: mentions permanent worktree cleanup
 * - Message input enabled for completed/cancelled tasks (send-to-reactivate hint)
 *
 * Note: Auto-reactivation via message send (status badge update) requires a real agent
 * group and is covered by daemon online integration tests (rpc-task-lifecycle.test.ts).
 *
 * Setup: uses RPC to create rooms/tasks and advance them to desired states (CLAUDE.md allowed).
 * Test actions and assertions: all through visible UI elements.
 * Teardown: deletes rooms via RPC.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

// ─── RPC Setup Helper ─────────────────────────────────────────────────────────

async function createRoomAndTaskInStatus(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	taskStatus: 'completed' | 'cancelled' | 'needs_attention'
): Promise<{ roomId: string; taskId: string }> {
	await waitForWebSocketConnected(page);

	return page.evaluate(async (status) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		// Create room
		const roomRes = await hub.request('room.create', {
			name: 'E2E Lifecycle Test Room',
		});
		const roomId = (roomRes as { room: { id: string } }).room.id;

		// Create task (starts as pending)
		const taskRes = await hub.request('task.create', {
			roomId,
			title: 'E2E Lifecycle Test Task',
			description: 'Task for testing reactivate and archive actions',
		});
		const taskId = (taskRes as { task: { id: string } }).task.id;

		// Advance to in_progress first (required for completed/cancelled/needs_attention transitions)
		await hub.request('task.setStatus', { roomId, taskId, status: 'in_progress' });
		// Advance to the requested terminal status
		await hub.request('task.setStatus', { roomId, taskId, status });

		return { roomId, taskId };
	}, taskStatus);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Task Lifecycle — Reactivate', () => {
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

	test('reactivates a completed task to in_progress via Reactivate button', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'completed'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 10000 });

		// Verify task shows "completed" status badge
		const statusBadge = page.locator('[data-testid="task-status-badge"]');
		await expect(statusBadge).toHaveText('completed', { timeout: 5000 });

		// Click the Reactivate button
		const reactivateBtn = page.locator('[data-testid="task-reactivate-button"]');
		await expect(reactivateBtn).toBeVisible({ timeout: 5000 });
		await reactivateBtn.click();

		// Status badge should update to "in progress" (status.replace('_', ' '))
		await expect(statusBadge).toHaveText('in progress', { timeout: 10000 });

		// Reactivate button should disappear (task is now active)
		await expect(page.locator('[data-testid="task-reactivate-button"]')).not.toBeAttached({
			timeout: 5000,
		});
	});

	test('reactivates a cancelled task to in_progress via Reactivate button', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'cancelled'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 10000 });

		// Verify task shows "cancelled" status badge
		const statusBadge = page.locator('[data-testid="task-status-badge"]');
		await expect(statusBadge).toHaveText('cancelled', { timeout: 5000 });

		// Click the Reactivate button
		const reactivateBtn = page.locator('[data-testid="task-reactivate-button"]');
		await expect(reactivateBtn).toBeVisible({ timeout: 5000 });
		await reactivateBtn.click();

		// Status badge should update to "in progress"
		await expect(statusBadge).toHaveText('in progress', { timeout: 10000 });
		await expect(page.locator('[data-testid="task-reactivate-button"]')).not.toBeAttached({
			timeout: 5000,
		});
	});

	test('reactivates completed task via Reactivate button in Done tab list', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'completed'));

		// Navigate to the room dashboard (not individual task)
		await page.goto(`/room/${roomId}`);
		await expect(page.locator('text=E2E Lifecycle Test Room').first()).toBeVisible({
			timeout: 10000,
		});

		// Click the Done tab to see completed tasks
		await page.getByRole('button', { name: /Done/ }).click();

		// Wait for the task to appear in the list
		await expect(page.locator('text=E2E Lifecycle Test Task').first()).toBeVisible({
			timeout: 5000,
		});

		// Click the Reactivate button in the list item
		const reactivateBtn = page.locator(`[data-testid="task-reactivate-${taskId}"]`);
		await expect(reactivateBtn).toBeVisible({ timeout: 5000 });
		await reactivateBtn.click();

		// Task should move from Done tab — click Active tab to confirm it's there
		await page.getByRole('button', { name: /Active/ }).click();
		await expect(page.locator('text=E2E Lifecycle Test Task').first()).toBeVisible({
			timeout: 10000,
		});
	});

	test('completed task shows send-to-reactivate hint and enabled input', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'completed'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 10000 });

		// Verify reactivation hint is visible (TaskView shows this for completed/cancelled when no group)
		await expect(page.locator('text=Sending a message will reactivate this task.')).toBeVisible({
			timeout: 5000,
		});

		// The message input should be enabled — completed tasks can send messages to reactivate
		const textarea = page.locator('textarea').first();
		await expect(textarea).toBeEnabled({ timeout: 5000 });

		// Placeholder should mention reactivation
		const placeholder = await textarea.getAttribute('placeholder');
		expect(placeholder).toMatch(/reactivate/i);
	});
});

test.describe('Task Lifecycle — Archive', () => {
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

	test('archive dialog mentions permanent worktree cleanup', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'completed'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 10000 });

		// Click the Archive button to open the dialog
		// Archive is inside the dropdown
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		const archiveBtn = page.locator('[data-testid="task-action-archive"]');
		await expect(archiveBtn).toBeVisible({ timeout: 5000 });
		await archiveBtn.click();

		// Dialog should appear
		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 5000 });

		// Dialog must mention permanent nature and worktree cleanup
		await expect(dialog.getByText(/This action is permanent/i)).toBeVisible();
		await expect(dialog.getByText(/worktree/i)).toBeVisible();
		await expect(dialog.getByText(/cannot be reactivated/i)).toBeVisible();

		// Close dialog without confirming
		await page.getByRole('button', { name: /Keep Task/ }).click();
		await expect(dialog).not.toBeVisible({ timeout: 3000 });
	});

	test('archives completed task and it disappears from Done tab', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'completed'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 10000 });

		// Click Archive button → confirm (Archive is in dropdown)
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		const archiveBtn = page.locator('[data-testid="task-action-archive"]');
		await expect(archiveBtn).toBeVisible({ timeout: 5000 });
		await archiveBtn.click();

		const confirmBtn = page.locator('[data-testid="archive-task-confirm"]');
		await expect(confirmBtn).toBeVisible({ timeout: 5000 });
		await confirmBtn.click();

		// Should navigate away from the task page after archiving
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });

		// Navigate to room dashboard and check Done tab
		await page.goto(`/room/${roomId}`);
		await page.getByRole('button', { name: /Done/ }).click();

		// Task should NOT appear in Done tab
		await expect(page.locator('text=E2E Lifecycle Test Task')).not.toBeVisible({
			timeout: 5000,
		});
	});

	test('archived task appears in Archived tab, not Done tab', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'completed'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 10000 });

		// Archive the task (Archive is in dropdown)
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		await page.locator('[data-testid="task-action-archive"]').click();
		await expect(page.locator('[data-testid="archive-task-confirm"]')).toBeVisible({
			timeout: 5000,
		});
		await page.locator('[data-testid="archive-task-confirm"]').click();

		// Wait for navigation away from task view
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });

		// Navigate to room dashboard
		await page.goto(`/room/${roomId}`);

		// Archived tab should now be visible (count > 0)
		const archivedTab = page.getByRole('button', { name: /Archived/ });
		await expect(archivedTab).toBeVisible({ timeout: 5000 });

		// Done tab should NOT show the task
		await page.getByRole('button', { name: /Done/ }).click();
		await expect(page.locator('text=E2E Lifecycle Test Task')).not.toBeVisible({
			timeout: 5000,
		});

		// Archived tab SHOULD show the task
		await archivedTab.click();
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 5000 });
	});

	test('can archive a cancelled task', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'cancelled'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 10000 });

		// Archive button should be available for cancelled tasks (Archive is in dropdown)
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		const archiveBtn = page.locator('[data-testid="task-action-archive"]');
		await expect(archiveBtn).toBeVisible({ timeout: 5000 });
		await archiveBtn.click();

		await expect(page.locator('[data-testid="archive-task-confirm"]')).toBeVisible({
			timeout: 5000,
		});
		await page.locator('[data-testid="archive-task-confirm"]').click();

		// Should navigate away
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });

		// Archived tab should show the task
		await page.goto(`/room/${roomId}`);
		const archivedTab = page.getByRole('button', { name: /Archived/ });
		await expect(archivedTab).toBeVisible({ timeout: 5000 });
		await archivedTab.click();
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 5000 });
	});

	test('can archive a needs_attention task', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'needs_attention'));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 10000 });

		// Archive button should be visible for needs_attention tasks (Archive is in dropdown)
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		const archiveBtn = page.locator('[data-testid="task-action-archive"]');
		await expect(archiveBtn).toBeVisible({ timeout: 5000 });
		await archiveBtn.click();

		await expect(page.locator('[data-testid="archive-task-confirm"]')).toBeVisible({
			timeout: 5000,
		});
		await page.locator('[data-testid="archive-task-confirm"]').click();

		// Should navigate away after archiving
		await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}`), { timeout: 10000 });
	});

	test('archived task has no Reactivate or Archive buttons', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTaskInStatus(page, 'completed'));

		// Archive the task via RPC (infrastructure setup — the UI archive flow is tested above)
		await page.evaluate(
			async ({ rId, tId }) => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub?.request) throw new Error('MessageHub not available');
				await hub.request('task.setStatus', { roomId: rId, taskId: tId, status: 'archived' });
			},
			{ rId: roomId, tId: taskId }
		);

		// Navigate to the archived task
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.locator('text=E2E Lifecycle Test Task')).toBeVisible({ timeout: 10000 });

		// Status badge should show "archived"
		await expect(page.locator('[data-testid="task-status-badge"]')).toHaveText('archived', {
			timeout: 5000,
		});

		// Neither Reactivate nor Archive buttons should be present
		await expect(page.locator('[data-testid="task-reactivate-button"]')).not.toBeAttached();
		// Archive is in dropdown - open to verify it's not there
		const dropdownTrigger = page.locator('[data-testid="task-action-dropdown-trigger"]');
		await dropdownTrigger.click();
		await expect(page.locator('[data-testid="task-action-archive"]')).not.toBeAttached();

		// Message input should show archived notice
		await expect(page.locator('text=Archived tasks cannot receive messages.').first()).toBeVisible({
			timeout: 5000,
		});
	});
});
