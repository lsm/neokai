/**
 * Shared RPC helpers for room setup and teardown in E2E tests.
 *
 * These helpers are for test infrastructure only (beforeEach/afterEach).
 * All test actions and assertions must go through the browser UI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected, getWorkspaceRoot } from './wait-helpers';

/**
 * Create a room via RPC. For use in beforeEach setup only.
 */
export async function createRoom(page: Page, name: string): Promise<string> {
	return page.evaluate(async (roomName) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const res = await hub.request('room.create', { name: roomName });
		return (res as { room: { id: string } }).room.id;
	}, name);
}

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

// ─── Task / Goal Creation ─────────────────────────────────────────────────────

/**
 * Create a task in a room via RPC. For use in beforeEach setup only.
 *
 * Returns the task's short ID (e.g. "t-3").
 */
export async function createTask(
	page: Page,
	roomId: string,
	title: string,
	description = ''
): Promise<string> {
	await waitForWebSocketConnected(page);
	return page.evaluate(
		async ({ rId, t, d }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('task.create', { roomId: rId, title: t, description: d });
			return (res as { task: { id: string } }).task.id;
		},
		{ rId: roomId, t: title, d: description }
	);
}

/**
 * Create a goal in a room via RPC. For use in beforeEach setup only.
 *
 * Returns the goal's short ID (e.g. "g-2").
 */
export async function createGoal(
	page: Page,
	roomId: string,
	title: string,
	description = ''
): Promise<string> {
	await waitForWebSocketConnected(page);
	return page.evaluate(
		async ({ rId, t, d }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('goal.create', {
				roomId: rId,
				title: t,
				description: d,
				priority: 'normal',
			});
			return (res as { goal: { id: string } }).goal.id;
		},
		{ rId: roomId, t: title, d: description }
	);
}

// ─── Delete Helpers ───────────────────────────────────────────────────────────

/**
 * Delete a task via RPC. Best-effort — silently ignores errors so it can be
 * used safely in afterEach without masking test failures.
 */
export async function deleteTask(page: Page, roomId: string, taskId: string): Promise<void> {
	if (!taskId) return;
	try {
		await page.evaluate(
			async ({ rId, tId }) => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub?.request) return;
				await hub.request('task.delete', { roomId: rId, taskId: tId });
			},
			{ rId: roomId, tId: taskId }
		);
	} catch {
		// Best-effort cleanup
	}
}

/**
 * Delete a goal via RPC. Best-effort — silently ignores errors so it can be
 * used safely in afterEach without masking test failures.
 */
export async function deleteGoal(page: Page, roomId: string, goalId: string): Promise<void> {
	if (!goalId) return;
	try {
		await page.evaluate(
			async ({ rId, gId }) => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub?.request) return;
				await hub.request('goal.delete', { roomId: rId, goalId: gId });
			},
			{ rId: roomId, gId: goalId }
		);
	} catch {
		// Best-effort cleanup
	}
}

// ─── Composite Setup Helpers ──────────────────────────────────────────────────

/**
 * Create a room with a task via RPC. Returns both IDs.
 * For use in beforeEach setup only.
 *
 * @param roomName - Optional explicit room name; defaults to `"${taskTitle} Room"`
 */
export async function createRoomWithTask(
	page: Page,
	taskTitle: string,
	taskDesc = '',
	roomName?: string
): Promise<{ roomId: string; taskId: string }> {
	const roomId = await createRoom(page, roomName ?? `${taskTitle} Room`);
	const taskId = await createTask(page, roomId, taskTitle, taskDesc);
	return { roomId, taskId };
}

/**
 * Create a room with a goal via RPC. Returns both IDs.
 * For use in beforeEach setup only.
 *
 * @param roomName - Optional explicit room name; defaults to `"${goalTitle} Room"`
 */
export async function createRoomWithGoal(
	page: Page,
	goalTitle: string,
	goalDesc = '',
	roomName?: string
): Promise<{ roomId: string; goalId: string }> {
	const roomId = await createRoom(page, roomName ?? `${goalTitle} Room`);
	const goalId = await createGoal(page, roomId, goalTitle, goalDesc);
	return { roomId, goalId };
}

