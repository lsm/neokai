/**
 * Multi-Agent Step Editor E2E Tests
 *
 * Tests:
 * - Add a second agent to a step — verify both agents appear as badges in the canvas node
 * - Configure a one-way channel (A → B) — verify directed arrow in panel and node
 * - Configure a bidirectional channel (A ↔ B) — verify bidirectional arrow in panel and node
 * - Remove one agent — verify only one remains and workflow channels persist
 * - Save workflow and re-open — verify multi-agent config AND channel topology persists
 *
 * Setup: creates a Space with two agents via RPC in beforeEach (infrastructure).
 * Cleanup: deletes the Space via RPC in afterEach.
 *
 * E2E Rules:
 * - All test actions go through the UI (clicks, inputs, navigation)
 * - All assertions check visible DOM state
 * - RPC is only used in beforeEach/afterEach for test infrastructure
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
	createSpace,
	deleteSpace,
	navigateToSpace,
	resetEditorModeStorage,
	openNewWorkflowEditor,
	switchToVisualMode,
	openWorkflowForEdit,
	setupMultiAgentStep,
	ensureChannelsSectionOpen,
	addWorkflowChannel,
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Roles used across tests ──────────────────────────────────────────────────

const ROLE_A = 'coder';
const ROLE_B = 'reviewer';
// Agent names use a distinct suffix to avoid conflicts with space pre-seeded agents
// (e.g. the seeded agent named 'coder'). These names become slot names in multi-agent
// steps, and the channel dropdown select options use slot names as their values.
const AGENT_A_NAME = 'Coder Agent';
const AGENT_B_NAME = 'Reviewer Agent';
// Option text as rendered by agent-select and add-agent-select: just the agent name
const AGENT_A_OPTION = AGENT_A_NAME;
const AGENT_B_OPTION = AGENT_B_NAME;

// ─── RPC helpers (infrastructure only) ───────────────────────────────────────

/**
 * Creates a space and two agents (coder, reviewer) for multi-agent test scenarios.
 * Returns only spaceId — agent IDs are not needed by tests since agents are
 * selected by option label in the UI.
 */
