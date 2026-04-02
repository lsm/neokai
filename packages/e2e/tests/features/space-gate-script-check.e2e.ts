/**
 * Script Gate Evaluation E2E Tests
 *
 * Tests script-based gate evaluation at runtime:
 * - Create a workflow with a script gate on a channel via the visual editor
 * - Save the workflow and start a run
 * - Verify the gate opens when the script succeeds (`_scriptResult.success === true`)
 * - Verify the gate blocks when the script fails (`_scriptResult.success === false`)
 * - Verify error reason is displayed in the gate status UI via `gate-script-error-badge`
 *
 * Architecture notes:
 *   The backend executes scripts in gate-evaluator.ts when ChannelRouter.deliverMessage()
 *   evaluates a gate. Script results are persisted as `_scriptResult` in gate_data by the
 *   write_gate MCP tool handler. The frontend reads `_scriptResult` from gate_data via
 *   spaceWorkflowRun.listGateData RPC and displays script failure via parseScriptResult().
 *
 *   In E2E tests, agents cannot run (no API credentials), so actual script execution cannot
 *   be triggered via message delivery. Instead, this test uses the spaceWorkflowRun.writeGateData
 *   RPC (test-only, disabled in production) to write `_scriptResult` into gate_data, simulating
 *   what the backend would persist after executing a script. This tests the full frontend
 *   rendering pipeline: gate_data → listGateData → evaluateGateStatus → GateIcon.
 *
 *   Actual script execution is covered by unit tests in gate-script-executor.test.ts and
 *   integration tests in channel-router-async.test.ts.
 *
 * Setup:
 *   - Space is created with agents via RPC in beforeEach (infrastructure).
 *   - Workflow with script gate is created via the visual editor UI.
 *   - Workflow is saved, then a run is started via RPC (infrastructure).
 *   - Gate data is written via writeGateData RPC (infrastructure).
 *
 * Cleanup:
 *   - Workflow run is cancelled via RPC in afterEach.
 *   - Space is deleted via RPC in afterEach.
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, inputs, navigation).
 *   - All assertions check visible DOM state (gate icon testids, badge text, title attributes).
 *   - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown.
 *   - writeGateData is used in beforeEach to set up gate data state for each test scenario.
 *
 * Interpreter constraint:
 *   - Only `node` interpreter is used in this test (no python3/bash dependency).
 *   - The script source is `console.log(JSON.stringify({ done: true }))` for the passing case.
 *   - The script source is `process.exit(1)` for the failing case.
 *
 * UI Flow:
 *   Create space → Open visual editor → Add 2 steps → Port-drag to create channel →
 *   Node click → NodeConfigPanel → channel-link button → ChannelRelationConfigPanel →
 *   "Add Gate" → GateEditorPanel → Toggle script → Set interpreter/source → Close panels →
 *   Save workflow → Start run → Navigate to Dashboard → Verify gate status on canvas.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import {
	createSpace,
	deleteSpace,
	navigateToSpace,
	resetEditorModeStorage,
	openNewWorkflowEditor,
	switchToVisualMode,
} from '../helpers/workflow-editor-helpers';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Script configurations ────────────────────────────────────────────────────

const PASSING_SCRIPT_SOURCE = 'console.log(JSON.stringify({ done: true }))';
const FAILING_SCRIPT_SOURCE = 'process.exit(1)';
const SCRIPT_ERROR_REASON = 'Exit code 1: process.exit(1)';

// ─── RPC helpers (infrastructure only — used in beforeEach / afterEach) ──────

/**
 * Creates a space with two agents for script gate test scenarios.
 * Agents are needed so the workflow can have steps with assigned agents.
 */
async function createTestSpace(page: Page): Promise<string> {
	await waitForWebSocketConnected(page);
	const spaceName = `E2E Script Gate ${Date.now()}`;
	const spaceId = await createSpace(page, spaceName);

	await page.evaluate(
		async ({ sid }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			// Create two agents for the workflow steps
			await hub.request('spaceAgent.create', {
				spaceId: sid,
				name: 'Planner Agent',
				role: 'planner',
				description: 'Planning agent for script gate tests',
			});
			await hub.request('spaceAgent.create', {
				spaceId: sid,
				name: 'Coder Agent',
				role: 'coder',
				description: 'Coding agent for script gate tests',
			});
		},
		{ sid: spaceId }
	);

	return spaceId;
}

/**
 * Cancels a workflow run via RPC (best-effort).
 */
