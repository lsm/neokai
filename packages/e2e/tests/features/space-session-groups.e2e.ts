/**
 * Space Session Groups E2E Tests
 *
 * Verifies that the SpaceTaskPane correctly displays "Working Agents" with
 * real-time status badges when session groups are associated with a task.
 *
 * Tests:
 * - Working Agents section appears when a session group is linked to the task
 * - Active member shows animated blue dot badge
 * - Completed member shows green checkmark badge
 * - Failed member shows red X badge
 * - Real-time status update: active badge changes to completed without page refresh
 * - Real-time status update: active badge changes to failed without page refresh
 * - Multiple members in a group are all displayed
 * - Task Agent member uses "Task Agent" label (no agentId)
 * - Named agent member uses agent name from SpaceAgent record
 * - Working Agents section is hidden when there are no groups
 *
 * Setup: creates Space + agents + task + session group via RPC in beforeEach (infrastructure).
 * Cleanup: deletes Space via RPC in afterEach (infrastructure).
 *
 * E2E Rules:
 * - All test actions go through the UI (clicks, navigation, page.goto)
 * - All assertions check visible DOM state
 * - RPC is used in beforeEach/afterEach for test infrastructure
 * - `space.sessionGroup.updateMember` is used in a small number of tests to
 *   simulate agent lifecycle events (completion/failure) — there is no UI path
 *   to trigger these state changes; the test verifies the UI's real-time reaction
 *   to server-sent WebSocket events, which IS the intended user-visible behavior.
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
			})) as { task: { id: string } };
			const taskId = taskRes.task.id;

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
 * Returns the group ID and member session IDs.
 *
 * Note: sessionId values are synthetic UUIDs — real agents are not running.
 * The session group DB record and the associated frontend events are sufficient
 * to render the Working Agents section in SpaceTaskPane.
 */
