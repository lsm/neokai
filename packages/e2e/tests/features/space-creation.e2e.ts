/**
 * Space Creation E2E Tests
 *
 * Verifies:
 * - Navigating to the Spaces section
 * - "Create Space" dialog opens
 * - Workspace path field is required
 * - Name auto-suggests from workspace path
 * - Creating a space navigates to it
 * - Space 3-column layout renders (nav panel, dashboard, no task pane initially)
 * - Nav panel shows "No runs or tasks yet" for a fresh space
 *
 * Setup: creates a space via dialog (UI-only)
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

async function deleteSpaceByRpc(
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

test.describe('Space Creation UX', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let createdSpaceId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		// Small settle time after connection
		await page.waitForTimeout(300);
	});

	test.afterEach(async ({ page }) => {
		if (createdSpaceId) {
			await deleteSpaceByRpc(page, createdSpaceId);
			createdSpaceId = '';
		}
	});

	test('navigates to Spaces section via NavRail', async ({ page }) => {
		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await expect(spacesButton).toBeVisible({ timeout: 5000 });
		await spacesButton.click();

		// ContextPanel should show "Spaces" header
		await expect(page.locator('h2:has-text("Spaces")')).toBeVisible({ timeout: 5000 });
	});

	test('shows "Create Space" button in Spaces section', async ({ page }) => {
		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();

		// Header CTA button
		await expect(
			page.getByRole('button', { name: 'Create Space', exact: true }).first()
		).toBeVisible({
			timeout: 5000,
		});
	});

	test('opens Create Space dialog when button clicked', async ({ page }) => {
		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();

		const createButton = page.getByRole('button', { name: 'Create Space', exact: true }).first();
		await expect(createButton).toBeVisible({ timeout: 5000 });
		await createButton.click();

		// Dialog should appear
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Workspace Path')).toBeVisible({ timeout: 3000 });
	});

	test('workspace path is required — shows error on empty submit', async ({ page }) => {
		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();
		await page.getByRole('button', { name: 'Create Space', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

		// Submit without filling workspace path
		const submitButton = page.getByRole('dialog').getByRole('button', { name: 'Create Space' });
		await submitButton.click();

		// Should show validation error
		await expect(page.locator('text=Workspace path is required')).toBeVisible({ timeout: 3000 });
	});

	test('auto-suggests name from workspace path', async ({ page }) => {
		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();
		await page.getByRole('button', { name: 'Create Space', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

		// Type a workspace path
		const pathInput = page.locator('input[placeholder*="/Users/you/projects"]');
		await pathInput.fill('/projects/my-cool-project');

		// Name should auto-suggest
		const nameInput = page.locator('input[placeholder="e.g., My App"]');
		await expect(nameInput).toHaveValue('my-cool-project', { timeout: 2000 });
	});

	test('creates space and shows 3-column layout', async ({ page }) => {
		const workspaceRoot = await getWorkspaceRoot(page);

		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();
		await page.getByRole('button', { name: 'Create Space', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

		// Fill workspace path with the server's workspace root (guaranteed to exist)
		const pathInput = page.locator('input[placeholder*="/Users/you/projects"]');
		await pathInput.fill(workspaceRoot);

		// Set a unique name to avoid conflicts
		const nameInput = page.locator('input[placeholder="e.g., My App"]');
		await nameInput.fill(`E2E Space ${Date.now()}`);

		// Submit
		const submitButton = page.getByRole('dialog').getByRole('button', { name: 'Create Space' });
		await submitButton.click();

		// Wait for navigation to the new space
		await page.waitForURL(/\/space\/[a-f0-9-]+/, { timeout: 10000 });

		// Extract the space ID from the URL for cleanup
		const url = page.url();
		const match = url.match(/\/space\/([a-f0-9-]+)/);
		if (match) {
			createdSpaceId = match[1];
		}

		// Space layout should be visible
		// Left column: nav panel
		await expect(page.locator('text=No runs or tasks yet')).toBeVisible({ timeout: 5000 });
		// Middle column: dashboard (quick actions)
		await expect(page.locator('text=Quick Actions')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Start Workflow Run')).toBeVisible({ timeout: 3000 });
		await expect(page.locator('text=Create Task')).toBeVisible({ timeout: 3000 });
	});

	test('dialog can be closed with Cancel button', async ({ page }) => {
		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();
		await page.getByRole('button', { name: 'Create Space', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

		// Click Cancel
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();

		// Dialog should close
		await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3000 });
	});
});
