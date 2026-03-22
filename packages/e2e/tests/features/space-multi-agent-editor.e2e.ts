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

interface SpaceSetup {
	spaceId: string;
	agentAId: string;
	agentBId: string;
}

async function createTestSpace(page: Page): Promise<SpaceSetup> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);
	const spaceName = `E2E Multi-Agent Editor ${Date.now()}`;
	return page.evaluate(
		async ({ wsPath, name, roleA, roleB, agentAName, agentBName }) => {
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

			const res = await hub.request('space.create', { name, workspacePath: wsPath });
			const spaceId = (res as { id: string }).id;

			const aRes = await hub.request('spaceAgent.create', {
				spaceId,
				name: agentAName,
				role: roleA,
				description: '',
			});
			const agentAId = (aRes as { agent: { id: string } }).agent.id;

			const bRes = await hub.request('spaceAgent.create', {
				spaceId,
				name: agentBName,
				role: roleB,
				description: '',
			});
			const agentBId = (bRes as { agent: { id: string } }).agent.id;

			return { spaceId, agentAId, agentBId };
		},
		{
			wsPath: workspaceRoot,
			name: spaceName,
			roleA: ROLE_A,
			roleB: ROLE_B,
			agentAName: AGENT_A_NAME,
			agentBName: AGENT_B_NAME,
		}
	);
}

async function deleteTestSpace(page: Page, spaceId: string): Promise<void> {
	if (!spaceId) return;
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

// ─── UI helpers ───────────────────────────────────────────────────────────────

async function navigateToSpace(page: Page, spaceId: string): Promise<void> {
	await page.goto(`/space/${spaceId}`);
	await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });
	await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 15000 });
}

async function resetEditorModeStorage(page: Page): Promise<void> {
	await page.evaluate(() => {
		localStorage.removeItem('workflow-editor-mode');
	});
}

async function openNewWorkflowEditor(page: Page): Promise<void> {
	await page.locator('text=Workflows').first().click();
	const createBtn = page.getByRole('button', { name: 'Create Workflow' });
	await expect(createBtn).toBeVisible({ timeout: 5000 });
	await createBtn.click();
	await expect(page.getByTestId('editor-mode-toggle')).toBeVisible({ timeout: 5000 });
}

async function switchToVisualMode(page: Page): Promise<void> {
	page.once('dialog', (d) => d.accept());
	await page.getByTestId('editor-mode-visual').click();
	await expect(page.getByTestId('visual-workflow-editor')).toBeVisible({ timeout: 5000 });
}

/**
 * Open the workflow edit UI for an existing workflow in the list.
 * Forced opacity reveal is required because edit buttons are CSS group-hover only.
 */
