/**
 * Agent-Centric Workflow E2E Tests
 *
 * Tests the agent-centric collaboration workflow model features:
 * - Create workflow with workflow-level channels between agents
 * - Add gate condition to a channel in the visual editor
 * - Agent completion state indicators on multi-agent canvas nodes
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
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
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
	expandChannelEntry,
	setChannelGate,
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Agent roles used across tests ────────────────────────────────────────────

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

// ─── RPC helpers (infrastructure only) ────────────────────────────────────────

/**
 * Creates a space and two agents (coder, reviewer) for agent-centric test scenarios.
 */
async function createTestSpace(page: Page): Promise<string> {
	await waitForWebSocketConnected(page);
	const spaceName = `E2E Agent-Centric Workflow ${Date.now()}`;
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

test.describe('Agent-Centric Workflow', () => {
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

	// ─── Test 1: Create workflow with workflow-level channels ─────────────────
	// Skipping: channels editor was removed from the workflow UI (db4118316).

	test.skip('Add workflow-level channels between agents and verify channel list', async ({
		page,
	}) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill('Agent Channel Test');

		// Wait for the canvas to fully render before checking node count.
		// switchToVisualMode only waits for the editor-mode toggle; the visual editor
		// renders async, so we must wait for the add-step button to be present.
		await expect(editor.getByTestId('add-step-button')).toBeVisible({ timeout: 5000 });

		// Add a node and configure two agents so agentRoles is populated,
		// which gives the ChannelEditor select dropdowns instead of text inputs.
		await editor.getByTestId('add-step-button').click();
		// :not([data-task-agent]) excludes the Task Agent virtual node by its own attribute.
		// Note: Playwright's filter({hasNot}) only matches descendants, not the element itself.
		const nodes = editor.locator('[data-testid^="workflow-node-"]:not([data-task-agent])');
		await expect(nodes).toHaveCount(1, { timeout: 3000 });

		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Parallel Step');
		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		// Channels section is visible by default — ensure it's open
		await ensureChannelsSectionOpen(editor);
		const channelsSection = editor.getByTestId('channels-section');
		await expect(channelsSection).toBeVisible({ timeout: 3000 });

		// Add a one-way channel: Coder Agent → Reviewer Agent
		// The channel dropdown uses slot names (= agent names) as option values.
		await addWorkflowChannel(editor, AGENT_A_NAME, AGENT_B_NAME, 'one-way');

		// Verify channel entry appears with correct from/to/direction
		const channelsList = channelsSection.getByTestId('channels-list');
		await expect(channelsList.getByTestId('channel-entry')).toHaveCount(1, { timeout: 3000 });
		const entry = channelsList.getByTestId('channel-entry').first();
		await expect(entry).toContainText(AGENT_A_NAME);
		await expect(entry).toContainText('→');
		await expect(entry).toContainText(AGENT_B_NAME);

		// Add a bidirectional channel: Reviewer Agent ↔ Coder Agent
		await addWorkflowChannel(editor, AGENT_B_NAME, AGENT_A_NAME, 'bidirectional');

		// Two entries should now be in the channels list
		await expect(channelsList.getByTestId('channel-entry')).toHaveCount(2, { timeout: 3000 });
		const secondEntry = channelsList.getByTestId('channel-entry').nth(1);
		await expect(secondEntry).toContainText(AGENT_B_NAME);
		await expect(secondEntry).toContainText('↔');
		await expect(secondEntry).toContainText(AGENT_A_NAME);
	});

	// ─── Test 2: Add gate condition to a workflow channel ─────────────────────
	// Skipping: channels editor was removed from the workflow UI (db4118316).

	test.skip('Configure human-approval gate on workflow channel — gate badge appears', async ({
		page,
	}) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill('Gate Config Test');

		// Add a node with two agents so agentRoles is populated
		await editor.getByTestId('add-step-button').click();
		const nodes = editor.locator('[data-testid^="workflow-node-"]:not([data-task-agent])');
		await expect(nodes).toHaveCount(1, { timeout: 3000 });

		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Gate Step');
		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		// Ensure channels section is open and add a channel
		// Channel select uses slot names (= agent names) as option values.
		await ensureChannelsSectionOpen(editor);
		const channelsSection = editor.getByTestId('channels-section');
		await addWorkflowChannel(editor, AGENT_A_NAME, AGENT_B_NAME);

		const channelsList = channelsSection.getByTestId('channels-list');
		await expect(channelsList.getByTestId('channel-entry')).toHaveCount(1, { timeout: 3000 });

		// Expand the channel entry to edit its gate condition
		await expandChannelEntry(channelsList, 0);

		// Gate defaults to "Automatic" (always). Switch to Human Approval.
		await setChannelGate(channelsList, 0, 'human');

		// Gate badge should appear in the channel entry summary
		const entry = channelsList.getByTestId('channel-entry').first();
		const gateBadge = entry.getByTestId('gate-badge');
		await expect(gateBadge).toBeVisible({ timeout: 3000 });
		await expect(gateBadge).toContainText('Human Approval');

		// The entry should also have data-has-gate="true" attribute
		await expect(entry).toHaveAttribute('data-has-gate', 'true');
	});

	// ─── Test 3: Agent completion state indicators ────────────────────────────
	// Skipping: depends on save functionality which has a known bug (#815) —
	// editor does not close after clicking save, preventing workflow name verification.

	test.skip('Multi-agent node renders agent badges and completion state structure', async ({
		page,
	}) => {
		const WORKFLOW_NAME = `Completion State Test ${Date.now()}`;

		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill(WORKFLOW_NAME);

		// Add a step with two agents
		await editor.getByTestId('add-step-button').click();
		const nodes = editor.locator('[data-testid^="workflow-node-"]:not([data-task-agent])');
		await expect(nodes).toHaveCount(1, { timeout: 3000 });

		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Parallel Agents');
		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		// The canvas node should show agent-badges with both agent names (slot names).
		const node = nodes.first();
		const agentBadges = node.getByTestId('agent-badges');
		await expect(agentBadges).toBeVisible({ timeout: 3000 });
		await expect(agentBadges.locator(`text=${AGENT_A_NAME}`)).toBeVisible({ timeout: 2000 });
		await expect(agentBadges.locator(`text=${AGENT_B_NAME}`)).toBeVisible({ timeout: 2000 });

		// Without an active workflow run, no completion state icons should be visible
		// (no agent-status-spinner, agent-status-check, or agent-status-fail)
		await expect(node.getByTestId('agent-status-spinner')).toHaveCount(0);
		await expect(node.getByTestId('agent-status-check')).toHaveCount(0);
		await expect(node.getByTestId('agent-status-fail')).toHaveCount(0);

		// Save the workflow so it can be reopened
		await editor.getByTestId('save-button').click();
		await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
		await expect(page.locator(`text=${WORKFLOW_NAME}`)).toBeVisible({ timeout: 5000 });

		// ── Reopen and verify agent badges persist ──────────────────────────────

		await openWorkflowForEdit(page, WORKFLOW_NAME);
		await switchToVisualMode(page);

		const editorReopen = page.getByTestId('visual-workflow-editor');
		const reopenedNodes = editorReopen.locator(
			'[data-testid^="workflow-node-"]:not([data-task-agent])'
		);
		await expect(reopenedNodes).toHaveCount(1, { timeout: 5000 });
		const reopenedNode = reopenedNodes.first();

		// Agent badges should be visible after reload (shows slot names = agent names)
		const reopenedBadges = reopenedNode.getByTestId('agent-badges');
		await expect(reopenedBadges).toBeVisible({ timeout: 3000 });
		await expect(reopenedBadges.locator(`text=${AGENT_A_NAME}`)).toBeVisible({ timeout: 2000 });
		await expect(reopenedBadges.locator(`text=${AGENT_B_NAME}`)).toBeVisible({ timeout: 2000 });

		// Still no completion state icons (no active run)
		await expect(reopenedNode.getByTestId('agent-status-spinner')).toHaveCount(0);
		await expect(reopenedNode.getByTestId('agent-status-check')).toHaveCount(0);
	});

	// ─── Test 4: Workflow channels persist after save and reopen ─────────────
	// Skipping: channels editor was removed from the workflow UI (db4118316).

	test.skip('Workflow-level channels and gate configuration persist after save', async ({
		page,
	}) => {
		const WORKFLOW_NAME = `Channel Persist Test ${Date.now()}`;

		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill(WORKFLOW_NAME);

		// Add step with two agents
		await editor.getByTestId('add-step-button').click();
		const nodes = editor.locator('[data-testid^="workflow-node-"]:not([data-task-agent])');
		await expect(nodes).toHaveCount(1, { timeout: 3000 });

		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Collab Step');
		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		// Add a workflow-level channel with a human-approval gate
		// Channel select uses slot names (= agent names) as option values.
		await ensureChannelsSectionOpen(editor);
		await addWorkflowChannel(editor, AGENT_A_NAME, AGENT_B_NAME);
		const channelsSection = editor.getByTestId('channels-section');
		const channelsList = channelsSection.getByTestId('channels-list');
		await expect(channelsList.getByTestId('channel-entry')).toHaveCount(1, { timeout: 3000 });

		// Set gate to human approval
		await expandChannelEntry(channelsList, 0);
		await setChannelGate(channelsList, 0, 'human');
		const entry = channelsList.getByTestId('channel-entry').first();
		await expect(entry.getByTestId('gate-badge')).toBeVisible({ timeout: 2000 });

		// Save workflow
		await editor.getByTestId('save-button').click();
		await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
		await expect(page.locator(`text=${WORKFLOW_NAME}`)).toBeVisible({ timeout: 5000 });

		// ── Reopen and verify channel + gate persist ────────────────────────────

		await openWorkflowForEdit(page, WORKFLOW_NAME);
		await switchToVisualMode(page);

		const editorReopen = page.getByTestId('visual-workflow-editor');

		// Channels section should be open with the persisted channel
		await ensureChannelsSectionOpen(editorReopen);
		const reopenedChannelsSection = editorReopen.getByTestId('channels-section');
		const reopenedChannelsList = reopenedChannelsSection.getByTestId('channels-list');
		await expect(reopenedChannelsList.getByTestId('channel-entry')).toHaveCount(1, {
			timeout: 5000,
		});

		// Persisted channel should show Coder Agent → Reviewer Agent (slot names = agent names)
		const persistedEntry = reopenedChannelsList.getByTestId('channel-entry').first();
		await expect(persistedEntry).toContainText(AGENT_A_NAME);
		await expect(persistedEntry).toContainText('→');
		await expect(persistedEntry).toContainText(AGENT_B_NAME);

		// Gate badge should be visible (human approval gate was persisted)
		await expect(persistedEntry.getByTestId('gate-badge')).toBeVisible({ timeout: 3000 });
		await expect(persistedEntry.getByTestId('gate-badge')).toContainText('Human Approval');
	});
});
