/**
 * Space Task Creation E2E Tests
 *
 * Verifies:
 * - "Create Task" quick action button opens SpaceCreateTaskDialog
 * - "Start Workflow Run" quick action button opens WorkflowRunStartDialog
 * - Filling and submitting the Create Task form creates a task
 * - Created task title appears in SpaceDashboard's Recent Activity section
 * - Cancelling the dialog dismisses it without creating a task
 *
 * Setup: creates a space via RPC (infrastructure), navigates to its Dashboard tab
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createSpaceViaRpc, deleteSpaceViaRpc } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Space Task Creation', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const workspaceRoot = await getWorkspaceRoot(page);
		const spaceName = `E2E Task Creation Test ${Date.now()}`;
		spaceId = await createSpaceViaRpc(page, workspaceRoot, spaceName);

		// Navigate directly to the space (Dashboard tab is default)
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Wait for the Dashboard tab to be active
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteSpaceViaRpc(page, spaceId);
			spaceId = '';
		}
	});

	test('Create Task button opens SpaceCreateTaskDialog', async ({ page }) => {
		// Fresh space has no workflows → SpaceDashboard fallback is shown with quick actions
		const createTaskBtn = page.getByRole('button', { name: 'Create Task' }).first();
		await expect(createTaskBtn).toBeVisible({ timeout: 5000 });

		await createTaskBtn.click();

		// The Create Task modal should open — scope assertions to the dialog itself
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await expect(dialog.getByRole('heading', { name: 'Create Task' })).toBeVisible();
	});

	test('Start Workflow Run button opens WorkflowRunStartDialog', async ({ page }) => {
		const startWorkflowBtn = page.getByRole('button', { name: 'Start Workflow Run' }).first();
		await expect(startWorkflowBtn).toBeVisible({ timeout: 5000 });

		await startWorkflowBtn.click();

		// The Start Workflow Run modal should open — scope assertions to the dialog
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await expect(dialog.getByRole('heading', { name: 'Start Workflow Run' })).toBeVisible();
	});

	test('submitting the Create Task form creates a task in Recent Activity', async ({ page }) => {
		const taskTitle = `E2E Task ${Date.now()}`;

		// Click "Create Task" quick action (the first button with that text in SpaceDashboard)
		await page.getByRole('button', { name: 'Create Task' }).first().click();

		// Fill in the title field
		const titleInput = page.getByPlaceholder('e.g., Implement authentication module');
		await expect(titleInput).toBeVisible({ timeout: 3000 });
		await titleInput.fill(taskTitle);

		// Submit via the dialog's "Create Task" button — scope to dialog to disambiguate
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('button', { name: 'Create Task' }).click();

		// Toast notification confirming creation appears
		await expect(page.getByText(`Task "${taskTitle}" created`)).toBeVisible({ timeout: 5000 });

		// Dialog should close after successful submission
		await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3000 });

		// The task title should appear in SpaceDashboard's Recent Activity section.
		// The store updates reactively via live-query after creation.
		// Use exact: true to avoid matching the taskTitle substring in the toast.
		await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });
	});

	test('Cancel dismisses the dialog without creating a task', async ({ page }) => {
		await page.getByRole('button', { name: 'Create Task' }).first().click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 3000 });

		// Click Cancel — dialog should close
		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3000 });

		// No task pane should appear — the right-column task detail pane only opens
		// when a task is selected (currentSpaceTaskIdSignal non-null), which Cancel never triggers
		await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeVisible();
	});
});
