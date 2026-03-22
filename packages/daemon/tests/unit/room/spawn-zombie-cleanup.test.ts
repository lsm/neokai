/**
 * Tests for the UNIQUE constraint crash fix in spawnGroupForTask:
 *
 * 1. recoverZombieGroups() in executeTick() handles the normal zombie case (task row
 *    present, both sessions missing) — it terminates the group and resets the task to
 *    pending for automatic re-spawn BEFORE the spawn loop runs. cleanStaleGroupsForTask()
 *    is NOT the handler for this case.
 *
 * 2. cleanStaleGroupsForTask()'s exclusive territory: zombie group whose task row was
 *    hard-deleted from the tasks table. getActiveGroups() (INNER JOIN) misses such
 *    groups; getActiveGroupsForTask() (no JOIN) finds them. cleanStaleGroupsForTask()
 *    terminates them without touching task status so the new group can be inserted.
 *
 * 3. When sessions are alive, cleanStaleGroupsForTask() leaves the group alone
 *    and spawnGroupForTask() skips the duplicate spawn (normal dedup path).
 *
 * 4. cleanStaleGroups() is called at the tick() level, independent of executeTick body.
 *
 * 5. UNIQUE constraint from a concurrent-tick race is handled as warn, not error.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

describe('recoverZombieGroups — normal zombie case (task row present)', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		ctx.runtime.start();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('recoverZombieGroups terminates zombie group and immediately re-spawns task on same tick', async () => {
		// Normal zombie scenario: task row exists, both sessions are missing from cache.
		// recoverZombieGroups() in executeTick() runs BEFORE the spawn loop, finds the
		// zombie via getActiveGroups() (INNER JOIN on tasks), terminates the group and
		// resets the task to pending. The spawn loop then picks up the pending task in
		// the SAME tick and spawns a fresh group — task ends up in_progress again.
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

		// Tick: recoverZombieGroups detects the zombie worker, terminates the group,
		// resets task to pending, then spawn loop spawns a fresh group.
		await ctx.runtime.tick();

		// Old zombie group is now terminated (completedAt set)
		const zombieGroup = ctx.groupRepo.getGroup(zombieGroupId);
		expect(zombieGroup?.completedAt).not.toBeNull();

		// A fresh group should have been spawned — task is back in_progress
		const taskAfter = await ctx.taskManager.getTask(task.id);
		expect(taskAfter?.status).toBe('in_progress');

		// New active group should exist (different from the zombie)
		const newGroups = ctx.groupRepo.getActiveGroups('room-1');
		expect(newGroups).toHaveLength(1);
		expect(newGroups[0].id).not.toBe(zombieGroupId);

		ctx.sessionFactory.missingSessionIds = undefined;
	});

	it('recoverZombieGroups handles zombie group inserted directly into DB (task row present)', async () => {
		// A zombie group was inserted into the DB for a pending task (simulating a crash
		// recovery gap), but the task row still exists. getActiveGroups() (INNER JOIN)
		// finds this group, so recoverZombieGroups processes it first — failing the group
		// and moving the task to needs_attention — before the spawn loop runs.
		const task = await ctx.taskManager.createTask({
			title: 'Pending task',
			description: 'With zombie group (task row present)',
		});

		const now = Date.now();
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

		// Tick: recoverZombieGroups (via getActiveGroups INNER JOIN) handles this zombie first
		await ctx.runtime.tick();

		// The zombie group is terminated by recoverZombieGroups
		const zombieGroup = ctx.groupRepo.getGroup('zombie-group-1');
		expect(zombieGroup?.completedAt).not.toBeNull();

		ctx.sessionFactory.missingSessionIds = undefined;
	});

	it('recoverZombieGroups processes zombie when only worker session is missing and re-spawns immediately', async () => {
		// When only the worker is missing, recoverZombieGroups handles it (zombie worker).
		// cleanStaleGroupsForTask does NOT trigger because both sessions must be missing.
		const { task } = await createGoalAndTask(ctx);
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		expect(groups).toHaveLength(1);
		const zombieGroupId = groups[0].id;
		const workerSessionId = groups[0].workerSessionId;

		// Only worker missing — not both sessions gone
		ctx.sessionFactory.missingSessionIds = new Set([workerSessionId]);

		// Reset task to pending to trigger zombie detection in next tick
		await ctx.taskManager.updateTaskStatus(task.id, 'pending');
		await ctx.runtime.tick();

		// recoverZombieGroups processes the zombie (worker missing),
		// terminates the group, resets task to pending, then spawn loop re-spawns immediately
		const taskAfter = await ctx.taskManager.getTask(task.id);
		expect(taskAfter?.status).toBe('in_progress');

		// Old zombie group terminated, new group spawned
		const zombieGroup = ctx.groupRepo.getGroup(zombieGroupId);
		expect(zombieGroup?.completedAt).not.toBeNull();

		ctx.sessionFactory.missingSessionIds = undefined;
	});
});

describe('cleanStaleGroupsForTask — exclusive territory: hard-deleted task row', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		ctx.runtime.start();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('direct call: terminates zombie whose task row is absent — recoverZombieGroups cannot interfere', async () => {
		// This test calls cleanStaleGroupsForTask() directly (bypassing tick() and
		// recoverZombieGroups entirely) to isolate its exclusive territory:
		// a zombie group whose task row has been hard-deleted from the tasks table.
		//
		// getActiveGroups() uses INNER JOIN on tasks — with no task row, the zombie is
		// invisible to recoverZombieGroups. getActiveGroupsForTask() has no JOIN and
		// finds it. cleanStaleGroupsForTask() terminates the zombie without changing
		// task status (the task object is passed in from the caller who still has it).
		const task = await ctx.taskManager.createTask({
			title: 'Orphan zombie task',
			description: 'Task row will be deleted before direct method call',
		});

		const now = Date.now();
		ctx.db.exec(
			`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES ('excl-zombie', 'task', '${task.id}', 0, '{}', ${now - 5000})`
		);
		ctx.db.exec(
			`INSERT INTO session_group_members (group_id, session_id, role, joined_at)
			 VALUES ('excl-zombie', 'excl-worker', 'worker', ${now - 5000}),
			        ('excl-zombie', 'excl-leader', 'leader', ${now - 5000})`
		);

		// Hard-delete the task row — zombie is now invisible to getActiveGroups (INNER JOIN)
		ctx.db.exec(`DELETE FROM tasks WHERE id = '${task.id}'`);

		// Confirm zombie is invisible via INNER JOIN but visible via direct query
		expect(
			ctx.groupRepo.getActiveGroups('room-1').find((g) => g.id === 'excl-zombie')
		).toBeUndefined();
		expect(ctx.groupRepo.getActiveGroupsForTask(task.id)).toHaveLength(1);

		// Both sessions missing
		ctx.sessionFactory.missingSessionIds = new Set(['excl-worker', 'excl-leader']);

		// DIRECT CALL — recoverZombieGroups never runs; only cleanStaleGroupsForTask acts
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (ctx.runtime as any).cleanStaleGroupsForTask(task);

		// Zombie group must be terminated (completedAt set)
		const zombieGroup = ctx.groupRepo.getGroup('excl-zombie');
		expect(zombieGroup?.completedAt).not.toBeNull();

		// No active groups remain for this task
		expect(ctx.groupRepo.getActiveGroupsForTask(task.id)).toHaveLength(0);

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

	it('spawnGroupForTask UNIQUE constraint catch path: warns and returns without throwing', async () => {
		// Exercises the catch block in spawnGroupForTask that handles the concurrent-tick
		// race: two ticks both pass the dedup check (getActiveGroupsForTask returns []),
		// then both attempt INSERT — the second one hits UNIQUE constraint.
		//
		// We simulate the race by:
		//   1. Insert a conflicting active group directly in the DB
		//   2. Patch getActiveGroupsForTask to return [] — simulates the dedup check
		//      running before the concurrent INSERT landed (the race gap)
		//   3. Call spawnGroupForTask directly — it passes the dedup check, calls
		//      taskGroupManager.spawn(), which calls groupRepo.createGroup() → UNIQUE
		//      constraint fires, caught by the catch block at lines 3482-3499
		//
		// Expected: no exception propagates, existing group is untouched, task stays pending
		// (createGroup fires before startTask — the task was never moved to in_progress).
		const { task } = await createGoalAndTask(ctx);

		const now = Date.now();
		// Insert the "concurrent" active group — this will trigger UNIQUE constraint on INSERT
		ctx.db.exec(
			`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES ('racing-group', 'task', '${task.id}', 0, '{}', ${now})`
		);

		// Patch getActiveGroupsForTask → [] so the dedup check does not catch it (race gap)
		const originalGetActive = ctx.groupRepo.getActiveGroupsForTask.bind(ctx.groupRepo);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(ctx.groupRepo as any).getActiveGroupsForTask = (_taskId: string) => [];

		try {
			// Must not throw — UNIQUE constraint is caught and logged as warn, not error
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (ctx.runtime as any).spawnGroupForTask(task);
		} finally {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(ctx.groupRepo as any).getActiveGroupsForTask = originalGetActive;
		}

		// The racing group is still active (we didn't disturb it)
		const racingGroup = ctx.groupRepo.getGroup('racing-group');
		expect(racingGroup?.completedAt).toBeNull();

		// Task is still pending — createGroup (which fires the constraint) is called
		// BEFORE startTask in taskGroupManager.spawn(), so the task was never started.
		const taskAfter = await ctx.taskManager.getTask(task.id);
		expect(taskAfter?.status).toBe('pending');
	});
});
