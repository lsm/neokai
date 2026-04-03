/**
 * Space ContextPanel Switching E2E Tests
 *
 * Verifies the Level 1 ↔ Level 2 switching in the ContextPanel:
 * - Level 1 (spaces list): SpaceContextPanel visible, "Spaces" header title
 * - Level 2 (space detail): SpaceDetailPanel visible, space name in header, back button present
 * - Back button navigates from detail back to list
 *
 * Setup: creates a space via RPC in beforeEach (infrastructure)
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

async function createSpaceByRpc(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	workspacePath: string,
	name: string
): Promise<string> {
	// Pre-creation cleanup: delete ALL existing spaces at this path (including archived).
	// Normalize macOS /private symlink prefix to avoid path mismatch.
	try {
		await page.evaluate(async (path) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			const norm = (p: string) => p.replace(/^\/private/, '');
			const spaces = (await hub.request('space.list', { includeArchived: true })) as Array<{
				id: string;
				workspacePath: string;
			}>;
			for (const space of spaces) {
				if (norm(space.workspacePath) === norm(path)) {
					await hub.request('space.delete', { id: space.id });
				}
			}
		}, workspacePath);
	} catch {
		// Best-effort cleanup
	}

	const spaceId = await page.evaluate(
		async ({ path, spaceName }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('No message hub');
			const res = await hub.request('space.create', { workspacePath: path, name: spaceName });
			return res?.id ?? res?.space?.id ?? '';
		},
		{ path: workspacePath, spaceName: name }
	);
	return spaceId as string;
}

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

test.describe('ContextPanel Space Switching (Level 1 ↔ Level 2)', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let createdSpaceId = '';
	let spaceName = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await expect(page.getByRole('button', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});

		const workspaceRoot = await getWorkspaceRoot(page);
		spaceName = `E2E SwitchTest ${Date.now()}`;
		createdSpaceId = await createSpaceByRpc(page, workspaceRoot, spaceName);
	});

	test.afterEach(async ({ page }) => {
		if (createdSpaceId) {
			await deleteSpaceByRpc(page, createdSpaceId);
			createdSpaceId = '';
		}
	});

	test('shows Spaces title and SpaceContextPanel when at spaces list level', async ({ page }) => {
		// Navigate to spaces section
		await page.getByRole('button', { name: 'Spaces', exact: true }).click();

		// Header should show "Spaces" — not "Home"
		await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// SpaceContextPanel should be visible (Create Space button is inside it)
		await expect(page.getByRole('button', { name: 'Create Space', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Back button should NOT be visible at list level
		await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();
	});

	test('shows SpaceDetailPanel with pinned items when a space is selected', async ({ page }) => {
		// Navigate to the space directly via URL
		await page.goto(`/space/${createdSpaceId}`);
		await waitForWebSocketConnected(page);

		// SpaceDetailPanel should render pinned items: Dashboard and Space Agent
		await expect(page.getByText('Dashboard')).toBeVisible({ timeout: 10000 });
		await expect(page.getByText('Space Agent')).toBeVisible({ timeout: 5000 });

		// Back button should be visible
		await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });
	});

	test('shows space name in ContextPanel header when inside a space', async ({ page }) => {
		await page.goto(`/space/${createdSpaceId}`);
		await waitForWebSocketConnected(page);

		// Header should show the space name
		await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 10000 });
	});

	test('back button navigates from space detail to spaces list', async ({ page }) => {
		// Start inside a space
		await page.goto(`/space/${createdSpaceId}`);
		await waitForWebSocketConnected(page);

		// Verify we're in space detail
		await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 10000 });

		// Click the back button
		await page.getByTitle('Back to Spaces').click();

		// Should now show the spaces list
		await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// SpaceContextPanel (Create Space button) should be visible
		await expect(page.getByRole('button', { name: 'Create Space', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Back button should be gone
		await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();
	});

	test('clicking a space from the list navigates to SpaceDetailPanel', async ({ page }) => {
		// Go to the spaces section list
		await page.getByRole('button', { name: 'Spaces', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Click on the created space in the list
		await page.getByText(spaceName).click();

		// Should now be inside the space — SpaceDetailPanel pinned items visible
		await expect(page.getByText('Dashboard')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });
	});
});
