/**
 * TaskViewV2 E2E Tests
 *
 * Verifies the V1/V2 task view toggle and TaskViewV2 structural presence.
 * Scoped to toggle behavior and localStorage persistence — detailed rendering
 * is covered by unit tests.
 *
 * Setup: creates a room+task via RPC in beforeEach (accepted infrastructure pattern).
 * Cleanup: deletes the room via RPC in afterEach.
 *
 * All test actions go through the UI (clicks, navigation, keyboard).
 * All assertions verify visible DOM state via data-testid selectors.
 *
 * Slide-out panel note:
 * SlideOutPanel is always mounted in the DOM and uses CSS transforms
 * (translate-x-full) to hide rather than display:none. Assertions use
 * toHaveClass(/translate-x-full/) to verify closed state directly rather
 * than toBeInViewport() which is viewport-size sensitive. Open/close behavior
 * (clicking turn blocks) requires real agent session records to satisfy the
 * sdk_messages FK constraint — that coverage is documented as future work when
 * real session seeding infrastructure is available.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

const STORAGE_KEY = 'neokai:taskViewVersion';

// ─── RPC Infrastructure Helpers ───────────────────────────────────────────────

/**
 * Creates a room and task via RPC. Called from beforeEach — accepted
 * infrastructure pattern (CLAUDE.md: room.create in beforeEach is allowed;
 * task.create is an accepted extension for task-specific test isolation).
 */
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
 * Creates a room, task, and a synthetic session group with a seeded status
 * message. The group presence causes turn-blocks-container to render in V2
 * (the container is conditional on a session group existing). System-type
 * messages go to task_group_events (no session_id FK), so they avoid the
 * sessions-table FK constraint that blocks agent-message seeding.
 */