async function createSessionGroup(
	page: Page,
	spaceId: string,
	taskId: string,
	agentId: string,
	members: Array<{ role: string; agentId?: string; status?: 'active' | 'completed' | 'failed' }>
): Promise<{ groupId: string; memberSessionIds: string[] }> {
	return page.evaluate(
		async ({ sid, tid, aid, memberDefs }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');

			// Generate stable synthetic session IDs for members
			const syntheticSessionIds = memberDefs.map(
				(_, i) => `e2e-session-${tid.slice(0, 8)}-${i}-${Date.now()}`
			);

			const res = (await hub.request('space.sessionGroup.create', {
				spaceId: sid,
				name: `task:${tid}`,
				taskId: tid,
				members: memberDefs.map((m, i) => ({
					sessionId: syntheticSessionIds[i],
					role: m.role,
					agentId: m.agentId,
					status: m.status ?? 'active',
				})),
			})) as { group: { id: string } };

			return { groupId: res.group.id, memberSessionIds: syntheticSessionIds };
		},
		{ sid: spaceId, tid: taskId, aid: agentId, memberDefs: members }
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('SpaceTaskPane — Working Agents Display', () => {
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: DESKTOP_VIEWPORT });

	let spaceId = '';
	let agentId = '';
	let taskId = '';

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

		// Task pane should be visible
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Working Agents heading should NOT be present
		await expect(page.locator('text=Working Agents')).not.toBeVisible({ timeout: 3000 });
	});

	// ─── Active badge ─────────────────────────────────────────────────────────

	test('shows animated active badge for an active member', async ({ page }) => {
		// Infrastructure: create group with one active member
		await createSessionGroup(page, spaceId, taskId, agentId, [
			{ role: 'coder', agentId, status: 'active' },
		]);

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });

		// Working Agents section should appear
		await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

		// Active badge should be visible and contain "active" text
		const activeBadge = page.locator('text=active').first();
		await expect(activeBadge).toBeVisible({ timeout: 5000 });

		// Animated ping indicator should be present (unique to active state)
		await expect(page.locator('.animate-ping')).toBeVisible({ timeout: 3000 });
	});

	// ─── Completed badge ──────────────────────────────────────────────────────

	test('shows green checkmark badge for a completed member', async ({ page }) => {
		// Infrastructure: create group with one completed member
		await createSessionGroup(page, spaceId, taskId, agentId, [
			{ role: 'coder', agentId, status: 'completed' },
		]);

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

		// Completed badge text
		const completedBadge = page.locator('text=completed').first();
		await expect(completedBadge).toBeVisible({ timeout: 5000 });

		// Checkmark SVG path is unique to completed state
		// The path starts with "M16.707" (fillRule="evenodd" checkmark)
		await expect(page.locator('path[d^="M16.707"]')).toBeVisible({ timeout: 3000 });

		// Active ping should NOT be visible for a completed member
		await expect(page.locator('.animate-ping')).not.toBeVisible({ timeout: 2000 });
	});

	// ─── Failed badge ─────────────────────────────────────────────────────────

	test('shows red X badge for a failed member', async ({ page }) => {
		// Infrastructure: create group with one failed member
		await createSessionGroup(page, spaceId, taskId, agentId, [
			{ role: 'coder', agentId, status: 'failed' },
		]);

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

		// Failed badge text
		const failedBadge = page.locator('text=failed').first();
		await expect(failedBadge).toBeVisible({ timeout: 5000 });

		// Red X SVG path is unique to failed state
		// The path starts with "M4.293" (fillRule="evenodd" X mark)
		await expect(page.locator('path[d^="M4.293"]')).toBeVisible({ timeout: 3000 });
	});

	// ─── Real-time update: active → completed ─────────────────────────────────

	test('badge updates in real-time from active to completed without page refresh', async ({
		page,
	}) => {
		// Infrastructure: create group with one active member
		const { groupId, memberSessionIds } = await createSessionGroup(page, spaceId, taskId, agentId, [
			{ role: 'coder', agentId, status: 'active' },
		]);
		const memberSessionId = memberSessionIds[0];

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

		// Verify active state is shown
		await expect(page.locator('text=active').first()).toBeVisible({ timeout: 5000 });
		await expect(page.locator('.animate-ping')).toBeVisible({ timeout: 3000 });

		// Simulate agent completion via admin RPC (server-sent WebSocket event).
		// There is no UI path to trigger agent completion — this simulates what
		// TaskAgentManager emits when a real sub-session finishes successfully.
		await page.evaluate(
			async ({ sid, gid, sessId }) => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub?.request) throw new Error('Hub not available');
				await hub.request('space.sessionGroup.updateMember', {
					spaceId: sid,
					groupId: gid,
					sessionId: sessId,
					status: 'completed',
				});
			},
			{ sid: spaceId, gid: groupId, sessId: memberSessionId }
		);

		// Badge should update to completed WITHOUT a page refresh
		await expect(page.locator('text=completed').first()).toBeVisible({ timeout: 5000 });
		await expect(page.locator('path[d^="M16.707"]')).toBeVisible({ timeout: 3000 });
		await expect(page.locator('.animate-ping')).not.toBeVisible({ timeout: 2000 });
		await expect(page.locator('text=active')).not.toBeVisible({ timeout: 2000 });
	});

	// ─── Real-time update: active → failed ───────────────────────────────────

	test('badge updates in real-time from active to failed without page refresh', async ({
		page,
	}) => {
		// Infrastructure: create group with one active member
		const { groupId, memberSessionIds } = await createSessionGroup(page, spaceId, taskId, agentId, [
			{ role: 'coder', agentId, status: 'active' },
		]);
		const memberSessionId = memberSessionIds[0];

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=active').first()).toBeVisible({ timeout: 5000 });

		// Simulate agent failure via admin RPC
		await page.evaluate(
			async ({ sid, gid, sessId }) => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub?.request) throw new Error('Hub not available');
				await hub.request('space.sessionGroup.updateMember', {
					spaceId: sid,
					groupId: gid,
					sessionId: sessId,
					status: 'failed',
				});
			},
			{ sid: spaceId, gid: groupId, sessId: memberSessionId }
		);

		// Badge should update to failed WITHOUT a page refresh
		await expect(page.locator('text=failed').first()).toBeVisible({ timeout: 5000 });
		await expect(page.locator('path[d^="M4.293"]')).toBeVisible({ timeout: 3000 });
		await expect(page.locator('.animate-ping')).not.toBeVisible({ timeout: 2000 });
	});

	// ─── Multiple members ─────────────────────────────────────────────────────

	test('shows all members when group has multiple members', async ({ page }) => {
		// Infrastructure: create group with three members in different states
		await createSessionGroup(page, spaceId, taskId, agentId, [
			{ role: 'task-agent', status: 'active' },
			{ role: 'coder', agentId, status: 'active' },
			{ role: 'reviewer', status: 'completed' },
		]);

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

		// All three members should have badges visible
		// Two active and one completed
		await expect(page.locator('text=active')).toHaveCount(2, { timeout: 5000 });
		await expect(page.locator('text=completed')).toHaveCount(1, { timeout: 5000 });
	});

	// ─── Task Agent label ──────────────────────────────────────────────────────

	test('shows "Task Agent" label for task-agent role member without agentId', async ({ page }) => {
		// Infrastructure: create group with a task-agent member (no agentId)
		await createSessionGroup(page, spaceId, taskId, agentId, [
			{ role: 'task-agent', status: 'active' },
		]);

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

		// "Task Agent" is the label shown when role === 'task-agent' and no agentId
		await expect(page.locator('text=Task Agent')).toBeVisible({ timeout: 5000 });
	});

	// ─── Named agent label ────────────────────────────────────────────────────

	test('shows agent name for members with a valid agentId', async ({ page }) => {
		// Infrastructure: create group with a member linked to the "Coder Agent" SpaceAgent
		await createSessionGroup(page, spaceId, taskId, agentId, [
			{ role: 'coder', agentId, status: 'active' },
		]);

		await page.goto(`/space/${spaceId}/task/${taskId}`);
		await waitForWebSocketConnected(page);

		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });

		// The agent name "Coder Agent" should appear
		await expect(page.locator('text=Coder Agent')).toBeVisible({ timeout: 5000 });

		// The role "coder" should appear as a secondary label
		await expect(page.locator('text=coder')).toBeVisible({ timeout: 5000 });
	});

	// ─── Task click navigation ─────────────────────────────────────────────────

	test('opens SpaceTaskPane with Working Agents when clicking a task in the sidebar', async ({
		page,
	}) => {
		// Infrastructure: create group with one active member
		await createSessionGroup(page, spaceId, taskId, agentId, [
			{ role: 'coder', agentId, status: 'active' },
		]);

		// Navigate to the space (not directly to task URL)
		await page.goto(`/space/${spaceId}`);
		await waitForWebSocketConnected(page);
		await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 10000 });

		// Click on the task in the sidebar context panel
		const taskButton = page.locator('button').filter({ hasText: 'E2E Test Task' }).first();
		await expect(taskButton).toBeVisible({ timeout: 5000 });
		await taskButton.click();

		// SpaceTaskPane should open with the task title and Working Agents section
		await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Working Agents')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=active').first()).toBeVisible({ timeout: 5000 });
	});
});
