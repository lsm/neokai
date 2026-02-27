/**
 * Room Replan Recovery (API-dependent)
 *
 * Tests the auto-recovery replan flow: after all tasks for a goal are
 * externally failed, the runtime detects the all-failed state on its
 * next tick and spawns a fresh planning group.
 *
 * Flow: goal → planning → execution → complete → external fail all →
 *       auto-replan detected → new planning → new execution tasks appear.
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	waitForTask,
	waitForNewTask,
	createRoom,
	createGoal,
	getGoal,
	listTasks,
} from './room-test-helpers';

// Use Sonnet for room agents (default model may be GLM in CI)
const savedModel = process.env.DEFAULT_MODEL;
process.env.DEFAULT_MODEL = 'sonnet';

describe('Room Replan Recovery (API-dependent)', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();
	}, 30_000);

	afterAll(
		async () => {
			if (savedModel !== undefined) {
				process.env.DEFAULT_MODEL = savedModel;
			} else {
				delete process.env.DEFAULT_MODEL;
			}

			if (daemon) {
				daemon.kill('SIGTERM');
				await daemon.waitForExit();
			}
		},
		{ timeout: 20_000 }
	);

	test(
		'auto-recovery: replan after external task failure',
		async () => {
			const roomId = await createRoom(daemon, 'Replan Recovery');

			// --- Phase 1: Normal lifecycle through to completion ---
			const goal = await createGoal(
				daemon,
				roomId,
				'Add a double utility',
				'Create src/double.ts that exports double(n: number): number which returns n * 2.'
			);

			// Wait for planning to complete
			await waitForTask(daemon, roomId, { taskType: 'planning', status: 'completed' }, 180_000);

			// Wait for coding task to complete (full lifecycle)
			await waitForTask(daemon, roomId, { taskType: 'coding', status: 'completed' }, 180_000);

			// Record initial state
			const goalBefore = await getGoal(daemon, roomId, goal.id);
			const attemptsBefore = goalBefore.planning_attempts;

			// Snapshot all existing task IDs before failure
			const tasksBefore = await listTasks(daemon, roomId);
			const existingTaskIds = new Set(tasksBefore.map((t) => t.id));

			// --- Phase 2: Externally fail ALL linked tasks to trigger auto-replan ---
			for (const task of tasksBefore) {
				await daemon.messageHub.request('task.fail', {
					roomId,
					taskId: task.id,
					error: 'Externally failed for replan test',
				});
			}

			// Verify all tasks are now failed
			const tasksAfterFail = await listTasks(daemon, roomId);
			for (const task of tasksAfterFail) {
				expect(task.status).toBe('failed');
			}

			// --- Phase 3: Wait for runtime tick to detect all-failed and auto-replan ---
			// Runtime tick interval is 30s. The tick's getNextGoalForPlanning()
			// detects all tasks failed → spawns new planning group.
			const newPlanningTask = await waitForNewTask(
				daemon,
				roomId,
				{ taskType: 'planning', status: ['pending', 'in_progress', 'completed'] },
				existingTaskIds,
				60_000
			);
			expect(newPlanningTask.id).not.toBe(tasksBefore.find((t) => t.taskType === 'planning')?.id);

			// planning_attempts should have incremented
			const goalAfterReplan = await getGoal(daemon, roomId, goal.id);
			expect(goalAfterReplan.planning_attempts).toBeGreaterThan(attemptsBefore);

			// --- Phase 4: Replan produces new execution tasks ---
			// Just verify new coding tasks appear (don't wait for full completion
			// to save ~30-60s — the execution path is already tested elsewhere)
			const newCodingTask = await waitForNewTask(
				daemon,
				roomId,
				{ taskType: 'coding', status: ['pending', 'in_progress', 'completed'] },
				existingTaskIds,
				180_000
			);
			expect(newCodingTask).toBeTruthy();
			expect(newCodingTask.taskType).toBe('coding');
		},
		{ timeout: 420_000 }
	);
});
