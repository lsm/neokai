/**
 * Tests for the session recovery safety net:
 * 1. Zombie detection in tick — restores missing sessions or fails groups
 * 2. resumeWorkerFromHuman rollback — reverts state when inject fails
 * 3. Tick remains async and handles zombie recovery correctly
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

/**
 * Helper: create a task + session group directly in DB (bypassing tick).
 * Avoids race conditions from scheduleTick background ticks.
 * @param submittedForReview - If true, sets the group as awaiting human review
 */
async function createTaskWithGroup(
	ctx: RuntimeTestContext,
	submittedForReview = false
): Promise<{ taskId: string; groupId: string; workerSessionId: string; leaderSessionId: string }> {
	const { task } = await createGoalAndTask(ctx);
	const group = ctx.groupRepo.createGroup(task.id, `worker:${task.id}`, `leader:${task.id}`);
	await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

	if (submittedForReview) {
		// Set submittedForReview flag and task status to review
		ctx.groupRepo.setSubmittedForReview(group.id, true);
		await ctx.taskManager.reviewTask(task.id);
	}

	// Reload group to get the updated values after setSubmittedForReview
	const updatedGroup = ctx.groupRepo.getGroup(group.id);

	return {
		taskId: task.id,
		groupId: group.id,
		workerSessionId: group.workerSessionId,
		leaderSessionId: group.leaderSessionId,
	};
}

