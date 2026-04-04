/**
 * Agent Overlay Chat E2E Tests (M7.6)
 *
 * Verifies that clicking the "View Agent Session" button in SpaceTaskPane opens
 * an overlay chat panel on top of the task view instead of navigating away:
 *   - The overlay panel appears (data-testid="agent-overlay-chat")
 *   - The task view remains accessible underneath (URL unchanged)
 *   - The agent name label is shown in the overlay header
 *   - The close button (data-testid="agent-overlay-close") dismisses the overlay
 *   - Pressing Escape also dismisses the overlay
 *
 * Setup:
 *   - A unique workspace directory is created in beforeEach.
 *   - Space + task are created via RPC (infrastructure).
 *   - A human session is created via RPC and linked to the task as
 *     taskAgentSessionId, so "view-agent-session-btn" renders without needing
 *     a live AI session from the daemon.
 *
 * Cleanup:
 *   - Space is deleted via RPC in afterEach.
 *   - Session is deleted via RPC in afterEach.
 *   - Unique workspace directory is removed in afterEach.
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, navigation, keyboard).
 *   - All assertions check visible DOM state.
 *   - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown.
 *
 * Timeout conventions:
 *   - 10000ms: server round-trips (store hydration, RPC calls)
 *   - 5000ms:  local UI changes (button visibility, overlay toggle)
 */

import { existsSync, rmSync } from 'node:fs';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
	createSpaceViaRpc,
	createSpaceTaskViaRpc,
	createUniqueSpaceDir,
	deleteSpaceViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

interface OverlayTestContext {
	spaceId: string;
	taskId: string;
	sessionId: string;
	wsPath: string;
}

/**
 * Create a space with a task that has an agent session linked to it.
 *
 * A human (non-AI) session is created so that `taskAgentSessionId` is
 * populated on the task — this causes SpaceTaskPane to render
 * `data-testid="view-agent-session-btn"` without requiring a live agent.
 */
async function createSpaceWithTaskAndSession(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<OverlayTestContext> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);
	const wsPath = createUniqueSpaceDir(workspaceRoot, 'overlay');

	const spaceName = `E2E Overlay ${Date.now()}`;
	const spaceId = await createSpaceViaRpc(page, wsPath, spaceName);
	const taskId = await createSpaceTaskViaRpc(page, spaceId, 'Overlay test task');

	// Create a human session and link it to the task as taskAgentSessionId.
	// This avoids needing a live AI agent while still satisfying the UI condition
	// that shows "view-agent-session-btn".
	const sessionId = await page.evaluate(
		async ({ wsPath, spaceId, taskId }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// Create a lightweight session (no AI)
			const session = (await hub.request('session.create', {
				workspacePath: wsPath,
				createdBy: 'human',
			})) as { id: string };

			// Link the session to the task
			await hub.request('spaceTask.update', {
				spaceId,
				taskId,
				taskAgentSessionId: session.id,
			});

			return session.id;
		},
		{ wsPath, spaceId, taskId }
	);

	return { spaceId, taskId, sessionId, wsPath };
}

/**
 * Delete a session via RPC. Best-effort for afterEach cleanup.
 */
async function deleteSessionViaRpc(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	sessionId: string
): Promise<void> {
	if (!sessionId) return;
	try {
		await page.evaluate(async (id) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			await hub.request('session.delete', { sessionId: id });
		}, sessionId);
	} catch {
		// Best-effort cleanup
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Agent Overlay Chat', () => {
	// Serial mode: tests share describe-scoped state (spaceId/taskId/sessionId)
	// and each beforeEach creates a new space. Running in parallel would race on
	// the same module-level variables and produce unpredictable failures.
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';
	let taskId = '';
	let sessionId = '';
	let wsPath = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		const ctx = await createSpaceWithTaskAndSession(page);
		spaceId = ctx.spaceId;
		taskId = ctx.taskId;
		sessionId = ctx.sessionId;
		wsPath = ctx.wsPath;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			await deleteSessionViaRpc(page, sessionId);
			sessionId = '';
		}
		if (spaceId) {
			await deleteSpaceViaRpc(page, spaceId);
			spaceId = '';
		}
		taskId = '';
		if (wsPath && existsSync(wsPath)) {
			try {
				rmSync(wsPath, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup
			}
			wsPath = '';
		}
	});

	// ─── Test 1: "View Agent Session" button opens the overlay ──────────────

	test('clicking "View Agent Session" opens the agent overlay panel', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		// Wait for the task pane to load and the agent session button to appear.
		// "view-agent-session-btn" is rendered when task.taskAgentSessionId is set.
		await expect(page.getByTestId('view-agent-session-btn')).toBeVisible({ timeout: 10000 });

		// Click the button to open the overlay.
		await page.getByTestId('view-agent-session-btn').click();

		// The overlay panel must appear.
		await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 2: Task view remains accessible while overlay is open ─────────

	test('task view is still visible underneath while overlay is open', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		await expect(page.getByTestId('view-agent-session-btn')).toBeVisible({ timeout: 10000 });
		await page.getByTestId('view-agent-session-btn').click();

		// Overlay is open.
		await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

		// URL must NOT have changed — the task view is still the active route.
		expect(page.url()).toContain(`/space/${spaceId}/task/${taskId}`);

		// The task-thread-panel remains in the DOM (rendered underneath the overlay).
		await expect(page.getByTestId('task-thread-panel')).toBeAttached({ timeout: 5000 });
	});

	// ─── Test 3: Agent name is shown in the overlay header ──────────────────

	test('overlay header displays an agent name label', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		await expect(page.getByTestId('view-agent-session-btn')).toBeVisible({ timeout: 10000 });
		await page.getByTestId('view-agent-session-btn').click();

		await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

		// The header label must be visible and non-empty.
		const nameLabel = page.getByTestId('agent-overlay-name');
		await expect(nameLabel).toBeVisible({ timeout: 5000 });
		const labelText = await nameLabel.textContent();
		expect(labelText?.trim().length).toBeGreaterThan(0);
	});

	// ─── Test 4: Close button dismisses the overlay ──────────────────────────

	test('close button dismisses the overlay', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		await expect(page.getByTestId('view-agent-session-btn')).toBeVisible({ timeout: 10000 });
		await page.getByTestId('view-agent-session-btn').click();

		// Overlay is open.
		await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

		// Click the ✕ close button.
		await page.getByTestId('agent-overlay-close').click();

		// Overlay must be gone.
		await expect(page.getByTestId('agent-overlay-chat')).toBeHidden({ timeout: 5000 });

		// Task thread panel must still be visible.
		await expect(page.getByTestId('task-thread-panel')).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 5: Escape key dismisses the overlay ───────────────────────────

	test('pressing Escape dismisses the overlay', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		await expect(page.getByTestId('view-agent-session-btn')).toBeVisible({ timeout: 10000 });
		await page.getByTestId('view-agent-session-btn').click();

		// Overlay is open.
		await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

		// Press Escape.
		await page.keyboard.press('Escape');

		// Overlay must be gone.
		await expect(page.getByTestId('agent-overlay-chat')).toBeHidden({ timeout: 5000 });
	});
});
