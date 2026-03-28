/**
 * Comprehensive Space Navigation E2E Tests
 *
 * Exercises the full two-layer space navigation flow:
 * - Level 1 (spaces list): NavRail → SpaceContextPanel in sidebar
 * - Level 2 (space detail): SpaceDetailPanel with Dashboard, Space Agent, Tasks
 * - Agent chat: SpaceDetailPanel "Space Agent" → ChatContainer in content area
 * - Dashboard: SpaceDetailPanel "Dashboard" → tabbed view with 4 clickable tabs
 * - Task drill-down: task click → full-width task pane → back → tabs return
 * - Back navigation: Level 2 → Level 1 via back button
 * - Deep link: direct navigation to /space/:id/agent
 *
 * Setup: creates a space via RPC in beforeEach (infrastructure)
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createSpaceViaRpc, deleteSpaceViaRpc } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Comprehensive Space Navigation', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';
	let spaceName = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const workspaceRoot = await getWorkspaceRoot(page);
		spaceName = `E2E SpaceNav ${Date.now()}`;
		spaceId = await createSpaceViaRpc(page, workspaceRoot, spaceName);
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteSpaceViaRpc(page, spaceId);
			spaceId = '';
		}
	});

	// ---------------------------------------------------------------------------
	// Level 1 → Level 2 transition
	// ---------------------------------------------------------------------------

	test('Level 1→2: NavRail Spaces → SpaceContextPanel → click space → SpaceDetailPanel', async ({
		page,
	}) => {
		// Navigate to Spaces via NavRail
		await page.getByRole('button', { name: 'Spaces', exact: true }).click();

		// SpaceContextPanel should be showing (Create Space button present)
		await expect(page.getByRole('button', { name: 'Create Space', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Level 1 heading visible
		await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Back button should NOT be visible at Level 1
		await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();

		// Click the created space in the list to drill into Level 2
		await page.getByText(spaceName).click();

		// SpaceDetailPanel should now show the two pinned items
		await expect(page.getByText('Dashboard')).toBeVisible({ timeout: 10000 });
		await expect(page.getByText('Space Agent')).toBeVisible({ timeout: 5000 });

		// Back button should be present
		await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });

		// Space name should appear in the ContextPanel header
		await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 5000 });
	});

	// ---------------------------------------------------------------------------
	// Space Agent
	// ---------------------------------------------------------------------------

	test('Space Agent: click in SpaceDetailPanel → ChatContainer renders → agent highlighted', async ({
		page,
	}) => {
		// Navigate directly into the space
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Verify tabbed dashboard is the default view
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Click "Space Agent" in SpaceDetailPanel sidebar
		await page.getByRole('button', { name: 'Space Agent', exact: true }).click();

		// URL should update to the agent route
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// ChatContainer must be rendered — the message textarea is the canonical signal
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });

		// Tab bar should be hidden (ChatContainer replaced it)
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).not.toBeVisible();

		// "Space Agent" item should be visually highlighted (has bg-dark-700 active class)
		// We verify it exists in the sidebar and does NOT look like an inactive item
		const spaceAgentBtn = page.getByRole('button', { name: 'Space Agent', exact: true });
		await expect(spaceAgentBtn).toBeVisible();
		await expect(spaceAgentBtn).toHaveClass(/bg-dark-700/);
	});

	// ---------------------------------------------------------------------------
	// Dashboard
	// ---------------------------------------------------------------------------

	test('Dashboard: click in SpaceDetailPanel → tabbed view returns → 4 tabs clickable', async ({
		page,
	}) => {
		// Start in agent view so we can verify Dashboard click returns to tabs
		await page.goto(`/space/${spaceId}/agent`);
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// Confirm we're in chat (no tab bar)
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).not.toBeVisible({
			timeout: 5000,
		});

		// Click "Dashboard" pinned item in SpaceDetailPanel
		await page.getByRole('button', { name: 'Dashboard', exact: true }).click();

		// URL should return to base space route
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// All 4 tab buttons should now be visible and clickable
		for (const tabName of ['Dashboard', 'Agents', 'Workflows', 'Settings']) {
			const tab = page.getByRole('button', { name: tabName, exact: true });
			await expect(tab).toBeVisible({ timeout: 5000 });
			await tab.click();
			// Each tab should remain selected (no crash)
			await expect(tab).toBeVisible({ timeout: 2000 });
		}
	});

	// ---------------------------------------------------------------------------
	// Task navigation
	// ---------------------------------------------------------------------------

	test('Task: click task → full-width task view → back → tabs return', async ({ page }) => {
		// Navigate to the space dashboard
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Create a task via the Quick Action button
		const taskTitle = `Nav Task ${Date.now()}`;
		await page.getByRole('button', { name: 'Create Task' }).first().click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await dialog.getByPlaceholder('e.g., Implement authentication module').fill(taskTitle);
		await dialog.getByRole('button', { name: 'Create Task' }).click();

		// Wait for the task to appear
		await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

		// Tab bar visible before drilling into task
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible();

		// Click the task title (first match) to open full-width task pane
		await page.getByText(taskTitle, { exact: true }).first().click();
		await page.waitForURL(`/space/${spaceId}/task/**`, { timeout: 5000 });

		// Full-width task pane should render
		await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

		// Tab bar should be hidden while task view is active
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).not.toBeVisible();

		// Click the back button in the task pane header
		await page.locator('[data-testid="task-back-button"]').click();

		// Should return to the base space route
		await page.waitForURL(`/space/${spaceId}`, { timeout: 5000 });

		// Tab bar should be visible again
		await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({
			timeout: 3000,
		});

		// Task pane should be gone
		await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
	});

	// ---------------------------------------------------------------------------
	// Level 2 → Level 1 back navigation
	// ---------------------------------------------------------------------------

	test('Level 2→1: back button in ContextPanel header → SpaceContextPanel + SpacesPage', async ({
		page,
	}) => {
		// Start inside the space at Level 2
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Confirm we're at Level 2 — SpaceDetailPanel is visible
		await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 10000 });
		await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 5000 });

		// Click the back button in the ContextPanel header
		await page.getByTitle('Back to Spaces').click();

		// Level 1 should be restored: SpaceContextPanel with Create Space button
		await expect(page.getByRole('button', { name: 'Create Space', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Level 1 heading should be visible
		await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Back button should be gone
		await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();

		// Content area should show the global spaces agent chat (SpacesPage)
		// SpacesPage renders ChatContainer with 'spaces:global' session — look for message input
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });
	});

	// ---------------------------------------------------------------------------
	// Deep link: /space/:id/agent
	// ---------------------------------------------------------------------------

	test('deep link /space/:id/agent → space loads with ChatContainer', async ({ page }) => {
		// Navigate directly to the agent sub-route (no prior navigation)
		await page.goto(`/space/${spaceId}/agent`);
		await waitForWebSocketConnected(page);
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// ContextPanel should be at Level 2 — space name in header
		await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 10000 });

		// SpaceDetailPanel pinned items should be visible
		await expect(page.getByText('Space Agent')).toBeVisible({ timeout: 5000 });

		// Content area must show ChatContainer
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });

		// Tab bar should NOT be visible (ChatContainer is active)
		await expect(page.getByRole('button', { name: 'Agents', exact: true })).not.toBeVisible();
	});
});
