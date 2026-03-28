/**
 * Space Agent Chat E2E Tests
 *
 * Verifies that clicking "Space Agent" in SpaceDetailPanel renders ChatContainer
 * in the ContentPanel, and that navigating away returns to the tab view.
 *
 * Setup: creates a space via RPC (infrastructure), navigates to it
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

test.describe('Space Agent Chat', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const workspaceRoot = await getWorkspaceRoot(page);
		const spaceName = `E2E Agent Chat Test ${Date.now()}`;
		spaceId = await createSpaceViaRpc(page, workspaceRoot, spaceName);

		// Navigate to the space
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteSpaceViaRpc(page, spaceId);
			spaceId = '';
		}
	});

	test('clicking Space Agent in SpaceDetailPanel renders ChatContainer with message input', async ({
		page,
	}) => {
		// The space tab view should be visible by default
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Click "Space Agent" in the SpaceDetailPanel (context panel)
		await page.getByRole('button', { name: 'Space Agent', exact: true }).click();

		// URL should update to the agent route
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// ChatContainer should render — message input textarea should be visible
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });

		// The tab bar should no longer be visible (ChatContainer replaces it)
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).not.toBeVisible();
	});

	test('navigating back to space base route returns to tab view', async ({ page }) => {
		// Click Space Agent to enter chat view
		await page.getByRole('button', { name: 'Space Agent', exact: true }).click();
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// Message input should be visible
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });

		// Click Dashboard to return to space tab view
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Tab bar should be back
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Message input should no longer be visible
		await expect(messageInput).not.toBeVisible();
	});
});