/**
 * Create a room with both a task and a goal via RPC. Returns all IDs.
 * For use in beforeEach setup only.
 *
 * @param roomName - Optional explicit room name; defaults to `"${taskTitle}-${goalTitle} Room"`
 */
export async function createRoomWithTaskAndGoal(
	page: Page,
	taskTitle: string,
	goalTitle: string,
	taskDesc = '',
	goalDesc = '',
	roomName?: string
): Promise<{ roomId: string; taskId: string; goalId: string }> {
	const roomId = await createRoom(page, roomName ?? `${taskTitle}-${goalTitle} Room`);
	const taskId = await createTask(page, roomId, taskTitle, taskDesc);
	const goalId = await createGoal(page, roomId, goalTitle, goalDesc);
	return { roomId, taskId, goalId };
}

// ─── File Helpers ─────────────────────────────────────────────────────────────

/**
 * Create a test file in the workspace directory.
 * For use in beforeEach setup only — writes using Node.js fs (test process side).
 *
 * @param page - Playwright page (used to resolve workspace root)
 * @param filePath - Relative path within the workspace (e.g. "e2e-test/sample.ts")
 * @param content - File content to write
 * @returns Absolute path of the created file
 */
export async function createTestFile(
	page: Page,
	filePath: string,
	content: string
): Promise<string> {
	const workspaceRoot = await getWorkspaceRoot(page);
	const absPath = path.join(workspaceRoot, filePath);
	fs.mkdirSync(path.dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, content, 'utf-8');
	return absPath;
}

/**
 * Delete a test file from the workspace directory.
 * Best-effort — silently ignores errors so it can be used safely in afterEach.
 *
 * @param page - Playwright page (used to resolve workspace root)
 * @param filePath - Relative path within the workspace (same as passed to createTestFile)
 */
export async function deleteTestFile(page: Page, filePath: string): Promise<void> {
	try {
		const workspaceRoot = await getWorkspaceRoot(page);
		const absPath = path.join(workspaceRoot, filePath);
		if (fs.existsSync(absPath)) {
			fs.rmSync(absPath, { force: true });
		}
	} catch {
		// Best-effort cleanup
	}
}

// ─── Cleanup Helpers ──────────────────────────────────────────────────────────

/**
 * Delete a room and all associated entities via RPC.
 * Alias for deleteRoom — provided for semantic clarity in reference test teardown.
 * Best-effort — silently ignores errors so it can be used safely in afterEach.
 */
export async function cleanupRoom(page: Page, roomId: string): Promise<void> {
	await deleteRoom(page, roomId);
}

/**
 * Entity IDs collected during a test for bulk cleanup.
 *
 * - `roomIds`: Rooms to delete. Cascades to all tasks/goals inside them.
 * - `tasks`: Standalone tasks created in an existing room (not covered by room cascade).
 * - `goals`: Standalone goals created in an existing room (not covered by room cascade).
 * - `filePaths`: Workspace-relative file paths created by `createTestFile`.
 */
export interface CreatedEntities {
	roomIds?: string[];
	tasks?: Array<{ roomId: string; taskId: string }>;
	goals?: Array<{ roomId: string; goalId: string }>;
	filePaths?: string[];
}

/**
 * Bulk cleanup of all created entities.
 *
 * Deletes rooms (cascades tasks/goals), individual tasks/goals in existing rooms,
 * and workspace files. Best-effort — silently ignores errors.
 */
export async function cleanupAllCreatedEntities(
	page: Page,
	entities: CreatedEntities
): Promise<void> {
	const roomCleanups = (entities.roomIds ?? []).map((id) => cleanupRoom(page, id));
	const taskCleanups = (entities.tasks ?? []).map(({ roomId, taskId }) =>
		deleteTask(page, roomId, taskId)
	);
	const goalCleanups = (entities.goals ?? []).map(({ roomId, goalId }) =>
		deleteGoal(page, roomId, goalId)
	);
	const fileCleanups = (entities.filePaths ?? []).map((fp) => deleteTestFile(page, fp));
	await Promise.allSettled([...roomCleanups, ...taskCleanups, ...goalCleanups, ...fileCleanups]);
}
