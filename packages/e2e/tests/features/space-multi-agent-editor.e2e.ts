/**
 * Multi-Agent Step Editor E2E Tests
 *
 * Tests:
 * - Add a second agent to a step — verify both agents appear as badges in the canvas node
 * - Configure a one-way channel (A → B) — verify directed arrow in panel and node
 * - Configure a bidirectional channel (A ↔ B) — verify bidirectional arrow in panel and node
 * - Remove one agent — verify only one remains and associated channels are removed
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
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Roles used across tests ──────────────────────────────────────────────────

const ROLE_A = 'coder';
const ROLE_B = 'reviewer';
const AGENT_A_NAME = 'Coder Agent';
const AGENT_B_NAME = 'Reviewer Agent';
// Option text as rendered by the agent select: "{name} ({role})"
const AGENT_A_OPTION = `${AGENT_A_NAME} (${ROLE_A})`;
const AGENT_B_OPTION = `${AGENT_B_NAME} (${ROLE_B})`;

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

		// Add one step
		await editor.getByTestId('add-step-button').click();
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await expect(nodes).toHaveCount(1, { timeout: 3000 });

		// Open node config panel
		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Parallel Step');

		// Switch to multi-agent mode and add both agents
		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);

		// Verify agent names are rendered in the list entries
		const agentsList = panel.getByTestId('agents-list');
		await expect(
			agentsList.getByTestId('agent-entry').filter({ hasText: AGENT_A_NAME })
		).toBeVisible({ timeout: 2000 });
		await expect(
			agentsList.getByTestId('agent-entry').filter({ hasText: AGENT_B_NAME })
		).toBeVisible({ timeout: 2000 });

		// Close panel and verify node shows agent badges for both agents
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		const node = nodes.first();
		const agentBadges = node.getByTestId('agent-badges');
		await expect(agentBadges).toBeVisible({ timeout: 3000 });
		// Both agent names should appear as badge spans within the agent-badges container
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
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Channel Step');

		// Set up two agents (required for channels section to appear)
		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);

		// Channels section should now be visible (multi-agent mode)
		const channelsSection = panel.getByTestId('channels-section');
		await expect(channelsSection).toBeVisible({ timeout: 3000 });

		const addChannelForm = panel.getByTestId('add-channel-form');
		const channelsList = panel.getByTestId('channels-list');

		// ── Add one-way channel: coder → reviewer ────────────────────────────

		await addChannelForm.getByTestId('channel-from-select').selectOption({ value: ROLE_A });
		// Direction defaults to 'one-way' — no change needed
		await addChannelForm.getByTestId('channel-to-input').fill(ROLE_B);
		await addChannelForm.getByTestId('add-channel-button').click();

		// Channel entry should appear: "coder → reviewer"
		await expect(channelsList.getByTestId('channel-entry')).toHaveCount(1, { timeout: 3000 });
		const firstEntry = channelsList.getByTestId('channel-entry').first();
		await expect(firstEntry).toContainText(ROLE_A);
		await expect(firstEntry).toContainText('→');
		await expect(firstEntry).toContainText(ROLE_B);

		// ── Add bidirectional channel: reviewer ↔ coder ──────────────────────

		await addChannelForm.getByTestId('channel-from-select').selectOption({ value: ROLE_B });
		await addChannelForm
			.getByTestId('channel-direction-select')
			.selectOption({ value: 'bidirectional' });
		await addChannelForm.getByTestId('channel-to-input').fill(ROLE_A);
		await addChannelForm.getByTestId('add-channel-button').click();

		// Two channel entries should now be present
		await expect(channelsList.getByTestId('channel-entry')).toHaveCount(2, { timeout: 3000 });
		const secondEntry = channelsList.getByTestId('channel-entry').nth(1);
		await expect(secondEntry).toContainText(ROLE_B);
		await expect(secondEntry).toContainText('↔');
		await expect(secondEntry).toContainText(ROLE_A);

		// Close panel and verify canvas node renders channel topology via ChannelTopologyBadge
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		const node = nodes.first();
		// The ChannelTopologyBadge container has data-testid="channel-topology-badge"
		const topologyBadge = node.getByTestId('channel-topology-badge');
		await expect(topologyBadge).toBeVisible({ timeout: 3000 });

		// One-way arrow should appear within the topology badge
		await expect(
			topologyBadge.locator('[class*="font-mono"]').filter({ hasText: ROLE_A }).first()
		).toBeVisible({
			timeout: 2000,
		});
		// Bidirectional arrow should also appear within the topology badge
		await expect(topologyBadge.locator('text=↔').first()).toBeVisible({ timeout: 2000 });
	});

	// ─── Test 3: Remove one agent — verify channels removed ──────────────────

	test('Remove one agent — verify only one remains and channels are removed', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill('Remove Agent Test');

		// Add step, open config, set up multi-agent with a channel
		await editor.getByTestId('add-step-button').click();
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Remove Step');

		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);

		// Add channel coder → reviewer
		const addChannelForm = panel.getByTestId('add-channel-form');
		await addChannelForm.getByTestId('channel-from-select').selectOption({ value: ROLE_A });
		await addChannelForm.getByTestId('channel-to-input').fill(ROLE_B);
		await addChannelForm.getByTestId('add-channel-button').click();
		await expect(panel.getByTestId('channels-list').getByTestId('channel-entry')).toHaveCount(1, {
			timeout: 3000,
		});

		// Remove Reviewer Agent (the second entry in the list)
		const agentsList = panel.getByTestId('agents-list');
		const secondAgentEntry = agentsList
			.getByTestId('agent-entry')
			.filter({ hasText: AGENT_B_NAME });
		await secondAgentEntry.getByTestId('remove-agent-button').click();

		// Only one agent entry should remain
		await expect(agentsList.getByTestId('agent-entry')).toHaveCount(1, { timeout: 3000 });
		await expect(
			agentsList.getByTestId('agent-entry').filter({ hasText: AGENT_A_NAME })
		).toBeVisible({ timeout: 2000 });

		// "Switch to single" button (data-testid="switch-to-single-button") appears when
		// exactly 1 agent remains in multi-agent mode
		const switchToSingleBtn = panel.getByTestId('switch-to-single-button');
		await expect(switchToSingleBtn).toBeVisible({ timeout: 3000 });

		// Click "Switch to single" — reverts to single-agent mode and clears channels
		await switchToSingleBtn.click();

		// Channels section should no longer be visible (single-agent mode, channels cleared)
		await expect(panel.getByTestId('channels-section')).not.toBeVisible({ timeout: 3000 });

		// Single-agent select dropdown and add-agent button should be visible
		await expect(panel.getByTestId('agent-select')).toBeVisible({ timeout: 3000 });
		await expect(panel.getByTestId('add-agent-button')).toBeVisible({ timeout: 2000 });
	});

	// ─── Test 4: Save and reopen — verify persistence ─────────────────────────

	test('Save workflow and reopen — multi-agent config and channel topology persist', async ({
		page,
	}) => {
		const WORKFLOW_NAME = `Persist Test ${Date.now()}`;

		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill(WORKFLOW_NAME);

		// Add step, configure multi-agent with one channel
		await editor.getByTestId('add-step-button').click();
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('step-name-input').fill('Persist Step');

		await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);

		// Add one-way channel coder → reviewer
		const addChannelForm = panel.getByTestId('add-channel-form');
		await addChannelForm.getByTestId('channel-from-select').selectOption({ value: ROLE_A });
		await addChannelForm.getByTestId('channel-to-input').fill(ROLE_B);
		await addChannelForm.getByTestId('add-channel-button').click();
		await expect(panel.getByTestId('channels-list').getByTestId('channel-entry')).toHaveCount(1, {
			timeout: 3000,
		});

		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		// Save the workflow
		await editor.getByTestId('save-button').click();
		await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
		await expect(page.locator(`text=${WORKFLOW_NAME}`)).toBeVisible({ timeout: 5000 });

		// ── Reopen the workflow ─────────────────────────────────────────────────

		await openWorkflowForEdit(page, WORKFLOW_NAME);

		// switchToVisualMode registers a dialog handler before clicking the toggle.
		// When re-opening a saved workflow in list mode (no unsaved edits), the app may
		// or may not show a native confirm() dialog depending on whether it detects edits.
		// The one-shot handler is harmless if no dialog fires — Playwright discards it.
		await switchToVisualMode(page);

		const editorReopen = page.getByTestId('visual-workflow-editor');
		const reopenedNodes = editorReopen.locator('[data-testid^="workflow-node-"]');
		await expect(reopenedNodes).toHaveCount(1, { timeout: 5000 });

		// ── Verify canvas node shows agent badges for both agents ───────────────

		const node = reopenedNodes.first();
		const agentBadges = node.getByTestId('agent-badges');
		await expect(agentBadges).toBeVisible({ timeout: 3000 });
		await expect(agentBadges.locator(`text=${AGENT_A_NAME}`)).toBeVisible({ timeout: 2000 });
		await expect(agentBadges.locator(`text=${AGENT_B_NAME}`)).toBeVisible({ timeout: 2000 });

		// ── Verify canvas node shows channel topology arrow ─────────────────────

		// ChannelTopologyBadge renders within data-testid="channel-topology-badge"
		const topologyBadge = node.getByTestId('channel-topology-badge');
		await expect(topologyBadge).toBeVisible({ timeout: 3000 });
		// The one-way arrow → should appear between the role names
		await expect(topologyBadge.locator('text=→').first()).toBeVisible({ timeout: 2000 });

		// ── Open node config and verify agents list and channel persist ─────────

		await node.click();
		const reopenedPanel = editorReopen.getByTestId('node-config-panel');
		await expect(reopenedPanel).toBeVisible({ timeout: 3000 });

		// Agents list should have 2 entries
		const reopenedAgentsList = reopenedPanel.getByTestId('agents-list');
		await expect(reopenedAgentsList).toBeVisible({ timeout: 3000 });
		await expect(reopenedAgentsList.getByTestId('agent-entry')).toHaveCount(2, { timeout: 3000 });
		await expect(
			reopenedAgentsList.getByTestId('agent-entry').filter({ hasText: AGENT_A_NAME })
		).toBeVisible({ timeout: 2000 });
		await expect(
			reopenedAgentsList.getByTestId('agent-entry').filter({ hasText: AGENT_B_NAME })
		).toBeVisible({ timeout: 2000 });

		// Channels section should be visible with the persisted channel
		const reopenedChannelsSection = reopenedPanel.getByTestId('channels-section');
		await expect(reopenedChannelsSection).toBeVisible({ timeout: 3000 });
		const reopenedChannelsList = reopenedPanel.getByTestId('channels-list');
		await expect(reopenedChannelsList.getByTestId('channel-entry')).toHaveCount(1, {
			timeout: 3000,
		});

		// Persisted channel should show "coder → reviewer"
		const persistedEntry = reopenedChannelsList.getByTestId('channel-entry').first();
		await expect(persistedEntry).toContainText(ROLE_A);
		await expect(persistedEntry).toContainText('→');
		await expect(persistedEntry).toContainText(ROLE_B);
	});
});