describe('Zombie detection in tick', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('should restore a zombie worker session during tick', async () => {
		const { groupId, workerSessionId } = await createTaskWithGroup(ctx);

		// Worker is missing from cache — becomes live after first restore
		const restoredSessions = new Set<string>();
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === workerSessionId && !restoredSessions.has(sessionId)) return false;
			return true;
		};
		const originalRestore = ctx.sessionFactory.restoreSession.bind(ctx.sessionFactory);
		ctx.sessionFactory.restoreSession = async (sessionId: string) => {
			restoredSessions.add(sessionId);
			return originalRestore(sessionId);
		};

		ctx.runtime.start();
		await ctx.runtime.tick();

		const restoreCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'restoreSession' && c.args[0] === workerSessionId
		);
		expect(restoreCalls).toHaveLength(1);

		// Group should still be active (not failed)
		const updated = ctx.groupRepo.getGroup(groupId);
		expect(updated!.completedAt).toBeNull();
	});

	it('should fail group when zombie worker cannot be restored', async () => {
		const { taskId, groupId, workerSessionId } = await createTaskWithGroup(ctx);

		// Worker missing AND restoreSession fails
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === workerSessionId) return false;
			return true;
		};
		ctx.sessionFactory.restoreSession = async () => false;

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Group should be failed
		const updated = ctx.groupRepo.getGroup(groupId);
		expect(updated!.completedAt).not.toBeNull();

		// Task should be failed
		const updatedTask = await ctx.taskManager.getTask(taskId);
		expect(updatedTask!.status).toBe('failed');
	});

	it('should restore a zombie leader session during tick', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		// Leader is missing from cache — becomes live after first restore
		const restoredSessions = new Set<string>();
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === leaderSessionId && !restoredSessions.has(sessionId)) return false;
			return true;
		};
		const originalRestore = ctx.sessionFactory.restoreSession.bind(ctx.sessionFactory);
		ctx.sessionFactory.restoreSession = async (sessionId: string) => {
			restoredSessions.add(sessionId);
			return originalRestore(sessionId);
		};

		ctx.runtime.start();
		await ctx.runtime.tick();

		const restoreCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'restoreSession' && c.args[0] === leaderSessionId
		);
		expect(restoreCalls).toHaveLength(1);

		// Group should still be active
		const updated = ctx.groupRepo.getGroup(groupId);
		expect(updated!.completedAt).toBeNull();
	});

	it('should continue when zombie leader cannot be restored (lazily created)', async () => {
		const { groupId, leaderSessionId } = await createTaskWithGroup(ctx);

		// Leader missing and unrestorable
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === leaderSessionId) return false;
			return true;
		};
		ctx.sessionFactory.restoreSession = async () => false;

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Group should NOT be failed - leader is created lazily later
		const updated = ctx.groupRepo.getGroup(groupId);
		expect(updated!.completedAt).toBeNull();
	});

	it('should not interfere with normal tick when no zombies exist', async () => {
		await createGoalAndTask(ctx);
		ctx.runtime.start();

		// Normal tick — all sessions exist (hasSession returns true by default)
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		expect(groups).toHaveLength(1);

		// No restore calls should have been made
		const restoreCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'restoreSession');
		expect(restoreCalls).toHaveLength(0);
	});

	it('should handle multiple zombie groups in a single tick', async () => {
		// Create two zombie groups directly in DB
		const goal = await ctx.goalManager.createGoal({
			title: 'Multi-task goal',
			description: 'Test',
		});
		const task1 = await ctx.taskManager.createTask({
			title: 'Task 1',
			description: 'First task',
			assignedAgent: 'general',
		});
		const task2 = await ctx.taskManager.createTask({
			title: 'Task 2',
			description: 'Second task',
			assignedAgent: 'general',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, task1.id);
		await ctx.goalManager.linkTaskToGoal(goal.id, task2.id);

		const group1 = ctx.groupRepo.createGroup(task1.id, 'worker-1', 'leader-1');
		const group2 = ctx.groupRepo.createGroup(task2.id, 'worker-2', 'leader-2');
		await ctx.taskManager.updateTaskStatus(task1.id, 'in_progress');
		await ctx.taskManager.updateTaskStatus(task2.id, 'in_progress');

		// Both workers are zombies — mark as live after restore
		const restoredSessions = new Set<string>();
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			return restoredSessions.has(sessionId);
		};
		ctx.sessionFactory.restoreSession = async (sessionId: string) => {
			restoredSessions.add(sessionId);
			return true;
		};

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Both workers should be restored
		expect(restoredSessions.has('worker-1')).toBe(true);
		expect(restoredSessions.has('worker-2')).toBe(true);

		// Both groups should remain active
		expect(ctx.groupRepo.getGroup(group1.id)!.completedAt).toBeNull();
		expect(ctx.groupRepo.getGroup(group2.id)!.completedAt).toBeNull();
	});

	it('should restore zombie worker in submitted_for_review group during tick', async () => {
		const { groupId, workerSessionId } = await createTaskWithGroup(ctx, true);

		// Worker is missing — becomes live after restore
		const restoredSessions = new Set<string>();
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === workerSessionId && !restoredSessions.has(sessionId)) return false;
			return true;
		};
		const originalRestore = ctx.sessionFactory.restoreSession.bind(ctx.sessionFactory);
		ctx.sessionFactory.restoreSession = async (sessionId: string) => {
			restoredSessions.add(sessionId);
			return originalRestore(sessionId);
		};

		ctx.runtime.start();
		await ctx.runtime.tick();

		const restoreCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'restoreSession' && c.args[0] === workerSessionId
		);
		expect(restoreCalls).toHaveLength(1);

		// Group should remain active (not failed)
		const updated = ctx.groupRepo.getGroup(groupId);
		expect(updated!.completedAt).toBeNull();
	});

	it('should fail submitted_for_review group when worker cannot be restored', async () => {
		const { taskId, groupId, workerSessionId } = await createTaskWithGroup(ctx, true);

		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === workerSessionId) return false;
			return true;
		};
		ctx.sessionFactory.restoreSession = async () => false;

		ctx.runtime.start();
		await ctx.runtime.tick();

		const updated = ctx.groupRepo.getGroup(groupId);
		expect(updated!.completedAt).not.toBeNull();

		const updatedTask = await ctx.taskManager.getTask(taskId);
		expect(updatedTask!.status).toBe('failed');
	});

	it('should reattach observer after restoring zombie worker', async () => {
		const { workerSessionId } = await createTaskWithGroup(ctx);

		const restoredSessions = new Set<string>();
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === workerSessionId && !restoredSessions.has(sessionId)) return false;
			return true;
		};
		ctx.sessionFactory.restoreSession = async (sessionId: string) => {
			restoredSessions.add(sessionId);
			return true;
		};

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Observer should be watching the restored session
		expect(ctx.observer.isObserving(workerSessionId)).toBe(true);
	});

	it('should reattach observer after restoring zombie leader', async () => {
		const { leaderSessionId } = await createTaskWithGroup(ctx);

		const restoredSessions = new Set<string>();
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === leaderSessionId && !restoredSessions.has(sessionId)) return false;
			return true;
		};
		ctx.sessionFactory.restoreSession = async (sessionId: string) => {
			restoredSessions.add(sessionId);
			return true;
		};

		ctx.runtime.start();
		await ctx.runtime.tick();

		expect(ctx.observer.isObserving(leaderSessionId)).toBe(true);
	});
});

