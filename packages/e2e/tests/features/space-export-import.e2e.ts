/**
 * Space Export/Import E2E Tests
 *
 * Tests the export and import UI actions in the Space view:
 * - Export a single agent from Space (verify download)
 * - Import with conflict (same name agent) — conflict dialog shown
 * - Import with no conflicts — success toast shown
 * - Import bundle with both agents and workflows
 *
 * Setup: creates a Space (and agents/workflows) via RPC in beforeEach.
 * This is accepted infrastructure for test isolation per CLAUDE.md rules.
 * Cleanup: deletes the Space via RPC in afterEach.
 */

import * as fs from 'fs';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

// ─── RPC helpers (infrastructure only) ───────────────────────────────────────

async function createTestSpace(page: Parameters<typeof waitForWebSocketConnected>[0]): Promise<{
	spaceId: string;
	agentId: string;
	agentName: string;
}> {
	await waitForWebSocketConnected(page);
	return page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');

		// Create a space
		const spaceRes = await hub.request('space.create', {
			name: 'E2E Export Import Space',
			description: 'Test space for export/import E2E tests',
			workspacePath: '/tmp',
		});
		const spaceId = (spaceRes as { space: { id: string } }).space.id;

		// Create an agent in the space
		const agentRes = await hub.request('spaceAgent.create', {
			spaceId,
			name: 'Test Coder',
			role: 'coder',
			description: 'A test coder agent',
		});
		const agentId = (agentRes as { agent: { id: string } }).agent.id;

		return { spaceId, agentId, agentName: 'Test Coder' };
	});
}

async function deleteTestSpace(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	spaceId: string
): Promise<void> {
	if (!spaceId) return;
	try {
		await page.evaluate(async (id) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			await hub.request('space.delete', { spaceId: id });
		}, spaceId);
	} catch {
		// Best-effort cleanup
	}
}

// ─── Navigation helper ────────────────────────────────────────────────────────

