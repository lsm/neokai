/**
 * Mission Terminology E2E Tests
 *
 * Verifies that the UI displays "Mission" terminology (not "Goal") after the
 * Task 5 copy rename. Tests cover:
 * - "Missions" tab label in room page
 * - Empty state heading "No missions yet"
 * - Empty state call-to-action "Create Mission" button
 * - No residual "Goal" text visible to users
 *
 * Setup: creates a room via RPC (infrastructure), then tests the UI.
 * Cleanup: deletes the room via RPC in afterEach.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createRoom(page: Parameters<typeof waitForWebSocketConnected>[0]): Promise<string> {
	await waitForWebSocketConnected(page);
	return page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const res = await hub.request('room.create', {
			name: 'E2E Mission Terminology Test Room',
		});
		return (res as { room: { id: string } }).room.id;
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Mission Terminology', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		roomId = await createRoom(page);
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('should show "Missions" tab label in room page', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// The "Missions" tab button should be visible
		const missionsTab = page.locator('button:has-text("Missions")');
		await expect(missionsTab).toBeVisible({ timeout: 10000 });
	});

	test('should not show "Goals" tab label in room page', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Wait for tabs to render
		await expect(page.locator('button:has-text("Missions")')).toBeVisible({ timeout: 10000 });

		// There should be no "Goals" tab button in the DOM at all
		const goalsTab = page.locator('button:has-text("Goals")');
		await expect(goalsTab).not.toBeAttached();
	});

	test('should show "No missions yet" in empty state after clicking Missions tab', async ({
		page,
	}) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Click the Missions tab
		const missionsTab = page.locator('button:has-text("Missions")');
		await expect(missionsTab).toBeVisible({ timeout: 10000 });
		await missionsTab.click();

		// Empty state heading should read "No missions yet"
		await expect(page.locator('h3:has-text("No missions yet")')).toBeVisible({ timeout: 5000 });
	});

	test('should show "Create Mission" button in empty state', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Click the Missions tab
		const missionsTab = page.locator('button:has-text("Missions")');
		await expect(missionsTab).toBeVisible({ timeout: 10000 });
		await missionsTab.click();

		// Both the header button and the empty-state button should say "Create Mission"
		const createMissionButtons = page.locator('button:has-text("Create Mission")');
		await expect(createMissionButtons.first()).toBeVisible({ timeout: 5000 });
	});

	test('should show "Missions" heading inside the tab panel', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Click the Missions tab
		const missionsTab = page.locator('button:has-text("Missions")');
		await expect(missionsTab).toBeVisible({ timeout: 10000 });
		await missionsTab.click();

		// The GoalsEditor renders an <h2>Missions</h2> heading
		await expect(page.locator('h2:has-text("Missions")')).toBeVisible({ timeout: 5000 });
	});
});
