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

// ─── Space lifecycle (RPC — infrastructure only) ───────────────────────────────

export async function createSpace(page: Page, name: string): Promise<string> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);
	return page.evaluate(
		async ({ wsPath, spaceName }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// Clean up any leftover space at this workspace path (including archived).
			const norm = (p: string) => p.replace(/^\/private/, '');
			try {
				const list = (await hub.request('space.list', { includeArchived: true })) as Array<{
					id: string;
					workspacePath: string;
				}>;
				const matches = list.filter((s) => norm(s.workspacePath) === norm(wsPath));
				for (const s of matches) {
					await hub.request('space.delete', { id: s.id });
				}
			} catch {
				// Ignore cleanup errors
			}

			const res = await hub.request('space.create', { name: spaceName, workspacePath: wsPath });
			return (res as { id: string }).id;
		},
		{ wsPath: workspaceRoot, spaceName: name }
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
	// Wait for the space overview to render. The space dashboard was refactored and
	// no longer shows a "Dashboard" tab — use the testid on the overview container instead.
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
 * Postcondition: agents-list has 2 agent-entry items.
 *
 * @param panel - Locator scoped to the `node-config-panel` element
 * @param agentAOption - Exact option label for the first agent (e.g. "Coder Agent (coder)")
 * @param agentBOption - Exact option label for the second agent (e.g. "Reviewer Agent (reviewer)")
 */
export async function setupMultiAgentStep(
	panel: Locator,
	agentAOption: string,
	agentBOption: string
): Promise<void> {
	// Select first agent in single-agent mode
	await panel.getByTestId('agent-select').selectOption({ label: agentAOption });

	// Switch to multi-agent mode — moves the selected agent into the agents[] array
	await panel.getByTestId('add-agent-button').click();
	await expect(panel.getByTestId('agents-list')).toBeVisible({ timeout: 3000 });

	// Add second agent from the dropdown (shows remaining agents)
	await panel.getByTestId('add-agent-select').selectOption({ label: agentBOption });

	// Verify both entries are present before returning
	await expect(panel.getByTestId('agents-list').getByTestId('agent-entry')).toHaveCount(2, {
		timeout: 3000,
	});
}

// ─── Workflow-level channel helpers ───────────────────────────────────────────

/**
 * Ensure the Channels collapsible section is expanded in the visual editor.
 * The section is open by default (showChannels = true), but this helper
 * will click the toggle if it was previously collapsed.
 *
 * @param editor - Locator scoped to the `visual-workflow-editor` element
 */
export async function ensureChannelsSectionOpen(editor: Locator): Promise<void> {
	const section = editor.getByTestId('channels-section');
	const isVisible = await section.isVisible().catch(() => false);
	if (!isVisible) {
		await editor.getByTestId('toggle-channels-button').click();
		await expect(section).toBeVisible({ timeout: 3000 });
	}
}

/**
 * Add a workflow-level channel using the AddChannelForm inside the ChannelEditor.
 *
 * When the editor has agentRoles (nodes with multi-agent config), select elements
 * are shown — pass `from`/`to` as agent role names.
 * When agentRoles is empty (single-agent nodes), text inputs are used instead.
 *
 * @param editor - Locator scoped to the `visual-workflow-editor` element
 * @param from - Source agent role name (e.g. "coder", "task-agent", "*")
 * @param to - Target agent role name (e.g. "reviewer")
 * @param direction - Channel direction ('one-way' | 'bidirectional'), defaults to 'one-way'
 */
export async function addWorkflowChannel(
	editor: Locator,
	from: string,
	to: string,
	direction: 'one-way' | 'bidirectional' = 'one-way'
): Promise<void> {
	const form = editor.getByTestId('add-channel-form');

	// From — prefer select, fall back to text input
	const fromSelect = form.getByTestId('new-channel-from-select');
	if (await fromSelect.isVisible().catch(() => false)) {
		await fromSelect.selectOption({ value: from });
	} else {
		await form.getByTestId('new-channel-from-input').fill(from);
	}

	// Direction (only change if not default one-way)
	if (direction !== 'one-way') {
		await form.getByTestId('new-channel-direction-select').selectOption({ value: direction });
	}

	// To — prefer select, fall back to text input
	const toSelect = form.getByTestId('new-channel-to-select');
	if (await toSelect.isVisible().catch(() => false)) {
		await toSelect.selectOption({ value: to });
	} else {
		await form.getByTestId('new-channel-to-input').fill(to);
	}

	await form.getByTestId('add-channel-submit-button').click();
}

/**
 * Expand a channel entry at the given (zero-based) index for inline editing.
 *
 * @param channelsList - Locator scoped to the `channels-list` element
 * @param index - Zero-based index of the channel to expand
 */
export async function expandChannelEntry(channelsList: Locator, index: number): Promise<void> {
	const entry = channelsList.getByTestId('channel-entry').nth(index);
	const editForm = entry.getByTestId('channel-edit-form');
	const isAlreadyExpanded = await editForm.isVisible().catch(() => false);
	if (!isAlreadyExpanded) {
		await entry.getByTestId('channel-expand-button').click();
		await expect(editForm).toBeVisible({ timeout: 2000 });
	}
}

/**
 * Set the gate condition type on an expanded channel entry.
 *
 * Precondition: the channel entry at `index` is already expanded (channel-edit-form visible).
 *
 * @param channelsList - Locator scoped to the `channels-list` element
 * @param index - Zero-based channel index (used to target the correct gate select)
 * @param gateType - Gate condition type: 'always' | 'human' | 'condition' | 'task_result'
 */
export async function setChannelGate(
	channelsList: Locator,
	index: number,
	gateType: 'always' | 'human' | 'condition' | 'task_result'
): Promise<void> {
	const gateSelect = channelsList.getByTestId(`channel-gate-select-${index}`);
	await expect(gateSelect).toBeVisible({ timeout: 3000 });
	await gateSelect.selectOption({ value: gateType });
}
