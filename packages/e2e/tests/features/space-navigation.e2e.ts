/**
 * Comprehensive Space Navigation E2E Tests
 *
 * Exercises navigation paths that are NOT fully covered by the narrower test files:
 * - Space Agent: click "Space Agent" in SpaceDetailPanel → ChatContainer renders + active state
 * - Dashboard tab cycling: all 4 tabs (Dashboard/Agents/Workflows/Settings) are clickable
 * - Deep link: direct /space/:id/agent loads space with agent chat
 *
 * Also provides integration-level coverage for the two-layer nav flow as a single chain:
 * - Level 1→2: NavRail → SpaceContextPanel → click space → SpaceDetailPanel
 * - Task drill-down: create task → click → full-width pane → back → tabs return
 * - Level 2→1: back button → SpaceContextPanel + SpacesPage content
 *
 * Note: Space Agent and Dashboard use `data-testid="space-detail-agent"` /
 * `data-testid="space-detail-dashboard"` selectors to disambiguate the sidebar
 * pinned buttons from the SpaceIsland tab-bar buttons, which have identical
 * accessible names ("Dashboard", "Agents", etc.) but live in different DOM regions.
 *
 * Setup: creates a space via RPC in beforeEach (infrastructure)
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createSpaceViaRpc, deleteSpaceViaRpc } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

// Locator helpers — the sidebar and tab bar share the same button names, so we
// use data-testid for the sidebar pinned items to avoid ambiguity.
// "Agents" only exists in the tab bar (not the sidebar), so it is the canonical
// signal for "tab bar visible" / "tab bar hidden".
const TAB_BAR_SIGNAL = 'Agents'; // exists only in SpaceIsland tab bar

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
	// Level 1 → Level 2 transition (integration chain)
	// ---------------------------------------------------------------------------

	test('Level 1→2: NavRail Spaces → SpaceContextPanel → click space → SpaceDetailPanel', async ({
		page,
	}) => {
		// Navigate to Spaces via NavRail
		await page.getByRole('button', { name: 'Spaces', exact: true }).click();

		// SpaceContextPanel visible: "Create Space" button present
		await expect(page.getByRole('button', { name: 'Create Space', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Back button should NOT be visible at Level 1
		await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();

		// Click the created space to drill into Level 2
		await page.getByText(spaceName, { exact: true }).click();

		// SpaceDetailPanel: pinned sidebar items visible
		await expect(page.locator('[data-testid="space-detail-dashboard"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('[data-testid="space-detail-agent"]')).toBeVisible({ timeout: 5000 });

		// Back button present and space name in header
		await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 5000 });
	});

	// ---------------------------------------------------------------------------
	// Space Agent navigation + active state
	// ---------------------------------------------------------------------------

	test('Space Agent: click → ChatContainer renders → sidebar item is active', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Tab bar visible by default
		await expect(page.getByRole('button', { name: TAB_BAR_SIGNAL, exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Click "Space Agent" via the sidebar data-testid (avoids name ambiguity)
		await page.locator('[data-testid="space-detail-agent"]').click();

		// URL updates to agent sub-route
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// ChatContainer rendered — message textarea is the canonical signal
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });

		// Tab bar hidden (Agents tab button only exists in tab bar)
		await expect(page.getByRole('button', { name: TAB_BAR_SIGNAL, exact: true })).not.toBeVisible();

		// Sidebar "Space Agent" item should report active state via data-active attribute
		await expect(page.locator('[data-testid="space-detail-agent"]')).toHaveAttribute(
			'data-active',
			'true'
		);
	});

	// ---------------------------------------------------------------------------
	// Dashboard: click returns to tabbed view + all 4 tabs clickable
	// ---------------------------------------------------------------------------

	test('Dashboard: click → tabbed view returns → all 4 tabs clickable', async ({ page }) => {
		// Start in agent view so clicking Dashboard exercises the navigation
		await page.goto(`/space/${spaceId}/agent`);
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// Confirm tab bar is gone
		await expect(page.getByRole('button', { name: TAB_BAR_SIGNAL, exact: true })).not.toBeVisible({
			timeout: 5000,
		});

		// Click the Dashboard pinned item via data-testid
		await page.locator('[data-testid="space-detail-dashboard"]').click();

		// URL returns to base space route
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// All 4 tab buttons should now be visible and individually clickable.
		// Scope to data-testid="space-tab-bar" to avoid matching the sidebar pinned
		// "Dashboard" button, which shares the same accessible name.
		const tabBar = page.locator('[data-testid="space-tab-bar"]');
		await expect(tabBar).toBeVisible({ timeout: 5000 });
		for (const tabName of ['Dashboard', 'Agents', 'Workflows', 'Settings']) {
			const tab = tabBar.getByRole('button', { name: tabName, exact: true });
			await expect(tab).toBeVisible({ timeout: 5000 });
			await tab.click();
			await expect(tab).toBeVisible({ timeout: 2000 });
		}
	});

	// ---------------------------------------------------------------------------
	// Task drill-down (integration chain)
	// ---------------------------------------------------------------------------

	test('Task: click task → full-width pane → back → tabs return', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		await expect(page.getByRole('button', { name: TAB_BAR_SIGNAL, exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Create a task via Quick Action
		const taskTitle = `Nav Task ${Date.now()}`;
		await page.getByRole('button', { name: 'Create Task' }).first().click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await dialog.getByPlaceholder('e.g., Implement authentication module').fill(taskTitle);
		await dialog.getByRole('button', { name: 'Create Task' }).click();

		await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

		// Click task to open full-width pane
		await page.getByText(taskTitle, { exact: true }).first().click();
		await page.waitForURL(`/space/${spaceId}/task/**`, { timeout: 5000 });

		// Full-width task pane rendered
		await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

		// Tab bar hidden (Agents only exists in tab bar)
		await expect(page.getByRole('button', { name: TAB_BAR_SIGNAL, exact: true })).not.toBeVisible();

		// Back button in task pane returns to tab view
		await page.locator('[data-testid="task-back-button"]').click();
		await page.waitForURL(`/space/${spaceId}`, { timeout: 5000 });

		await expect(page.getByRole('button', { name: TAB_BAR_SIGNAL, exact: true })).toBeVisible({
			timeout: 3000,
		});
		await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
	});

	// ---------------------------------------------------------------------------
	// Level 2 → Level 1 back navigation
	// ---------------------------------------------------------------------------

	test('Level 2→1: back button → SpaceContextPanel + SpacesPage content', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 10000 });

		// Click back
		await page.getByTitle('Back to Spaces').click();

		// Level 1 restored
		await expect(page.getByRole('button', { name: 'Create Space', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();

		// SpacesPage renders the global spaces agent chat
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });
	});

	// ---------------------------------------------------------------------------
	// Deep link: /space/:id/agent
	// ---------------------------------------------------------------------------

	test('deep link /space/:id/agent → space loads with ChatContainer', async ({ page }) => {
		await page.goto(`/space/${spaceId}/agent`);
		await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

		// Wait for WS after hard navigation
		await waitForWebSocketConnected(page);

		// ContextPanel at Level 2 — space name in header
		await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 10000 });

		// SpaceDetailPanel sidebar items visible
		await expect(page.locator('[data-testid="space-detail-agent"]')).toBeVisible({ timeout: 5000 });

		// ChatContainer rendered
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 10000 });

		// Tab bar hidden
		await expect(page.getByRole('button', { name: TAB_BAR_SIGNAL, exact: true })).not.toBeVisible();
	});
});
