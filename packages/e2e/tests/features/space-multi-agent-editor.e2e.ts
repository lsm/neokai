/**
 * Multi-Agent Step Editor E2E Tests
 *
 * Tests:
 * - Add a second agent to a step — verify both agents appear as badges in the canvas node
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
	setupMultiAgentStep,
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
});
