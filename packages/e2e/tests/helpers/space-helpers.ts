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
	// Pre-creation cleanup: delete any existing space at this path (including archived)
	await cleanupExistingSpace(page, workspacePath);

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
 * Create a standalone task in a space via RPC. For use in test setup only.
 * Returns the new task's id.
 */
export async function createSpaceTaskViaRpc(
	page: Page,
	spaceId: string,
	title: string,
	description = ''
): Promise<string> {
	const id = await page.evaluate(
		async ({ spaceId, title, description }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const task = (await hub.request('spaceTask.create', {
				spaceId,
				title,
				description,
			})) as { id: string };
			return task.id;
		},
		{ spaceId, title, description }
	);
	if (!id) throw new Error('spaceTask.create returned no id');
	return id;
}

/**
 * Delete any existing space at the given workspace path (including archived ones).
 * Prevents UNIQUE constraint violations when tests reuse the same workspace path.
 */
async function cleanupExistingSpace(page: Page, workspacePath: string): Promise<void> {
	try {
		await page.evaluate(async (path) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			// Normalize macOS /private symlink prefix before comparing
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
}
