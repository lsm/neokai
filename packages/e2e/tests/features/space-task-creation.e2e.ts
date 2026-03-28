/**
 * Space Task Creation E2E Tests
 *
 * Verifies:
 * - "Create Task" quick action button opens SpaceCreateTaskDialog
 * - "Start Workflow Run" quick action button opens WorkflowRunStartDialog
 * - Filling and submitting the Create Task form creates a task
 * - Created task title appears in the SpaceDetailPanel Tasks section
 *
 * Setup: creates a space via RPC (infrastructure), navigates to its Dashboard tab
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

async function createSpaceViaRpc(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	workspacePath: string,
	name: string
): Promise<string> {
	const id = await page.evaluate(
		async ({ workspacePath, name }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const space = (await hub.request('space.create', { workspacePath, name })) as {
				id: string;
			};
			return space.id;
		},
		{ workspacePath, name }
	);
	if (!id) throw new Error('space.create returned no id');
	return id;
}

async function deleteSpaceViaRpc(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	spaceId: string
): Promise<void> {
	if (!spaceId) return;
	try {
		await page.evaluate(async (id) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			await hub.request('space.delete', { id });
		}, spaceId);
	} catch {
		// Best-effort cleanup
	}
}

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
		// The SpaceDashboard fallback is shown when no workflows exist (fresh space)
		const createTaskBtn = page.getByRole('button', { name: 'Create Task' }).first();
		await expect(createTaskBtn).toBeVisible({ timeout: 5000 });

		await createTaskBtn.click();

		// The Create Task modal should open
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 });
		await expect(page.getByText('Create Task').first()).toBeVisible();
	});

	test('Start Workflow Run button opens WorkflowRunStartDialog', async ({ page }) => {
		const startWorkflowBtn = page.getByRole('button', { name: 'Start Workflow Run' }).first();
		await expect(startWorkflowBtn).toBeVisible({ timeout: 5000 });

		await startWorkflowBtn.click();

		// The Start Workflow Run modal should open
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 });
		await expect(page.getByText('Start Workflow Run').first()).toBeVisible();
	});

	test('filling and submitting Create Task form creates a task visible in the panel', async ({
		page,
	}) => {
		const taskTitle = `E2E Task ${Date.now()}`;

		// Click "Create Task" quick action (the first button with that text — in SpaceDashboard)
		await page.getByRole('button', { name: 'Create Task' }).first().click();

		// Dialog is now open — fill in the title field
		const titleInput = page.getByPlaceholder('e.g., Implement authentication module');
		await expect(titleInput).toBeVisible({ timeout: 3000 });
		await titleInput.fill(taskTitle);

		// Submit the form — the submit button inside the dialog also says "Create Task"
		// Use the dialog scope to disambiguate
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('button', { name: 'Create Task' }).click();

		// Toast notification confirming creation
		await expect(page.getByText(`Task "${taskTitle}" created`)).toBeVisible({ timeout: 5000 });

		// Dialog should close
		await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3000 });

		// The task should appear in the SpaceDetailPanel Tasks section in the right sidebar
		await expect(page.getByText(taskTitle)).toBeVisible({ timeout: 5000 });
	});

	test('Create Task dialog can be dismissed without creating a task', async ({ page }) => {
		await page.getByRole('button', { name: 'Create Task' }).first().click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 3000 });

		// Click Cancel
		await dialog.getByRole('button', { name: 'Cancel' }).click();

		// Dialog should close
		await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3000 });
	});
});
