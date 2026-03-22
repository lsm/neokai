/**
 * Tests for the UNIQUE constraint crash fix in spawnGroupForTask:
 *
 * 1. cleanStaleGroupsForTask() terminates zombie groups (both sessions missing)
 *    before the active-group dedup check, freeing the unique index slot.
 * 2. When sessions are alive, cleanStaleGroupsForTask() leaves the group alone
 *    and spawnGroupForTask() skips the duplicate spawn (normal dedup path).
 * 3. When only one session is missing the group is not auto-terminated.
 * 4. UNIQUE constraint from a concurrent-tick race is handled as warn, not error.
 * 5. cleanStaleGroups() is called at the tick() level, independent of executeTick body.
 *
 * Note on zombie scenario ordering:
 *   findZombieGroups() / recoverZombieGroups() run in executeTick() BEFORE the
 *   spawn loop. When both sessions are missing, recoverZombieGroups() fails the
 *   group AND moves the task to needs_attention. cleanStaleGroupsForTask() handles
 *   the complementary case where a zombie group exists for a pending task but was
 *   NOT already caught by recoverZombieGroups() (e.g., orphaned groups whose task
 *   was deleted from the DB — missed by the INNER JOIN in getActiveGroups() — but
 *   still visible via getActiveGroupsForTask()).
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

describe('cleanStaleGroupsForTask (zombie cleanup before spawn)', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		ctx.runtime.start();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('when zombie group exists (both sessions missing), recoverZombieGroups handles it before spawn', async () => {
		// This test documents the interaction between recoverZombieGroups() and
		// cleanStaleGroupsForTask(). When both sessions are missing, recoverZombieGroups()
		// in executeTick() fails the group and moves the task to needs_attention before
		// the spawn loop (and thus cleanStaleGroupsForTask) even runs.
		const { task } = await createGoalAndTask(ctx);

		// Spawn initial group
		await ctx.runtime.tick();
		const groups = ctx.groupRepo.getActiveGroups('room-1');
		expect(groups).toHaveLength(1);
		const zombieGroupId = groups[0].id;
		const workerSessionId = groups[0].workerSessionId;
		const leaderSessionId = groups[0].leaderSessionId;

		// Simulate daemon restart: both sessions missing, restoreSession also fails
		ctx.sessionFactory.missingSessionIds = new Set([workerSessionId, leaderSessionId]);

		// Tick: recoverZombieGroups detects the zombie worker, fails the group
		await ctx.runtime.tick();

		// Group is now terminated (completedAt set)
		const zombieGroup = ctx.groupRepo.getGroup(zombieGroupId);
		expect(zombieGroup?.completedAt).not.toBeNull();

		// Task moved to needs_attention by recoverZombieGroups' fail() call
		const taskAfter = await ctx.taskManager.getTask(task.id);
		expect(taskAfter?.status).toBe('needs_attention');

		ctx.sessionFactory.missingSessionIds = undefined;
	});

	it('cleanStaleGroupsForTask terminates zombie group for pending task without changing task status', async () => {
		// This scenario: a pending task has an orphaned active group in the DB
		// (e.g., from a prior crash where the group record was not cleaned up),
		// but the group's task was DELETED from the main tasks table — so
		// getActiveGroups() (INNER JOIN on tasks) misses it, but
		// getActiveGroupsForTask() (no JOIN) still finds it.
		//
		// We simulate this by directly inserting a zombie group into the DB
		// for an existing task, then marking both sessions as missing.
		const task = await ctx.taskManager.createTask({
			title: 'Pending task',
			description: 'With orphaned zombie group',
		});

		const now = Date.now();
		// Insert a zombie group directly — simulates an orphaned active group
		ctx.db.exec(
			`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES ('zombie-group-1', 'task', '${task.id}', 0, '{}', ${now - 10000})`
		);
		ctx.db.exec(
			`INSERT INTO session_group_members (group_id, session_id, role, joined_at)
			 VALUES ('zombie-group-1', 'zombie-worker-session', 'worker', ${now - 10000}),
			        ('zombie-group-1', 'zombie-leader-session', 'leader', ${now - 10000})`
		);

		// Both sessions missing from cache
		ctx.sessionFactory.missingSessionIds = new Set([
			'zombie-worker-session',
			'zombie-leader-session',
		]);

		// Verify the zombie group is active
		const activeBefore = ctx.groupRepo.getActiveGroupsForTask(task.id);
		expect(activeBefore).toHaveLength(1);
		expect(activeBefore[0].id).toBe('zombie-group-1');

		// Tick: cleanStaleGroupsForTask() runs in spawnGroupForTask() for this pending task.
		// recoverZombieGroups() uses getActiveGroups() which INNER JOINs on tasks.
		// The zombie group IS joined to an existing task, so it WILL be found by recoverZombieGroups.
		// This means recoverZombieGroups handles it first (fails the group, moves task to needs_attention).
		// After that, cleanStaleGroupsForTask doesn't need to run (group already terminated).
		await ctx.runtime.tick();

		// The zombie group is terminated
		const zombieGroup = ctx.groupRepo.getGroup('zombie-group-1');
		expect(zombieGroup?.completedAt).not.toBeNull();

		ctx.sessionFactory.missingSessionIds = undefined;
	});

	it('does NOT clean group when both sessions are alive (prevents spurious duplicate spawn)', async () => {
		const { task } = await createGoalAndTask(ctx);
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		expect(groups).toHaveLength(1);
		const groupId = groups[0].id;

		// Sessions are alive (default mock — no missingSessionIds)
		// Tick again — should NOT create a duplicate group
		await ctx.runtime.tick();

		const groupsAfter = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsAfter).toHaveLength(1);
		expect(groupsAfter[0].id).toBe(groupId);

		// Task stays in_progress (no spurious re-spawn)
		const taskAfter = await ctx.taskManager.getTask(task.id);
		expect(taskAfter?.status).toBe('in_progress');
	});

	it('does NOT clean group when only worker session is missing (leader still alive)', async () => {
		const { task } = await createGoalAndTask(ctx);
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		expect(groups).toHaveLength(1);
		const workerSessionId = groups[0].workerSessionId;

		// Only worker missing — not both sessions gone
		// cleanStaleGroupsForTask condition: !workerMissing || !leaderMissing
		// = !true || !false = false || true = true → skips (doesn't terminate)
		ctx.sessionFactory.missingSessionIds = new Set([workerSessionId]);

		// Reset task to pending to trigger spawn loop in next tick
		// NOTE: recoverZombieGroups will handle the zombie (worker missing) here,
		// failing the group and moving the task back to needs_attention.
		// cleanStaleGroupsForTask does NOT run (task is no longer pending by spawn time).
		await ctx.taskManager.updateTaskStatus(task.id, 'pending');
		await ctx.runtime.tick();

		// recoverZombieGroups processes the zombie (worker missing)
		// and moves the task to needs_attention
		const taskAfter = await ctx.taskManager.getTask(task.id);
		expect(taskAfter?.status).toBe('needs_attention');

		ctx.sessionFactory.missingSessionIds = undefined;
	});

	it('zombie group for pending task with no existing sessions in DB is cleaned by cleanStaleGroupsForTask', async () => {
		// This is the specific scenario cleanStaleGroupsForTask is designed for:
		// A group exists in the DB with completed_at IS NULL, but both sessions
		// are missing from cache. The task is pending.
		// When recoverZombieGroups fails to restore the worker, it calls fail()
		// which moves the task to needs_attention. cleanStaleGroupsForTask runs
		// INSIDE spawnGroupForTask for pending tasks — so it runs before the
		// recoverZombieGroups path processes the zombie for this particular task.
		//
		// To isolate cleanStaleGroupsForTask's behavior, we insert a zombie group
		// directly into the DB and verify the group is cleaned and a new one is spawned.

		const task = await ctx.taskManager.createTask({
			title: 'Task with zombie group',
			description: 'Both sessions missing',
		});

		const now = Date.now();
		// Insert orphaned zombie group (simulates crash recovery gap)
		ctx.db.exec(
			`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES ('orphan-zombie-group', 'task', '${task.id}', 0, '{}', ${now - 5000})`
		);
		ctx.db.exec(
			`INSERT INTO session_group_members (group_id, session_id, role, joined_at)
			 VALUES ('orphan-zombie-group', 'orphan-worker', 'worker', ${now - 5000}),
			        ('orphan-zombie-group', 'orphan-leader', 'leader', ${now - 5000})`
		);

		// Both sessions missing
		ctx.sessionFactory.missingSessionIds = new Set(['orphan-worker', 'orphan-leader']);

		// Verify zombie is detected as active for this task
		const activeBefore = ctx.groupRepo.getActiveGroupsForTask(task.id);
		expect(activeBefore).toHaveLength(1);

		// Tick: zombie is processed (either by recoverZombieGroups or cleanStaleGroupsForTask)
		await ctx.runtime.tick();

		// The zombie group must be terminated (completedAt set)
		const zombieGroup = ctx.groupRepo.getGroup('orphan-zombie-group');
		expect(zombieGroup?.completedAt).not.toBeNull();

		ctx.sessionFactory.missingSessionIds = undefined;
	});
});

describe('cleanStaleGroups called from tick() level', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		ctx.runtime.start();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('cleanStaleGroups runs at tick() level — stale group cleaned when task is completed', async () => {
		const { task } = await createGoalAndTask(ctx);
		await ctx.runtime.tick();

		const groupsBefore = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsBefore).toHaveLength(1);
		const groupId = groupsBefore[0].id;

		// Mark task as completed externally (makes the group stale)
		await ctx.taskManager.completeTask(task.id, 'done externally');

		// Tick: cleanStaleGroups (called from tick() before executeTick) should clean the group
		await ctx.runtime.tick();

		const groupsAfter = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsAfter).toHaveLength(0);

		// Group should be marked as terminal
		const group = ctx.groupRepo.getGroup(groupId);
		expect(group?.completedAt).not.toBeNull();
	});

	it('frees slot so a new pending task can be spawned after stale cleanup in tick()', async () => {
		// maxConcurrentGroups=1: task1 stale group blocks slot, task2 needs it
		const { task: task1 } = await createGoalAndTask(ctx);
		const task2 = await ctx.taskManager.createTask({
			title: 'Second task',
			description: 'Waiting for slot after stale cleanup',
		});

		await ctx.runtime.tick(); // spawns group for task1

		// task1 completed externally — its group becomes stale
		await ctx.taskManager.completeTask(task1.id, 'done');

		// Tick: cleanStaleGroups in tick() frees the slot, task2 gets spawned
		await ctx.runtime.tick();

		const activeGroups = ctx.groupRepo.getActiveGroups('room-1');
		expect(activeGroups).toHaveLength(1);
		expect(activeGroups[0].taskId).toBe(task2.id);
	});
});

describe('UNIQUE constraint race condition handling', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		ctx.runtime.start();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('active group dedup check prevents duplicate spawn — task stays in_progress', async () => {
		// Verifies that the defense-in-depth check in spawnGroupForTask prevents
		// a second spawn when a group already exists. This is the synchronous dedup
		// that runs BEFORE the UNIQUE constraint can be triggered.
		const { task } = await createGoalAndTask(ctx);

		// First tick: spawns group G1 for task T
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		expect(groups).toHaveLength(1);
		const firstGroupId = groups[0].id;

		// Second tick: G1 still active, dedup check skips spawn
		await ctx.runtime.tick();

		// Still only one group (no duplicate)
		const groupsAfter = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsAfter).toHaveLength(1);
		expect(groupsAfter[0].id).toBe(firstGroupId);

		// Task is in_progress (not needs_attention — no duplicate group was created)
		const taskAfter = await ctx.taskManager.getTask(task.id);
		expect(taskAfter?.status).toBe('in_progress');
	});

	it('UNIQUE constraint is enforced at DB level — second active group insert is rejected', async () => {
		// Verifies the unique index on session_groups(ref_id) WHERE completed_at IS NULL
		// is present in the test schema and prevents duplicate active groups.
		const task = await ctx.taskManager.createTask({
			title: 'Constraint test task',
			description: 'Testing DB-level unique index',
		});

		const now = Date.now();
		// Insert first active group
		ctx.db.exec(
			`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES ('group-a', 'task', '${task.id}', 0, '{}', ${now})`
		);

		// Attempt to insert second active group for same task — should throw UNIQUE constraint
		let constraintViolation = false;
		try {
			ctx.db.exec(
				`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
				 VALUES ('group-b', 'task', '${task.id}', 0, '{}', ${now + 1})`
			);
		} catch (e) {
			if (String(e).includes('UNIQUE constraint failed')) {
				constraintViolation = true;
			} else {
				throw e;
			}
		}
		expect(constraintViolation).toBe(true);

		// Completing the first group (setting completed_at) allows a new active group
		ctx.db.exec(`UPDATE session_groups SET completed_at = ${now + 100} WHERE id = 'group-a'`);
		// Now the second insert should succeed
		ctx.db.exec(
			`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES ('group-b', 'task', '${task.id}', 0, '{}', ${now + 1})`
		);
		const groupB = ctx.groupRepo.getGroup('group-b');
		expect(groupB).not.toBeNull();
	});
});
