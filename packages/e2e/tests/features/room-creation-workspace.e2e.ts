/**
 * Room Creation with Workspace Path E2E Tests
 *
 * Verifies the CreateRoomModal flow:
 * - Opening the modal via "Create Room" button
 * - Workspace path field is visible and pre-populated from daemon workspaceRoot
 * - Validation: empty name, empty path, relative path all show errors
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
	 * Uses .first() to avoid strict-mode violation: both the header button and the
	 * empty-state RoomGrid button share the accessible name "Create Room".
	 */
	async function openCreateRoomModal(page: Parameters<typeof waitForWebSocketConnected>[0]) {
		await page.getByRole('button', { name: 'Create Room', exact: true }).first().click();
		// Wait for the modal title to appear (specific to the Create Room modal)
		await expect(page.locator('h2:has-text("Create Room")')).toBeVisible({ timeout: 5000 });
	}

	// ─── Modal Opens ─────────────────────────────────────────────────────────────

	test('opens Create Room dialog when button clicked', async ({ page }) => {
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
		await expect(pathInput).toHaveValue(workspaceRoot, { timeout: 3000 });
	});

	// ─── Validation Tests ─────────────────────────────────────────────────────────

	test('shows error when room name is empty on submit', async ({ page }) => {
		await openCreateRoomModal(page);

		// Name input is autoFocus and should be empty by default
		const nameInput = page.locator('input[placeholder*="Website Development"]');
		await nameInput.fill('');

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

	// ─── Successful Room Creation ─────────────────────────────────────────────────

	test('creates room and navigates to /room/:id', async ({ page }) => {
		const workspaceRoot = await getWorkspaceRoot(page);
		const roomName = `E2E Workspace Room ${Date.now()}`;

		await openCreateRoomModal(page);

		// Fill room name
		await page.locator('input[placeholder*="Website Development"]').fill(roomName);

		// Workspace path should already be pre-filled; verify and keep it
		await expect(page.locator('input[placeholder="/path/to/workspace"]')).toHaveValue(
			workspaceRoot,
			{ timeout: 3000 }
		);

		// Submit via the form's submit button
		await page.locator('button[type="submit"]').click();

		// Should navigate to /room/:id
		await page.waitForURL(/\/room\/[a-f0-9-]+/, { timeout: 10000 });

		// Extract room ID for cleanup
		const url = page.url();
		const match = url.match(/\/room\/([a-f0-9-]+)/);
		if (match) {
			createdRoomId = match[1];
		}

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
		await expect(page.locator('input[placeholder="/path/to/workspace"]')).toHaveValue(
			workspaceRoot,
			{ timeout: 3000 }
		);

		// Submit
		await page.locator('button[type="submit"]').click();

		// Wait for navigation
		await page.waitForURL(/\/room\/[a-f0-9-]+/, { timeout: 10000 });

		const url = page.url();
		const match = url.match(/\/room\/([a-f0-9-]+)/);
		if (match) {
			createdRoomId = match[1];
		}

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

	test('dialog can be closed with Cancel button', async ({ page }) => {
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

		const url = page.url();
		const match = url.match(/\/room\/([a-f0-9-]+)/);
		if (match) {
			createdRoomId = match[1];
		}

		// Room page should load
		await expect(page.getByRole('button', { name: 'Overview' }).first()).toBeVisible({
			timeout: 10000,
		});
	});
});