describe('resumeWorkerFromHuman rollback', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('should rollback task when injectMessage fails', async () => {
		const { taskId } = await createTaskWithGroup(ctx, true);
		// Task is already in review status from createTaskWithGroup

		// Make injectMessage fail (simulates session not in cache after restart)
		ctx.sessionFactory.injectMessage = async () => {
			throw new Error('Session not in service cache');
		};

		ctx.runtime.start();
		const result = await ctx.runtime.resumeWorkerFromHuman(taskId, 'Approved');
		expect(result).toBe(false);

		// Task should revert to review (not stuck in in_progress)
		const updatedTask = await ctx.taskManager.getTask(taskId);
		expect(updatedTask!.status).toBe('review');
	});

	it('should succeed normally when injectMessage works', async () => {
		const { taskId, groupId } = await createTaskWithGroup(ctx, true);
		// Task is already in review status from createTaskWithGroup

		ctx.runtime.start();
		const result = await ctx.runtime.resumeWorkerFromHuman(taskId, 'Approved');
		expect(result).toBe(true);

		// Group should still be active (completedAt null)
		const updated = ctx.groupRepo.getGroup(groupId);
		expect(updated!.completedAt).toBeNull();

		// Task should be in_progress
		const updatedTask = await ctx.taskManager.getTask(taskId);
		expect(updatedTask!.status).toBe('in_progress');
	});

	it('should return false for non-existent task', async () => {
		ctx.runtime.start();
		const result = await ctx.runtime.resumeWorkerFromHuman('nonexistent', 'Approved');
		expect(result).toBe(false);
	});

	it('should return false when group is not in submitted_for_review', async () => {
		const { taskId } = await createTaskWithGroup(ctx, false);

		ctx.runtime.start();
		const result = await ctx.runtime.resumeWorkerFromHuman(taskId, 'Approved');
		expect(result).toBe(false);
	});
});

describe('Tick async behavior', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('tick should be async and await zombie recovery before proceeding', async () => {
		const { workerSessionId } = await createTaskWithGroup(ctx);

		const restoredSessions = new Set<string>();
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === workerSessionId && !restoredSessions.has(sessionId)) return false;
			return true;
		};

		let restoreResolved = false;
		ctx.sessionFactory.restoreSession = async (sessionId: string) => {
			// Simulate async restore with delay
			await new Promise((resolve) => setTimeout(resolve, 10));
			restoredSessions.add(sessionId);
			restoreResolved = true;
			return true;
		};

		ctx.runtime.start();
		await ctx.runtime.tick();

		// The tick should have awaited the async restore
		expect(restoreResolved).toBe(true);
	});

	it('should handle concurrent ticks with zombie detection without double-processing', async () => {
		const { workerSessionId } = await createTaskWithGroup(ctx);

		let restoreCount = 0;
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === workerSessionId && restoreCount === 0) return false;
			return true;
		};
		ctx.sessionFactory.restoreSession = async () => {
			restoreCount++;
			return true;
		};

		ctx.runtime.start();
		// Run two ticks concurrently - mutex should prevent double processing
		await Promise.all([ctx.runtime.tick(), ctx.runtime.tick()]);

		expect(restoreCount).toBe(1);
	});
});
