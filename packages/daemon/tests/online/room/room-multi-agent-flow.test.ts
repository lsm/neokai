/**
 * Room Multi-Agent Flow (API-dependent)
 *
 * Verifies the end-to-end room lifecycle through real API calls:
 *
 * Stage 1: Goal creation triggers planning group
 * Stage 2: Planning produces execution tasks
 * Stage 3: Execution completes task via leader review
 *
 * Each test is isolated and verifies a specific lifecycle stage,
 * so failures pinpoint exactly which stage broke.
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests are slow (~60-180s each) due to multi-agent roundtrips
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { NeoTask, RoomGoal } from '@neokai/shared';

// =========================================================================
// Polling Helpers
// =========================================================================

/**
 * Poll task.list until at least one task matches the filter criteria.
 */
async function waitForTask(
	daemon: DaemonServerContext,
	roomId: string,
	filter: {
		taskType?: string;
		status?: string | string[];
	},
	timeout = 120_000
): Promise<NeoTask> {
	const start = Date.now();
	const statusArray = filter.status
		? Array.isArray(filter.status)
			? filter.status
			: [filter.status]
		: undefined;

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.list', { roomId })) as {
			tasks: NeoTask[];
		};
		const match = result.tasks.find(
			(t) =>
				(!filter.taskType || t.taskType === filter.taskType) &&
				(!statusArray || statusArray.includes(t.status))
		);
		if (match) return match;
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for task matching ${JSON.stringify(filter)} in room ${roomId}`
	);
}

/**
 * Poll task.list until tasks matching filter reach a target count.
 */
async function waitForTaskCount(
	daemon: DaemonServerContext,
	roomId: string,
	filter: { taskType?: string; status?: string | string[] },
	minCount: number,
	timeout = 120_000
): Promise<NeoTask[]> {
	const start = Date.now();
	const statusArray = filter.status
		? Array.isArray(filter.status)
			? filter.status
			: [filter.status]
		: undefined;

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.list', { roomId })) as {
			tasks: NeoTask[];
		};
		const matches = result.tasks.filter(
			(t) =>
				(!filter.taskType || t.taskType === filter.taskType) &&
				(!statusArray || statusArray.includes(t.status))
		);
		if (matches.length >= minCount) return matches;
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for ${minCount}+ tasks matching ${JSON.stringify(filter)}`
	);
}

/**
 * Poll task.getGroup until the group reaches a target state.
 */
async function waitForGroupState(
	daemon: DaemonServerContext,
	roomId: string,
	taskId: string,
	targetStates: string[],
	timeout = 120_000
): Promise<{ id: string; state: string; feedbackIteration: number }> {
	const start = Date.now();

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.getGroup', { roomId, taskId })) as {
			group: { id: string; state: string; feedbackIteration: number } | null;
		};
		if (result.group && targetStates.includes(result.group.state)) {
			return result.group;
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for group state ${targetStates.join('|')} on task ${taskId}`
	);
}

/**
 * Poll goal.get until goal reaches target status.
 */
async function waitForGoalStatus(
	daemon: DaemonServerContext,
	roomId: string,
	goalId: string,
	targetStatuses: string[],
	timeout = 120_000
): Promise<RoomGoal> {
	const start = Date.now();

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('goal.get', { roomId, goalId })) as {
			goal: RoomGoal;
		};
		if (targetStatuses.includes(result.goal.status)) {
			return result.goal;
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for goal ${goalId} status ${targetStatuses.join('|')}`
	);
}

// =========================================================================
// Tests
// =========================================================================

