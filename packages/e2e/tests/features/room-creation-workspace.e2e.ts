/**
 * Room Creation with Workspace Path E2E Tests
 *
 * Verifies the CreateRoomModal flow:
 * - Opening the modal via "Create Room" button
 * - Workspace path field is visible and initially empty (no default since --workspace was removed)
 * - Validation: empty name, empty path, relative path show inline modal errors;
 *   non-existent path shows a toast error (lobbyStore catches the RPC error)
 *
 * Note: Room creation with a real workspace is skipped because:
 * 1. The --workspace flag was removed, so there's no default workspace root
 * 2. The E2E temp workspace path isn't accessible from the browser context
 * 3. Room creation requires a path that exists on disk and is known to the daemon
 *
 * Setup: navigates to lobby via UI for each test
 *
 * NOTE: The Neo panel sidebar also has role="dialog", so we target the Create Room
 * modal by its `h2` title heading or via `button[type="submit"]` within the form,
 * rather than using `page.getByRole('dialog')` which would cause strict-mode violations.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Room Creation with Workspace Path', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		// Wait for Lobby to be ready by checking the header title
		await expect(page.locator('h2:has-text("Neo Lobby")')).toBeVisible({ timeout: 10000 });
	});

	// ─── Helpers ─────────────────────────────────────────────────────────────────

	/**
	 * Open the Create Room modal.
	 * The ContextPanel has a disabled "Create Room" button - we use :not([disabled]) to exclude it.
	 */
	async function openCreateRoomModal(page: Page) {
		// The ContextPanel has a disabled "Create Room" button when not connected/authenticated.
		// Use button:not([disabled]) to target only enabled buttons.
		await page.locator('button:has-text("Create Room"):not([disabled])').click();
		// Wait for the modal title to appear (specific to the Create Room modal)
		await expect(page.locator('h2:has-text("Create Room")')).toBeVisible({ timeout: 5000 });
	}

	// ─── Modal Opens ─────────────────────────────────────────────────────────────

	test('opens Create Room modal when button clicked', async ({ page }) => {
		await openCreateRoomModal(page);

		// Verify modal-specific elements are visible
		await expect(page.locator('label:has-text("Workspace Path")')).toBeVisible({ timeout: 3000 });
		await expect(page.locator('label:has-text("Room Name")')).toBeVisible({ timeout: 3000 });
	});

	// ─── Workspace Path Field ─────────────────────────────────────────────────────

	test('workspace path field is visible and initially empty (no default workspace)', async ({
		page,
	}) => {
		await openCreateRoomModal(page);

		// Workspace path field should be visible
		const pathInput = page.locator('input[placeholder="/path/to/workspace"]');
		await expect(pathInput).toBeVisible({ timeout: 3000 });

		// Since --workspace flag was removed, the field should be empty
		await expect(pathInput).toHaveValue('', { timeout: 3000 });
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

	test('modal can be closed with Cancel button', async ({ page }) => {
		await openCreateRoomModal(page);

		await page.getByRole('button', { name: 'Cancel', exact: true }).click();

		// Modal is closed when its title heading is no longer visible
		await expect(page.locator('h2:has-text("Create Room")')).not.toBeVisible({ timeout: 3000 });
	});
});
