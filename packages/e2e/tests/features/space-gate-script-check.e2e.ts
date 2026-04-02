/**
 * Script Gate Configuration E2E Tests
 *
 * Tests script-based gate configuration in the visual workflow editor:
 * - Create a workflow with a script gate on a channel via the visual editor
 * - Configure interpreter to "node" and set script source
 * - Verify the gate badge shows the script icon ⚡ on the canvas
 * - Verify gate configuration persists after save and reopen
 * - Verify preset scripts populate interpreter and source correctly
 * - Verify gate completeness validation passes when script is configured
 *
 * Architecture notes:
 *   Gate evaluation (script execution, open/blocked state) is handled by the backend
 *   and covered by unit tests (gate-script-executor.test.ts) and integration tests
 *   (channel-router-async.test.ts). This E2E test focuses on the frontend configuration
 *   flow: creating a gate, enabling script check, setting interpreter/source, and
 *   verifying the visual badge updates reactively.
 *
 * Setup:
 *   - Space is created with agents via RPC in beforeEach (infrastructure).
 *
 * Cleanup:
 *   - Space is deleted via RPC in afterEach.
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, inputs, navigation).
 *   - All assertions check visible DOM state (badge SVG text, panel fields, testids).
 *   - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown.
 *
 * Interpreter constraint:
 *   - Only `node` interpreter is used in this test (no python3/bash dependency).
 *
 * UI Flow:
 *   Create space → Open visual editor → Add 2 steps → Port-drag to create channel →
 *   Node click → NodeConfigPanel → channel-link button → ChannelRelationConfigPanel →
 *   "Add Gate" → GateEditorPanel → Toggle script → Set interpreter/source → Verify badge
 */

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

// ─── RPC helpers (infrastructure only — used in beforeEach / afterEach) ──────

/**
 * Creates a space with two agents for script gate test scenarios.
 * Agents are needed so the workflow can have steps with assigned agents.
 */
