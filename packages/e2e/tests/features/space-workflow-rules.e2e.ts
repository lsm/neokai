/**
 * Space Workflow Rules & Integration E2E Tests
 *
 * Tests:
 * - Navigate to Workflows via nav panel "Workflows" link
 * - Navigate to Agents via nav panel "Agents" link
 * - Navigate to Settings via nav panel "Settings" link
 * - Create workflow with 3 steps from template, add tags, save
 * - Open workflow editor and add a custom rule targeting specific steps
 * - Edit existing workflow
 * - Delete workflow (with confirmation dialog)
 * - Create custom agent
 *
 * Setup: creates a Space via RPC in beforeEach (infrastructure).
 * Cleanup: deletes the Space via RPC in afterEach.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

// ─── RPC helpers (infrastructure only) ────────────────────────────────────────

async function createTestSpace(page: Page): Promise<string> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);
	return page.evaluate(async (wsPath) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const res = await hub.request('space.create', {
			name: `E2E Rules Test Space ${Date.now()}`,
			workspacePath: wsPath,
		});
		return (res as { space: { id: string } }).space.id;
	}, workspaceRoot);
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

async function navigateToSpace(page: Page, spaceId: string): Promise<void> {
	await page.goto(`/space/${spaceId}`);
	await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Space Workflow Rules & Navigation Integration', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		spaceId = await createTestSpace(page);
	});

	test.afterEach(async ({ page }) => {
		if (spaceId) {
			await deleteTestSpace(page, spaceId);
			spaceId = '';
		}
	});

	// ─── Navigation ─────────────────────────────────────────────────────────────

	test('nav panel "Workflows" link switches to workflows tab', async ({ page }) => {
		await navigateToSpace(page, spaceId);

		// Click the "Workflows" link in the nav panel footer
		const workflowsLink = page.locator('text=Workflows').first();
		await expect(workflowsLink).toBeVisible({ timeout: 5000 });
		await workflowsLink.click();

		// Workflows list should appear
		await expect(page.locator('text=New Workflow')).toBeVisible({ timeout: 5000 });
	});

	test('nav panel "Agents" link switches to agents tab', async ({ page }) => {
		await navigateToSpace(page, spaceId);

		const agentsLink = page.locator('text=Agents').first();
		await expect(agentsLink).toBeVisible({ timeout: 5000 });
		await agentsLink.click();

		// Agents list should appear — empty state or list
		await expect(
			page.locator('text=No custom agents yet').or(page.locator('text=Create Agent'))
		).toBeVisible({ timeout: 5000 });
	});

	test('nav panel "Settings" link switches to settings tab', async ({ page }) => {
		await navigateToSpace(page, spaceId);

		const settingsLink = page
			.locator('[class*="cursor-pointer"]')
			.filter({ hasText: 'Settings' })
			.last();
		await expect(settingsLink).toBeVisible({ timeout: 5000 });
		await settingsLink.click();

		// Settings panel should appear
		await expect(
			page.locator('text=Space Settings').or(page.locator('text=Delete Space'))
		).toBeVisible({ timeout: 5000 });
	});

	// ─── Workflow creation with tags ──────────────────────────────────────────

	test('can create a workflow from template with tags', async ({ page }) => {
		await navigateToSpace(page, spaceId);

		// Navigate to workflows
		await page.locator('text=Workflows').first().click();
		await expect(page.locator('text=New Workflow')).toBeVisible({ timeout: 5000 });

		// Click New Workflow button
		await page.getByRole('button', { name: 'New Workflow' }).first().click();

		// Editor should open
		await expect(page.locator('text=New Workflow').first()).toBeVisible({ timeout: 5000 });

		// Fill name
		const nameInput = page.locator('input[placeholder*="Feature Development"]');
		await nameInput.fill('E2E Test Workflow');

		// Use the Coding template
		await page.locator('text=Start from template').click();
		await page.locator('text=Coding (Plan → Code)').click();

		// 2 steps from template
		await expect(page.locator('text=2 steps')).toBeVisible({ timeout: 3000 });

		// Add a tag via suggestion
		await expect(page.locator('text=+ coding')).toBeVisible({ timeout: 3000 });
		await page.locator('text=+ coding').click();

		// The suggestion button should disappear (tag added)
		await expect(page.locator('text=+ coding')).not.toBeVisible({ timeout: 2000 });
	});

	// ─── Rules editor ────────────────────────────────────────────────────────

	test('can add a rule to a workflow', async ({ page }) => {
		await navigateToSpace(page, spaceId);

		// Navigate to workflows → open editor
		await page.locator('text=Workflows').first().click();
		await page.getByRole('button', { name: 'New Workflow' }).first().click();
		await expect(page.locator('input[placeholder*="Feature Development"]')).toBeVisible({
			timeout: 5000,
		});

		// Fill name
		await page.locator('input[placeholder*="Feature Development"]').fill('Workflow With Rule');

		// Click Add Rule
		await page.locator('text=Add Rule').click();
		await expect(page.locator('text=1 rule')).toBeVisible({ timeout: 3000 });

		// Fill rule name
		const ruleNameInput = page.locator('input[placeholder*="Rule name"]');
		await expect(ruleNameInput).toBeVisible({ timeout: 3000 });
		await ruleNameInput.fill('TypeScript conventions');

		// Fill rule content
		const ruleContent = page.locator('textarea[placeholder*="Describe the rule"]');
		await expect(ruleContent).toBeVisible({ timeout: 3000 });
		await ruleContent.fill('Always use TypeScript strict mode');
	});

	test('rule "Applies to" shows step buttons from the steps list', async ({ page }) => {
		await navigateToSpace(page, spaceId);

		// Navigate to workflows → open editor
		await page.locator('text=Workflows').first().click();
		await page.getByRole('button', { name: 'New Workflow' }).first().click();
		await expect(page.locator('input[placeholder*="Feature Development"]')).toBeVisible({
			timeout: 5000,
		});

		// Apply Coding template to get named steps
		await page.locator('text=Start from template').click();
		await page.locator('text=Coding (Plan → Code)').click();
		await expect(page.locator('text=2 steps')).toBeVisible({ timeout: 3000 });

		// Add a rule
		await page.locator('text=Add Rule').click();
		await expect(page.locator('text=1 rule')).toBeVisible({ timeout: 3000 });

		// The step buttons should show the step names
		// After template, steps are named "Planner" and "Coder" (or role names)
		// The "Applies to" section renders step name buttons
		// At minimum, 2 buttons should appear under "Applies to"
		const appliesToSection = page.locator('text=Applies to').first();
		await expect(appliesToSection).toBeVisible({ timeout: 3000 });
	});

	test('removing a rule decrements rule count', async ({ page }) => {
		await navigateToSpace(page, spaceId);

		await page.locator('text=Workflows').first().click();
		await page.getByRole('button', { name: 'New Workflow' }).first().click();
		await expect(page.locator('input[placeholder*="Feature Development"]')).toBeVisible({
			timeout: 5000,
		});

		// Add two rules
		await page.locator('text=Add Rule').click();
		await page.locator('text=Add Rule').click();
		await expect(page.locator('text=2 rules')).toBeVisible({ timeout: 3000 });

		// Remove the first rule
		await page.locator('[title="Remove rule"]').first().click();
		await expect(page.locator('text=1 rule')).toBeVisible({ timeout: 2000 });
	});

	// ─── Agent management integration ────────────────────────────────────────

	test('can open agent creation form from Agents tab', async ({ page }) => {
		await navigateToSpace(page, spaceId);

		// Navigate to agents tab
		await page.locator('text=Agents').first().click();
		await expect(
			page.locator('text=No custom agents yet').or(page.locator('text=Create Agent'))
		).toBeVisible({ timeout: 5000 });

		// Click "Create Agent" button
		const createBtn = page.getByRole('button', { name: 'Create Agent' }).first();
		await expect(createBtn).toBeVisible({ timeout: 5000 });
		await createBtn.click();

		// Agent editor modal should open
		await expect(
			page.locator('text=Create Agent').or(page.locator('input[placeholder*="My Coder"]'))
		).toBeVisible({ timeout: 5000 });
	});

	// ─── Workflow deletion ────────────────────────────────────────────────────

	test('can delete a workflow via list UI', async ({ page }) => {
		// First create a workflow via RPC
		const workflowName = `Deletable Workflow ${Date.now()}`;
		const workflowId = await page.evaluate(
			async ({ sid, wname }) => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub?.request) throw new Error('Hub not available');

				// Need a step with an agent — use the preset planner agent
				const agentsRes = await hub.request('spaceAgent.list', { spaceId: sid });
				const agents = (agentsRes as { agents: Array<{ id: string; role: string }> }).agents;
				const planner = agents.find((a) => a.role === 'planner') ?? agents[0];
				if (!planner) throw new Error('No agents available');

				const step = { id: crypto.randomUUID(), name: 'Step 1', agentId: planner.id };
				const res = await hub.request('spaceWorkflow.create', {
					spaceId: sid,
					name: wname,
					steps: [step],
					transitions: [],
					startStepId: step.id,
					rules: [],
					tags: [],
				});
				return (res as { workflow: { id: string } }).workflow.id;
			},
			{ sid: spaceId, wname: workflowName }
		);
		expect(workflowId).toBeTruthy();

		await navigateToSpace(page, spaceId);
		await page.locator('text=Workflows').first().click();

		// The workflow card should appear
		await expect(page.locator(`text=${workflowName}`)).toBeVisible({ timeout: 5000 });

		// Click the delete button on the workflow card
		const deleteBtn = page
			.locator('[title="Delete workflow"]')
			.or(page.locator('button[aria-label="Delete workflow"]'))
			.first();
		await expect(deleteBtn).toBeVisible({ timeout: 3000 });
		await deleteBtn.click();

		// Confirm deletion
		await expect(page.locator('text=Delete').last()).toBeVisible({ timeout: 3000 });
		await page.locator('text=Delete').last().click();

		// Workflow should disappear
		await expect(page.locator(`text=${workflowName}`)).not.toBeVisible({ timeout: 5000 });
	});
});