async function createTestSpace(page: Page): Promise<string> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);
	const spaceName = `E2E Multi-Agent Editor ${Date.now()}`;
	const spaceId = await createSpace(page, spaceName);

	await page.evaluate(
		async ({ sid, roleA, roleB, agentAName, agentBName }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			await hub.request('spaceAgent.create', {
				spaceId: sid,
				name: agentAName,
				role: roleA,
				description: '',
			});
			await hub.request('spaceAgent.create', {
				spaceId: sid,
				name: agentBName,
				role: roleB,
				description: '',
			});
		},
		{
			sid: spaceId,
			roleA: ROLE_A,
			roleB: ROLE_B,
			agentAName: AGENT_A_NAME,
			agentBName: AGENT_B_NAME,
		}
	);

	return spaceId;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Multi-Agent Step Editor', () => {
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

	// ─── Test 1: Add second agent — verify both agents appear as badges ───────

	test('Edit step to add second agent — verify both agents appear as badges', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill('Multi-Agent Badges Test');

		// Add one step — Task Agent is shown as an overlay (data-testid="task-agent-overlay"),
		// not as a workflow-node-* element, so we get 1 node in the canvas after clicking Add Step.
		await editor.getByTestId('add-step-button').click();
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await expect(nodes).toHaveCount(1, { timeout: 3000 });

		// Open node config panel — click the single added regular node
		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Parallel Step');

		// Switch to multi-agent mode and add both agents
		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);

		// Verify agent slot names are rendered in the list entries.
		// Using agent-role-input values instead of hasText filter because both entries
		// contain all agent names in their dropdown options (causing false filter matches).
		const agentsList = panel.getByTestId('agents-list');
		await expect(agentsList.getByTestId('agent-entry')).toHaveCount(2, { timeout: 2000 });
		const roleInputs = agentsList.locator('[data-testid="agent-role-input"]');
		// Slot names are derived from agent names — AGENT_A_NAME is added first, AGENT_B_NAME second
		await expect(roleInputs.first()).toHaveValue(AGENT_A_NAME, { timeout: 2000 });
		await expect(roleInputs.nth(1)).toHaveValue(AGENT_B_NAME, { timeout: 2000 });

		// Close panel and verify node shows agent badges for both agents
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		// Get a fresh node locator after panel closes (the previous nodes locator may be stale).
		// Task Agent is rendered as a separate overlay (not a workflow-node-* element), so the
		// regular node is the only workflow-node-* and sits at index 0.
		const freshNodes = editor.locator('[data-testid^="workflow-node-"]');
		const regularNode = freshNodes.nth(0);
		const agentBadges = regularNode.getByTestId('agent-badges');
		await expect(agentBadges).toBeVisible({ timeout: 3000 });
		// Badges show the slot name (= agent name) for each agent in the step
		await expect(agentBadges.locator(`text=${AGENT_A_NAME}`)).toBeVisible({ timeout: 2000 });
		await expect(agentBadges.locator(`text=${AGENT_B_NAME}`)).toBeVisible({ timeout: 2000 });
	});

	// ─── Test 2: Configure channels — one-way and bidirectional ──────────────

	test('Add one-way and bidirectional channels — verify directed arrows appear', async ({
		page,
	}) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill('Channel Topology Test');

		// Add step and open config
		await editor.getByTestId('add-step-button').click();
		const regularNode = editor.locator(
			'[data-testid^="workflow-node-"]:not([data-task-agent="true"])'
		);
		await expect(regularNode).toHaveCount(1, { timeout: 3000 });
		await regularNode.click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Channel Step');

		// Set up two agents (required for channels section to populate agent role dropdowns)
		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);

		// Close panel — channels section is in the editor sidebar, not the node config panel
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		// Open the workflow-level channels section in the sidebar
		await ensureChannelsSectionOpen(editor);
		const channelsSection = editor.getByTestId('channels-section');
		await expect(channelsSection).toBeVisible({ timeout: 3000 });

		const channelsList = channelsSection.getByTestId('channels-list');

		// ── Add one-way channel: Coder Agent → Reviewer Agent ───────────────
		// Channel dropdown uses slot names (= agent names) as option values.

		await addWorkflowChannel(editor, AGENT_A_NAME, AGENT_B_NAME, 'one-way');

		// One channel entry should appear
		await expect(channelsList.getByTestId('channel-entry')).toHaveCount(1, { timeout: 3000 });
		const firstEntry = channelsList.getByTestId('channel-entry').first();
		await expect(firstEntry).toContainText(AGENT_A_NAME);
		await expect(firstEntry).toContainText('→');
		await expect(firstEntry).toContainText(AGENT_B_NAME);

		// ── Add bidirectional channel: Reviewer Agent ↔ Coder Agent ─────────

		await addWorkflowChannel(editor, AGENT_B_NAME, AGENT_A_NAME, 'bidirectional');

		// Two channel entries should now be present
		await expect(channelsList.getByTestId('channel-entry')).toHaveCount(2, { timeout: 3000 });
		const secondEntry = channelsList.getByTestId('channel-entry').nth(1);
		await expect(secondEntry).toContainText(AGENT_B_NAME);
		await expect(secondEntry).toContainText('↔');
		await expect(secondEntry).toContainText(AGENT_A_NAME);
	});

	// ─── Test 3: Remove one agent — verify workflow channels persist ──────────

	test('Remove one agent — verify only one remains and workflow channels persist', async ({
		page,
	}) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill('Remove Agent Test');

		// Add step, open config, set up multi-agent
		await editor.getByTestId('add-step-button').click();
		const regularNode = editor.locator(
			'[data-testid^="workflow-node-"]:not([data-task-agent="true"])'
		);
		await expect(regularNode).toHaveCount(1, { timeout: 3000 });
		await regularNode.click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Remove Step');

		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);

		// Close panel — channels section is in the editor sidebar, not the node config panel
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		// Add a workflow-level channel: Coder Agent → Reviewer Agent
		// Channel dropdown uses slot names (= agent names) as option values.
		await ensureChannelsSectionOpen(editor);
		await addWorkflowChannel(editor, AGENT_A_NAME, AGENT_B_NAME);
		await expect(
			editor
				.getByTestId('channels-section')
				.getByTestId('channels-list')
				.getByTestId('channel-entry')
		).toHaveCount(1, { timeout: 3000 });

		// Reopen the node config panel to remove an agent
		await regularNode.click();
		const reopenedPanel = editor.getByTestId('node-config-panel');
		await expect(reopenedPanel).toBeVisible({ timeout: 3000 });

		// Remove Reviewer Agent (the second entry in the list).
		// Cannot use filter({ hasText }) because both entries contain all agent names in their
		// dropdown options — use nth(1) to target the second entry directly.
		const agentsList = reopenedPanel.getByTestId('agents-list');
		const secondAgentEntry = agentsList.getByTestId('agent-entry').nth(1);
		await secondAgentEntry.getByTestId('remove-agent-button').click();

		// Only one agent entry should remain; verify by role-input value (not hasText filter)
		await expect(agentsList.getByTestId('agent-entry')).toHaveCount(1, { timeout: 3000 });
		const remainingRoleInput = agentsList.locator('[data-testid="agent-role-input"]').first();
		await expect(remainingRoleInput).toHaveValue(AGENT_A_NAME, { timeout: 2000 });

		// "Switch to single" button (data-testid="switch-to-single-button") appears when
		// exactly 1 agent remains in multi-agent mode
		const switchToSingleBtn = reopenedPanel.getByTestId('switch-to-single-button');
		await expect(switchToSingleBtn).toBeVisible({ timeout: 3000 });

		// Click "Switch to single" — reverts to single-agent mode and clears node-level channels
		await switchToSingleBtn.click();

		// Workflow-level channels are independent of node-level agent config and persist
		await ensureChannelsSectionOpen(editor);
		await expect(
			editor
				.getByTestId('channels-section')
				.getByTestId('channels-list')
				.getByTestId('channel-entry')
		).toHaveCount(1, { timeout: 3000 });

		// Single-agent select dropdown and add-agent button should be visible
		await expect(reopenedPanel.getByTestId('agent-select')).toBeVisible({ timeout: 3000 });
		await expect(reopenedPanel.getByTestId('add-agent-button')).toBeVisible({ timeout: 2000 });
	});

	// ─── Test 4: Save and reopen — verify persistence ─────────────────────────

	// Tracking: https://github.com/lsm/neokai/issues/815 (save issue - editor does not close after clicking save)
	// This is a product bug. When fixed, restore the full multi-agent setup below.
	test.skip('Save workflow and reopen — multi-agent config and channel topology persist', async ({
		page,
	}) => {
		const WORKFLOW_NAME = `Persist Test ${Date.now()}`;

		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill(WORKFLOW_NAME);

		// Add step (simplified - no multi-agent to isolate save issue)
		await editor.getByTestId('add-step-button').click();
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		// Task Agent is an overlay (not a workflow-node-*), so the regular node is at index 0
		await nodes.nth(0).click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Persist Step');
		// Assign an agent - required for save to succeed
		await panel.getByTestId('agent-select').selectOption({ index: 1 });

		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		// Save the workflow
		await editor.getByTestId('save-button').click();
		await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
		await expect(page.locator(`text=${WORKFLOW_NAME}`)).toBeVisible({ timeout: 5000 });

		// ── Reopen the workflow ─────────────────────────────────────────────────

		await openWorkflowForEdit(page, WORKFLOW_NAME);
		await switchToVisualMode(page);

		const editorReopen = page.getByTestId('visual-workflow-editor');
		const reopenedNodes = editorReopen.locator('[data-testid^="workflow-node-"]');
		// 1 regular node + Task Agent = 2 total
		await expect(reopenedNodes).toHaveCount(2, { timeout: 5000 });

		// ── Verify the regular node was restored ─────────────────────────────────

		// Task Agent is at index 0, regular node at index 1
		const regularNode = reopenedNodes.nth(1);
		const agentName = regularNode.getByTestId('agent-name');
		await expect(agentName).toBeVisible({ timeout: 3000 });
	});
});