async function createTestSpace(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<string> {
	await waitForWebSocketConnected(page);
	const spaceName = `E2E Script Gate ${Date.now()}`;
	const spaceId = await createSpace(page, spaceName);

	await page.evaluate(
		async ({ sid }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
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

// ─── UI action helpers ────────────────────────────────────────────────────────

/**
 * Sets up a workflow with two steps connected by a channel that has a script gate.
 *
 * Preconditions:
 *   - Space is created with agents
 *   - Page is navigated to the space
 *
 * Postconditions:
 *   - Visual workflow editor is open with 2 named steps with agents assigned
 *   - A one-way channel exists from step 1 (Plan Step) to step 2 (Code Step)
 *   - A script gate is configured on the channel with the given interpreter and source
 *   - NodeConfigPanel is closed
 *
 * @returns The workflow name (for later save/reopen verification)
 */
async function setupWorkflowWithScriptGate(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	scriptSource: string,
	interpreter = 'node'
): Promise<string> {
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

	// Name step 1 and assign an agent
	const step1 = regularNodes().first();
	await step1.click();
	const panel1 = editor.getByTestId('node-config-panel');
	await expect(panel1).toBeVisible({ timeout: 3000 });
	await panel1.getByTestId('step-name-input').fill('Plan Step');
	await panel1.getByTestId('agent-select').selectOption({ label: 'Planner Agent' });
	await panel1.getByTestId('close-button').click();
	await expect(panel1).not.toBeVisible({ timeout: 2000 });

	// Add step 2
	await editor.getByTestId('add-step-button').click();
	await expect(regularNodes()).toHaveCount(2, { timeout: 3000 });

	// Name step 2 and assign an agent
	const step2 = regularNodes().nth(1);
	await step2.click();
	const panel2 = editor.getByTestId('node-config-panel');
	await expect(panel2).toBeVisible({ timeout: 3000 });
	await panel2.getByTestId('step-name-input').fill('Code Step');
	await panel2.getByTestId('agent-select').selectOption({ label: 'Coder Agent' });
	await panel2.getByTestId('close-button').click();
	await expect(panel2).not.toBeVisible({ timeout: 2000 });

	// Create a channel by dragging from step 1's output port to step 2's input port
	const step1Output = step1.getByTestId('port-output');
	const step2Input = step2.getByTestId('port-input');
	await step1Output.dragTo(step2Input);

	// Verify an edge now renders on the canvas
	await expect(editor.locator('[data-testid^="channel-edge-"]')).toHaveCount(1, { timeout: 5000 });

	// Open GateEditorPanel for the channel
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
	const scriptToggle = gatePanel.getByTestId('gate-editor-script-enabled');
	await scriptToggle.click();
	await expect(scriptToggle).toHaveAttribute('aria-checked', 'true');

	// Set interpreter
	const interpreterSelect = gatePanel.getByTestId('gate-editor-script-interpreter');
	await expect(interpreterSelect).toBeVisible({ timeout: 3000 });
	await interpreterSelect.selectOption({ value: interpreter });

	// Set script source
	const sourceTextarea = gatePanel.getByTestId('gate-editor-script-source');
	await expect(sourceTextarea).toBeVisible({ timeout: 2000 });
	await sourceTextarea.fill(scriptSource);

	// Verify no gate completeness error
	const gateError = gatePanel.getByTestId('gate-editor-gate-error');
	await expect(gateError).not.toBeVisible({ timeout: 2000 });

	// Close all panels
	await nodePanel.getByTestId('close-button').click();
	await expect(nodePanel).not.toBeVisible({ timeout: 2000 });

	return workflowName;
}

/**
 * Returns a locator for the first gate badge on the canvas SVG.
 * Uses a prefix match since the badge testid includes step IDs (UUIDs).
 */
function getFirstGateBadge(page: Parameters<typeof waitForWebSocketConnected>[0]) {
	return page.locator('[data-testid^="channel-gate-"]').first();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Script Gate Configuration', () => {
	// Serial mode is required because tests share describe-scoped spaceId state
	// via beforeEach/afterEach, and parallel execution causes workspace_path collisions.
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await resetEditorModeStorage(page);
		spaceId = await createTestSpace(page);
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteSpace(page, spaceId);
			spaceId = '';
		}
	});

	// ─── Test 1: Script gate configuration with passing script ───────────────

	test('script gate with node interpreter and passing script shows script icon on badge', async ({
		page,
	}) => {
		await navigateToSpace(page, spaceId);
		const workflowName = await setupWorkflowWithScriptGate(page, PASSING_SCRIPT_SOURCE);

		// ── Verify badge shows on canvas with script icon ⚡ ──────────────────
		const gateBadge = getFirstGateBadge(page);
		await expect(gateBadge).toBeVisible({ timeout: 5000 });
		await expect(gateBadge).toContainText('\u26A1');

		// ── Save the workflow ─────────────────────────────────────────────────
		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('save-button').click();
		await expect(page.locator(`text=${workflowName}`)).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 2: Script gate configuration with failing script ───────────────

	test('script gate with failing script source configures correctly', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		const workflowName = await setupWorkflowWithScriptGate(page, FAILING_SCRIPT_SOURCE);

		// ── Verify badge shows on canvas ──────────────────────────────────────
		const gateBadge = getFirstGateBadge(page);
		await expect(gateBadge).toBeVisible({ timeout: 5000 });
		await expect(gateBadge).toContainText('\u26A1');

		// ── Save the workflow ─────────────────────────────────────────────────
		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('save-button').click();
		await expect(page.locator(`text=${workflowName}`)).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 3: Script gate configuration persists after save and reopen ────

	test('script gate configuration persists after save and reopen', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		const workflowName = await setupWorkflowWithScriptGate(page, PASSING_SCRIPT_SOURCE);

		// ── Save the workflow ─────────────────────────────────────────────────
		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('save-button').click();
		await expect(page.locator(`text=${workflowName}`)).toBeVisible({ timeout: 5000 });

		// ── Reopen the workflow for editing ────────────────────────────────────
		const { openWorkflowForEdit } = await import('../helpers/workflow-editor-helpers');
		await openWorkflowForEdit(page, workflowName);

		const reopenedEditor = page.getByTestId('visual-workflow-editor');
		await expect(reopenedEditor).toBeVisible({ timeout: 5000 });

		// ── Verify gate badge still shows script icon ⚡ ──────────────────────
		const gateBadge = getFirstGateBadge(page);
		await expect(gateBadge).toBeVisible({ timeout: 5000 });
		await expect(gateBadge).toContainText('\u26A1');

		// ── Verify gate configuration by opening the gate editor ───────────────
		const regularNodes = () =>
			reopenedEditor.locator('[data-testid^="workflow-node-"]:not([data-task-agent="true"])');
		const step1 = regularNodes().first();
		await step1.click();

		const nodePanel = reopenedEditor.getByTestId('node-config-panel');
		await expect(nodePanel).toBeVisible({ timeout: 3000 });

		const channelLinkButton = nodePanel.getByTestId('node-channel-link-button');
		await expect(channelLinkButton).toBeVisible({ timeout: 5000 });
		await channelLinkButton.click();

		const relationPanel = nodePanel.getByTestId('channel-relation-config-panel');
		await expect(relationPanel).toBeVisible({ timeout: 5000 });

		// Click the existing gate to open the editor
		await relationPanel.getByTestId('channel-edge-edit-gate-0').click();

		const gatePanel = nodePanel.getByTestId('gate-editor-panel');
		await expect(gatePanel).toBeVisible({ timeout: 5000 });

		// ── Verify script settings are preserved ──────────────────────────────
		// Script should still be enabled
		const scriptToggle = gatePanel.getByTestId('gate-editor-script-enabled');
		await expect(scriptToggle).toHaveAttribute('aria-checked', 'true');

		// Interpreter should be "node"
		const interpreterSelect = gatePanel.getByTestId('gate-editor-script-interpreter');
		await expect(interpreterSelect).toHaveValue('node');

		// Source should contain the passing script
		const sourceTextarea = gatePanel.getByTestId('gate-editor-script-source');
		const sourceValue = await sourceTextarea.inputValue();
		expect(sourceValue).toBe(PASSING_SCRIPT_SOURCE);

		// No gate completeness error
		const gateError = gatePanel.getByTestId('gate-editor-gate-error');
		await expect(gateError).not.toBeVisible({ timeout: 2000 });
	});

	// ─── Test 4: Preset scripts populate interpreter and source ──────────────

	test('lint and typecheck presets populate interpreter and source correctly', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill('Preset Test Workflow');

		// Add 2 steps with agents
		await editor.getByTestId('add-step-button').click();
		const regularNodes = () =>
			editor.locator('[data-testid^="workflow-node-"]:not([data-task-agent="true"])');
		await expect(regularNodes()).toHaveCount(1, { timeout: 3000 });

		const step1 = regularNodes().first();
		await step1.click();
		const panel1 = editor.getByTestId('node-config-panel');
		await expect(panel1).toBeVisible({ timeout: 3000 });
		await panel1.getByTestId('step-name-input').fill('Step A');
		await panel1.getByTestId('agent-select').selectOption({ label: 'Planner Agent' });
		await panel1.getByTestId('close-button').click();
		await expect(panel1).not.toBeVisible({ timeout: 2000 });

		await editor.getByTestId('add-step-button').click();
		await expect(regularNodes()).toHaveCount(2, { timeout: 3000 });

		const step2 = regularNodes().nth(1);
		await step2.click();
		const panel2 = editor.getByTestId('node-config-panel');
		await expect(panel2).toBeVisible({ timeout: 3000 });
		await panel2.getByTestId('step-name-input').fill('Step B');
		await panel2.getByTestId('agent-select').selectOption({ label: 'Coder Agent' });
		await panel2.getByTestId('close-button').click();
		await expect(panel2).not.toBeVisible({ timeout: 2000 });

		// Create a channel
		await step1.getByTestId('port-output').dragTo(step2.getByTestId('port-input'));
		await expect(editor.locator('[data-testid^="channel-edge-"]')).toHaveCount(1, {
			timeout: 5000,
		});

		// Open gate editor
		await step1.click();
		const nodePanel = editor.getByTestId('node-config-panel');
		await expect(nodePanel).toBeVisible({ timeout: 3000 });
		await nodePanel.getByTestId('node-channel-link-button').click();
		const relationPanel = nodePanel.getByTestId('channel-relation-config-panel');
		await expect(relationPanel).toBeVisible({ timeout: 5000 });
		await relationPanel.getByTestId('channel-edge-add-gate-0').click();
		const gatePanel = nodePanel.getByTestId('gate-editor-panel');
		await expect(gatePanel).toBeVisible({ timeout: 5000 });

		// ── Enable script and apply Lint Check preset ─────────────────────────
		const scriptToggle = gatePanel.getByTestId('gate-editor-script-enabled');
		await scriptToggle.click();
		await expect(scriptToggle).toHaveAttribute('aria-checked', 'true');

		await gatePanel.getByTestId('gate-editor-preset-lint').click();

		// Lint preset should set bash interpreter
		const interpreterSelect = gatePanel.getByTestId('gate-editor-script-interpreter');
		await expect(interpreterSelect).toHaveValue('bash');

		// Lint preset source should contain 'npm run lint'
		const sourceTextarea = gatePanel.getByTestId('gate-editor-script-source');
		const lintSource = await sourceTextarea.inputValue();
		expect(lintSource).toContain('npm run lint');

		// Badge should show script icon
		const gateBadge = getFirstGateBadge(page);
		await expect(gateBadge).toBeVisible({ timeout: 5000 });
		await expect(gateBadge).toContainText('\u26A1');

		// ── Apply Type Check preset ───────────────────────────────────────────
		await gatePanel.getByTestId('gate-editor-preset-typecheck').click();

		// Type check preset should also set bash interpreter
		await expect(interpreterSelect).toHaveValue('bash');

		// Type check preset source should contain 'npx tsc --noEmit'
		const typeCheckSource = await sourceTextarea.inputValue();
		expect(typeCheckSource).toContain('npx tsc --noEmit');
	});
});
