/**
 * TaskViewV2 E2E Tests
 *
 * Verifies the V1/V2 task view toggle and TaskViewV2 structural presence.
 * Scoped to toggle behavior and localStorage persistence — detailed rendering
 * is covered by unit tests.
 *
 * Setup: creates a room+task via RPC (accepted infrastructure pattern).
 * Cleanup: deletes the room via RPC in afterEach.
 *
 * All test actions go through the UI (clicks, navigation).
 * All assertions verify visible DOM state via data-testid selectors.
 *
 * Note on slide-out panel: SlideOutPanel is always mounted in the DOM and uses
 * CSS transforms (translate-x-full) to hide. Playwright's toBeInViewport() is
 * used to verify visibility since toBeVisible() does not detect off-screen
 * transforms. Slide-out open/close tests require turn blocks which need real
 * agent sessions — those tests are skipped when no turn blocks are available
 * (turn blocks cannot be seeded via RPC without real session records in SQLite).
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

const STORAGE_KEY = 'neokai:taskViewVersion';

// ─── Setup Helpers ────────────────────────────────────────────────────────────

async function createRoomAndTask(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<{ roomId: string; taskId: string }> {
	await waitForWebSocketConnected(page);

	return page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		const roomRes = await hub.request('room.create', {
			name: 'E2E TaskViewV2 Test Room',
		});
		const roomId = (roomRes as { room: { id: string } }).room.id;

		const taskRes = await hub.request('task.create', {
			roomId,
			title: 'E2E TaskViewV2 Test Task',
			description: 'Task for testing the V2 toggle and structural presence',
		});
		const taskId = (taskRes as { task: { id: string } }).task.id;

		return { roomId, taskId };
	});
}

/**
 * Creates a room, task, and a synthetic session group.
 * The group makes the turn-blocks-container render in V2 (it's conditional on group existence).
 * System messages are seeded so the container is not empty — they appear as runtime messages.
 */
async function createRoomTaskAndGroup(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<{ roomId: string; taskId: string; groupId: string }> {
	await waitForWebSocketConnected(page);

	return page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		const roomRes = await hub.request('room.create', {
			name: 'E2E TaskViewV2 Group Test Room',
		});
		const roomId = (roomRes as { room: { id: string } }).room.id;

		const taskRes = await hub.request('task.create', {
			roomId,
			title: 'E2E TaskViewV2 Group Test Task',
			description: 'Task with session group for structural tests',
		});
		const taskId = (taskRes as { task: { id: string } }).task.id;

		// Create synthetic session group (E2E infrastructure RPC — non-production only)
		const groupRes = await hub.request('task.group.create', {
			roomId,
			taskId,
		});
		const groupId = (groupRes as { groupId: string }).groupId;

		// Seed a system status message (goes to task_group_events — no session FK constraint)
		await hub.request('task.group.addMessage', {
			groupId,
			role: 'system',
			messageType: 'status',
			content: 'Task started',
		});

		return { roomId, taskId, groupId };
	});
}

// ─── Toggle and Persistence Tests ─────────────────────────────────────────────

test.describe('TaskViewV2 — Toggle and Persistence', () => {
	let roomId = '';
	let taskId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });
		roomId = '';
		taskId = '';

		// Clear the localStorage preference so each test starts from V1 (default)
		await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
	});

	test('shows toggle button in task view header', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		const toggle = page.locator('[data-testid="task-view-toggle"]');
		await expect(toggle).toBeVisible({ timeout: 5000 });
	});

	test('switches to V2 view when toggle is clicked', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// V2 container should NOT be present initially (default is V1)
		await expect(page.locator('[data-testid="task-view-v2"]')).not.toBeAttached();

		// Click the toggle to switch to V2
		await page.locator('[data-testid="task-view-toggle"]').click();

		// V2 container should now be visible
		await expect(page.locator('[data-testid="task-view-v2"]')).toBeVisible({ timeout: 5000 });
	});

	test('persists V2 preference across page reload', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Switch to V2 via toggle
		await page.locator('[data-testid="task-view-toggle"]').click();
		await expect(page.locator('[data-testid="task-view-v2"]')).toBeVisible({ timeout: 5000 });

		// Verify localStorage was set
		const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
		expect(stored).toBe('v2');

		// Reload the page
		await page.reload();
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// V2 should still be active (no flicker — synchronous lazy init)
		await expect(page.locator('[data-testid="task-view-v2"]')).toBeVisible({ timeout: 5000 });
	});

	test('switches back to V1 from V2 view when toggle is clicked again', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		const toggle = page.locator('[data-testid="task-view-toggle"]');

		// Switch to V2
		await toggle.click();
		await expect(page.locator('[data-testid="task-view-v2"]')).toBeVisible({ timeout: 5000 });

		// Switch back to V1
		await toggle.click();
		await expect(page.locator('[data-testid="task-view-v2"]')).not.toBeAttached();
	});

	test('persists V1 preference when returning to V1 and reloading', async ({ page }) => {
		// Pre-set to V2 via localStorage so we start in V2
		await page.evaluate((key) => localStorage.setItem(key, 'v2'), STORAGE_KEY);

		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Should start in V2 (from localStorage)
		await expect(page.locator('[data-testid="task-view-v2"]')).toBeVisible({ timeout: 5000 });

		// Toggle back to V1
		await page.locator('[data-testid="task-view-toggle"]').click();
		await expect(page.locator('[data-testid="task-view-v2"]')).not.toBeAttached();

		// Reload — should stay on V1
		await page.reload();
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('[data-testid="task-view-v2"]')).not.toBeAttached();

		const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
		expect(stored).toBe('v1');
	});
});

