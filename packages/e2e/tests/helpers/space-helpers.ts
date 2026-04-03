/**
 * Shared RPC helpers for space setup and teardown in E2E tests.
 *
 * These helpers are for test infrastructure only (beforeEach/afterEach).
 * All test actions and assertions must go through the browser UI.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Create a unique workspace subdirectory for a space test.
 *
 * Multiple E2E tests run in parallel and all share the same workspace root.
 * Since the `spaces` table has a UNIQUE constraint on `workspace_path`, parallel
 * tests that all try to create spaces at the workspace root will race and conflict.
 *
 * This helper creates a unique subdirectory within the workspace root so each
 * test gets its own isolated path. The directory is created synchronously (Node.js
 * side) before the space is created via RPC.
 *
 * @param workspaceRoot - The base workspace root (from `getWorkspaceRoot(page)`)
 * @param prefix - Optional prefix for the subdirectory name (for easier debugging)
 * @returns The unique subdirectory path
 */
export function createUniqueSpaceDir(workspaceRoot: string, prefix = 'space'): string {
	const uniqueDir = join(
		workspaceRoot,
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
	);
	mkdirSync(uniqueDir, { recursive: true });
	return uniqueDir;
}
