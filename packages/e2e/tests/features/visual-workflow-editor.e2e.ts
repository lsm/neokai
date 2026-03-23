/**
 * Visual Workflow Editor E2E Tests
 *
 * Tests:
 * - Create workflow with visual editor (add nodes, configure properties, set start node, save)
 * - Node positions are restored after save and reopen (layout persistence)
 * - Load template in visual editor (auto-layout with nodes and edges)
 * - Toggle between List and Visual modes (mode switching with confirmation)
 * - Validation errors when saving incomplete workflows
 *
 * Setup: creates a Space via RPC in beforeEach (infrastructure).
 * Cleanup: deletes the Space via RPC in afterEach.
 *
 * E2E Rules:
 * - All test actions go through the UI (clicks, inputs, navigation)
 * - All assertions check visible DOM state
 * - RPC is only used in beforeEach/afterEach for test infrastructure
 *
 * Task Agent Node Tests (SKIPPED - feature not yet implemented):
 * - Task Agent node is always visible when opening the visual editor
 * - Task Agent node cannot be deleted via keyboard
 * - Adding a new node shows Task Agent channel edges on the canvas
 * - Task Agent node has distinct visual styling (purple border, pinned-node class)
 * - Channels to Task Agent can be removed via the config panel
 *
 * These tests are skipped because the Task Agent visible node feature (Change 3 of
 * the workflow graph model goal) has not been implemented yet. Once the feature is
 * implemented (Tasks 4.1, 4.2, 4.3), remove the test.skip() annotations.
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
	getDefaultAgentId,
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── RPC helpers (infrastructure only) ────────────────────────────────────────

async function createTestSpace(page: Page): Promise<string> {
	return createSpace(page, `E2E Visual Editor Test ${Date.now()}`);
}

async function deleteTestSpace(page: Page, spaceId: string): Promise<void> {
	return deleteSpace(page, spaceId);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Visual Workflow Editor', () => {
	// All tests share the same workspace path (one space at a time) — must run serially
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Clear persisted editor mode so tests are independent of run order
		await resetEditorModeStorage(page);
		spaceId = await createTestSpace(page);
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteTestSpace(page, spaceId);
			spaceId = '';
		}
	});

	// ─── Test 1: Create workflow with visual editor ──────────────────────────

	// NOTE: When the Task Agent pinned node feature is implemented (Tasks 4.1-4.3), the
	// toHaveCount assertions in this test will need to add +1 to account for the always-
	// present Task Agent node. For example, "3" Add-Step clicks will produce 4 nodes
	// (Task Agent + 3 regular nodes), not 3. Update line ~111 accordingly.

	test('Create workflow with visual editor', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// Fill workflow name
		await editor.getByTestId('workflow-name-input').fill('Visual Test Workflow');

		// Add 3 nodes via "Add Step" button
		const addStepBtn = editor.getByTestId('add-step-button');
		await addStepBtn.click();
		await addStepBtn.click();
		await addStepBtn.click();

		// 3 nodes should appear on the canvas
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await expect(nodes).toHaveCount(3, { timeout: 3000 });

		// Configure node 1: name + agent.
		// The first added node is auto-designated as start (VisualWorkflowEditor addStep).
		await nodes.nth(0).click();
		await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
		await editor.getByTestId('step-name-input').fill('Planner');
		await editor.getByTestId('agent-select').selectOption({ index: 1 });
		await editor.getByTestId('close-button').click();
		await expect(editor.getByTestId('node-config-panel')).not.toBeVisible({ timeout: 2000 });

		// Verify node 1 shows the start badge after the panel is closed.
		// Assertions on start-badge are intentionally placed after the panel closes — the
		// 320px NodeConfigPanel can visually occlude the badge while open.
		await expect(
			editor
				.locator('[data-testid^="workflow-node-"]')
				.filter({ hasText: 'Planner' })
				.getByTestId('start-badge')
		).toBeVisible({ timeout: 2000 });

		// Configure node 2: name + agent
		await nodes.nth(1).click();
		await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
		await editor.getByTestId('step-name-input').fill('Coder');
		await editor.getByTestId('agent-select').selectOption({ index: 1 });
		await editor.getByTestId('close-button').click();
		await expect(editor.getByTestId('node-config-panel')).not.toBeVisible({ timeout: 2000 });

		// Configure node 3: name + agent + designate as start
		await nodes.nth(2).click();
		await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
		await editor.getByTestId('step-name-input').fill('Reviewer');
		await editor.getByTestId('agent-select').selectOption({ index: 1 });

		// "Set as Start" only renders when !isStartNode — assert it is visible before clicking
		await expect(editor.getByTestId('set-as-start-button')).toBeVisible({ timeout: 2000 });
		await editor.getByTestId('set-as-start-button').click();

		// Close config panel before asserting badge state on canvas nodes (panel may occlude)
		await editor.getByTestId('close-button').click();
		await expect(editor.getByTestId('node-config-panel')).not.toBeVisible({ timeout: 2000 });

		// Start badge should now appear on the Reviewer node (node 3)
		await expect(
			editor
				.locator('[data-testid^="workflow-node-"]')
				.filter({ hasText: 'Reviewer' })
				.getByTestId('start-badge')
		).toBeVisible({ timeout: 3000 });

		// Planner node (node 1) should no longer show start badge after reassignment
		await expect(
			editor
				.locator('[data-testid^="workflow-node-"]')
				.filter({ hasText: 'Planner' })
				.getByTestId('start-badge')
		).not.toBeVisible({ timeout: 2000 });

		// Save the workflow
		await editor.getByTestId('save-button').click();

		// Editor should close after save; workflow should appear in the list
		await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Visual Test Workflow')).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 2: Node positions are restored after save and reopen ──────────

	// NOTE: When the Task Agent pinned node feature is implemented, the toHaveCount
	// assertion on line ~250 will need to change from 2 to 3 (adds Task Agent node).

	test('Node positions are restored after save and reopen', async ({ page }) => {
		await navigateToSpace(page, spaceId);

		// Infrastructure: create a workflow with layout positions via RPC
		const agentId = await getDefaultAgentId(page, spaceId);

		await page.evaluate(
			async ({ sid, aId }) => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub?.request) throw new Error('Hub not available');
				const s1 = crypto.randomUUID();
				const s2 = crypto.randomUUID();
				// Provide layout with deterministic positions
				const layout = {
					[s1]: { x: 100, y: 80 },
					[s2]: { x: 450, y: 80 },
				};
				await hub.request('spaceWorkflow.create', {
					spaceId: sid,
					name: 'Layout Persist Test',
					steps: [
						{ id: s1, name: 'Step One', agentId: aId },
						{ id: s2, name: 'Step Two', agentId: aId },
					],
					transitions: [{ id: crypto.randomUUID(), from: s1, to: s2, order: 0 }],
					startStepId: s1,
					rules: [],
					tags: [],
					layout,
				});
			},
			{ sid: spaceId, aId: agentId }
		);

		// Navigate to the workflows list
		await page.locator('text=Workflows').first().click();
		await expect(page.locator('text=Layout Persist Test')).toBeVisible({ timeout: 5000 });

		// The Edit button lives inside a data-testid="workflow-card-actions" container that
		// is opacity-0 by default (only visible on CSS group-hover). Force it visible via JS
		// before clicking — Tailwind CSS group-hover is unreliable in headless Chromium/xvfb.
		const workflowCard = page
			.locator('[class*="group"]')
			.filter({ has: page.locator('text=Layout Persist Test') })
			.first();
		await expect(workflowCard).toBeVisible({ timeout: 3000 });
		await workflowCard.evaluate((el) => {
			const actions = el.querySelector<HTMLElement>('[data-testid="workflow-card-actions"]');
			if (actions) actions.style.opacity = '1';
		});

		// Click the Edit button scoped to the target workflow card
		const editBtn = workflowCard.getByRole('button', { name: 'Edit' });
		await expect(editBtn).toBeVisible({ timeout: 3000 });
		await editBtn.click();

		// Wait for editor mode toggle
		await expect(page.getByTestId('editor-mode-toggle')).toBeVisible({ timeout: 5000 });

		// Switch to Visual mode
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// Both nodes should appear
		await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(2, {
			timeout: 5000,
		});

		// Verify step names are rendered
		await expect(editor.locator('text=Step One').first()).toBeVisible({ timeout: 3000 });
		await expect(editor.locator('text=Step Two').first()).toBeVisible({ timeout: 3000 });

		// The start node (Step One) should have the start badge
		const nodeWithStepOne = editor
			.locator('[data-testid^="workflow-node-"]')
			.filter({ has: page.locator('text=Step One') });
		await expect(nodeWithStepOne.getByTestId('start-badge')).toBeVisible({ timeout: 3000 });

		// Verify that the two nodes are at different horizontal positions —
		// the layout positions (x=100 and x=450) should result in nodes being
		// clearly separated on-screen, not stacked at the same location.
		const nodeOne = editor
			.locator('[data-testid^="workflow-node-"]')
			.filter({ has: page.locator('text=Step One') });
		const nodeTwo = editor
			.locator('[data-testid^="workflow-node-"]')
			.filter({ has: page.locator('text=Step Two') });
		const boxOne = await nodeOne.boundingBox();
		const boxTwo = await nodeTwo.boundingBox();
		expect(boxOne).not.toBeNull();
		expect(boxTwo).not.toBeNull();
		// The canvas transforms positions (x=100 vs x=450 → 350px apart in canvas space)
		// After viewport scaling/translation the absolute screen positions differ by >50px
		expect(Math.abs(boxTwo!.x - boxOne!.x)).toBeGreaterThan(50);

		// Save (no changes) and verify round-trip: workflow still in list
		await editor.getByTestId('save-button').click();
		await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Layout Persist Test')).toBeVisible({ timeout: 5000 });
	});

	// ─── Test 3: Load template in visual editor ──────────────────────────────

	// NOTE: When the Task Agent pinned node feature is implemented:
	// - The toHaveCount on line ~316 will need to change from 2 to 3 (adds Task Agent node)
	// - The template-picker-button visibility assertion below will be unreachable because
	//   the Task Agent node is always present, so the canvas is never truly "empty"
	//   and the picker is hidden immediately on editor open.

	test('Load template in visual editor', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// Template picker button should be visible on empty new canvas
		await expect(editor.getByTestId('template-picker-button')).toBeVisible({ timeout: 3000 });

		// Open the template dropdown
		await editor.getByTestId('template-picker-button').click();

		// Template options should appear
		await expect(editor.locator('[data-testid="template-option"]').first()).toBeVisible({
			timeout: 3000,
		});

		// Select the Coding template by its exact data-template-label attribute
		// (more precise than partial text match — avoids false matches if new templates added)
		const codingTemplate = editor.locator('[data-template-label="Coding (Plan → Code)"]');
		await expect(codingTemplate).toBeVisible({ timeout: 3000 });
		await codingTemplate.click();

		// Coding template creates 2 nodes (Planner + Coder) with auto-layout
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await expect(nodes).toHaveCount(2, { timeout: 5000 });

		// Verify node names from template
		await expect(editor.locator('text=Planner').first()).toBeVisible({ timeout: 3000 });
		await expect(editor.locator('text=Coder').first()).toBeVisible({ timeout: 3000 });

		// Template picker should be hidden after nodes exist
		await expect(editor.getByTestId('template-picker-button')).not.toBeVisible({
			timeout: 2000,
		});

		// Workflow name should be populated from template
		const nameValue = await editor.getByTestId('workflow-name-input').inputValue();
		expect(nameValue.length).toBeGreaterThan(0);

		// Assign agents to each node before saving
		// Node 1 agent
		await nodes.nth(0).click();
		await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
		await editor.getByTestId('agent-select').selectOption({ index: 1 });
		await editor.getByTestId('close-button').click();

		// Node 2 agent
		await nodes.nth(1).click();
		await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
		await editor.getByTestId('agent-select').selectOption({ index: 1 });
		await editor.getByTestId('close-button').click();

		// Save the workflow
		await editor.getByTestId('save-button').click();

		// Editor should close after save
		await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
	});

	// ─── Test 4: Toggle between List and Visual modes ────────────────────────

	test('Toggle between List and Visual modes', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);

		// Verify List mode is active by default (localStorage was cleared in beforeEach)
		await expect(page.getByTestId('editor-mode-list')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByTestId('editor-mode-visual')).toHaveAttribute('aria-pressed', 'false');

		// List mode shows WorkflowEditor UI (has template/step controls)
		await expect(page.getByRole('button', { name: /Start from template/ })).toBeVisible({
			timeout: 3000,
		});

		// Add steps in List mode using a template
		await page.getByRole('button', { name: /Start from template/ }).click();
		await page.locator('text=Coding (Plan → Code)').click();

		// Verify steps appear in List mode
		await expect(page.locator('text=2 steps')).toBeVisible({ timeout: 3000 });

		// Switch to Visual mode — confirm dialog will appear (editor is open)
		await switchToVisualMode(page);

		// Visual mode should be active
		await expect(page.getByTestId('editor-mode-visual')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByTestId('visual-workflow-editor')).toBeVisible({ timeout: 5000 });

		// Switch back to List mode (confirm dialog will appear again)
		page.once('dialog', (d) => d.accept());
		await page.getByTestId('editor-mode-list').click();

		// List mode should be active
		await expect(page.getByTestId('editor-mode-list')).toHaveAttribute('aria-pressed', 'true', {
			timeout: 3000,
		});

		// Visual editor should not be visible
		await expect(page.getByTestId('visual-workflow-editor')).not.toBeVisible({ timeout: 3000 });
	});

	// ─── Test 5: Visual editor validation — missing name ────────────────────

	// NOTE: When the Task Agent pinned node feature is implemented, the toHaveCount
	// assertion on line ~412 will need to change from 1 to 2 (adds Task Agent node).

	test('Visual editor shows error when saving without name', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// Add a step (so validation reaches the name check)
		await editor.getByTestId('add-step-button').click();
		await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
			timeout: 3000,
		});

		// Attempt to save without filling in the name
		await editor.getByTestId('save-button').click();

		// Error banner should appear
		await expect(page.locator('text=Workflow name is required')).toBeVisible({ timeout: 3000 });

		// Editor should remain open
		await expect(editor).toBeVisible();
	});

	// ─── Test 6: Visual editor validation — missing agent ───────────────────

	// NOTE: When the Task Agent pinned node feature is implemented, the toHaveCount
	// assertion on line ~442 will need to change from 1 to 2 (adds Task Agent node).

	test('Visual editor shows error when saving without agent assigned', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// Fill workflow name
		await editor.getByTestId('workflow-name-input').fill('Test Validation Workflow');

		// Add a step but do not assign an agent
		await editor.getByTestId('add-step-button').click();
		await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
			timeout: 3000,
		});

		// Attempt to save
		await editor.getByTestId('save-button').click();

		// Error should mention agent requirement
		await expect(page.locator('text=requires an agent')).toBeVisible({ timeout: 3000 });

		// Editor should remain open
		await expect(editor).toBeVisible();
	});

	// ─── Task Agent Node Tests ───────────────────────────────────────────────
	// These tests are skipped because the Task Agent visible node feature
	// (Change 3 of the workflow graph model goal) has not been implemented yet.
	// They require:
	// - Task Agent rendered as a pinned node in VisualWorkflowEditor
	// - data-testid="workflow-node-task-agent" attribute on the node
	// - data-task-agent-node="true" attribute on the node
	// - border-purple-500 CSS class for distinct styling
	// - pinned-node CSS class for the pinned marker
	// - Task Agent node always present at canvas open (not added via add-step-button)
	// - ChannelTopologyBadge showing task-agent channels on regular nodes
	// - channels-section in NodeConfigPanel for multi-agent steps showing task-agent channels
	//
	// Once the feature is implemented (Tasks 4.1, 4.2, 4.3), remove the test.skip()
	// and update selectors if the implementation differs from the assumptions below.
	// See: https://github.com/lsm/neokai/issues (tracking issue for Task Agent visible node)

	// ─── Test 7: Task Agent node is always visible when opening the visual editor ───

	test.skip('Task Agent node is always visible when opening the visual editor', async ({
		page,
	}) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// The Task Agent pinned node should be visible even on an empty canvas
		// It has a distinct data attribute to identify it
		const taskAgentNode = editor.locator('[data-testid="workflow-node-task-agent"]');
		await expect(taskAgentNode).toBeVisible({ timeout: 5000 });

		// The Task Agent node should also have the data-task-agent-node attribute
		await expect(taskAgentNode).toHaveAttribute('data-task-agent-node', 'true');

		// Task Agent node should display "Task Agent" as its name
		await expect(taskAgentNode.locator('text=Task Agent')).toBeVisible({ timeout: 2000 });
	});

	// ─── Test 8: Task Agent node cannot be deleted via keyboard ─────────────

	test.skip('Task Agent node cannot be deleted via keyboard', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// First add a regular node so we have something to select and potentially delete
		await editor.getByTestId('add-step-button').click();

		// Should have 2 nodes: Task Agent pinned node + 1 regular node
		await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(2, {
			timeout: 3000,
		});

		// Select the Task Agent node
		const taskAgentNode = editor.locator('[data-testid="workflow-node-task-agent"]');
		await taskAgentNode.click();

		// Try to delete via Delete key
		await page.keyboard.press('Delete');

		// Task Agent node should still be visible after Delete key
		await expect(taskAgentNode).toBeVisible({ timeout: 2000 });

		// Also try Backspace key (graph editors often handle both)
		await taskAgentNode.click();
		await page.keyboard.press('Backspace');
		await expect(taskAgentNode).toBeVisible({ timeout: 2000 });
	});

	// ─── Test 9: Adding a new node shows Task Agent channel edges on the canvas ───

	test.skip('Adding a new node shows Task Agent channel edges on the canvas', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// The Task Agent node should already be visible (1 node)
		const taskAgentNode = editor.locator('[data-testid="workflow-node-task-agent"]');
		await expect(taskAgentNode).toBeVisible({ timeout: 5000 });

		// Count nodes before adding (should be 1 - just the Task Agent pinned node)
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await expect(nodes).toHaveCount(1, { timeout: 3000 });

		// Add a new node via "Add Step" button
		await editor.getByTestId('add-step-button').click();

		// Wait for the new node to appear - should now be 2 nodes (Task Agent + new node)
		await expect(nodes).toHaveCount(2, { timeout: 3000 });

		// Click the new node (second one, not the Task Agent) to select it and open the config panel
		await nodes.nth(1).click();
		await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });

		// The ChannelTopologyBadge on the canvas node should show a channel to/from Task Agent
		// "task-agent" is 10 chars; the 8-char truncation limit produces "task-age…"
		// so we look for the truncated form.
		const nodeCard = nodes.nth(1);
		await expect(nodeCard.locator('[data-testid="channel-topology-badge"]')).toBeVisible({
			timeout: 2000,
		});
		await expect(nodeCard.locator('text=task-age')).toBeVisible({ timeout: 2000 });
	});

	// ─── Test 10: Task Agent node has distinct visual styling ───────────────

	test.skip('Task Agent node has distinct visual styling', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// The Task Agent node should have a distinct border color (purple)
		const taskAgentNode = editor.locator('[data-testid="workflow-node-task-agent"]');
		await expect(taskAgentNode).toBeVisible({ timeout: 5000 });

		// Check for the distinct styling class - Task Agent uses purple border
		// The Task Agent node should have border-purple-500 class
		await expect(taskAgentNode).toHaveClass(/border-purple-500/);

		// Also verify it has the pinned-node marker class
		await expect(taskAgentNode).toHaveClass(/pinned-node/);
	});

	// ─── Test 11: Channels to Task Agent can be removed via config panel ───

	test.skip('Channels to Task Agent can be removed via config panel', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');

		// Task Agent pinned node should already be visible (1 node)
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await expect(nodes).toHaveCount(1, { timeout: 3000 });

		// Add a node that will have a Task Agent channel
		await editor.getByTestId('add-step-button').click();

		// Should now have 2 nodes: Task Agent + 1 regular node
		await expect(nodes).toHaveCount(2, { timeout: 3000 });

		// Configure the first regular node (nth(1), not Task Agent at nth(0)) with an agent
		await nodes.nth(1).click();
		await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
		await editor.getByTestId('agent-select').selectOption({ index: 1 });
		await editor.getByTestId('close-button').click();

		// Now add a second regular node
		await editor.getByTestId('add-step-button').click();
		await expect(nodes).toHaveCount(3, { timeout: 3000 });

		// Select the second regular node (nth(2), Task Agent is nth(0))
		// NOTE: DOM ordering assumes Task Agent pinned node is always nth(0). This
		// assumption should be verified when the feature is implemented.
		await nodes.nth(2).click();
		await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });

		// Put node in multi-agent mode (channels-section only renders with 2+ agents)
		// Use index-based selection: index 1 for first agent, then index 0 for second
		// (after selecting index 1, the remaining agent is at index 0 in the dropdown)
		const panel = editor.getByTestId('node-config-panel');
		await panel.getByTestId('agent-select').selectOption({ index: 1 });
		await panel.getByTestId('add-agent-button').click();
		await expect(panel.getByTestId('agents-list')).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('add-agent-select').selectOption({ index: 0 });
		await expect(panel.getByTestId('agents-list').getByTestId('agent-entry')).toHaveCount(2, {
			timeout: 3000,
		});

		// Verify Task Agent channel exists in the NodeConfigPanel's channels-section
		// (not the ChannelTopologyBadge which is on the canvas node)
		const channelsSection = panel.getByTestId('channels-section');
		await expect(channelsSection).toBeVisible({ timeout: 2000 });

		// Find the channel entry that references task-agent
		// "task-agent" is 10 chars; the 8-char truncation limit produces "task-age…"
		const taskAgentChannelEntry = channelsSection.locator('[data-testid="channel-entry"]').filter({
			has: page.locator('text=task-age'),
		});
		await expect(taskAgentChannelEntry).toBeVisible({ timeout: 2000 });

		// Click the remove button on that channel entry
		const removeBtn = taskAgentChannelEntry.locator('[data-testid="remove-channel-button"]');
		await expect(removeBtn).toBeVisible({ timeout: 2000 });
		await removeBtn.click();

		// Verify the Task Agent channel is no longer in the channels section
		await expect(taskAgentChannelEntry).not.toBeVisible({ timeout: 2000 });
	});
});
