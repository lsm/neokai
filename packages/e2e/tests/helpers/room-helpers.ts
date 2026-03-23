/**
 * Shared RPC helpers for room setup and teardown in E2E tests.
 *
 * These helpers are for test infrastructure only (beforeEach/afterEach).
 * All test actions and assertions must go through the browser UI.
 */

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected } from './wait-helpers';

/**
 * Delete a room via RPC. Best-effort — silently ignores errors so it can be
 * used safely in afterEach without masking test failures.
 */
export async function deleteRoom(page: Page, roomId: string): Promise<void> {
	if (!roomId) return;
	try {
		await page.evaluate(async (id) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			await hub.request('room.delete', { roomId: id });
		}, roomId);
	} catch {
		// Best-effort cleanup
	}
}

/**
 * Navigate to the Missions tab on a room page.
 *
 * Uses `exact: true` to avoid matching the sidebar CollapsibleSection header
 * button (which has aria-label="Missions section" — accessible name is "Missions section",
 * not "Missions"). Only the room tab bar button has accessible name "Missions".
 */
export async function openMissionsTab(page: Page): Promise<void> {
	await waitForWebSocketConnected(page);
	const missionsTab = page.getByRole('button', { name: 'Missions', exact: true });
	await expect(missionsTab).toBeVisible({ timeout: 10000 });
	await missionsTab.click();
	await expect(page.locator('h2:has-text("Missions")')).toBeVisible({ timeout: 5000 });
}
