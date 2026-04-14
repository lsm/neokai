/**
 * Tests for:
 * - cleanStaleGroups(): auto-cleans groups whose tasks are in terminal states
 * - forceStopSessionGroup(): manually force-stops a group by ID
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

describe('cleanStaleGroups (tick auto-cleanup)', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		ctx.runtime.start();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('should not affect active groups with in_progress tasks', async () => {
		await createGoalAndTask(ctx);
		await ctx.runtime.tick();

		// Group is active, task is in_progress — should NOT be cleaned up
		const groupsBefore = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsBefore).toHaveLength(1);

		// Second tick: stale cleanup runs but should leave in_progress group alone
		await ctx.runtime.tick();

		const groupsAfter = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsAfter).toHaveLength(1);
	});

	it('should auto-clean a stale group when task is completed', async () => {
		const { task } = await createGoalAndTask(ctx);
		await ctx.runtime.tick();

		// Verify group is active
		const groupsBefore = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsBefore).toHaveLength(1);
		const groupId = groupsBefore[0].id;

		// Manually mark the task as completed (simulating external status change)
		await ctx.taskManager.completeTask(task.id, 'done externally');

		// Tick: cleanStaleGroups should detect and clean the orphaned group
		await ctx.runtime.tick();

		// The group should no longer be active (marked as failed by terminateGroup)
		const groupsAfter = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsAfter).toHaveLength(0);

		// stopSession should have been called for both sessions
		const stopCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'stopSession');
		expect(stopCalls.length).toBeGreaterThanOrEqual(1);

		// cleanStaleGroups calls terminateGroup which marks the group terminal (completedAt set)
		// but does NOT delete the record — the group remains in the DB as inactive.
		const group = ctx.groupRepo.getGroup(groupId);
		expect(group).not.toBeNull();
		expect(group!.completedAt).not.toBeNull();
	});

	it('should auto-clean a stale group when task is cancelled', async () => {
		// Create a task without a goal so the tick does NOT trigger replanning
		// when the task is cancelled (replanning only triggers for goal-linked tasks).
		const task = await ctx.taskManager.createTask({
			title: 'Standalone task',
			description: 'No goal linked',
		});
		await ctx.runtime.tick();

		const groupsBefore = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsBefore).toHaveLength(1);

		// Mark task as cancelled externally (in_progress → cancelled is a valid transition)
		await ctx.taskManager.cancelTask(task.id);

		// Tick: should auto-clean the stale group
		await ctx.runtime.tick();

		const groupsAfter = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsAfter).toHaveLength(0);
	});

	it('should auto-clean a stale group when task is archived', async () => {
		// Create a task without a goal to avoid replanning side effects.
		// Archive requires transition through cancelled first.
		const task = await ctx.taskManager.createTask({
			title: 'Standalone task to archive',
			description: 'No goal linked',
		});
		await ctx.runtime.tick();

		const groupsBefore = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsBefore).toHaveLength(1);

		// Transition: in_progress → cancelled → archived (two-step required by status transitions)
		await ctx.taskManager.cancelTask(task.id);
		await ctx.taskManager.archiveTask(task.id);

		// Tick: should auto-clean the stale group
		await ctx.runtime.tick();

		const groupsAfter = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsAfter).toHaveLength(0);
	});

	it('should free slot so a new task can be spawned after stale cleanup', async () => {
		// Create and spawn first task
		const { task: task1 } = await createGoalAndTask(ctx);
		const task2 = await ctx.taskManager.createTask({
			title: 'Second task',
			description: 'Pending task waiting for a slot',
		});
		await ctx.runtime.tick(); // spawns group for task1

		// task1 completes externally but group is orphaned
		await ctx.taskManager.completeTask(task1.id, 'done externally');

		// task2 should now be spawnable after stale cleanup frees the slot
		await ctx.runtime.tick();

		const activeGroups = ctx.groupRepo.getActiveGroups('room-1');
		// After cleanup: task1's stale group is gone, task2's group is spawned
		expect(activeGroups).toHaveLength(1);
		expect(activeGroups[0].taskId).toBe(task2.id);
	});
});

describe('forceStopSessionGroup', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		ctx.runtime.start();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('should return success=false for non-existent group', async () => {
		const result = await ctx.runtime.forceStopSessionGroup('non-existent-group');
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not found/i);
	});

	it('should return success=false for group in a different room', async () => {
		// Manually create a group for a task in another room by seeding the DB
		// We simulate this by creating a group whose task.id does not exist in this room's TaskManager.
		// The simplest way: use a task ID that doesn't exist.
		const now = Date.now();
		ctx.db.exec(
			`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES ('foreign-group', 'task', 'non-existent-task-id', 0, '{}', ${now})`
		);
		ctx.db.exec(
			`INSERT INTO session_group_members (group_id, session_id, role, joined_at)
			 VALUES ('foreign-group', 'worker:room-2:non-existent-task-id:abc', 'worker', ${now}),
			        ('foreign-group', 'leader:room-2:non-existent-task-id:abc', 'leader', ${now})`
		);

		const result = await ctx.runtime.forceStopSessionGroup('foreign-group');
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/different room|no longer exists/i);
	});

	it('should force-stop an active group and delete it from the DB', async () => {
		const { task } = await createGoalAndTask(ctx);
		await ctx.runtime.tick();

		const groupsBefore = ctx.groupRepo.getActiveGroups('room-1');
		expect(groupsBefore).toHaveLength(1);
		const groupId = groupsBefore[0].id;

		const result = await ctx.runtime.forceStopSessionGroup(groupId);
		expect(result.success).toBe(true);

		// Group should be deleted from DB
		const groupAfter = ctx.groupRepo.getGroup(groupId);
		expect(groupAfter).toBeNull();

		// No more active groups
		const activeAfter = ctx.groupRepo.getActiveGroups('room-1');
		expect(activeAfter).toHaveLength(0);

		// stopSession should have been called
		const stopCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'stopSession');
		expect(stopCalls.length).toBeGreaterThanOrEqual(1);

		// Task status should be unchanged (force-stop doesn't cancel the task)
		const taskAfter = await ctx.taskManager.getTask(task.id);
		expect(taskAfter!.status).toBe('in_progress');
	});

	it('should force-stop a group whose task is already completed', async () => {
		const { task } = await createGoalAndTask(ctx);
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const groupId = groups[0].id;

		// Task completes externally but group is orphaned
		await ctx.taskManager.completeTask(task.id, 'done');

		const result = await ctx.runtime.forceStopSessionGroup(groupId);
		expect(result.success).toBe(true);

		const groupAfter = ctx.groupRepo.getGroup(groupId);
		expect(groupAfter).toBeNull();
	});

	it('should schedule a tick after force-stopping so pending tasks can be picked up', async () => {
		const { task: task1 } = await createGoalAndTask(ctx);
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const groupId = groups[0].id;

		// Mark task1 as completed so the freed slot can be used
		await ctx.taskManager.completeTask(task1.id, 'done');

		// Create a second pending task
		const task2 = await ctx.taskManager.createTask({
			title: 'Pending task',
			description: 'Waiting for a slot',
		});

		// Force-stop the stale group (task1 is completed but group is orphaned)
		const result = await ctx.runtime.forceStopSessionGroup(groupId);
		expect(result.success).toBe(true);

		// Tick again: now the slot should be freed and task2 gets spawned
		await ctx.runtime.tick();

		const activeGroups = ctx.groupRepo.getActiveGroups('room-1');
		expect(activeGroups).toHaveLength(1);
		expect(activeGroups[0].taskId).toBe(task2.id);
	});
});
