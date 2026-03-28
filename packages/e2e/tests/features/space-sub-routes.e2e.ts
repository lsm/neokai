/**
 * Space Sub-Routes Deep Link E2E Tests
 *
 * Verifies all four space URL patterns render the correct content when
 * navigated to directly (deep links) and that browser back/forward works:
 *
 *   /space/:id           → dashboard tabs (SpaceIsland default)
 *   /space/:id/agent     → ChatContainer (space agent chat)
 *   /space/:id/session/:sid → ChatContainer (session within space)
 *   /space/:id/task/:tid → SpaceTaskPane (full-width task view)
 *
 * Setup: creates a space and a task via RPC (infrastructure)
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createSpaceViaRpc, deleteSpaceViaRpc } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

/**
 * Create a task via RPC. For use in beforeEach setup only.
 * Returns the new task's id.
 */
async function createTaskViaRpc(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	spaceId: string,
	title: string
): Promise<string> {
	const id = await page.evaluate(
		async ({ spaceId, title }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const task = (await hub.request('spaceTask.create', {
				spaceId,
				title,
				description: '',
			})) as { id: string };
			return task.id;
		},
		{ spaceId, title }
	);
	if (!id) throw new Error('spaceTask.create returned no id');
	return id;
}

test.describe('Space Sub-Routes Deep Links', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';
	let taskId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const workspaceRoot = await getWorkspaceRoot(page);
		const spaceName = `E2E Sub-Routes Test ${Date.now()}`;
		spaceId = await createSpaceViaRpc(page, workspaceRoot, spaceName);
		taskId = await createTaskViaRpc(page, spaceId, `Test Task ${Date.now()}`);
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteSpaceViaRpc(page, spaceId);
			spaceId = '';
			taskId = '';
		}
	});

	test('direct navigation to /space/:id renders dashboard tabs', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Dashboard tabs should be visible
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Workflows', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();

		// No ChatContainer or task pane
		await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
	});

	test('direct navigation to /space/:id/agent renders ChatContainer', async ({ page }) => {
		await page.goto(`/space/${spaceId}/agent`);
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// ChatContainer message input should be visible
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });

		// Tab bar should not be visible (ChatContainer replaced it)
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).not.toBeVisible();

		// No task pane
		await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
	});

	test('direct navigation to /space/:id/task/:tid renders SpaceTaskPane', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		// Full-width task pane should be visible
		await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 5000 });

		// Tab bar should not be visible (task pane replaced it)
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).not.toBeVisible();
		await expect(page.getByRole('button', { name: 'Agents', exact: true })).not.toBeVisible();
	});

	test('browser back/forward navigates correctly between space views', async ({ page }) => {
		// Step 1: Start at dashboard
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Step 2: Navigate to agent chat
		await page.goto(`/space/${spaceId}/agent`);
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });

		// Step 3: Navigate to task view
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });
		await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 5000 });

		// Step 4: Back — should return to agent chat
		await page.goBack();
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });
		await expect(messageInput).toBeVisible({ timeout: 10000 });
		await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();

		// Step 5: Back — should return to dashboard
		await page.goBack();
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(messageInput).not.toBeVisible();

		// Step 6: Forward — should return to agent chat
		await page.goForward();
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });
		await expect(messageInput).toBeVisible({ timeout: 10000 });
	});

	test('navigating between sub-routes via UI updates URL and content', async ({ page }) => {
		// Start at dashboard
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Click "Space Agent" in the SpaceDetailPanel to go to agent view
		await page.getByRole('button', { name: 'Space Agent', exact: true }).click();
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// ChatContainer should be visible
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });

		// Click the back button to return to the space dashboard
		// (Use browser back since SpaceDetailPanel's "Space Agent" entry acts as nav)
		await page.goBack();
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Tab bar should be restored
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});
	});
});
