/**
 * Space Completion-Action Approval Banner E2E Tests
 *
 * Tests the `PendingCompletionActionBanner` rendered in `SpaceTaskPane` when a
 * task is paused at a workflow end-node `completionAction`:
 *   - Banner renders with the action name, type, and required-vs-space level
 *   - Script source is present in the DOM under a collapsed <details>
 *   - Reject opens a confirmation modal and cancels the task on confirm
 *   - Space-level "awaiting approval" summary appears on SpaceOverview and
 *     deep-links to the Tasks view with the awaiting-approval filter toggled
 *
 * Setup (beforeEach — infrastructure RPC only):
 *   - Space is created via RPC
 *   - Seeded built-in workflows are deleted (keeps SpaceOverview visible)
 *   - A custom workflow with a single end node + script completion action is
 *     created via RPC (required-level 3 — above the default space level 1)
 *   - A workflow run is started via RPC which creates a task; the task is
 *     immediately marked done to prevent the task agent from running (pattern
 *     borrowed from space-approval-gate-rejection.e2e.ts) and then walked back
 *     through in_progress → review so the pause checkpoint can be set
 *   - `pendingActionIndex: 0, pendingCheckpointType: 'completion_action'` are
 *     applied via a follow-up update
 *
 * Cleanup (afterEach — infrastructure RPC only):
 *   - The workflow run is cancelled
 *   - The space is deleted
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, navigation).
 *   - All assertions verify visible DOM state.
 *   - RPC is only used in beforeEach / afterEach for infrastructure.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
	createSpaceViaRpc,
	createUniqueSpaceDir,
	deleteSpaceViaRpc,
	deleteSpaceWorkflowsViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

const ACTION_NAME = 'merge-pr';
const ACTION_SCRIPT = 'echo approved';
const ACTION_REQUIRED_LEVEL = 3;

interface PausedTaskFixture {
	spaceId: string;
	runId: string;
	taskId: string;
	workflowId: string;
}

/**
 * Creates a space with a workflow that pauses at a completion action on its
 * sole (end) node, starts a run for that workflow, and primes the resulting
 * task into `review` state with `pendingCheckpointType: 'completion_action'`.
 *
 * Uses the "mark done → reopen" trick to stop the task agent from racing with
 * our manual field updates (same pattern as space-approval-gate-rejection).
 */
async function createSpaceWithPausedTask(page: Page): Promise<PausedTaskFixture> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);
	const wsPath = createUniqueSpaceDir(workspaceRoot, 'completion-action');
	const spaceName = `E2E Completion Action ${Date.now()}`;

	const spaceId = await createSpaceViaRpc(page, wsPath, spaceName);
	// Drop seeded workflows so our custom one is the only choice for runs and
	// SpaceOverview is not hidden by a full WorkflowCanvas.
	await deleteSpaceWorkflowsViaRpc(page, spaceId);

	return page.evaluate(
		async ({
			spaceId,
			actionName,
			actionScript,
			actionRequiredLevel,
		}: {
			spaceId: string;
			actionName: string;
			actionScript: string;
			actionRequiredLevel: number;
		}) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// Grab any agent in the space so our workflow node has a valid agent ref.
			const agentsRes = (await hub.request('spaceAgent.list', { spaceId })) as {
				agents: Array<{ id: string; name: string }>;
			};
			if (!agentsRes.agents || agentsRes.agents.length === 0) {
				throw new Error('Space has no agents — cannot create workflow');
			}
			const agent = agentsRes.agents[0];

			// Single-node workflow; the node is both start and end. Completion actions
			// run after the end node succeeds.
			const nodeId = crypto.randomUUID();
			const wfRes = (await hub.request('spaceWorkflow.create', {
				spaceId,
				name: `Completion Action Flow ${Date.now()}`,
				nodes: [
					{
						id: nodeId,
						name: 'finish',
						agents: [{ agentId: agent.id, name: agent.name || 'agent' }],
						completionActions: [
							{
								id: crypto.randomUUID(),
								name: actionName,
								type: 'script',
								requiredLevel: actionRequiredLevel,
								script: actionScript,
							},
						],
					},
				],
				startNodeId: nodeId,
				endNodeId: nodeId,
			})) as { workflow: { id: string } };
			const workflowId = wfRes.workflow.id;

			// Start a run — this creates a task that references the workflow run.
			const runRes = (await hub.request('spaceWorkflowRun.start', {
				spaceId,
				workflowId,
				title: 'E2E: Completion action approval',
				description: 'Task paused at an end-node completion action.',
			})) as { run: { id: string } };
			const runId = runRes.run.id;

			// Find the task the runtime just created for this run.
			const tasks = (await hub.request('spaceTask.list', { spaceId })) as Array<{
				id: string;
				workflowRunId?: string | null;
			}>;
			const task = tasks.find((t) => t.workflowRunId === runId);
			if (!task) throw new Error(`No task found for run ${runId}`);
			const taskId = task.id;

			// Stop the runtime from racing with us: mark done first (kills the agent
			// loop), then walk the task back through in_progress → review and drop
			// the pending-completion-action fields on with a final no-status update.
			await hub.request('spaceTask.update', { spaceId, taskId, status: 'done' });
			await hub.request('spaceTask.update', { spaceId, taskId, status: 'in_progress' });
			await hub.request('spaceTask.update', { spaceId, taskId, status: 'review' });
			await hub.request('spaceTask.update', {
				spaceId,
				taskId,
				pendingActionIndex: 0,
				pendingCheckpointType: 'completion_action',
			});

			return { spaceId, runId, taskId, workflowId };
		},
		{
			spaceId,
			actionName: ACTION_NAME,
			actionScript: ACTION_SCRIPT,
			actionRequiredLevel: ACTION_REQUIRED_LEVEL,
		}
	);
}

