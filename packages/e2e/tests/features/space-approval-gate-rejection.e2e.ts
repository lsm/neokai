/**
 * Approval Gate Rejection E2E Tests (M8.3)
 *
 * Tests human rejection via the artifacts view and direct popup action:
 * - Proceeding to plan-approval-gate (waiting_human state at run start)
 * - Rejecting via GateArtifactsView (View Artifacts → Reject button)
 * - Rejecting directly from the gate popup (without opening artifacts)
 * - Workflow run transitions to needs_attention state on canvas
 * - Canvas shows "Workflow paused — awaiting approval" banner
 * - Gate shows blocked state (red lock icon)
 * - Space remains usable after rejection (tabs navigate, canvas visible)
 *
 * Setup:
 *   - Space is created via RPC in beforeEach (infrastructure).
 *   - Workflow run is started via RPC in beforeEach (infrastructure).
 *
 * Cleanup:
 *   - Workflow run is cancelled via RPC in afterEach.
 *   - Space is deleted via RPC in afterEach.
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, navigation, keyboard).
 *   - All assertions check visible DOM state.
 *   - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown.
 *
 * Note: The plan-approval-gate is ALWAYS in `waiting_human` state at the start of a run
 * because its condition is `{ type: 'check', field: 'approved' }` and no gate data has
 * been written yet. Rejection sets approved=false → gate becomes `blocked`, and the run
 * transitions to `needs_attention` with failureReason `humanRejected`.
 *
 * Timeout conventions:
 *   - 10000ms: state transitions requiring a server round-trip (gate data load, run status)
 *   - 5000ms: UI-only changes (popup visibility, overlay open/close, tab content)
 */

import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

async function createSpaceWithRun(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<{ spaceId: string; runId: string }> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);
	// Use a unique subdirectory to avoid conflicts with other parallel tests
	// (workspace_path has a UNIQUE constraint in the DB).
	const wsPath = createUniqueSpaceDir(workspaceRoot, 'gate-rejection');

	return page.evaluate(
		async ({ wsPath }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// Create the space (preset agents + workflow are auto-seeded by the daemon).
			const spaceRes = (await hub.request('space.create', {
				name: `E2E Rejection ${Date.now()}`,
				workspacePath: wsPath,
			})) as { id: string };
			const spaceId = spaceRes.id;

			// Start a workflow run so the canvas enters runtime mode.
			const runRes = (await hub.request('spaceWorkflowRun.start', {
				spaceId,
				title: 'E2E: Rejection test task',
				description: 'Implement a feature to test rejection flow.',
			})) as { run: { id: string } };
			const runId = runRes.run.id;

			return { spaceId, runId };
		},
		{ wsPath }
	);
}

async function cancelRun(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	runId: string
): Promise<void> {
	try {
		await page.evaluate(async (rid) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			await hub.request('spaceWorkflowRun.cancel', { id: rid });
		}, runId);
	} catch {
		// Best-effort cleanup
	}
}

