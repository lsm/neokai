/**
 * Space Session Groups E2E Tests
 *
 * Verifies that the SpaceTaskPane correctly displays "Working Agents" with
 * status badges when session groups are associated with a task.
 *
 * Tests:
 * - Working Agents section is hidden when there are no groups
 * - Active member shows animated blue dot badge
 * - Completed member shows green checkmark badge
 * - Failed member shows red X badge
 * - Multiple members in a group are all displayed
 * - Task Agent member uses "Task Agent" label (no agentId)
 * - Named agent member uses agent name from SpaceAgent record
 * - Task click in sidebar opens SpaceTaskPane with Working Agents section
 *
 * Note on "real-time update" testing: per CLAUDE.md, if a test scenario cannot
 * be triggered through the UI it belongs in daemon integration tests, not E2E.
 * Agent lifecycle transitions (completion/failure) cannot be triggered via UI
 * without running real agents, so those are covered by daemon online tests.
 * These E2E tests verify the display rendering for each distinct badge state.
 *
 * Setup: creates Space + agents + task via RPC in outer beforeEach (infrastructure).
 *        Each sub-describe creates its specific session group in its own beforeEach.
 * Cleanup: deletes Space via RPC in outer afterEach (infrastructure).
 *
 * E2E Rules:
 * - All test actions go through the UI (clicks, navigation, page.goto)
 * - All assertions check visible DOM state
 * - RPC is used only in beforeEach/afterEach for test infrastructure
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── RPC helpers (infrastructure only) ────────────────────────────────────────

interface CreatedSpace {
	spaceId: string;
	agentId: string;
	taskId: string;
}

/**
 * Creates a space, one agent, and one task via RPC.
 * All three are needed to exercise the SpaceTaskPane Working Agents section.
 */
