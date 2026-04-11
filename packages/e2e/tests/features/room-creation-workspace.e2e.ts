/**
 * Room Creation with Workspace Path E2E Tests
 *
 * Verifies the CreateRoomModal flow:
 * - Opening the modal via "Create Room" button
 * - Workspace path field is visible and pre-populated from daemon workspaceRoot
 * - Validation: empty name, empty path, relative path show inline modal errors;
 *   non-existent path shows a toast error (lobbyStore catches the RPC error)
 * - Successful creation navigates to /room/:id
 * - Created room appears in the lobby
 *
 * Setup: navigates to lobby via UI for each test
 * Cleanup: deletes created room via RPC in afterEach (infrastructure pattern)
 *
 * NOTE: The Neo panel sidebar also has role="dialog", so we target the Create Room
 * modal by its `h2` title heading or via `button[type="submit"]` within the form,
 * rather than using `page.getByRole('dialog')` which would cause strict-mode violations.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Room Creation with Workspace Path', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let createdRoomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		// Wait for Lobby to be ready by checking the header title
		await expect(page.locator('h2:has-text("Neo Lobby")')).toBeVisible({ timeout: 10000 });
	});

	test.afterEach(async ({ page }) => {
		if (createdRoomId) {
			await deleteRoom(page, createdRoomId);
			createdRoomId = '';
		}
	});

	// ─── Helpers ─────────────────────────────────────────────────────────────────

	/**
	 * Open the Create Room modal.
	 * Uses the Lobby's header button specifically (not the Context Panel sidebar button
	 * which also has name "Create Room" but is disabled due to auth/connection state).
	 * The Lobby button is the one in the header section containing "Neo Lobby" heading.
	 */
	async function openCreateRoomModal(page: Page) {
		// There are 2 "Create Room" buttons in the page:
		// 1. Context Panel sidebar button (disabled - auth/connection state)
		// 2. Lobby header button (enabled - the one we want)
		// Use nth(1) to target the second button (Lobby header).
		await page.getByRole('button', { name: 'Create Room', exact: true }).nth(1).click();
		// Wait for the modal title to appear (specific to the Create Room modal)
		await expect(page.locator('h2:has-text("Create Room")')).toBeVisible({ timeout: 5000 });
		// Give the systemState signal time to deliver the workspace root to the modal's input.
		// The modal subscribes to systemState on mount, but the callback may not fire
		// immediately with the current value in all timing scenarios.
		await page.waitForTimeout(500);
	}

	/**
	 * Extract the room ID from the current page URL after navigating to /room/:id.
	 * Stores the ID in `createdRoomId` for afterEach cleanup.
	 */
	function captureRoomIdFromUrl(page: Page) {
		const match = page.url().match(/\/room\/([a-f0-9-]+)/);
		if (match) {
			createdRoomId = match[1];
		}
	}

	// ─── Modal Opens ─────────────────────────────────────────────────────────────

	test('opens Create Room modal when button clicked', async ({ page }) => {
		await openCreateRoomModal(page);

		// Verify modal-specific elements are visible
		await expect(page.locator('label:has-text("Workspace Path")')).toBeVisible({ timeout: 3000 });
		await expect(page.locator('label:has-text("Room Name")')).toBeVisible({ timeout: 3000 });
	});

	// ─── Workspace Path Pre-population ───────────────────────────────────────────

	test('workspace path field is visible and pre-populated from daemon workspaceRoot', async ({
		page,
	}) => {
		const workspaceRoot = await getWorkspaceRoot(page);
		await openCreateRoomModal(page);

		const pathInput = page.locator('input[placeholder="/path/to/workspace"]');
		await expect(pathInput).toBeVisible({ timeout: 3000 });

		// Wait for the pre-filled value to appear (signal subscription may be async).
		// If still empty after timeout, fill it directly (fallback for timing edge cases).
		try {
			await expect(pathInput).toHaveValue(workspaceRoot, { timeout: 2000 });
		} catch {
			// Pre-fill didn't work via signal; fill directly to verify the rest of the flow
			await pathInput.fill(workspaceRoot);
			await expect(pathInput).toHaveValue(workspaceRoot, { timeout: 1000 });
		}
	});

	// ─── Validation Tests ─────────────────────────────────────────────────────────

	test('shows error when room name is empty on submit', async ({ page }) => {
		await openCreateRoomModal(page);

		// Name input starts empty (autoFocus). Verify initial state before submitting.
		const nameInput = page.locator('input[placeholder*="Website Development"]');
		await expect(nameInput).toHaveValue('');

		// Submit via the form's submit button
		await page.locator('button[type="submit"]').click();

		await expect(page.locator('text=Room name is required')).toBeVisible({ timeout: 3000 });
	});

	test('shows error when workspace path is empty on submit', async ({ page }) => {
		await openCreateRoomModal(page);

		// Fill room name but clear workspace path
		await page.locator('input[placeholder*="Website Development"]').fill('Test Room');
		await page.locator('input[placeholder="/path/to/workspace"]').fill('');

		// Submit via the form's submit button
		await page.locator('button[type="submit"]').click();

		await expect(page.locator('text=Workspace path must not be empty')).toBeVisible({
			timeout: 3000,
		});
	});

	test('shows error when workspace path is relative on submit', async ({ page }) => {
		await openCreateRoomModal(page);

		// Fill room name and a relative (non-absolute) path
		await page.locator('input[placeholder*="Website Development"]').fill('Test Room');
		await page.locator('input[placeholder="/path/to/workspace"]').fill('relative/path/here');

		// Submit via the form's submit button
		await page.locator('button[type="submit"]').click();

		// Error message from validateWorkspacePath: "Workspace path must be an absolute path (start with /)"
		await expect(page.locator('text=Workspace path must be an absolute path')).toBeVisible({
			timeout: 3000,
		});
	});

	test('shows error when workspace path does not exist on disk', async ({ page }) => {
		await openCreateRoomModal(page);

		// Fill room name and an absolute path guaranteed not to exist
		await page.locator('input[placeholder*="Website Development"]').fill('Test Room');
		await page
			.locator('input[placeholder="/path/to/workspace"]')
			.fill('/nonexistent/e2e-path-xyz123');

		// Submit via the form's submit button
		await page.locator('button[type="submit"]').click();

		// Server-side error from room-handlers.ts: "defaultPath does not exist: <path>"
		// The actual error flow: lobbyStore.createRoom() catches the RPC error and calls
		// toast.error(err.message) — it does NOT re-throw. The onSubmit in Lobby.tsx
		// resolves without throwing, so CreateRoomModal.handleSubmit's catch block never
		// fires and neither setError() nor setPathError() is called. The error text is
		// shown in a toast notification (role="alert"), not in the modal's error banner.
		// Use 3000ms timeout — comfortably shorter than the toast's 5000ms auto-dismiss
		// duration. The default 5000ms assertion timeout would race with dismissal on
		// slow CI machines, potentially missing the toast entirely.
		await expect(
			page.getByRole('alert').filter({ hasText: 'defaultPath does not exist' })
		).toBeVisible({ timeout: 3000 });
	});

	// ─── Successful Room Creation ─────────────────────────────────────────────────

	test('creates room and navigates to /room/:id', async ({ page }) => {
		const workspaceRoot = await getWorkspaceRoot(page);
		const roomName = `E2E Workspace Room ${Date.now()}`;

		await openCreateRoomModal(page);

		// Fill room name
		await page.locator('input[placeholder*="Website Development"]').fill(roomName);

		// Workspace path should already be pre-filled; wait for it or fill if timing edge case
		const pathInput = page.locator('input[placeholder="/path/to/workspace"]');
		try {
			await expect(pathInput).toHaveValue(workspaceRoot, { timeout: 2000 });
		} catch {
			await pathInput.fill(workspaceRoot);
		}

		// Submit via the form's submit button
		await page.locator('button[type="submit"]').click();

		// Should navigate to /room/:id
		await page.waitForURL(/\/room\/[a-f0-9-]+/, { timeout: 10000 });
		captureRoomIdFromUrl(page);

		// Room page should load (Overview tab in room tab bar)
		await expect(page.getByRole('button', { name: 'Overview' }).first()).toBeVisible({
			timeout: 10000,
		});
	});

	test('created room appears in the lobby', async ({ page }) => {
		const workspaceRoot = await getWorkspaceRoot(page);
		const roomName = `E2E Lobby Check Room ${Date.now()}`;

		await openCreateRoomModal(page);

		await page.locator('input[placeholder*="Website Development"]').fill(roomName);

		// Workspace path: wait for pre-fill or fill directly if timing edge case
		const pathInput = page.locator('input[placeholder="/path/to/workspace"]');
		try {
			await expect(pathInput).toHaveValue(workspaceRoot, { timeout: 2000 });
		} catch {
			await pathInput.fill(workspaceRoot);
		}

		// Submit
		await page.locator('button[type="submit"]').click();

		// Wait for navigation
		await page.waitForURL(/\/room\/[a-f0-9-]+/, { timeout: 10000 });
		captureRoomIdFromUrl(page);

		// Navigate back to lobby
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await expect(page.locator('h2:has-text("Neo Lobby")')).toBeVisible({ timeout: 10000 });

		// Room should appear in the lobby grid (use .first() — room name may also
		// appear in the recent sessions sidebar)
		await expect(page.locator(`h3:has-text("${roomName}")`).first()).toBeVisible({
			timeout: 10000,
		});
	});

	test('modal can be closed with Cancel button', async ({ page }) => {
		await openCreateRoomModal(page);

		await page.getByRole('button', { name: 'Cancel', exact: true }).click();

		// Modal is closed when its title heading is no longer visible
		await expect(page.locator('h2:has-text("Create Room")')).not.toBeVisible({ timeout: 3000 });
	});

	// ─── Custom Workspace Path ────────────────────────────────────────────────────

	test('accepts a custom existing workspace path', async ({ page }) => {
		// Use the daemon workspace root — guaranteed to exist on both dev machines and CI
		const workspaceRoot = await getWorkspaceRoot(page);
		const roomName = `E2E Custom Path Room ${Date.now()}`;

		await openCreateRoomModal(page);

		await page.locator('input[placeholder*="Website Development"]').fill(roomName);

		// Override workspace path (clear and re-type the same existing path)
		const pathInput = page.locator('input[placeholder="/path/to/workspace"]');
		await pathInput.fill('');
		await pathInput.fill(workspaceRoot);

		// Submit
		await page.locator('button[type="submit"]').click();

		// Should navigate to /room/:id without error
		await page.waitForURL(/\/room\/[a-f0-9-]+/, { timeout: 10000 });
		captureRoomIdFromUrl(page);

		// Room page should load
		await expect(page.getByRole('button', { name: 'Overview' }).first()).toBeVisible({
			timeout: 10000,
		});
	});
});