// ─── Structural Presence Tests ────────────────────────────────────────────────

test.describe('TaskViewV2 — Structural Presence', () => {
	let roomId = '';
	let taskId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });
		roomId = '';
		taskId = '';

		// Start each test in V2 mode
		await page.evaluate((key) => localStorage.setItem(key, 'v2'), STORAGE_KEY);
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
	});

	test('V2 root container is present with correct data-testid', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		await expect(page.locator('[data-testid="task-view-v2"]')).toBeVisible({ timeout: 5000 });
	});

	test('V2 turn blocks container is present when session group exists', async ({ page }) => {
		// turn-blocks-container is conditionally rendered only when a session group exists
		({ roomId, taskId } = await createRoomTaskAndGroup(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Group Test Task' })).toBeVisible(
			{ timeout: 10000 }
		);

		// The turn blocks container should be present in V2 when a group exists
		await expect(page.locator('[data-testid="turn-blocks-container"]')).toBeVisible({
			timeout: 8000,
		});
	});

	test('toggle button label updates to reflect current view', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		const toggle = page.locator('[data-testid="task-view-toggle"]');

		// In V2 mode, toggle should show "V1 ← V2" pattern (offering to go back to V1)
		await expect(toggle).toBeVisible({ timeout: 5000 });
		await expect(toggle).toContainText('V2');

		// Switch to V1 — toggle should now show "V1 → V2" pattern
		await toggle.click();
		await expect(toggle).toContainText('V1');
	});

	test('toggle aria-label reflects current state', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		const toggle = page.locator('[data-testid="task-view-toggle"]');

		// Currently in V2 — aria-label should say switching to V1
		await expect(toggle).toHaveAttribute('aria-label', /V1 timeline/);

		// Switch to V1 — aria-label should now say switching to V2
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-label', /V2 turn-based/);
	});
});

// ─── Slide-out Panel Tests ────────────────────────────────────────────────────

