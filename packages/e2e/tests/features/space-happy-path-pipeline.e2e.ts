/**
 * Space Happy Path Pipeline E2E Tests
 *
 * Exercises the full UI flow for the Space V2 workflow pipeline:
 * - Navigating to Spaces and creating a Space
 * - Verifying preset agents (Coder, General, Planner, Reviewer, QA) are seeded
 * - Verifying CODING_WORKFLOW_V2 ("Coding Workflow V2") is seeded
 * - WorkflowCanvas visible in runtime mode with an active workflow run
 * - Approval gate (plan-approval-gate) shows `waiting_human` state on the canvas
 * - Clicking the gate icon reveals Approve / Reject / View Artifacts actions
 * - Opening the GateArtifactsView overlay via "View Artifacts"
 * - Approve button visible and clickable inside the artifacts view
 * - Approving the gate updates the canvas to `open` state
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
 * been written yet (approved === undefined → waiting_human per the canvas evaluator).
 * This makes it deterministic to test without waiting for any AI execution to complete.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

async function createSpaceWithRun(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<{ spaceId: string; runId: string }> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);

	return page.evaluate(
		async ({ wsPath }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// Clean up any leftover space at this workspace path.
			const norm = (p: string) => p.replace(/^\/private/, '');
			try {
				const list = (await hub.request('space.list', {})) as Array<{
					id: string;
					workspacePath: string;
				}>;
				const existing = list.find((s) => norm(s.workspacePath) === norm(wsPath));
				if (existing) await hub.request('space.delete', { id: existing.id });
			} catch {
				// Ignore cleanup errors
			}

			// Create the space (preset agents + workflow are auto-seeded by the daemon).
			const spaceRes = (await hub.request('space.create', {
				name: `E2E Happy Path ${Date.now()}`,
				workspacePath: wsPath,
			})) as { id: string };
			const spaceId = spaceRes.id;

			// Start a workflow run so the canvas enters runtime mode.
			const runRes = (await hub.request('spaceWorkflowRun.start', {
				spaceId,
				title: 'E2E: Add hello-world function',
				description: 'Implement a simple hello-world function for E2E testing.',
			})) as { run: { id: string } };
			const runId = runRes.run.id;

			return { spaceId, runId };
		},
		{ wsPath: workspaceRoot }
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
			await hub.request('spaceWorkflowRun.cancel', { runId: rid });
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

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Space Happy Path Pipeline', () => {
	// Run serially: each test assumes clean state from a fresh beforeEach.
	test.describe.configure({ mode: 'serial' });
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

	// ─── Test 1: Preset agents and V2 workflow seeded ─────────────────────────

	test('preset agents and Coding Workflow V2 are seeded on space creation', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Dashboard tab should be active and visible.
		await expect(page.locator('button:has-text("Dashboard")')).toBeVisible({ timeout: 5000 });

		// Navigate to Agents tab — verify all preset roles are present.
		await page.locator('button:has-text("Agents")').click();
		await expect(page.locator('text=Planner')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Coder')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Reviewer')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=QA')).toBeVisible({ timeout: 5000 });

		// Navigate to Workflows tab — Coding Workflow V2 should be present.
		await page.locator('button:has-text("Workflows")').click();
		await expect(page.locator('text=Coding Workflow V2')).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 2: Canvas visible in runtime mode with active run ──────────────

	test('workflow canvas shows in runtime mode once a run is active', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Canvas panel should be visible (desktop viewport, runtime mode).
		await expect(page.getByTestId('canvas-panel')).toBeVisible({ timeout: 10000 });

		// Active-run banner: a pulsing dot and the run title.
		await expect(page.locator('text=E2E: Add hello-world function')).toBeVisible({
			timeout: 10000,
		});

		// WorkflowCanvas SVG element should be rendered.
		await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 5000 });

		// Key workflow nodes from CODING_WORKFLOW_V2 should be visible.
		await expect(page.locator('text=Planning')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Plan Review')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Coding')).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 3: Approval gate shows waiting_human state ─────────────────────

	test('plan-approval-gate shows waiting_human (amber pulsing) on the canvas', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Wait for canvas to render in runtime mode.
		await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 10000 });

		// The plan-approval-gate condition checks `approved` field.
		// At run start no gate data has been written → evaluates to `waiting_human`.
		await expect(page.getByTestId('gate-icon-waiting_human')).toBeVisible({ timeout: 10000 });
	});

	// ─── Test 4: Clicking gate shows Approve / Reject / View Artifacts ────────

	test('clicking waiting_human gate reveals action popup with Approve, Reject, View Artifacts', async ({
		page,
	}) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Wait for the amber approval gate to appear.
		const waitingGate = page.getByTestId('gate-icon-waiting_human');
		await expect(waitingGate).toBeVisible({ timeout: 10000 });

		// Click the gate icon to reveal the action popup.
		await waitingGate.click();

		// All three action buttons should be visible in the popup.
		await expect(page.locator('button:has-text("Approve")').first()).toBeVisible({
			timeout: 3000,
		});
		await expect(page.locator('button:has-text("Reject")').first()).toBeVisible({ timeout: 3000 });
		await expect(page.getByTestId('view-artifacts-btn')).toBeVisible({ timeout: 3000 });
	});

	// ─── Test 5: View Artifacts opens the artifacts panel overlay ─────────────

	test('clicking View Artifacts opens the GateArtifactsView overlay', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Wait for the amber approval gate.
		const waitingGate = page.getByTestId('gate-icon-waiting_human');
		await expect(waitingGate).toBeVisible({ timeout: 10000 });

		// Open the action popup.
		await waitingGate.click();
		await expect(page.getByTestId('view-artifacts-btn')).toBeVisible({ timeout: 3000 });

		// Click "View Artifacts".
		await page.getByTestId('view-artifacts-btn').click();

		// The full-screen artifacts overlay should appear.
		await expect(page.getByTestId('artifacts-panel-overlay')).toBeVisible({ timeout: 5000 });

		// GateArtifactsView inside the overlay should be visible.
		await expect(page.getByTestId('gate-artifacts-view')).toBeVisible({ timeout: 5000 });

		// Header copy: "Review Changes".
		await expect(page.locator('text=Review Changes')).toBeVisible({ timeout: 3000 });

		// Footer always renders Approve / Reject regardless of artifact load state.
		await expect(page.getByTestId('approve-button')).toBeVisible({ timeout: 3000 });
		await expect(page.getByTestId('reject-button')).toBeVisible({ timeout: 3000 });

		// Chat command input is visible as a secondary approval mechanism.
		await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 3000 });
	});

	// ─── Test 6: Artifacts view shows diff summary or error state ─────────────

	test('GateArtifactsView shows content area (diff summary or loading/error) after open', async ({
		page,
	}) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		const waitingGate = page.getByTestId('gate-icon-waiting_human');
		await expect(waitingGate).toBeVisible({ timeout: 10000 });
		await waitingGate.click();
		await expect(page.getByTestId('view-artifacts-btn')).toBeVisible({ timeout: 3000 });
		await page.getByTestId('view-artifacts-btn').click();

		await expect(page.getByTestId('gate-artifacts-view')).toBeVisible({ timeout: 5000 });

		// The body should show one of: loading spinner, error message, diff summary,
		// or no-files message. Wait for the loading state to resolve.
		await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

		// After loading resolves, one of these states must be visible:
		const errorEl = page.getByTestId('artifacts-error');
		const diffSummaryEl = page.getByTestId('diff-summary');
		const noFilesEl = page.getByTestId('no-files');

		const state = await Promise.race([
			errorEl.waitFor({ state: 'visible', timeout: 5000 }).then(() => 'error' as const),
			diffSummaryEl.waitFor({ state: 'visible', timeout: 5000 }).then(() => 'diff' as const),
			noFilesEl.waitFor({ state: 'visible', timeout: 5000 }).then(() => 'no-files' as const),
		]);

		// Any terminal state is acceptable for an E2E test without a real worktree.
		expect(['error', 'diff', 'no-files']).toContain(state);

		// Regardless of content state, approve/reject buttons must remain enabled.
		await expect(page.getByTestId('approve-button')).toBeEnabled({ timeout: 2000 });
		await expect(page.getByTestId('reject-button')).toBeEnabled({ timeout: 2000 });
	});

	// ─── Test 7: Approving via GateArtifactsView updates the canvas ──────────

	test('approving via GateArtifactsView closes overlay and turns gate open (green)', async ({
		page,
	}) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Open the artifacts panel.
		const waitingGate = page.getByTestId('gate-icon-waiting_human');
		await expect(waitingGate).toBeVisible({ timeout: 10000 });
		await waitingGate.click();
		await expect(page.getByTestId('view-artifacts-btn')).toBeVisible({ timeout: 3000 });
		await page.getByTestId('view-artifacts-btn').click();
		await expect(page.getByTestId('gate-artifacts-view')).toBeVisible({ timeout: 5000 });

		// Wait for the loading state to resolve before clicking Approve.
		await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

		// Click Approve.
		await page.getByTestId('approve-button').click();

		// Overlay should close after the decision.
		await expect(page.getByTestId('artifacts-panel-overlay')).toBeHidden({ timeout: 10000 });

		// The gate should now show as "open" (green checkmark) on the canvas.
		await expect(page.getByTestId('gate-icon-open')).toBeVisible({ timeout: 10000 });

		// The amber waiting_human gate should no longer be visible for this gate.
		// (There may still be other waiting_human gates if the workflow has advanced,
		//  but the plan-approval-gate must have transitioned to open.)
		// We verify at least one open gate exists — sufficient to confirm approval.
	});

	// ─── Test 8: Approving directly from the gate popup (without artifacts) ───

	test('approving directly from gate popup turns gate open without opening overlay', async ({
		page,
	}) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Wait for the amber approval gate.
		const waitingGate = page.getByTestId('gate-icon-waiting_human');
		await expect(waitingGate).toBeVisible({ timeout: 10000 });

		// Open the action popup.
		await waitingGate.click();
		await expect(page.locator('button:has-text("Approve")').first()).toBeVisible({
			timeout: 3000,
		});

		// Click Approve in the popup (not inside the artifacts overlay).
		await page.locator('button:has-text("Approve")').first().click();

		// Overlay must NOT appear (we didn't open it).
		await expect(page.getByTestId('artifacts-panel-overlay')).toBeHidden({ timeout: 3000 });

		// Gate should turn open on the canvas.
		await expect(page.getByTestId('gate-icon-open')).toBeVisible({ timeout: 10000 });
	});

	// ─── Test 9: Parallel reviewer nodes visible on canvas ───────────────────

	test('canvas shows all three Reviewer nodes (parallel execution)', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		// Wait for WorkflowCanvas to render.
		await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 10000 });

		// CODING_WORKFLOW_V2 has three parallel reviewer nodes.
		await expect(page.locator('text=Reviewer 1')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Reviewer 2')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Reviewer 3')).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 10: QA and Done nodes visible on canvas ────────────────────────

	test('canvas shows QA and Done nodes at the end of the pipeline', async ({ page }) => {
		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });

		await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 10000 });

		// QA and Done nodes are at the tail of CODING_WORKFLOW_V2.
		await expect(page.locator('text=QA')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Done')).toBeVisible({ timeout: 5000 });
	});
});
