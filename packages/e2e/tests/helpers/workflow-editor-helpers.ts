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

// ─── Navigation helpers ────────────────────────────────────────────────────────

export async function navigateToSpace(page: Page, spaceId: string): Promise<void> {
	await page.goto(`/space/${spaceId}`);
	await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });
	await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 15000 });
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

/** Navigate to Workflows tab and open the workflow editor for a new workflow. */
export async function openNewWorkflowEditor(page: Page): Promise<void> {
	await page.locator('text=Workflows').first().click();
	const createBtn = page.getByRole('button', { name: 'Create Workflow' });
	await expect(createBtn).toBeVisible({ timeout: 5000 });
	await createBtn.click();
	await expect(page.getByTestId('editor-mode-toggle')).toBeVisible({ timeout: 5000 });
}

/** Switch to Visual editor mode, accepting any confirmation dialogs. */
export async function switchToVisualMode(page: Page): Promise<void> {
	// Register dialog handler before clicking — native confirm() fires synchronously
	page.once('dialog', (d) => d.accept());
	await page.getByTestId('editor-mode-visual').click();
	await expect(page.getByTestId('visual-workflow-editor')).toBeVisible({ timeout: 5000 });
}

/**
 * Open the workflow edit UI for an existing workflow in the list.
 * The edit button is CSS group-hover only, so opacity is forced via JS before clicking.
 */
export async function openWorkflowForEdit(page: Page, workflowName: string): Promise<void> {
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

// ─── Multi-agent step helpers ──────────────────────────────────────────────────

/**
 * Configure a node config panel to have two agents in multi-agent mode.
 *
 * Precondition: the NodeConfigPanel is already open (panel locator is visible).
 * Postcondition: agents-list has 2 agent-entry items and channels-section is visible.
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
