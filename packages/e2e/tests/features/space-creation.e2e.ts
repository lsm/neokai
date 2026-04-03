/**
 * Space Creation E2E Tests
 *
 * Verifies:
 * - Navigating to the Spaces section (NavRail Spaces button + Create Space button visible)
 * - "Create Space" dialog opens
 * - Workspace path field is required
 * - Name auto-suggests from workspace path
 * - Creating a space navigates to it
 * - Space overview renders with tabbed layout (Active / Review / Done tabs)
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
		// Wait for the NavRail to be visible — deterministic signal that the app is ready
		await expect(page.getByRole('button', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});
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

		// ContextPanel should show the Spaces list view with "Spaces" heading and "Create Space" button
		await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByRole('button', { name: 'Create Space', exact: true })).toBeVisible({
			timeout: 5000,
		});
	});

	test('opens Create Space dialog when button clicked', async ({ page }) => {
		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();

		const createButton = page.getByRole('button', { name: 'Create Space', exact: true });
		await expect(createButton).toBeVisible({ timeout: 5000 });
		await createButton.click();

		// Dialog should appear
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Workspace Path')).toBeVisible({ timeout: 3000 });
	});

	test('workspace path is required — shows error on empty submit', async ({ page }) => {
		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();
		await page.getByRole('button', { name: 'Create Space', exact: true }).click();
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
		await page.getByRole('button', { name: 'Create Space', exact: true }).click();
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

		// Type a workspace path
		const pathInput = page.locator('input[placeholder*="/Users/you/projects"]');
		await pathInput.fill('/projects/my-cool-project');

		// Name should auto-suggest
		const nameInput = page.locator('input[placeholder="e.g., My App"]');
		await expect(nameInput).toHaveValue('my-cool-project', { timeout: 2000 });
	});

	test('creates space and shows tabbed dashboard layout', async ({ page }) => {
		const workspaceRoot = await getWorkspaceRoot(page);

		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();
		await page.getByRole('button', { name: 'Create Space', exact: true }).click();
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

		// Space overview (dashboard) should be visible
		await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 5000 });

		// The tabbed layout with Active / Review / Done tabs should render
		await expect(page.getByRole('button', { name: 'Active', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible({
			timeout: 5000,
		});
	});

	test('dialog can be closed with Cancel button', async ({ page }) => {
		const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
		await spacesButton.click();
		await page.getByRole('button', { name: 'Create Space', exact: true }).click();
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

		// Click Cancel
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();

		// Dialog should close
		await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3000 });
	});
});