async function createRoomTaskAndGroup(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<{ roomId: string; taskId: string }> {
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

		// Create synthetic session group (non-production E2E RPC)
		const groupRes = await hub.request('task.group.create', { roomId, taskId });
		const { groupId } = groupRes as { groupId: string };

		// Seed a system status message (goes to task_group_events — no session FK constraint).
		// This makes the turn-blocks-container render; the message appears as a RuntimeMessage,
		// not a TurnBlock (agent messages with a valid sessions-table FK are needed for turn blocks).
		await hub.request('task.group.addMessage', {
			groupId,
			role: 'system',
			messageType: 'status',
			content: 'Task started',
		});

		return { roomId, taskId };
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

		// Ensure each test starts from V1 (default)
		await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

		// Infrastructure RPC setup (in beforeEach per E2E rules)
		({ roomId, taskId } = await createRoomAndTask(page));
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
		taskId = '';
	});

	test('shows toggle button in task view header', async ({ page }) => {
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		await expect(page.locator('[data-testid="task-view-toggle"]')).toBeVisible({ timeout: 5000 });
	});

	test('switches to V2 view when toggle is clicked', async ({ page }) => {
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// V2 container should not exist in V1 mode
		await expect(page.locator('[data-testid="task-view-v2"]')).not.toBeAttached();

		// Click the toggle to switch to V2
		await page.locator('[data-testid="task-view-toggle"]').click();

		// V2 container should now be visible
		await expect(page.locator('[data-testid="task-view-v2"]')).toBeVisible({ timeout: 5000 });
	});

	test('persists V2 preference across page reload', async ({ page }) => {
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Switch to V2 via toggle
		await page.locator('[data-testid="task-view-toggle"]').click();
		await expect(page.locator('[data-testid="task-view-v2"]')).toBeVisible({ timeout: 5000 });

		// Verify localStorage was updated
		const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
		expect(stored).toBe('v2');

		// Reload — synchronous lazy init prevents flicker so V2 should be active immediately
		await page.reload();
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});
		await expect(page.locator('[data-testid="task-view-v2"]')).toBeVisible({ timeout: 5000 });
	});

	test('switches back to V1 from V2 view when toggle is clicked again', async ({ page }) => {
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
		// Pre-set to V2 so we can test the V2→V1→reload flow
		await page.evaluate((key) => localStorage.setItem(key, 'v2'), STORAGE_KEY);

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

		// Start in V2 mode
		await page.evaluate((key) => localStorage.setItem(key, 'v2'), STORAGE_KEY);
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
		taskId = '';
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
		// turn-blocks-container is conditionally rendered only when a session group exists.
		// Create the group (and seed a status message) via RPC before navigating.
		({ roomId, taskId } = await createRoomTaskAndGroup(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Group Test Task' })).toBeVisible(
			{ timeout: 10000 }
		);

		await expect(page.locator('[data-testid="turn-blocks-container"]')).toBeVisible({
			timeout: 8000,
		});
	});

	test('toggle button shows directional arrow indicating current view', async ({ page }) => {
		// TaskViewToggle renders different arrow characters per state:
		//   V2 active → button text contains "←" (offering to go back to V1)
		//   V1 active → button text contains "→" (offering to go forward to V2)
		// Both states always contain the strings "V1" and "V2", so the arrow character
		// is the discriminating indicator.
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		const toggle = page.locator('[data-testid="task-view-toggle"]');

		// In V2 mode: button shows "V1 ← V2" (← indicates V2 is active)
		await expect(toggle).toBeVisible({ timeout: 5000 });
		await expect(toggle).toContainText('←');

		// After switching to V1: button shows "V1 → V2" (→ indicates V1 is active)
		await toggle.click();
		await expect(toggle).toContainText('→');
	});

	test('toggle aria-label reflects current view state', async ({ page }) => {
		({ roomId, taskId } = await createRoomAndTask(page));

		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		const toggle = page.locator('[data-testid="task-view-toggle"]');

		// Currently in V2 — aria-label offers to switch back to V1
		await expect(toggle).toHaveAttribute('aria-label', /V1 timeline/);

		// Switch to V1 — aria-label now offers to switch to V2
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

		// Start in V2 mode
		await page.evaluate((key) => localStorage.setItem(key, 'v2'), STORAGE_KEY);

		// Infrastructure RPC setup (in beforeEach per E2E rules)
		({ roomId, taskId } = await createRoomAndTask(page));
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
		taskId = '';
	});

	test('slide-out panel is off-screen when closed (translate-x-full)', async ({ page }) => {
		// SlideOutPanel is always mounted in the DOM; CSS transforms control visibility.
		// Check the translate-x-full class directly (more reliable than viewport intersection).
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		await expect(page.locator('[data-testid="slide-out-panel"]')).toHaveClass(/translate-x-full/, {
			timeout: 5000,
		});
	});

	test('slide-out backdrop is transparent when panel is closed (opacity-0)', async ({ page }) => {
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		// Backdrop uses opacity-0 + pointer-events-none when closed
		await expect(page.locator('[data-testid="slide-out-backdrop"]')).toHaveClass(/opacity-0/, {
			timeout: 5000,
		});
	});

	test('slide-out panel has correct accessibility attributes', async ({ page }) => {
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		const panel = page.locator('[data-testid="slide-out-panel"]');
		await expect(panel).toHaveAttribute('role', 'dialog');
		await expect(panel).toHaveAttribute('aria-modal', 'true');
	});

	test('slide-out panel close button has correct aria-label', async ({ page }) => {
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await expect(page.getByRole('heading', { name: 'E2E TaskViewV2 Test Task' })).toBeVisible({
			timeout: 10000,
		});

		await expect(page.locator('[data-testid="slide-out-panel-close"]')).toHaveAttribute(
			'aria-label',
			'Close panel'
		);
	});

	// NOTE: Open/close interaction tests (clicking turn blocks to open the panel,
	// closing via button/Escape/backdrop) require agent-turn messages in sdk_messages,
	// which need valid session_id FK references to the sessions table. Synthetic session
	// groups created via task.group.create use generated IDs (e2e-worker-xxx) that are
	// not in the sessions table. This coverage is reserved for when real session seeding
	// infrastructure (or daemon-level session stub creation) becomes available.
});