async function openWorkflowForEdit(page: Page, workflowName: string): Promise<void> {
	await page.locator('text=Workflows').first().click();
	await expect(page.locator(`text=${workflowName}`)).toBeVisible({ timeout: 5000 });

	const workflowCard = page
		.locator('[class*="group"]')
		.filter({ has: page.locator(`text=${workflowName}`) })
		.first();
	await expect(workflowCard).toBeVisible({ timeout: 3000 });
	await workflowCard.evaluate((el) => {
		const actions = el.querySelector<HTMLElement>('[data-testid="workflow-card-actions"]');
		if (actions) actions.style.opacity = '1';
	});

	const editBtn = workflowCard.getByRole('button', { name: 'Edit' });
	await expect(editBtn).toBeVisible({ timeout: 3000 });
	await editBtn.click();

	await expect(page.getByTestId('editor-mode-toggle')).toBeVisible({ timeout: 5000 });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Multi-Agent Step Editor', () => {
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await resetEditorModeStorage(page);
		const setup = await createTestSpace(page);
		spaceId = setup.spaceId;
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteTestSpace(page, spaceId);
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

		// Set step name
		await panel.getByTestId('step-name-input').fill('Parallel Step');

		// Select first agent (Coder Agent) via single-agent select
		const agentSelect = panel.getByTestId('agent-select');
		await agentSelect.selectOption({ label: AGENT_A_OPTION });

		// Click "+ Add agent" to switch to multi-agent mode
		await panel.getByTestId('add-agent-button').click();

		// Multi-agent mode: agents-list should appear with one entry (Coder Agent)
		const agentsList = panel.getByTestId('agents-list');
		await expect(agentsList).toBeVisible({ timeout: 3000 });
		await expect(agentsList.getByTestId('agent-entry')).toHaveCount(1, { timeout: 2000 });

		// Add Reviewer Agent via add-agent-select
		const addAgentSelect = panel.getByTestId('add-agent-select');
		await expect(addAgentSelect).toBeVisible({ timeout: 3000 });
		await addAgentSelect.selectOption({ label: AGENT_B_OPTION });

		// Both agents should now be in the list
		await expect(agentsList.getByTestId('agent-entry')).toHaveCount(2, { timeout: 3000 });

		// Verify agent names are rendered in the entries
		await expect(agentsList.locator(`text=${AGENT_A_NAME}`).first()).toBeVisible({
			timeout: 2000,
		});
		await expect(agentsList.locator(`text=${AGENT_B_NAME}`).first()).toBeVisible({
			timeout: 2000,
		});

		// Close panel and verify node shows agent badges for both agents
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		const node = nodes.first();
		const agentBadges = node.getByTestId('agent-badges');
		await expect(agentBadges).toBeVisible({ timeout: 3000 });

		// Both agent names should appear as badges in the canvas node
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

		// Set up multi-agent step: select Coder Agent, then add Reviewer Agent
		await panel.getByTestId('agent-select').selectOption({ label: AGENT_A_OPTION });
		await panel.getByTestId('add-agent-button').click();
		await expect(panel.getByTestId('agents-list')).toBeVisible({ timeout: 3000 });
		await panel.getByTestId('add-agent-select').selectOption({ label: AGENT_B_OPTION });
		await expect(panel.getByTestId('agents-list').getByTestId('agent-entry')).toHaveCount(2, {
			timeout: 3000,
		});

		// Channels section should now be visible (multi-agent mode)
		const channelsSection = panel.getByTestId('channels-section');
		await expect(channelsSection).toBeVisible({ timeout: 3000 });

		// ── Add one-way channel: coder → reviewer ────────────────────────────

		const addChannelForm = panel.getByTestId('add-channel-form');

		await addChannelForm.getByTestId('channel-from-select').selectOption({ value: ROLE_A });
		// Direction is 'one-way' by default — no change needed
		await addChannelForm.getByTestId('channel-to-input').fill(ROLE_B);
		await addChannelForm.getByTestId('add-channel-button').click();

		// Channel entry should appear: "coder → reviewer"
		const channelsList = panel.getByTestId('channels-list');
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

		// Close panel and verify canvas node renders channel topology
		await panel.getByTestId('close-button').click();
		await expect(panel).not.toBeVisible({ timeout: 2000 });

		const node = nodes.first();

		// One-way arrow should appear in the channel topology badge on the node
		await expect(node.locator('text=→').first()).toBeVisible({ timeout: 3000 });
		// Bidirectional arrow should also appear
		await expect(node.locator('text=↔').first()).toBeVisible({ timeout: 3000 });
	});

	// ─── Test 3: Remove one agent — verify channels removed ──────────────────

	test('Remove one agent — verify only one remains and channels are removed', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill('Remove Agent Test');

		// Add step, switch to multi-agent with a channel
		await editor.getByTestId('add-step-button').click();
		const nodes = editor.locator('[data-testid^="workflow-node-"]');
		await nodes.first().click();
		const panel = editor.getByTestId('node-config-panel');
		await expect(panel).toBeVisible({ timeout: 3000 });

		await panel.getByTestId('step-name-input').fill('Remove Step');
		await panel.getByTestId('agent-select').selectOption({ label: AGENT_A_OPTION });
		await panel.getByTestId('add-agent-button').click();
		await panel.getByTestId('add-agent-select').selectOption({ label: AGENT_B_OPTION });
		await expect(panel.getByTestId('agents-list').getByTestId('agent-entry')).toHaveCount(2, {
			timeout: 3000,
		});

		// Add channel coder → reviewer
		const addChannelForm = panel.getByTestId('add-channel-form');
		await addChannelForm.getByTestId('channel-from-select').selectOption({ value: ROLE_A });
		await addChannelForm.getByTestId('channel-to-input').fill(ROLE_B);
		await addChannelForm.getByTestId('add-channel-button').click();
		await expect(panel.getByTestId('channels-list').getByTestId('channel-entry')).toHaveCount(1, {
			timeout: 3000,
		});

		// Remove Reviewer Agent (second entry)
		const agentsList = panel.getByTestId('agents-list');
		const secondAgentEntry = agentsList.getByTestId('agent-entry').nth(1);
		await secondAgentEntry.getByTestId('remove-agent-button').click();

		// Only one agent entry should remain
		await expect(agentsList.getByTestId('agent-entry')).toHaveCount(1, { timeout: 3000 });

		// "Switch to single" button appears when exactly 1 agent remains in multi-agent mode
		const switchToSingleBtn = panel.getByRole('button', { name: 'Switch to single' });
		await expect(switchToSingleBtn).toBeVisible({ timeout: 3000 });

		// Click "Switch to single" — reverts to single-agent mode and clears channels
		await switchToSingleBtn.click();

		// Channels section should no longer be visible (single-agent mode)
		await expect(panel.getByTestId('channels-section')).not.toBeVisible({ timeout: 3000 });

		// Single-agent select dropdown should be visible
		await expect(panel.getByTestId('agent-select')).toBeVisible({ timeout: 3000 });

		// Add-agent button should be visible (single-agent mode controls)
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
		await panel.getByTestId('agent-select').selectOption({ label: AGENT_A_OPTION });
		await panel.getByTestId('add-agent-button').click();
		await panel.getByTestId('add-agent-select').selectOption({ label: AGENT_B_OPTION });
		await expect(panel.getByTestId('agents-list').getByTestId('agent-entry')).toHaveCount(2, {
			timeout: 3000,
		});

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

		// The ChannelTopologyBadge renders the → symbol between role names
		await expect(node.locator('text=→').first()).toBeVisible({ timeout: 3000 });

		// ── Open node config and verify agents list and channel persist ─────────

		await node.click();
		const reopenedPanel = editorReopen.getByTestId('node-config-panel');
		await expect(reopenedPanel).toBeVisible({ timeout: 3000 });

		// Agents list should have 2 entries
		const reopenedAgentsList = reopenedPanel.getByTestId('agents-list');
		await expect(reopenedAgentsList).toBeVisible({ timeout: 3000 });
		await expect(reopenedAgentsList.getByTestId('agent-entry')).toHaveCount(2, { timeout: 3000 });

		// Channels section should be visible with the persisted channel
		const reopenedChannelsSection = reopenedPanel.getByTestId('channels-section');
		await expect(reopenedChannelsSection).toBeVisible({ timeout: 3000 });
		const reopenedChannelsList = reopenedPanel.getByTestId('channels-list');
		await expect(reopenedChannelsList.getByTestId('channel-entry')).toHaveCount(1, {
			timeout: 3000,
		});

		// The persisted channel should show coder → reviewer
		const persistedEntry = reopenedChannelsList.getByTestId('channel-entry').first();
		await expect(persistedEntry).toContainText(ROLE_A);
		await expect(persistedEntry).toContainText('→');
		await expect(persistedEntry).toContainText(ROLE_B);
	});
});
