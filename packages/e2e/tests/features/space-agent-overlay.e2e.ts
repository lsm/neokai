/**
 * Agent Overlay Chat E2E Tests (M7.6)
 *
 * Verifies that clicking the "View Agent Session" button in SpaceTaskPane opens
 * an overlay chat panel on top of the task view instead of navigating away:
 *   - The overlay panel appears (data-testid="agent-overlay-chat")
 *   - The task view remains accessible underneath (URL unchanged)
 *   - The agent name is surfaced via the dialog's aria-label
 *   - The back button in ChatHeader (data-testid="chat-header-back") dismisses the overlay
 *   - Pressing Escape also dismisses the overlay
 *   - Clicking the translucent backdrop also dismisses the overlay
 *
 * Setup:
 *   - A unique workspace directory is created in beforeEach.
 *   - Space + task are created via RPC (infrastructure).
 *   - A human session is created via RPC and linked to the task as
 *     taskAgentSessionId, so "view-agent-session-btn" renders without needing
 *     a live AI session from the daemon.
 *   - The task is transitioned to "done" status so SpaceTaskPane's useEffect
 *     skips the ensureTaskAgentSession call (which would clear the human
 *     session ID since it is not a real task-agent session), eliminating the
 *     race condition between the UI mount and the test click.
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
 *
 * The task is then set to `done` so that SpaceTaskPane's useEffect skips the
 * `ensureTaskAgentSession` call (the effect returns early for terminal tasks).
 * Without this, the daemon would clear the human session ID (it's not a real
 * task-agent session), causing a race condition against the test click.
 *
 * For a done task, `showHeaderSessionAction = !!runtimeSpaceId && !!agentSessionId`,
 * so the "View Agent Session" button still renders as long as `taskAgentSessionId`
 * is set.
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

	// Mark the task as done FIRST, then link the session. Order matters:
	// if the task were still in 'open' status when taskAgentSessionId is set,
	// the space runtime's tick loop could pick it up, call ensureTaskAgentSession,
	// fail to restore the human session (it's not a real task-agent session), and
	// clear taskAgentSessionId — a race condition that silently drops the button.
	// By transitioning to 'done' before setting the session ID, the runtime skips
	// this task entirely (it only processes non-terminal tasks). SpaceTaskPane also
	// skips the ensureTaskAgentSession useEffect for terminal tasks, so the session
	// ID stays set. The "View Agent Session" button still renders because
	// showHeaderSessionAction = !!runtimeSpaceId && !!agentSessionId (both truthy).
	const sessionId = await page.evaluate(
		async ({ wsPath, spaceId, taskId }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// 1. Mark as done first — prevents the space runtime from touching it.
			await hub.request('spaceTask.update', {
				spaceId,
				taskId,
				status: 'done',
			});

			// 2. Create a lightweight session (no AI).
			// session.create returns { sessionId, session } — not { id }.
			const { sessionId: newSessionId } = (await hub.request('session.create', {
				workspacePath: wsPath,
				createdBy: 'human',
			})) as { sessionId: string };

			// 3. Link the session to the now-done task. The runtime won't clear this
			//    because it only processes non-terminal tasks.
			await hub.request('spaceTask.update', {
				spaceId,
				taskId,
				taskAgentSessionId: newSessionId,
			});

			return newSessionId;
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
	// Serial mode: tests share describe-scoped let variables and each beforeEach
	// creates fresh state. Serial execution ensures those variables aren't
	// overwritten mid-test by another test's beforeEach on the same worker.
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

	// ─── Test 3: Agent identity surfaced via dialog aria-label ──────────────

	test('overlay surfaces the agent name via the dialog aria-label', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		await expect(page.getByTestId('view-agent-session-btn')).toBeVisible({ timeout: 10000 });
		await page.getByTestId('view-agent-session-btn').click();

		const overlay = page.getByTestId('agent-overlay-chat');
		await expect(overlay).toBeVisible({ timeout: 5000 });

		// The dialog wrapper's aria-label must be non-empty so screen readers
		// identify which agent is open. It's either `${agentName} chat` when we
		// have a name, or the fallback `Agent chat` — both are non-empty.
		const ariaLabel = await overlay.getAttribute('aria-label');
		expect(ariaLabel?.trim().length).toBeGreaterThan(0);
		expect(ariaLabel).toMatch(/chat$/);
	});

	// ─── Test 4: Back button dismisses the overlay ──────────────────────────

	test('back button in the chat header dismisses the overlay', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		await expect(page.getByTestId('view-agent-session-btn')).toBeVisible({ timeout: 10000 });
		await page.getByTestId('view-agent-session-btn').click();

		// Overlay is open.
		await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

		// The embedded ChatContainer owns the only header; its left-slot back
		// button (which replaces the mobile-menu button when `onBack` is set)
		// is the dismiss control.
		await page.getByTestId('chat-header-back').click();

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

	// ─── Test 6: Backdrop click dismisses the overlay ───────────────────────

	test('clicking the backdrop dismisses the overlay', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		await expect(page.getByTestId('view-agent-session-btn')).toBeVisible({ timeout: 10000 });
		await page.getByTestId('view-agent-session-btn').click();

		// Overlay is open.
		await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

		// Click the translucent backdrop (the aria-hidden div that fills the left
		// side of the screen). The slide-over panel is right-aligned (max-w-2xl),
		// so clicking at {x:100, y:100} relative to the full-screen backdrop lands
		// safely in the left area, away from the panel.
		const backdrop = page.getByTestId('agent-overlay-chat').locator('[aria-hidden="true"]').first();
		await backdrop.click({ position: { x: 100, y: 100 } });

		// Overlay must be gone.
		await expect(page.getByTestId('agent-overlay-chat')).toBeHidden({ timeout: 5000 });
	});
});
