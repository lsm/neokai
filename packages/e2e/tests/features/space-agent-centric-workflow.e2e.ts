/**
 * Agent-Centric Workflow E2E Tests
 *
 * Tests the agent-centric collaboration workflow model features:
 * - Multi-agent node renders agent badges and completion state structure
 *
 * Previous tests for workflow-level channels and gate configuration were removed
 * because the channels editor was removed from the workflow UI (db4118316).
 * The save+reopen test was removed due to a known save bug (#815).
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
	setupMultiAgentStep,
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

	test('Multi-agent node renders agent badges and completion state structure', async ({ page }) => {
		await navigateToSpace(page, spaceId);
		await openNewWorkflowEditor(page);
		await switchToVisualMode(page);

		const editor = page.getByTestId('visual-workflow-editor');
		await editor.getByTestId('workflow-name-input').fill('Completion State Test');

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
	});
});
