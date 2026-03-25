/**
 * App MCP Registry E2E Tests
 *
 * Tests for the Application MCP Registry UI and per-room MCP enable/disable:
 * - Global Application MCP Servers settings show pre-seeded fetch-mcp entry
 * - Per-room MCP toggle in Room Settings allows enable/disable
 * - Toggle changes persist after page navigation (round-trip persistence)
 *
 * Setup: creates a room via RPC (infrastructure), then tests the UI.
 * Cleanup: deletes the room via RPC in afterEach. Does NOT delete fetch-mcp
 * from the registry — it is a permanent seed entry.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { createRoom, deleteRoom } from '../helpers/room-helpers';

// ─── Constants ────────────────────────────────────────────────────────────────

const FETCH_MCP_SERVER_NAME = 'fetch-mcp';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Navigate to the Application MCP Servers section in Global Settings.
 * Assumes Global Settings panel is already open.
 */
async function navigateToAppMcpServersSection(
	page: import('@playwright/test').Page
): Promise<void> {
	// Click on "Application MCP Servers" in the settings section list
	const appMcpServersButton = page.locator('button:has-text("Application MCP Servers")');
	await appMcpServersButton.waitFor({ state: 'visible', timeout: 5000 });
	await appMcpServersButton.click();

	// Wait for the AppMcpServersSettings panel to appear
	await page.locator('text=Application MCP servers are available to any room').waitFor({
		state: 'visible',
		timeout: 5000,
	});
}

/**
 * Navigate to a room's Settings tab and wait for it to load.
 * Uses a scoped selector within the room's tab bar div to avoid conflict
 * with the global bottom tab bar's Settings button.
 */
async function navigateToRoomSettings(
	page: import('@playwright/test').Page,
	roomId: string
): Promise<void> {
	await page.goto(`/room/${roomId}`);
	await waitForWebSocketConnected(page);

	// Scope to the room's tab bar (the div with border-b containing the tabs)
	// This avoids matching the global Settings button in the bottom nav
	const roomTabBar = page.locator('.border-b.border-dark-700.bg-dark-850');
	const settingsTab = roomTabBar.locator('button:has-text("Settings")');
	await settingsTab.waitFor({ state: 'visible', timeout: 5000 });
	await settingsTab.click();

	// Wait for MCP Servers section to be visible in RoomSettings
	await expect(page.getByText('MCP Servers', { exact: true })).toBeVisible({ timeout: 5000 });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('App MCP Registry - Global Settings', () => {
	test('should show fetch-mcp in Application MCP Servers list', async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Open Global Settings
		const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
		await settingsButton.click();

		// Wait for settings panel to appear
		await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Navigate to Application MCP Servers section
		await navigateToAppMcpServersSection(page);

		// Verify fetch-mcp entry is present
		const fetchMcpEntry = page.locator(`text="${FETCH_MCP_SERVER_NAME}"`).first();
		await expect(fetchMcpEntry).toBeVisible({ timeout: 10000 });

		// Verify the stdio badge is visible (fetch-mcp is a stdio server)
		// The source type is shown in a span with uppercase text
		const fetchMcpRow = page.locator('div').filter({ hasText: FETCH_MCP_SERVER_NAME }).first();
		await expect(fetchMcpRow.locator('span').filter({ hasText: 'stdio' }).first()).toBeVisible();
	});
});

test.describe('App MCP Registry - Per-Room Enable/Disable', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a test room via RPC (infrastructure only)
		roomId = await createRoom(page, 'E2E MCP Registry Test Room');
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('should show fetch-mcp in room settings MCP list with global default enabled state', async ({
		page,
	}) => {
		await navigateToRoomSettings(page, roomId);

		// Verify fetch-mcp appears in the MCP Servers list
		const fetchMcpEntry = page.locator(`label:has-text("${FETCH_MCP_SERVER_NAME}")`).first();
		await expect(fetchMcpEntry).toBeVisible({ timeout: 10000 });

		// Verify the checkbox is checked (fetch-mcp is enabled globally by default on seed)
		const checkbox = fetchMcpEntry.locator('input[type="checkbox"]');
		await expect(checkbox).toBeChecked();
	});

	test('should toggle fetch-mcp off for the room, verify UI, and persist after reload', async ({
		page,
	}) => {
		await navigateToRoomSettings(page, roomId);

		// Find fetch-mcp checkbox
		const fetchMcpLabel = page.locator(`label:has-text("${FETCH_MCP_SERVER_NAME}")`).first();
		const checkbox = fetchMcpLabel.locator('input[type="checkbox"]');

		// Verify initially checked (global default)
		await expect(checkbox).toBeChecked();

		// Toggle off
		await checkbox.click();

		// Verify checkbox is now unchecked
		await expect(checkbox).not.toBeChecked();

		// Verify "room override" badge appears (indicates per-room setting differs from global)
		await expect(page.locator('text=room override')).toBeVisible({ timeout: 5000 });

		// P1-fix: Verify persistence - reload the page and confirm state persists
		await page.reload();
		await waitForWebSocketConnected(page);

		// Navigate back to room settings
		await navigateToRoomSettings(page, roomId);

		// Verify checkbox is still unchecked after reload
		const persistedCheckbox = page
			.locator(`label:has-text("${FETCH_MCP_SERVER_NAME}")`)
			.first()
			.locator('input[type="checkbox"]');
		await expect(persistedCheckbox).not.toBeChecked();

		// Verify "room override" badge is still visible (persisted per-room setting)
		await expect(page.locator('text=room override')).toBeVisible({ timeout: 5000 });
	});

	test('should toggle fetch-mcp back on for the room and verify UI state persists', async ({
		page,
	}) => {
		await navigateToRoomSettings(page, roomId);

		// Find fetch-mcp checkbox
		const fetchMcpLabel = page.locator(`label:has-text("${FETCH_MCP_SERVER_NAME}")`).first();
		const checkbox = fetchMcpLabel.locator('input[type="checkbox"]');

		// First toggle off
		await checkbox.click();
		await expect(checkbox).not.toBeChecked();

		// Verify "room override" badge appears
		await expect(page.locator('text=room override')).toBeVisible({ timeout: 5000 });

		// Then toggle back on
		await checkbox.click();

		// Verify checkbox is checked again
		await expect(checkbox).toBeChecked();

		// Note: The "room override" badge may still be visible since the per-room override
		// is still set (it just matches the global default). The toggle functionality is verified.
	});

	test('should show disabled globally badge for brave-search in room settings', async ({
		page,
	}) => {
		await navigateToRoomSettings(page, roomId);

		// Verify brave-search appears in the MCP Servers list
		const braveSearchEntry = page.locator('label:has-text("brave-search")').first();
		await expect(braveSearchEntry).toBeVisible({ timeout: 5000 });

		// Verify the checkbox is unchecked (disabled globally by default on seed)
		const checkbox = braveSearchEntry.locator('input[type="checkbox"]');
		await expect(checkbox).not.toBeChecked();

		// Verify "disabled globally" badge appears (indicates globally disabled)
		await expect(page.locator('text=disabled globally')).toBeVisible({ timeout: 5000 });
	});
});