async function cancelRun(page: Page, runId: string): Promise<void> {
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

/**
 * Sets up a workflow with two steps connected by a channel that has a script gate.
 *
 * Steps:
 *   1. Open visual workflow editor
 *   2. Add "Plan Step" (auto-designated as start node)
 *   3. Add "Code Step"
 *   4. Create a one-way channel by port-dragging from Plan Step → Code Step
 *   5. Open GateEditorPanel for the channel
 *   6. Enable script check, set interpreter to "node", set script source
 *   7. Close all panels
 *
 * Preconditions:
 *   - Space is created with agents
 *   - Page is navigated to the space
 *
 * Postconditions:
 *   - Visual workflow editor is open with 2 named steps
 *   - A one-way channel exists from step 1 (Plan Step) to step 2 (Code Step)
 *   - A script gate is configured on the channel with the given source
 *   - NodeConfigPanel is closed
 */
async function setupWorkflowWithScriptGate(page: Page, scriptSource: string): Promise<void> {
	await openNewWorkflowEditor(page);
	await switchToVisualMode(page);

	const editor = page.getByTestId('visual-workflow-editor');
	const workflowName = `Script Gate Workflow ${Date.now()}`;
	await editor.getByTestId('workflow-name-input').fill(workflowName);

	// Add step 1 (auto-designated as start node)
	await editor.getByTestId('add-step-button').click();
	const regularNodes = () =>
		editor.locator('[data-testid^="workflow-node-"]:not([data-task-agent="true"])');
	await expect(regularNodes()).toHaveCount(1, { timeout: 3000 });

	// Name step 1
	const step1 = regularNodes().first();
	await step1.click();
	const panel1 = editor.getByTestId('node-config-panel');
	await expect(panel1).toBeVisible({ timeout: 3000 });
	await panel1.getByTestId('step-name-input').fill('Plan Step');
	await panel1.getByTestId('close-button').click();
	await expect(panel1).not.toBeVisible({ timeout: 2000 });

	// Add step 2
	await editor.getByTestId('add-step-button').click();
	await expect(regularNodes()).toHaveCount(2, { timeout: 3000 });

	// Name step 2
	const step2 = regularNodes().nth(1);
	await step2.click();
	const panel2 = editor.getByTestId('node-config-panel');
	await expect(panel2).toBeVisible({ timeout: 3000 });
	await panel2.getByTestId('step-name-input').fill('Code Step');
	await panel2.getByTestId('close-button').click();
	await expect(panel2).not.toBeVisible({ timeout: 2000 });

	// Create a channel by dragging from step 1's output port to step 2's input port
	const step1Output = step1.getByTestId('port-output');
	const step2Input = step2.getByTestId('port-input');
	await step1Output.dragTo(step2Input);

	// Verify an edge now renders on the canvas
	await expect(editor.locator('[data-testid^="channel-edge-"]')).toHaveCount(1, { timeout: 5000 });

	// Open GateEditorPanel for the channel
	// Click step 1 → NodeConfigPanel → channel-link button → "Add Gate"
	await step1.click();
	const nodePanel = editor.getByTestId('node-config-panel');
	await expect(nodePanel).toBeVisible({ timeout: 3000 });

	const channelLinkButton = nodePanel.getByTestId('node-channel-link-button');
	await expect(channelLinkButton).toBeVisible({ timeout: 5000 });
	await channelLinkButton.click();

	const relationPanel = nodePanel.getByTestId('channel-relation-config-panel');
	await expect(relationPanel).toBeVisible({ timeout: 5000 });

	await relationPanel.getByTestId('channel-edge-add-gate-0').click();

	const gatePanel = nodePanel.getByTestId('gate-editor-panel');
	await expect(gatePanel).toBeVisible({ timeout: 5000 });

	// Configure the script gate
	// Toggle script enabled
	const scriptToggle = gatePanel.getByTestId('gate-editor-script-enabled');
	await scriptToggle.click();
	await expect(scriptToggle).toHaveAttribute('aria-checked', 'true');

	// Set interpreter to "node"
	const interpreterSelect = gatePanel.getByTestId('gate-editor-script-interpreter');
	await expect(interpreterSelect).toBeVisible({ timeout: 3000 });
	await interpreterSelect.selectOption({ value: 'node' });

	// Set script source
	const sourceTextarea = gatePanel.getByTestId('gate-editor-script-source');
	await expect(sourceTextarea).toBeVisible({ timeout: 2000 });
	await sourceTextarea.fill(scriptSource);

	// Verify no gate completeness error
	const gateError = gatePanel.getByTestId('gate-editor-gate-error');
	await expect(gateError).not.toBeVisible({ timeout: 2000 });

	// Verify badge shows on canvas with script icon ⚡
	const gateBadge = page.locator('[data-testid^="channel-gate-"]').first();
	await expect(gateBadge).toBeVisible({ timeout: 5000 });
	await expect(gateBadge).toContainText('\u26A1');

	// Close all panels by navigating away from the node
	await nodePanel.getByTestId('close-button').click();
	await expect(nodePanel).not.toBeVisible({ timeout: 2000 });

	// Save the workflow
	await editor.getByTestId('save-button').click();
	// After saving, the editor closes and we return to the workflow list
	await expect(page.locator(`text=${workflowName}`)).toBeVisible({ timeout: 5000 });
}

/**
 * Gets the workflow ID and gate ID from the saved workflow via RPC.
 * Uses spaceWorkflow.list to find the workflow, then spaceWorkflow.get
 * to retrieve the full workflow definition including gates.
 */
async function getWorkflowAndGateIds(
	page: Page,
	spaceId: string
): Promise<{ workflowId: string; gateId: string }> {
	return page.evaluate(
		async ({ sid }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// List all workflows for the space
			const listRes = (await hub.request('spaceWorkflow.list', { spaceId: sid })) as {
				workflows: Array<{ id: string; name: string }>;
			};
			if (!listRes.workflows || listRes.workflows.length === 0) {
				throw new Error('No workflows found in space');
			}

			// Get the most recently created workflow (last in the list)
			const latestWorkflow = listRes.workflows[listRes.workflows.length - 1];

			// Get the full workflow definition to extract gate IDs
			const getRes = (await hub.request('spaceWorkflow.get', {
				id: latestWorkflow.id,
				spaceId: sid,
			})) as { workflow: { id: string; gates?: Array<{ id: string }> } };

			const workflow = getRes.workflow;
			if (!workflow.gates || workflow.gates.length === 0) {
				throw new Error('No gates found in workflow');
			}

			return {
				workflowId: workflow.id,
				gateId: workflow.gates[0].id,
			};
		},
		{ sid: spaceId }
	);
}

/**
 * Starts a workflow run via RPC (infrastructure).
 */
async function startRun(page: Page, spaceId: string, workflowId: string): Promise<string> {
	return page.evaluate(
		async ({ sid, wid }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const runRes = (await hub.request('spaceWorkflowRun.start', {
				spaceId: sid,
				workflowId: wid,
				title: 'E2E: Script gate test run',
				description: 'Testing script gate evaluation at runtime.',
			})) as { run: { id: string } };
			return runRes.run.id;
		},
		{ sid: spaceId, wid: workflowId }
	);
}

/**
 * Writes gate data via RPC (test-only infrastructure).
 * This simulates what the backend would persist after executing a gate script.
 */
async function writeGateData(
	page: Page,
	runId: string,
	gateId: string,
	data: Record<string, unknown>
): Promise<void> {
	await page.evaluate(
		async ({ rid, gid, gd }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			await hub.request('spaceWorkflowRun.writeGateData', {
				runId: rid,
				gateId: gid,
				data: gd,
			});
		},
		{ rid: runId, gid: gateId, gd: data }
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Script Gate Evaluation', () => {
	// Serial mode is required because tests share describe-scoped state
	// and each test creates its own space with a fresh database.
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: DESKTOP_VIEWPORT });

	// ─── Test 1: Gate opens when script succeeds ─────────────────────────────

	test('gate shows open state when script succeeds', async ({ page }) => {
		let spaceId = '';
		let runId = '';

		// ── Infrastructure setup (beforeEach equivalent) ───────────────────────
		await page.goto('/');
		await resetEditorModeStorage(page);

		// Create space with agents
		spaceId = await createTestSpace(page);

		try {
			// Create workflow with passing script gate via UI
			await navigateToSpace(page, spaceId);
			await setupWorkflowWithScriptGate(page, PASSING_SCRIPT_SOURCE);

			// Get workflow and gate IDs via RPC
			const { workflowId, gateId } = await getWorkflowAndGateIds(page, spaceId);

			// Start a run via RPC
			runId = await startRun(page, spaceId, workflowId);

			// Write successful script result to gate data (infrastructure)
			await writeGateData(page, runId, gateId, {
				_scriptResult: { success: true },
				done: true,
			});

			// ── Test assertions (UI only) ───────────────────────────────────────
			await navigateToSpace(page, spaceId);

			// Wait for canvas to enter runtime mode
			await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 10000 });
			await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 10000 });

			// Gate should show as "open" (green checkmark icon)
			await expect(page.getByTestId('gate-icon-open')).toBeVisible({ timeout: 10000 });

			// Gate should NOT show as blocked
			await expect(page.getByTestId('gate-icon-blocked')).toHaveCount(0);

			// Script error badge should NOT be visible
			await expect(page.getByTestId('gate-script-error-badge')).toHaveCount(0);
		} finally {
			// ── Cleanup (afterEach equivalent) ───────────────────────────────────
			if (runId) await cancelRun(page, runId);
			if (spaceId) await deleteSpace(page, spaceId);
		}
	});

	// ─── Test 2: Gate blocks when script fails ───────────────────────────────

	test('gate shows blocked state with error message when script fails', async ({ page }) => {
		let spaceId = '';
		let runId = '';

		// ── Infrastructure setup ───────────────────────────────────────────────
		await page.goto('/');
		await resetEditorModeStorage(page);

		spaceId = await createTestSpace(page);

		try {
			// Create workflow with failing script gate via UI
			await navigateToSpace(page, spaceId);
			await setupWorkflowWithScriptGate(page, FAILING_SCRIPT_SOURCE);

			// Get workflow and gate IDs via RPC
			const { workflowId, gateId } = await getWorkflowAndGateIds(page, spaceId);

			// Start a run via RPC
			runId = await startRun(page, spaceId, workflowId);

			// Write failed script result to gate data (infrastructure)
			await writeGateData(page, runId, gateId, {
				_scriptResult: { success: false, reason: SCRIPT_ERROR_REASON },
			});

			// ── Test assertions (UI only) ───────────────────────────────────────
			await navigateToSpace(page, spaceId);

			// Wait for canvas to enter runtime mode
			await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 10000 });
			await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 10000 });

			// Gate should show as "blocked" (gray lock icon)
			await expect(page.getByTestId('gate-icon-blocked')).toBeVisible({ timeout: 10000 });

			// Gate should NOT show as open
			await expect(page.getByTestId('gate-icon-open')).toHaveCount(0);

			// Script error badge should be visible
			const scriptErrorBadge = page.getByTestId('gate-script-error-badge');
			await expect(scriptErrorBadge).toBeVisible({ timeout: 10000 });

			// Badge should contain "Script failed" text
			await expect(scriptErrorBadge).toContainText('Script failed');

			// Badge title attribute should contain the error reason
			await expect(scriptErrorBadge).toHaveAttribute('title', SCRIPT_ERROR_REASON);
		} finally {
			// ── Cleanup ─────────────────────────────────────────────────────────
			if (runId) await cancelRun(page, runId);
			if (spaceId) await deleteSpace(page, spaceId);
		}
	});

	// ─── Test 3: Error reason with stderr content ───────────────────────────

	test('script error reason from stderr is displayed in gate badge tooltip', async ({ page }) => {
		const STDERR_ERROR_REASON =
			'ReferenceError: myVariable is not defined\n    at eval (eval at <anonymous>';

		let spaceId = '';
		let runId = '';

		// ── Infrastructure setup ───────────────────────────────────────────────
		await page.goto('/');
		await resetEditorModeStorage(page);

		spaceId = await createTestSpace(page);

		try {
			// Create workflow with script gate via UI
			await navigateToSpace(page, spaceId);
			await setupWorkflowWithScriptGate(page, 'throw new Error("boom")');

			// Get workflow and gate IDs via RPC
			const { workflowId, gateId } = await getWorkflowAndGateIds(page, spaceId);

			// Start a run via RPC
			runId = await startRun(page, spaceId, workflowId);

			// Write failed script result with stderr content as reason
			await writeGateData(page, runId, gateId, {
				_scriptResult: { success: false, reason: STDERR_ERROR_REASON },
			});

			// ── Test assertions (UI only) ───────────────────────────────────────
			await navigateToSpace(page, spaceId);

			// Wait for canvas to enter runtime mode
			await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 10000 });
			await expect(page.getByTestId('workflow-canvas-svg')).toBeVisible({ timeout: 10000 });

			// Gate should be blocked
			await expect(page.getByTestId('gate-icon-blocked')).toBeVisible({ timeout: 10000 });

			// Script error badge should show the full error reason in its title
			const scriptErrorBadge = page.getByTestId('gate-script-error-badge');
			await expect(scriptErrorBadge).toBeVisible({ timeout: 10000 });
			await expect(scriptErrorBadge).toHaveAttribute('title', STDERR_ERROR_REASON);
		} finally {
			// ── Cleanup ─────────────────────────────────────────────────────────
			if (runId) await cancelRun(page, runId);
			if (spaceId) await deleteSpace(page, spaceId);
		}
	});
});
