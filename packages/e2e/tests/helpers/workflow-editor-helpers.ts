/**
 * Shared helpers for visual workflow editor E2E tests.
 *
 * Used by:
 * - tests/features/visual-workflow-editor.e2e.ts
 * - tests/features/space-multi-agent-editor.e2e.ts
 */

import type { Page, Locator } from '@playwright/test';
import { expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from './wait-helpers';
import { createUniqueSpaceDir } from './space-helpers';

// ─── Space lifecycle (RPC — infrastructure only) ───────────────────────────────

export async function createSpace(page: Page, name: string): Promise<string> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);
	// Use a unique subdirectory to avoid conflicts with other parallel tests
	// (workspace_path has a UNIQUE constraint in the DB).
	const wsPath = createUniqueSpaceDir(workspaceRoot, 'workflow-editor');
	return page.evaluate(
		async ({ wsPath, spaceName }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			const res = await hub.request('space.create', { name: spaceName, workspacePath: wsPath });
			return (res as { id: string }).id;
		},
		{ wsPath, spaceName: name }
	);
}

export async function deleteSpace(page: Page, spaceId: string): Promise<void> {
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

/** Get the default agent ID for the active space (infrastructure only). */
export async function getDefaultAgentId(page: Page, spaceId: string): Promise<string> {
	return page.evaluate(async (sid) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('Hub not available');
		const res = (await hub.request('spaceAgent.list', { spaceId: sid })) as {
			agents: Array<{ id: string; name: string }>;
		};
		const agent = res.agents.find((a) => a.name === 'Planner') ?? res.agents[0];
		if (!agent) throw new Error('No agents found in space');
		return agent.id;
	}, spaceId);
}

// ─── Navigation helpers ────────────────────────────────────────────────────────

export async function navigateToSpace(page: Page, spaceId: string): Promise<void> {
	await page.goto(`/space/${spaceId}`);
	await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });
	// Wait for the overview surface to appear. This confirms space data has loaded.
	await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 15000 });
}

// ─── Editor mode helpers ───────────────────────────────────────────────────────

/**
 * Reset the workflow editor mode stored in localStorage to prevent test-ordering
 * flakiness. SpaceIsland reads 'workflow-editor-mode' on mount; if a prior test
 * left it at 'visual', subsequent tests start in visual mode unexpectedly.
 */
export async function resetEditorModeStorage(page: Page): Promise<void> {
	await page.evaluate(() => {
		localStorage.removeItem('workflow-editor-mode');
	});
}

/**
 * Navigate to Workflows tab and open the workflow editor for a new workflow.
 *
 * The Workflows tab lives inside the Configure page (/space/:id/configure).
 * If the current page is not the configure view, this helper first clicks the
 * "Configure space" gear button in the context panel to get there.
 */
export async function openNewWorkflowEditor(page: Page): Promise<void> {
	// Navigate to configure view if not already there.
	const configureView = page.getByTestId('space-configure-view');
	if (!(await configureView.isVisible().catch(() => false))) {
		await page.getByRole('button', { name: 'Configure space' }).click();
		await expect(configureView).toBeVisible({ timeout: 5000 });
	}

	// Switch to Workflows tab within the configure page.
	await page.getByTestId('space-configure-tab-workflows').click();

	const createBtn = page.getByRole('button', { name: 'Create Workflow' });
	await expect(createBtn).toBeVisible({ timeout: 5000 });
	await createBtn.click();
	// Current UX opens Visual editor directly. Keep compatibility with older
	// builds that still render an editor mode toggle.
	await Promise.any([
		page.getByTestId('visual-workflow-editor').waitFor({ state: 'visible', timeout: 5000 }),
		page.getByTestId('editor-mode-toggle').waitFor({ state: 'visible', timeout: 5000 }),
	]);
}