async function cancelRun(page: Page, runId: string): Promise<void> {
	if (!runId) return;
	try {
		await page.evaluate(async (rid) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			await hub.request('spaceWorkflowRun.cancel', { id: rid });
		}, runId);
	} catch {
		// best-effort
	}
}

test.describe('PendingCompletionActionBanner', () => {
	// Serial — creating workflow runs + tasks is heavy and the workspace is shared.
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: DESKTOP_VIEWPORT });

	let fixture: PausedTaskFixture | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		fixture = await createSpaceWithPausedTask(page);
	});

	test.afterEach(async ({ page }) => {
		if (fixture?.runId) {
			await cancelRun(page, fixture.runId);
		}
		if (fixture?.spaceId) {
			await deleteSpaceViaRpc(page, fixture.spaceId);
		}
		fixture = null;
	});

	test('banner renders with action name, type, level and collapsed script source', async ({
		page,
	}) => {
		if (!fixture) throw new Error('fixture missing');
		const { spaceId, taskId } = fixture;

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		const banner = page.getByTestId('pending-completion-action-banner');
		await expect(banner).toBeVisible({ timeout: 15000 });
		await expect(banner).toContainText(ACTION_NAME);

		// Type line calls out "Bash script" + the required level.
		await expect(page.getByTestId('pending-completion-action-type')).toContainText('Bash script');
		await expect(page.getByTestId('pending-completion-action-type')).toContainText(
			`Level ${ACTION_REQUIRED_LEVEL}`
		);

		// Space defaults to level 1 — below the required level.
		await expect(page.getByTestId('pending-completion-action-current-level')).toContainText(
			'Level 1'
		);

		// Script source is in the DOM, nested inside a collapsed <details>.
		const details = page.getByTestId('pending-completion-action-details');
		await expect(details).toHaveAttribute('data-action-type', 'script');
		// Details opens via native disclosure — it is NOT open by default, so the
		// script source is present in the DOM (we can read textContent) but not
		// "visible" for Playwright's visibility checks.
		await expect(details).not.toHaveAttribute('open', /.*/);
		const scriptText = await page
			.getByTestId('pending-completion-action-script')
			.evaluate((el) => el.textContent ?? '');
		expect(scriptText).toContain(ACTION_SCRIPT);

		// Approve + Reject buttons are both present.
		await expect(page.getByTestId('pending-completion-action-approve-btn')).toBeVisible();
		await expect(page.getByTestId('pending-completion-action-reject-btn')).toBeVisible();
	});

	test('Reject opens confirmation modal and dismisses banner on confirm', async ({ page }) => {
		if (!fixture) throw new Error('fixture missing');
		const { spaceId, taskId } = fixture;

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

		const banner = page.getByTestId('pending-completion-action-banner');
		await expect(banner).toBeVisible({ timeout: 15000 });

		// Confirm modal not mounted until Reject is clicked.
		await expect(page.getByTestId('pending-completion-action-reject-confirm')).toBeHidden();

		await page.getByTestId('pending-completion-action-reject-btn').click();
		const confirmBtn = page.getByTestId('pending-completion-action-reject-confirm');
		await expect(confirmBtn).toBeVisible({ timeout: 5000 });

		// Supply a reason — optional but exercises the textarea binding.
		await page.getByTestId('pending-completion-action-reject-reason').fill('E2E: script too risky');

		await confirmBtn.click();

		// Banner must disappear once the daemon clears the pending fields.
		await expect(banner).toBeHidden({ timeout: 15000 });
		// Confirm modal also closes.
		await expect(page.getByTestId('pending-completion-action-reject-confirm')).toBeHidden({
			timeout: 5000,
		});
	});

	test('SpaceOverview shows awaiting-approval summary linking to filtered Tasks view', async ({
		page,
	}) => {
		if (!fixture) throw new Error('fixture missing');
		const { spaceId } = fixture;

		await page.goto(`/space/${spaceId}`);
		await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

		// Summary CTA is visible with the count.
		const summary = page.getByTestId('awaiting-approval-summary');
		await expect(summary).toBeVisible({ timeout: 15000 });
		await expect(summary).toContainText('1');
		await expect(summary).toContainText(/awaiting/i);

		// Click the summary — should navigate to /space/{id}/tasks with the
		// awaiting-approval filter chip toggled on (action tab by default).
		await summary.click();
		await page.waitForURL(`/space/${spaceId}/tasks`, { timeout: 5000 });

		const filterChip = page.getByTestId('tasks-filter-awaiting-approval');
		await expect(filterChip).toBeVisible({ timeout: 5000 });
		await expect(filterChip).toContainText('1');

		// The clear-filter affordance shows up while the chip is active.
		await expect(page.getByTestId('tasks-filter-clear')).toBeVisible();
	});
});