async function navigateToSpaceAgents(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	spaceId: string
): Promise<void> {
	// Navigate to the space URL directly
	await page.goto(`/space/${spaceId}`);
	// Wait for the Agents tab to be visible (SpaceIsland renders it by default)
	await expect(page.locator('h2:has-text("Agents")')).toBeVisible({ timeout: 10000 });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Space Export/Import', () => {
	let spaceId = '';
	let agentName = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		const data = await createTestSpace(page);
		spaceId = data.spaceId;
		agentName = data.agentName;
	});

	test.afterEach(async ({ page }) => {
		await deleteTestSpace(page, spaceId);
		spaceId = '';
	});

	test('export single agent triggers download with .neokai.json filename', async ({ page }) => {
		await navigateToSpaceAgents(page, spaceId);

		// Hover over the agent row to reveal the Export button
		const agentRow = page.locator(`li:has-text("${agentName}")`);
		await expect(agentRow).toBeVisible({ timeout: 8000 });
		await agentRow.hover();

		const exportBtn = agentRow.locator('button:has-text("Export")');
		await expect(exportBtn).toBeVisible({ timeout: 3000 });

		// Intercept the download
		const [download] = await Promise.all([page.waitForEvent('download'), exportBtn.click()]);

		expect(download.suggestedFilename()).toMatch(/\.neokai\.json$/);
		expect(download.suggestedFilename()).toContain('agents');
	});

	test('Export All button downloads agents bundle', async ({ page }) => {
		await navigateToSpaceAgents(page, spaceId);

		await expect(page.locator('button:has-text("Export All")')).toBeVisible({ timeout: 8000 });

		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.locator('button:has-text("Export All")').click(),
		]);

		expect(download.suggestedFilename()).toMatch(/\.neokai\.json$/);
		expect(download.suggestedFilename()).toContain('agents');

		// Verify the downloaded JSON is valid
		const filePath = await download.path();
		if (filePath) {
			const content = fs.readFileSync(filePath, 'utf-8');
			const parsed = JSON.parse(content);
			expect(parsed).toHaveProperty('type', 'bundle');
			expect(parsed).toHaveProperty('version', 1);
			expect(parsed.agents).toBeInstanceOf(Array);
			expect(parsed.agents.length).toBeGreaterThan(0);
		}
	});

	test('import with no conflicts shows success toast', async ({ page }) => {
		// Build a bundle with a NEW agent name that does not exist in the space
		const newAgentBundle = {
			version: 1,
			type: 'bundle',
			name: 'test bundle',
			agents: [
				{
					version: 1,
					type: 'agent',
					name: 'Imported Reviewer',
					role: 'reviewer',
					description: 'A reviewer agent imported from a bundle',
					tools: [],
				},
			],
			workflows: [],
			exportedAt: Date.now(),
		};

		await navigateToSpaceAgents(page, spaceId);

		// Intercept the file input
		await page.evaluate((bundle) => {
			// Override the file input behavior to immediately resolve with our bundle
			const originalCreate = document.createElement.bind(document);
			(document as unknown as { createElement: typeof document.createElement }).createElement = (
				tag: string,
				...args: unknown[]
			) => {
				const el = originalCreate(tag, ...(args as []));
				if (tag === 'input') {
					const input = el as HTMLInputElement;
					// Intercept click to inject a synthetic file
					const origClick = input.click.bind(input);
					input.click = () => {
						// Create a mock file from the bundle JSON
						const json = JSON.stringify(bundle);
						const file = new File([json], 'test.neokai.json', { type: 'application/json' });
						const dt = new DataTransfer();
						dt.items.add(file);
						Object.defineProperty(input, 'files', { value: dt.files, writable: false });
						// Fire the change event
						input.dispatchEvent(new Event('change', { bubbles: true }));
						origClick();
					};
				}
				return el;
			};
		}, newAgentBundle);

		await page.locator('button:has-text("Import")').click();

		// ImportPreviewDialog should appear
		await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Import Preview')).toBeVisible();

		// The new agent should appear with "new" status
		await expect(page.locator('text=Imported Reviewer')).toBeVisible();
		await expect(page.locator('text=new').first()).toBeVisible();

		// Summary should say "Will create 1 agent"
		await expect(page.locator('text=/Will create.*1.*agent/')).toBeVisible();

		// Confirm import
		await page.locator('[role="dialog"] button:has-text("Import")').click();

		// Success toast
		await expect(page.locator('text=/Imported.*agent/')).toBeVisible({ timeout: 8000 });
	});

	test('import with conflict shows conflict resolution options', async ({ page }) => {
		// Build a bundle with the SAME agent name as the existing one
		const conflictBundle = {
			version: 1,
			type: 'bundle',
			name: 'conflict test bundle',
			agents: [
				{
					version: 1,
					type: 'agent',
					name: agentName, // same name → conflict
					role: 'coder',
					description: 'Duplicate agent',
					tools: [],
				},
			],
			workflows: [],
			exportedAt: Date.now(),
		};

		await navigateToSpaceAgents(page, spaceId);

		// Inject the file
		await page.evaluate((bundle) => {
			const originalCreate = document.createElement.bind(document);
			(document as unknown as { createElement: typeof document.createElement }).createElement = (
				tag: string,
				...args: unknown[]
			) => {
				const el = originalCreate(tag, ...(args as []));
				if (tag === 'input') {
					const input = el as HTMLInputElement;
					const origClick = input.click.bind(input);
					input.click = () => {
						const json = JSON.stringify(bundle);
						const file = new File([json], 'conflict.neokai.json', {
							type: 'application/json',
						});
						const dt = new DataTransfer();
						dt.items.add(file);
						Object.defineProperty(input, 'files', { value: dt.files, writable: false });
						input.dispatchEvent(new Event('change', { bubbles: true }));
						origClick();
					};
				}
				return el;
			};
		}, conflictBundle);

		await page.locator('button:has-text("Import")').click();

		// Dialog should show conflict
		await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=conflict').first()).toBeVisible();

		// Conflict resolution dropdown should be present
		const conflictSelect = page.locator(`select[aria-label*="${agentName}"]`);
		await expect(conflictSelect).toBeVisible();

		// Default is "skip" — verify Import button is disabled (0 will be created)
		await expect(page.locator('[role="dialog"] button:has-text("Import")')).toBeDisabled();

		// Change to "rename"
		await conflictSelect.selectOption('rename');

		// Now 1 agent will be created
		await expect(page.locator('text=/Will create.*1.*agent/')).toBeVisible();
		await expect(page.locator('[role="dialog"] button:has-text("Import")')).not.toBeDisabled();

		// Confirm import
		await page.locator('[role="dialog"] button:has-text("Import")').click();

		// Success toast
		await expect(page.locator('text=/Imported.*agent/')).toBeVisible({ timeout: 8000 });
	});

	test('import bundle with agents and workflows shows both sections', async ({ page }) => {
		const bundleWithBoth = {
			version: 1,
			type: 'bundle',
			name: 'full bundle',
			agents: [
				{
					version: 1,
					type: 'agent',
					name: 'Bundle Agent',
					role: 'general',
					tools: [],
				},
			],
			workflows: [
				{
					version: 1,
					type: 'workflow',
					name: 'Bundle Workflow',
					steps: [
						{
							name: 'step-1',
							agentRef: 'Bundle Agent',
						},
					],
					transitions: [],
					startStep: 'step-1',
					rules: [],
					tags: [],
				},
			],
			exportedAt: Date.now(),
		};

		await navigateToSpaceAgents(page, spaceId);

		// Inject the file
		await page.evaluate((bundle) => {
			const originalCreate = document.createElement.bind(document);
			(document as unknown as { createElement: typeof document.createElement }).createElement = (
				tag: string,
				...args: unknown[]
			) => {
				const el = originalCreate(tag, ...(args as []));
				if (tag === 'input') {
					const input = el as HTMLInputElement;
					const origClick = input.click.bind(input);
					input.click = () => {
						const json = JSON.stringify(bundle);
						const file = new File([json], 'full-bundle.neokai.json', {
							type: 'application/json',
						});
						const dt = new DataTransfer();
						dt.items.add(file);
						Object.defineProperty(input, 'files', { value: dt.files, writable: false });
						input.dispatchEvent(new Event('change', { bubbles: true }));
						origClick();
					};
				}
				return el;
			};
		}, bundleWithBoth);

		await page.locator('button:has-text("Import")').click();

		// Dialog should show both Agents and Workflows sections
		await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=/Agents \\(1\\)/')).toBeVisible();
		await expect(page.locator('text=/Workflows \\(1\\)/')).toBeVisible();

		// Both items should appear as "new"
		await expect(page.locator('text=Bundle Agent')).toBeVisible();
		await expect(page.locator('text=Bundle Workflow')).toBeVisible();

		// Summary should reflect both
		await expect(page.locator('text=/Will create.*1.*agent.*1.*workflow/')).toBeVisible();

		// Import
		await page.locator('[role="dialog"] button:has-text("Import")').click();

		// Success toast
		await expect(page.locator('text=/Imported.*agent/')).toBeVisible({ timeout: 8000 });
	});
});
