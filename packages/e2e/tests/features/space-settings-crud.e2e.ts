/**
 * Space Settings CRUD E2E Tests
 *
 * Verifies:
 * - Navigating to the Settings tab of a space
 * - Editing space name and saving persists changes
 * - Discarding reverts edits without saving
 * - Archiving a space redirects to the spaces list
 * - Deleting a space redirects to the spaces list
 *
 * Setup: creates a space via RPC (infrastructure), navigates to its Settings tab
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
	const spaceId = await page.evaluate(
		async ({ workspacePath, name }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const result = (await hub.request('space.create', { workspacePath, name })) as {
				space: { id: string };
			};
			return result.space.id;
		},
		{ workspacePath, name }
	);
	return spaceId;
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

test.describe('Space Settings CRUD', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const workspaceRoot = await getWorkspaceRoot(page);
		const uniqueName = `E2E Settings Test ${Date.now()}`;
		spaceId = await createSpaceViaRpc(page, workspaceRoot, uniqueName);

		// Navigate to the space
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Click the Settings tab
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await expect(page.locator('text=Danger Zone')).toBeVisible({ timeout: 5000 });
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteSpaceViaRpc(page, spaceId);
			spaceId = '';
		}
	});

	test('renders settings tab with name, description, workspace path', async ({ page }) => {
		// Name input should be visible and contain the space name
		await expect(page.locator('input[type="text"]').first()).toBeVisible();

		// Workspace path should be shown as read-only text
		const workspaceRoot = await getWorkspaceRoot(page);
		await expect(page.locator(`text=${workspaceRoot}`)).toBeVisible({ timeout: 3000 });

		// Danger Zone section
		await expect(page.locator('text=Danger Zone')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
	});

	test('shows Save Changes button only when form is dirty', async ({ page }) => {
		// Save Changes not visible initially
		await expect(page.getByRole('button', { name: 'Save Changes' })).not.toBeVisible();

		// Type something in the name field
		const nameInput = page.locator('input[type="text"]').first();
		await nameInput.fill('New Space Name');

		// Save Changes should now appear
		await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible({ timeout: 2000 });
	});

	test('edits space name, saves, and persists the change', async ({ page }) => {
		const newName = `Renamed Space ${Date.now()}`;

		const nameInput = page.locator('input[type="text"]').first();
		await nameInput.fill(newName);

		// Accept the browser confirm dialog that may appear (archive/delete), and just save
		await page.getByRole('button', { name: 'Save Changes' }).click();

		// Toast notification of success
		await expect(page.locator('text=Space updated')).toBeVisible({ timeout: 5000 });

		// The input should now reflect the saved name
		await expect(nameInput).toHaveValue(newName, { timeout: 3000 });

		// Save Changes button should disappear (form is clean again)
		await expect(page.getByRole('button', { name: 'Save Changes' })).not.toBeVisible({
			timeout: 3000,
		});
	});

	test('Discard button reverts unsaved edits', async ({ page }) => {
		const nameInput = page.locator('input[type="text"]').first();
		const originalName = await nameInput.inputValue();

		await nameInput.fill('Temporary Name');
		await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible({ timeout: 2000 });

		await page.getByRole('button', { name: 'Discard' }).click();

		// Name should revert to original
		await expect(nameInput).toHaveValue(originalName, { timeout: 2000 });
		// Save Changes should disappear
		await expect(page.getByRole('button', { name: 'Save Changes' })).not.toBeVisible();
	});

	test('Archive space shows confirm dialog and redirects to spaces list', async ({ page }) => {
		// Accept the browser confirm dialog
		page.on('dialog', (dialog) => dialog.accept());

		await page.getByRole('button', { name: 'Archive', exact: true }).click();

		// Should redirect to /spaces
		await page.waitForURL('/spaces', { timeout: 10000 });
		await expect(page).toHaveURL('/spaces');

		// Space is now archived — no need for RPC cleanup in afterEach since it's not deleted
		// Re-delete via RPC in afterEach still handles it
	});

	test('Delete space shows confirm dialog and redirects to spaces list', async ({ page }) => {
		// Accept the browser confirm dialog
		page.on('dialog', (dialog) => dialog.accept());

		await page.getByRole('button', { name: 'Delete', exact: true }).click();

		// Should redirect to /spaces
		await page.waitForURL('/spaces', { timeout: 10000 });
		await expect(page).toHaveURL('/spaces');

		// Space is already deleted — don't double-delete in afterEach
		spaceId = '';
	});
});