/** Switch to Visual editor mode, accepting any confirmation dialogs. */
export async function switchToVisualMode(page: Page): Promise<void> {
	// Modern flow: visual editor is already active.
	if (
		await page
			.getByTestId('visual-workflow-editor')
			.isVisible()
			.catch(() => false)
	) {
		return;
	}

	// Register dialog handler before clicking — native confirm() fires synchronously
	page.once('dialog', (d) => d.accept());
	await page.getByTestId('editor-mode-visual').click();
	await expect(page.getByTestId('visual-workflow-editor')).toBeVisible({ timeout: 5000 });
}

/**
 * Open the workflow edit UI for an existing workflow in the list.
 * The edit button is CSS group-hover only, so opacity is forced via JS before clicking.
 *
 * The Workflows tab lives inside the Configure page (/space/:id/configure).
 * If the current page is not the configure view, this helper first clicks the
 * "Configure space" gear button in the context panel to get there.
 */
export async function openWorkflowForEdit(page: Page, workflowName: string): Promise<void> {
	// Navigate to configure view if not already there.
	const configureView = page.getByTestId('space-configure-view');
	if (!(await configureView.isVisible().catch(() => false))) {
		await page.getByRole('button', { name: 'Configure space' }).click();
		await expect(configureView).toBeVisible({ timeout: 5000 });
	}

	// Switch to Workflows tab within the configure page.
	await page.getByTestId('space-configure-tab-workflows').click();
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

	await Promise.any([
		page.getByTestId('visual-workflow-editor').waitFor({ state: 'visible', timeout: 5000 }),
		page.getByTestId('editor-mode-toggle').waitFor({ state: 'visible', timeout: 5000 }),
	]);
}

// ─── Multi-agent step helpers ──────────────────────────────────────────────────

/**
 * Configure a node config panel to have two agents in multi-agent mode.
 *
 * Precondition: the NodeConfigPanel is already open (panel locator is visible).
 * Postcondition: agents-list has 2 agent-entry items with the specified agents.
 *
 * The "Add agent" button creates 2 slots: primary (selected agent) and secondary
 * (auto-selected from the first non-primary agent in the space's agent list). Since
 * spaces have pre-seeded preset agents, the auto-selected secondary is typically a
 * preset agent — not the desired agent. This helper updates the secondary slot's
 * agent assignment and role name to match the desired agent.
 *
 * @param panel - Locator scoped to the `node-config-panel` element
 * @param agentAOption - Exact option label for the first agent (e.g. "Coder Agent")
 * @param agentBOption - Exact option label for the second agent (e.g. "Reviewer Agent")
 */
export async function setupMultiAgentStep(
	panel: Locator,
	agentAOption: string,
	agentBOption: string
): Promise<void> {
	// Select first agent in single-agent mode
	await panel.getByTestId('agent-select').selectOption({ label: agentAOption });

	// Switch to multi-agent mode — creates 2 slots:
	//   1) primary slot from the selected agent
	//   2) secondary slot auto-selected from the first non-primary agent in the list
	await panel.getByTestId('add-agent-button').click();
	await expect(panel.getByTestId('agents-list')).toBeVisible({ timeout: 3000 });

	// Verify 2 slots were created by the button
	const agentEntries = panel.getByTestId('agents-list').getByTestId('agent-entry');
	await expect(agentEntries).toHaveCount(2, { timeout: 3000 });

	// Update the secondary slot's agent assignment to the desired agent
	await agentEntries.nth(1).getByTestId('agent-slot-select').selectOption({ label: agentBOption });

	// Update the secondary slot's role name to match the agent name
	const secondaryRoleInput = agentEntries.nth(1).getByTestId('agent-role-input');
	await secondaryRoleInput.clear();
	await secondaryRoleInput.fill(agentBOption);

	// Verify both entries are present before returning
	await expect(panel.getByTestId('agents-list').getByTestId('agent-entry')).toHaveCount(2, {
		timeout: 3000,
	});
}