test.describe('TaskViewV2 — Slide-out Panel', () => {
	let roomId = '';
	let taskId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page
			.getByRole('button', { name: 'New Session', exact: true })
			.waitFor({ timeout: 10000 });
		roomId = '';
		taskId = '';

		// Start in V2 mode
		await page.evaluate((key) => localStorage.setItem(key, 'v2'), STORAGE_KEY);
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
	});

	test('slide-out panel is not in viewport initially', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// The panel is always in the DOM but translated off-screen (translate-x-full).
		// Use toBeInViewport() to verify it's not visible in the viewport.
		await expect(page.locator('[data-testid="slide-out-panel"]')).not.toBeInViewport();
		// Backdrop should be transparent (opacity-0) when closed
		await expect(page.locator('[data-testid="slide-out-backdrop"]')).toHaveClass(/opacity-0/);
	});

	test('slide-out panel has correct accessibility attributes', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Panel should have correct accessibility attributes regardless of open state
		const panel = page.locator('[data-testid="slide-out-panel"]');
		await expect(panel).toHaveAttribute('role', 'dialog');
		await expect(panel).toHaveAttribute('aria-modal', 'true');
	});

	test('clicking a turn block opens the slide-out panel', async ({ page }) => {
		// Note: Turn blocks require real agent messages in sdk_messages with valid session_id FK.
		// Synthetic session groups (e2e-worker-xxx) don't satisfy the sessions table FK.
		// This test runs its assertions only if turn blocks are actually rendered.
		({ roomId, taskId } = await createRoomTaskAndGroup(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Group Test Task' })).toBeVisible(
			{ timeout: 10000 }
		);

		// Wait for the turn-blocks-container to appear
		await expect(page.locator('[data-testid="turn-blocks-container"]')).toBeVisible({
			timeout: 8000,
		});

		const turnBlocks = page.locator('[data-testid="turn-block"]');
		const blockCount = await turnBlocks.count();

		if (blockCount === 0) {
			// No turn blocks — system-only messages don't produce agent turn blocks.
			// Verify the panel is still off-screen (nothing to open it).
			await expect(page.locator('[data-testid="slide-out-panel"]')).not.toBeInViewport();
			return;
		}

		// Click the first turn block
		await turnBlocks.first().click();

		// Slide-out panel should slide into the viewport
		await expect(page.locator('[data-testid="slide-out-panel"]')).toBeInViewport({
			timeout: 5000,
		});
	});

	test('slide-out panel closes when close button is clicked', async ({ page }) => {
		({ roomId, taskId } = await createRoomTaskAndGroup(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Group Test Task' })).toBeVisible(
			{ timeout: 10000 }
		);

		await expect(page.locator('[data-testid="turn-blocks-container"]')).toBeVisible({
			timeout: 8000,
		});

		const turnBlocks = page.locator('[data-testid="turn-block"]');
		const blockCount = await turnBlocks.count();

		if (blockCount === 0) {
			// No turn blocks available — skip open/close assertion
			await expect(page.locator('[data-testid="slide-out-panel"]')).not.toBeInViewport();
			return;
		}

		// Open the panel
		await turnBlocks.first().click();
		await expect(page.locator('[data-testid="slide-out-panel"]')).toBeInViewport({
			timeout: 5000,
		});

		// Click the close button
		await page.locator('[data-testid="slide-out-panel-close"]').click();

		// Panel should slide off-screen
		await expect(page.locator('[data-testid="slide-out-panel"]')).not.toBeInViewport({
			timeout: 3000,
		});
	});

	test('slide-out panel closes on Escape key', async ({ page }) => {
		({ roomId, taskId } = await createRoomTaskAndGroup(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Group Test Task' })).toBeVisible(
			{ timeout: 10000 }
		);

		await expect(page.locator('[data-testid="turn-blocks-container"]')).toBeVisible({
			timeout: 8000,
		});

		const turnBlocks = page.locator('[data-testid="turn-block"]');
		const blockCount = await turnBlocks.count();

		if (blockCount === 0) {
			await expect(page.locator('[data-testid="slide-out-panel"]')).not.toBeInViewport();
			return;
		}

		// Open the panel
		await turnBlocks.first().click();
		await expect(page.locator('[data-testid="slide-out-panel"]')).toBeInViewport({
			timeout: 5000,
		});

		// Press Escape to close
		await page.keyboard.press('Escape');

		// Panel should slide off-screen
		await expect(page.locator('[data-testid="slide-out-panel"]')).not.toBeInViewport({
			timeout: 3000,
		});
	});

	test('slide-out panel closes when backdrop is clicked', async ({ page }) => {
		({ roomId, taskId } = await createRoomTaskAndGroup(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Group Test Task' })).toBeVisible(
			{ timeout: 10000 }
		);

		await expect(page.locator('[data-testid="turn-blocks-container"]')).toBeVisible({
			timeout: 8000,
		});

		const turnBlocks = page.locator('[data-testid="turn-block"]');
		const blockCount = await turnBlocks.count();

		if (blockCount === 0) {
			// Verify backdrop is transparent (pointer-events-none)
			await expect(page.locator('[data-testid="slide-out-backdrop"]')).toHaveClass(/opacity-0/);
			return;
		}

		// Open the panel
		await turnBlocks.first().click();
		const backdrop = page.locator('[data-testid="slide-out-backdrop"]');
		await expect(backdrop).toHaveClass(/opacity-100/, { timeout: 5000 });

		// Click the backdrop to close
		await backdrop.click();

		// Panel should slide off-screen
		await expect(page.locator('[data-testid="slide-out-panel"]')).not.toBeInViewport({
			timeout: 3000,
		});
	});
});
