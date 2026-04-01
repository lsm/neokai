/**
 * Goal Lifecycle Reset Integration Tests
 *
 * Tests DB-level state changes for goal lifecycle operations:
 * - reset_goal clears all stale state (linkedTaskIds, planning_attempts, consecutiveFailures)
 * - description update resets planning_attempts (invalidation)
 * - planning_attempts is writable via update_goal
 * - description update transitions needs_human → active
 *
 * These tests verify RPC-observable state without exercising actual planning sessions.
 * No real API calls are made — this test is safe to run with NEOKAI_USE_DEV_PROXY=1.
 *
 * NOTE: Like all room/* online tests this file is intentionally excluded from the CI
 * matrix (see .github/workflows/main.yml) due to resource usage. Registered in
 * scripts/validate-online-test-matrix.sh.
 * Run locally with: NEOKAI_USE_DEV_PROXY=1 bun test tests/online/room/goal-lifecycle-reset.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { DaemonAppContext } from '../../../src/app';
import type { RoomGoal } from '@neokai/shared';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';
import { TaskManager } from '../../../src/lib/room/managers/task-manager';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import { createRoomAgentToolHandlers } from '../../../src/lib/room/tools/room-agent-tools';
import { setupGitEnvironment, createRoom, createGoal, getGoal } from './room-test-helpers';

type InProcessDaemon = DaemonServerContext & { daemonContext?: DaemonAppContext };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the DaemonAppContext from an in-process daemon.
 * Fails fast with a clear message if running in spawned mode (DAEMON_TEST_SPAWN=true),
 * since this test file requires direct DB access via daemonContext.
 */
function getDaemonCtx(daemon: DaemonServerContext): DaemonAppContext {
	const ctx = daemon as InProcessDaemon;
	if (!ctx.daemonContext) {
		throw new Error(
			'daemonContext not available — this test requires in-process mode. ' +
				'Do not run with DAEMON_TEST_SPAWN=true.'
		);
	}
	return ctx.daemonContext;
}

/**
 * Create a GoalManager instance backed by the running daemon's SQLite database.
 * Used to inject stale state for setup — the daemon and this manager share the same
 * underlying database file, so writes are visible to each other immediately.
 */
function makeGoalManager(daemon: DaemonServerContext, roomId: string): GoalManager {
	const ctx = getDaemonCtx(daemon);
	return new GoalManager(
		ctx.db.getDatabase(),
		roomId,
		ctx.reactiveDb,
		ctx.db.getShortIdAllocator()
	);
}

/**
 * Create a set of room agent tool handlers backed by the running daemon's database.
 * These handlers call the same code paths as the actual MCP tools.
 */
function makeAgentToolHandlers(daemon: DaemonServerContext, roomId: string) {
	const ctx = getDaemonCtx(daemon);
	const db = ctx.db.getDatabase();
	const reactiveDb = ctx.reactiveDb;
	const shortIdAllocator = ctx.db.getShortIdAllocator();

	const goalManager = new GoalManager(db, roomId, reactiveDb, shortIdAllocator);
	const taskManager = new TaskManager(db, roomId, reactiveDb, shortIdAllocator);
	const groupRepo = new SessionGroupRepository(db, reactiveDb);

	return createRoomAgentToolHandlers({ roomId, goalManager, taskManager, groupRepo });
}

