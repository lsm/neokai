/**
 * Space Task Full-Width View E2E Tests
 *
 * Verifies:
 * - Clicking a task in SpaceDashboard opens the full-width task pane
 * - The SpaceDashboard tab bar (Active/Review/Done) is hidden when the full-width task view is active
 * - Back button in task view returns to the tabbed dashboard view
 * - Task pane is not attached to the DOM when no task is selected
 *
 * Setup: creates a space and a task via RPC (infrastructure) in beforeEach
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
	createSpaceViaRpc,
	createSpaceTaskViaRpc,
	deleteSpaceViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Space Task Full-Width View', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';
	let taskTitle = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const workspaceRoot = await getWorkspaceRoot(page);
		spaceId = await createSpaceViaRpc(
			page,
			workspaceRoot,
			`E2E Full-Width Task Test ${Date.now()}`
		);

		// Create the task in beforeEach — each test gets its own isolated space so there
		// is no collision risk with the title, and task creation is setup, not an action
		// under test. No "Create Task" UI button exists in the space dashboard yet.
		taskTitle = 'Full-Width Test Task';
		await createSpaceTaskViaRpc(page, spaceId, taskTitle);

		// Navigate to the space dashboard
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Wait for the Active tab to be visible (SpaceDashboard is loaded)
		await expect(page.getByRole('button', { name: 'Active', exact: true })).toBeVisible({
			timeout: 5000,
		});
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteSpaceViaRpc(page, spaceId);
			spaceId = '';
			taskTitle = '';
		}
	});

	test('clicking a task opens full-width task pane and hides dashboard tab bar', async ({
		page,
	}) => {
		// Wait for task to appear in SpaceDashboard's Active tab (status 'open' → Queued group)
		await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

		// SpaceDashboard tab bar should be visible before clicking a task
		await expect(page.getByRole('button', { name: 'Active', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible();

		// Click the task title to navigate to the full-width task view
		await page.getByText(taskTitle, { exact: true }).first().click();

		// Wait for navigation to the task route
		await page.waitForURL(`/space/${spaceId}/task/**`, { timeout: 5000 });

		// Full-width task pane should now be visible
		await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

		// SpaceDashboard tab bar should be hidden (SpaceTaskPane replaced SpaceDashboard)
		await expect(page.getByRole('button', { name: 'Active', exact: true })).not.toBeVisible();
		await expect(page.getByRole('button', { name: 'Review', exact: true })).not.toBeVisible();
	});

	test('back button in task view returns to the tabbed dashboard', async ({ page }) => {
		// Wait for task to appear, then navigate to it
		await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });
		await page.getByText(taskTitle, { exact: true }).first().click();
		await page.waitForURL(`/space/${spaceId}/task/**`, { timeout: 5000 });

		// Verify task pane is shown
		await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

		// Click the back button
		await page.locator('[data-testid="task-back-button"]').click();

		// Should return to the space dashboard URL
		await page.waitForURL(`/space/${spaceId}`, { timeout: 5000 });

		// SpaceDashboard tab bar should be visible again
		await expect(page.getByRole('button', { name: 'Active', exact: true })).toBeVisible({
			timeout: 3000,
		});

		// Task pane should no longer be in the DOM
		await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
	});

	test('task pane is not attached before any task is selected', async ({ page }) => {
		// No task selected — task pane should not be in the DOM
		await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
	});
});