async function createTestSpaceWithTask(page: Page): Promise<CreatedSpace> {
	await waitForWebSocketConnected(page);
	const workspaceRoot = await getWorkspaceRoot(page);

	return page.evaluate(
		async ({ wsPath }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// Clean up any leftover space at this path
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

			// Create space
			const spaceRes = (await hub.request('space.create', {
				name: `E2E Session Groups ${Date.now()}`,
				workspacePath: wsPath,
			})) as { id: string };
			const spaceId = spaceRes.id;

			// Create an agent
			const agentRes = (await hub.request('spaceAgent.create', {
				spaceId,
				name: 'Coder Agent',
				role: 'coder',
				description: 'Test agent for E2E',
			})) as { agent: { id: string } };
			const agentId = agentRes.agent.id;

			// Create a task
			const taskRes = (await hub.request('spaceTask.create', {
				spaceId,
				title: 'E2E Test Task',
				description: 'Task for testing Working Agents display',
			})) as { id: string };
			const taskId = taskRes.id;

			return { spaceId, agentId, taskId };
		},
		{ wsPath: workspaceRoot }
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

/**
 * Creates a session group linked to the given task via RPC (infrastructure).
 *
 * Uses `space.sessionGroup.create` (admin RPC) to inject group state without
 * running real agents. The handler emits the same WebSocket events that
 * TaskAgentManager emits, so the SpaceStore signal updates reactively.
 *
 * Note: sessionId values are synthetic — real agent sessions are not needed
 * to render the Working Agents section in SpaceTaskPane.
 *
 * Must be called from beforeEach/afterEach only (infrastructure pattern).
 */
async function createSessionGroup(
	page: Page,
	spaceId: string,
	taskId: string,
	members: Array<{ role: string; agentId?: string; status?: 'active' | 'completed' | 'failed' }>
): Promise<void> {
	await page.evaluate(
		async ({ sid, tid, memberDefs }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// Generate synthetic session IDs — no real agent sessions needed
			const syntheticSessionIds = memberDefs.map(
				(_, i) => `e2e-session-${tid.slice(0, 8)}-${i}-${Date.now()}`
			);

			await hub.request('space.sessionGroup.create', {
				spaceId: sid,
				name: `task:${tid}`,
				taskId: tid,
				members: memberDefs.map((m, i) => ({
					sessionId: syntheticSessionIds[i],
					role: m.role,
					agentId: m.agentId,
					status: m.status ?? 'active',
				})),
			});
		},
		{ sid: spaceId, tid: taskId, memberDefs: members }
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('SpaceTaskPane — Working Agents Display', () => {
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';
	let agentId = '';
	let taskId = '';

	// Outer beforeEach: create the space, agent, and task (shared infrastructure)
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		({ spaceId, agentId, taskId } = await createTestSpaceWithTask(page));
	});

	test.afterEach(async ({ page }) => {
		await deleteTestSpace(page, spaceId);
		spaceId = '';
		agentId = '';
		taskId = '';
	});

	// ─── Baseline: no groups ──────────────────────────────────────────────────

	test('Working Agents section is hidden when no session groups exist', async ({ page }) => {
		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Working Agents heading should NOT be present
		await expect(page.locator('text=Working Agents')).not.toBeVisible({ timeout: 3000 });
	});

	// ─── Active badge ─────────────────────────────────────────────────────────

	test.describe('active member', () => {
		test.beforeEach(async ({ page }) => {
			await createSessionGroup(page, spaceId, taskId, [
				{ role: 'coder', agentId, status: 'active' },
			]);
		});

		test('shows animated active badge for an active member', async ({ page }) => {
			await page.goto(`/space/${spaceId}/task/${taskId}`);
			await waitForWebSocketConnected(page);

			await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

			// Active badge via data-testid
			const activeBadge = page.getByTestId('member-status-badge-active');
			await expect(activeBadge).toBeVisible({ timeout: 5000 });
			await expect(activeBadge).toContainText('active');

			// Animated ping indicator is unique to active state
			await expect(page.locator('.animate-ping')).toBeVisible({ timeout: 3000 });
		});
	});

	// ─── Completed badge ──────────────────────────────────────────────────────

	test.describe('completed member', () => {
		test.beforeEach(async ({ page }) => {
			await createSessionGroup(page, spaceId, taskId, [
				{ role: 'coder', agentId, status: 'completed' },
			]);
		});

		test('shows green checkmark badge for a completed member', async ({ page }) => {
			await page.goto(`/space/${spaceId}/task/${taskId}`);
			await waitForWebSocketConnected(page);

			await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

			// Completed badge via data-testid
			const completedBadge = page.getByTestId('member-status-badge-completed');
			await expect(completedBadge).toBeVisible({ timeout: 5000 });
			await expect(completedBadge).toContainText('completed');

			// Checkmark icon via data-testid
			await expect(page.getByTestId('member-status-icon-completed')).toBeVisible({
				timeout: 3000,
			});

			// Active ping should NOT be visible
			await expect(page.locator('.animate-ping')).not.toBeVisible({ timeout: 2000 });
		});
	});

	// ─── Failed badge ─────────────────────────────────────────────────────────

	test.describe('failed member', () => {
		test.beforeEach(async ({ page }) => {
			await createSessionGroup(page, spaceId, taskId, [
				{ role: 'coder', agentId, status: 'failed' },
			]);
		});

		test('shows red X badge for a failed member', async ({ page }) => {
			await page.goto(`/space/${spaceId}/task/${taskId}`);
			await waitForWebSocketConnected(page);

			await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

			// Failed badge via data-testid
			const failedBadge = page.getByTestId('member-status-badge-failed');
			await expect(failedBadge).toBeVisible({ timeout: 5000 });
			await expect(failedBadge).toContainText('failed');

			// Red X icon via data-testid
			await expect(page.getByTestId('member-status-icon-failed')).toBeVisible({
				timeout: 3000,
			});
		});
	});

	// ─── Multiple members ─────────────────────────────────────────────────────

	test.describe('multiple members', () => {
		test.beforeEach(async ({ page }) => {
			await createSessionGroup(page, spaceId, taskId, [
				{ role: 'task-agent', status: 'active' },
				{ role: 'coder', agentId, status: 'active' },
				{ role: 'reviewer', status: 'completed' },
			]);
		});

		test('shows all members when group has multiple members', async ({ page }) => {
			await page.goto(`/space/${spaceId}/task/${taskId}`);
			await waitForWebSocketConnected(page);

			await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

			// Two active badges and one completed badge
			await expect(page.getByTestId('member-status-badge-active')).toHaveCount(2, {
				timeout: 5000,
			});
			await expect(page.getByTestId('member-status-badge-completed')).toHaveCount(1, {
				timeout: 5000,
			});
		});
	});

	// ─── Task Agent label ──────────────────────────────────────────────────────

	test.describe('task-agent member', () => {
		test.beforeEach(async ({ page }) => {
			await createSessionGroup(page, spaceId, taskId, [{ role: 'task-agent', status: 'active' }]);
		});

		test('shows "Task Agent" label for task-agent role member without agentId', async ({
			page,
		}) => {
			await page.goto(`/space/${spaceId}/task/${taskId}`);
			await waitForWebSocketConnected(page);

			await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

			// "Task Agent" is the label shown when role === 'task-agent' and no agentId
			await expect(page.locator('text=Task Agent')).toBeVisible({ timeout: 5000 });
		});
	});

	// ─── Named agent label ────────────────────────────────────────────────────

	test.describe('named agent member', () => {
		test.beforeEach(async ({ page }) => {
			await createSessionGroup(page, spaceId, taskId, [
				{ role: 'coder', agentId, status: 'active' },
			]);
		});

		test('shows agent name for members with a valid agentId', async ({ page }) => {
			await page.goto(`/space/${spaceId}/task/${taskId}`);
			await waitForWebSocketConnected(page);

			await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
			await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

			// The agent name "Coder Agent" should appear
			await expect(page.locator('text=Coder Agent')).toBeVisible({ timeout: 5000 });

			// The role "coder" should appear as a secondary label
			await expect(page.locator('text=coder')).toBeVisible({ timeout: 5000 });
		});
	});

	// ─── Task click navigation ─────────────────────────────────────────────────

	test.describe('sidebar task click', () => {
		test.beforeEach(async ({ page }) => {
			await createSessionGroup(page, spaceId, taskId, [
				{ role: 'coder', agentId, status: 'active' },
			]);
		});

		test('opens SpaceTaskPane with Working Agents when clicking task in sidebar', async ({
			page,
		}) => {
			// Navigate to the space (not directly to task URL) — uses UI to open task pane
			await page.goto(`/space/${spaceId}`);
			await waitForWebSocketConnected(page);
			await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 10000 });

			// Click on the task in the sidebar context panel
			const taskButton = page.locator('button').filter({ hasText: 'E2E Test Task' }).first();
			await expect(taskButton).toBeVisible({ timeout: 5000 });
			await taskButton.click();

			// SpaceTaskPane should open with task title and Working Agents section
			await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 5000 });
			await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });
			await expect(page.getByTestId('member-status-badge-active')).toBeVisible({
				timeout: 5000,
			});
		});
	});
});
