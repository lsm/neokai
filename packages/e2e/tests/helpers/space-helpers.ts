/**
 * Shared RPC helpers for space setup and teardown in E2E tests.
 *
 * These helpers are for test infrastructure only (beforeEach/afterEach).
 * All test actions and assertions must go through the browser UI.
 */

import type { Page } from '@playwright/test';

/**
 * Create a space via RPC. For use in beforeEach setup only.
 * Returns the new space's id.
 */
export async function createSpaceViaRpc(
	page: Page,
	workspacePath: string,
	name: string
): Promise<string> {
	const id = await page.evaluate(
		async ({ workspacePath, name }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			// space.create returns the Space object directly (not wrapped in { space: ... })
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

/**
 * Delete a space via RPC. Best-effort — silently ignores errors so it can be
 * used safely in afterEach without masking test failures.
 */
export async function deleteSpaceViaRpc(page: Page, spaceId: string): Promise<void> {
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