async function deleteSpace(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	spaceId: string
): Promise<void> {
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

// ─── UI action helpers ────────────────────────────────────────────────────────

/**
 * Waits for the canvas to be fully initialized (SVG rendered + gate data loaded),
 * then rejects the waiting_human gate via the action popup.
 * Resolves once the gate-icon-blocked state is visible on the canvas.
 */
async function rejectViaPopup(page: Page): Promise<void> {
	// Wait for canvas to be in runtime mode with gate data fetched.
	// Both the container and SVG must be visible before gate icons appear.
	await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 10000 });
	await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 10000 });

	// Gate data is fetched async after canvas renders; wait for the gate icon.
	const waitingGate = page.getByTestId('gate-icon-waiting_human');
	await expect(waitingGate).toBeVisible({ timeout: 10000 });

	// Open the action popup.
	await waitingGate.click();
	await expect(page.locator('button:has-text("Reject")').first()).toBeVisible({ timeout: 5000 });

	// Click Reject in the popup.
	await page.locator('button:has-text("Reject")').first().click();

	// Wait for the server round-trip: run transitions to needs_attention + gate becomes blocked.
	await expect(page.getByTestId('gate-icon-blocked')).toBeVisible({ timeout: 10000 });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Approval Gate Rejection', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';
	let runId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		const ids = await createSpaceWithRun(page);
		spaceId = ids.spaceId;
		runId = ids.runId;
	});

	test.afterEach(async ({ page }) => {
		if (runId) {
			await cancelRun(page, runId);
			runId = '';
		}
		if (spaceId) {
			await deleteSpace(page, spaceId);
			spaceId = '';
		}
	});

	// ─── Test 1: Reject via GateArtifactsView closes overlay and transitions run ──

	test('rejecting via GateArtifactsView closes overlay and transitions run to needs_attention', async ({
		page,
	}) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Wait for canvas to be fully initialized (container + SVG + gate data).
		await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 10000 });

		// The plan-approval-gate starts in waiting_human (amber pulsing).
		const waitingGate = page.getByTestId('gate-icon-waiting_human');
		await expect(waitingGate).toBeVisible({ timeout: 10000 });

		// Open the action popup.
		await waitingGate.click();
		await expect(page.getByTestId('view-artifacts-btn')).toBeVisible({ timeout: 5000 });

		// Open the artifacts overlay.
		await page.getByTestId('view-artifacts-btn').click();
		await expect(page.getByTestId('artifacts-panel-overlay')).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId('gate-artifacts-view')).toBeVisible({ timeout: 5000 });

		// Wait for the loading state to resolve before clicking Reject.
		await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

		// Click Reject.
		await page.getByTestId('reject-button').click();

		// Overlay should close after the rejection decision.
		await expect(page.getByTestId('artifacts-panel-overlay')).toBeHidden({ timeout: 5000 });

		// The gate should now show as "blocked" (red lock) on the canvas.
		await expect(page.getByTestId('gate-icon-blocked')).toBeVisible({ timeout: 10000 });

		// Canvas banner: "Workflow paused — awaiting approval" (run.failureReason === 'humanRejected').
		await expect(page.locator('text=Workflow paused — awaiting approval')).toBeVisible({
			timeout: 10000,
		});
	});

	// ─── Test 2: Reject directly from gate popup without opening artifacts ────

	test('rejecting directly from gate popup sets gate to blocked without opening overlay', async ({
		page,
	}) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		await rejectViaPopup(page);

		// Overlay must NOT have appeared (we never opened it).
		await expect(page.getByTestId('artifacts-panel-overlay')).toBeHidden({ timeout: 5000 });

		// Canvas banner should indicate needs_attention.
		await expect(page.locator('text=Workflow paused — awaiting approval')).toBeVisible({
			timeout: 10000,
		});
	});

	// ─── Test 3: Canvas shows error/attention state after rejection ───────────

	test('canvas shows needs_attention banner and blocked gate after rejection', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		await rejectViaPopup(page);

		// Canvas shows the needs_attention banner.
		await expect(page.locator('text=Workflow paused — awaiting approval')).toBeVisible({
			timeout: 5000,
		});

		// The canvas container and SVG are still present (not replaced by an error fallback).
		await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 4: Space remains usable after rejection ─────────────────────────

	test('space remains fully navigable and usable after gate rejection', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		await rejectViaPopup(page);

		// Navigate to the Agents tab — space navigation should still work.
		await page.locator('button:has-text("Agents")').click();
		await expect(page.locator('text=Planner')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Coder')).toBeVisible({ timeout: 5000 });

		// Navigate to the Workflows tab.
		await page.locator('button:has-text("Workflows")').click();
		await expect(page.locator('text=Full-Cycle Coding Workflow')).toBeVisible({ timeout: 5000 });

		// Navigate back to Dashboard — canvas should still be visible with the blocked state.
		await page.locator('button:has-text("Dashboard")').click();
		await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId('gate-icon-blocked')).toBeVisible({ timeout: 5000 });

		// The attention banner must still be present.
		await expect(page.locator('text=Workflow paused — awaiting approval')).toBeVisible({
			timeout: 5000,
		});
	});

	// ─── Test 5: Rejected gate shows blocked state on canvas ─────────────────

	test('rejected gate icon transitions from waiting_human (amber) to blocked (red lock)', async ({
		page,
	}) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Initially: amber waiting_human gate is visible.
		await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('gate-icon-waiting_human')).toBeVisible({ timeout: 10000 });

		await rejectViaPopup(page);

		// After rejection: blocked gate is visible.
		await expect(page.getByTestId('gate-icon-blocked')).toBeVisible({ timeout: 10000 });

		// The waiting_human gate should no longer be visible.
		// Assumption: FULL_CYCLE_CODING_WORKFLOW has exactly one human-approval gate in the
		// pre-coding phase (plan-approval-gate). If the workflow adds more human gates
		// in the future, this assertion would need revisiting — but for the current
		// template it confirms the gate correctly transitioned away from waiting_human.
		await expect(page.getByTestId('gate-icon-waiting_human')).toBeHidden({ timeout: 10000 });
	});
});