function parseToolResult(result: { content: Array<{ type: string; text: string }> }): {
	success: boolean;
	goal?: RoomGoal;
	error?: string;
} {
	return JSON.parse(result.content[0].text) as {
		success: boolean;
		goal?: RoomGoal;
		error?: string;
	};
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('Goal Lifecycle Reset Integration Tests', () => {
	let daemon: DaemonServerContext;
	let savedModel: string | undefined;

	beforeAll(async () => {
		// Set DEFAULT_MODEL inside beforeAll so restoration is guaranteed even if
		// the import is re-evaluated, and won't leak if beforeAll itself throws.
		savedModel = process.env.DEFAULT_MODEL;
		process.env.DEFAULT_MODEL = 'sonnet';

		daemon = await createDaemonServer();
		setupGitEnvironment(process.env.NEOKAI_WORKSPACE_PATH!);
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

	// ─── 1. reset_goal clears all stale state ────────────────────────────────────

	test('reset_goal clears linkedTaskIds, planning_attempts, consecutiveFailures, and restores active status', async () => {
		const roomId = await createRoom(daemon, 'Reset Goal Test');
		const goal = await createGoal(daemon, roomId, 'Reset test goal', 'Initial description');

		const goalManager = makeGoalManager(daemon, roomId);

		// Inject stale state: fake linked task IDs and elevated counters.
		// Fake task IDs are safe here: reset_goal iterates linkedTaskIds and calls
		// taskManager.getTask() for each; unknown IDs return null and are skipped
		// by the `!task` guard, so no error occurs during the reset.
		await goalManager.patchGoal(goal.id, {
			linkedTaskIds: ['fake-task-1', 'fake-task-2'],
			planning_attempts: 3,
			consecutiveFailures: 2,
			replanCount: 1,
		});

		// Also transition to needs_human to verify full reset
		await goalManager.updateGoalStatus(goal.id, 'needs_human');

		// Verify stale state is in place
		const staleGoal = await getGoal(daemon, roomId, goal.id);
		expect(staleGoal.linkedTaskIds).toHaveLength(2);
		expect(staleGoal.planning_attempts).toBe(3);
		expect(staleGoal.consecutiveFailures).toBe(2);
		expect(staleGoal.replanCount ?? 0).toBe(1);
		expect(staleGoal.status).toBe('needs_human');

		// Call reset_goal MCP tool handler
		const handlers = makeAgentToolHandlers(daemon, roomId);
		const result = await handlers.reset_goal({ goal_id: goal.id });
		const data = parseToolResult(result);
		expect(data.success).toBe(true);

		// Assert DB-level state via goal.get RPC
		const resetGoal = await getGoal(daemon, roomId, goal.id);
		expect(resetGoal.linkedTaskIds).toHaveLength(0);
		expect(resetGoal.planning_attempts ?? 0).toBe(0);
		expect(resetGoal.consecutiveFailures ?? 0).toBe(0);
		expect(resetGoal.replanCount ?? 0).toBe(0);
		expect(resetGoal.status).toBe('active');
	}, 30_000);

	// ─── 2. Description update resets planning_attempts ──────────────────────────

	test('description update via update_goal resets planning_attempts to 0', async () => {
		const roomId = await createRoom(daemon, 'Description Invalidation Test');
		const goal = await createGoal(daemon, roomId, 'Invalidation test goal', 'Original description');

		const handlers = makeAgentToolHandlers(daemon, roomId);

		// Set planning_attempts to 3 via update_goal
		const setResult = await handlers.update_goal({ goal_id: goal.id, planning_attempts: 3 });
		expect(parseToolResult(setResult).success).toBe(true);

		const beforeUpdate = await getGoal(daemon, roomId, goal.id);
		expect(beforeUpdate.planning_attempts).toBe(3);

		// Update description — invalidation hook should reset planning_attempts to 0
		const updateResult = await handlers.update_goal({
			goal_id: goal.id,
			description: 'Updated description with new context',
		});
		expect(parseToolResult(updateResult).success).toBe(true);

		// Assert via goal.get RPC: planning_attempts is reset
		const afterUpdate = await getGoal(daemon, roomId, goal.id);
		expect(afterUpdate.planning_attempts ?? 0).toBe(0);
		expect(afterUpdate.description).toBe('Updated description with new context');
	}, 30_000);

	// ─── 3. planning_attempts is writable via update_goal ────────────────────────

	test('planning_attempts is writable via update_goal', async () => {
		const roomId = await createRoom(daemon, 'Planning Attempts Write Test');
		const goal = await createGoal(daemon, roomId, 'Write test goal', 'Test description');

		// Initial state: planning_attempts defaults to 0
		const initial = await getGoal(daemon, roomId, goal.id);
		expect(initial.planning_attempts ?? 0).toBe(0);

		const handlers = makeAgentToolHandlers(daemon, roomId);

		// Write planning_attempts = 5 via update_goal
		const result = await handlers.update_goal({ goal_id: goal.id, planning_attempts: 5 });
		const data = parseToolResult(result);
		expect(data.success).toBe(true);

		// Assert via goal.get RPC: persisted value is 5
		const updated = await getGoal(daemon, roomId, goal.id);
		expect(updated.planning_attempts).toBe(5);
	}, 30_000);

	// ─── 4. Description update transitions needs_human → active ─────────────────

	test('description update via update_goal transitions needs_human to active', async () => {
		const roomId = await createRoom(daemon, 'Needs Human Recovery Test');
		const goal = await createGoal(daemon, roomId, 'Recovery test goal', 'Initial description');

		// Transition to needs_human via goal.needsHuman RPC
		const needsHumanResult = (await daemon.messageHub.request('goal.needsHuman', {
			roomId,
			goalId: goal.id,
		})) as { goal: RoomGoal };
		expect(needsHumanResult.goal.status).toBe('needs_human');

		const handlers = makeAgentToolHandlers(daemon, roomId);

		// Update description — should auto-transition needs_human → active
		const updateResult = await handlers.update_goal({
			goal_id: goal.id,
			description: 'Updated description that resolves the blocking issue',
		});
		const data = parseToolResult(updateResult);
		expect(data.success).toBe(true);

		// Assert via goal.get RPC: status is now active
		const finalGoal = await getGoal(daemon, roomId, goal.id);
		expect(finalGoal.status).toBe('active');
	}, 30_000);
});