describe('Room Multi-Agent Flow (API-dependent)', () => {
	let daemon: DaemonServerContext;
	let roomId: string;

	beforeEach(async () => {
		daemon = await createDaemonServer();

		// Create a room for each test
		const result = (await daemon.messageHub.request('room.create', {
			name: `Multi-Agent Flow ${Date.now()}`,
		})) as { room: { id: string } };
		roomId = result.room.id;
	}, 30_000);

	afterEach(
		async () => {
			if (daemon) {
				daemon.kill('SIGTERM');
				await daemon.waitForExit();
			}
		},
		{ timeout: 20_000 }
	);

	// -----------------------------------------------------------------
	// Stage 1: Goal creation triggers planning group
	// -----------------------------------------------------------------

	test(
		'Stage 1: creating a goal triggers a planning task',
		async () => {
			// Create a goal — the RoomRuntime should detect it and spawn a planning group
			const goalResult = (await daemon.messageHub.request('goal.create', {
				roomId,
				title: 'Add a health check endpoint',
				description: 'Create GET /health that returns 200 OK with {"status":"ok"}',
			})) as { goal: RoomGoal };

			const goalId = goalResult.goal.id;
			expect(goalId).toBeTruthy();

			// Wait for a planning task to appear (the runtime creates one)
			const planningTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['pending', 'in_progress'] },
				60_000
			);
			expect(planningTask).toBeTruthy();
			expect(planningTask.taskType).toBe('planning');
			expect(planningTask.title).toContain('Plan:');

			// Verify planning_attempts was incremented
			const updatedGoal = (
				(await daemon.messageHub.request('goal.get', { roomId, goalId })) as {
					goal: RoomGoal;
				}
			).goal;
			expect(updatedGoal.planning_attempts).toBeGreaterThanOrEqual(1);

			// Verify a session group was created for this planning task
			const group = await waitForGroupState(
				daemon,
				roomId,
				planningTask.id,
				['awaiting_worker', 'awaiting_leader', 'completed', 'failed'],
				30_000
			);
			expect(group).toBeTruthy();
			expect(group.id).toBeTruthy();
		},
		{ timeout: 120_000 }
	);

	// -----------------------------------------------------------------
	// Stage 2: Planning completes and produces execution tasks
	// -----------------------------------------------------------------

	test(
		'Stage 2: planning produces execution tasks after review',
		async () => {
			// Create a goal with a clear, simple description
			const goalResult = (await daemon.messageHub.request('goal.create', {
				roomId,
				title: 'Simple file creation',
				description:
					'Create a single file called hello.txt with the text "hello world". This is a trivial task.',
			})) as { goal: RoomGoal };

			const goalId = goalResult.goal.id;

			// Wait for planning task to complete (planner creates tasks, leader approves)
			const planningTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: 'completed' },
				180_000
			);
			expect(planningTask.status).toBe('completed');

			// After planning completes, execution tasks should be promoted to pending
			const execTasks = await waitForTaskCount(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['pending', 'in_progress'] },
				1,
				30_000
			);
			expect(execTasks.length).toBeGreaterThanOrEqual(1);

			// Verify the goal still has the tasks linked
			const updatedGoal = (
				(await daemon.messageHub.request('goal.get', { roomId, goalId })) as {
					goal: RoomGoal;
				}
			).goal;
			// Planning task + at least 1 execution task
			expect((updatedGoal.linkedTaskIds ?? []).length).toBeGreaterThanOrEqual(2);
		},
		{ timeout: 240_000 }
	);

	// -----------------------------------------------------------------
	// Stage 3: Execution completes task via leader review
	// -----------------------------------------------------------------

	test(
		'Stage 3: execution task completes through worker → leader cycle',
		async () => {
			// Create a goal with a trivially simple task to minimize API cost
			const goalResult = (await daemon.messageHub.request('goal.create', {
				roomId,
				title: 'Echo test',
				description:
					'Create a file called test-output.txt containing exactly "test passed". ' +
					'This is a single trivial task — no complex planning needed.',
			})) as { goal: RoomGoal };

			const goalId = goalResult.goal.id;

			// Wait for at least one execution task to complete
			// (planning + execution cycle must both finish)
			const completedTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: 'completed' },
				300_000
			);
			expect(completedTask.status).toBe('completed');
			expect(completedTask.result).toBeTruthy();

			// Verify the group reached completed state
			const group = await waitForGroupState(
				daemon,
				roomId,
				completedTask.id,
				['completed'],
				10_000
			);
			expect(group.state).toBe('completed');

			// Verify we can retrieve group messages (the mirrored timeline)
			const messagesResult = (await daemon.messageHub.request('task.getGroupMessages', {
				groupId: group.id,
			})) as { messages: unknown[]; hasMore: boolean };
			expect(messagesResult.messages.length).toBeGreaterThan(0);
		},
		{ timeout: 360_000 }
	);

	// -----------------------------------------------------------------
	// Stage 4: Leader uses feedback loop (multi-iteration)
	// -----------------------------------------------------------------

	test(
		'Stage 4: session group tracks feedback iterations',
		async () => {
			// Create a goal — we just verify iteration tracking works
			const goalResult = (await daemon.messageHub.request('goal.create', {
				roomId,
				title: 'Iteration tracking test',
				description: 'Create a file called iteration-test.txt with "iteration test". Simple task.',
			})) as { goal: RoomGoal };

			// Wait for an execution task to start (gets a group)
			const execTask = await waitForTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['in_progress', 'completed'] },
				180_000
			);

			// Get the group and verify iteration tracking
			const group = await waitForGroupState(
				daemon,
				roomId,
				execTask.id,
				['awaiting_leader', 'completed', 'failed', 'awaiting_human'],
				120_000
			);
			// feedbackIteration tracks how many worker→leader rounds occurred
			// At minimum 1 (the initial round)
			expect(group.feedbackIteration).toBeGreaterThanOrEqual(1);
		},
		{ timeout: 360_000 }
	);
});
