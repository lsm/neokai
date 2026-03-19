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
		expect(updatedTask!.status).toBe('needs_attention');
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
		expect(updatedTask!.status).toBe('needs_attention');
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

describe('Stuck worker detection and recovery', () => {
	let ctx: ReturnType<typeof createRuntimeTestContext>;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	/**
	 * Helper: spawn a group via tick and return it with its session IDs.
	 * The group has deferredLeader set (normal spawn) and feedbackIteration = 0.
	 */
	async function spawnGroup() {
		await createGoalAndTask(ctx);
		ctx.runtime.start();
		await ctx.runtime.tick();
		const groups = ctx.groupRepo.getActiveGroups('room-1');
		return groups[0];
	}

	/**
	 * Helper: await the next leader session creation by spying on createAndStartSession.
	 * Returns a Promise that resolves when 'createAndStartSession' is called with role 'leader'.
	 */
	function waitForLeaderCreation(): Promise<void> {
		return new Promise((resolve) => {
			const orig = ctx.sessionFactory.createAndStartSession.bind(ctx.sessionFactory);
			ctx.sessionFactory.createAndStartSession = async (init: unknown, role: string) => {
				await orig(init, role);
				if (role === 'leader') {
					ctx.sessionFactory.createAndStartSession = orig;
					resolve();
				}
			};
		});
	}

	it('should detect a stuck worker (idle, leader in restart recovery) during tick and re-trigger routing', async () => {
		const group = await spawnGroup();

		// Simulate: worker is idle but leader hasn't been created yet
		ctx.sessionFactory.processingStates.set(group.workerSessionId, 'idle');
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			// Leader doesn't exist in the session factory yet
			if (sessionId === group.leaderSessionId) return false;
			return true;
		};

		const leaderCreated = waitForLeaderCreation();

		// Tick detects the stuck worker and re-triggers routing
		await ctx.runtime.tick();

		// Wait for the fire-and-forget routing to complete
		await leaderCreated;

		// Leader session should now be created (1 from eager spawn + 1 from routing recovery)
		const leaderCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCalls).toHaveLength(2);
	});

	it('should detect a stuck worker in interrupted state (leader in restart recovery) and re-trigger routing', async () => {
		const group = await spawnGroup();

		ctx.sessionFactory.processingStates.set(group.workerSessionId, 'interrupted');
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === group.leaderSessionId) return false;
			return true;
		};

		const leaderCreated = waitForLeaderCreation();

		await ctx.runtime.tick();
		await leaderCreated;

		// Leader session should now be created (1 from eager spawn + 1 from routing recovery)
		const leaderCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCalls).toHaveLength(2);
	});

	it('should not re-trigger routing if worker is still processing (not stuck)', async () => {
		const group = await spawnGroup();

		// Worker is still actively processing — NOT stuck
		ctx.sessionFactory.processingStates.set(group.workerSessionId, 'processing');
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === group.leaderSessionId) return false;
			return true;
		};

		await ctx.runtime.tick();
		// Allow any pending microtasks to drain
		await new Promise((r) => setTimeout(r, 5));

		const leaderCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCalls).toHaveLength(1);
	});

	it('should not re-trigger routing when processing state is undefined (unknown)', async () => {
		const group = await spawnGroup();

		// No processing state set → undefined (worker state unknown)
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === group.leaderSessionId) return false;
			return true;
		};
		// processingStates is empty by default → getProcessingState returns undefined

		await ctx.runtime.tick();
		await new Promise((r) => setTimeout(r, 5));

		const leaderCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCalls).toHaveLength(1);
	});

	it('should skip stuck-worker recovery for groups with feedbackIteration > 0', async () => {
		const group = await spawnGroup();

		// Manually increment feedbackIteration to simulate a group past its first review
		ctx.groupRepo.incrementFeedbackIteration(group.id, group.version);
		const updatedGroup = ctx.groupRepo.getGroup(group.id)!;
		expect(updatedGroup.feedbackIteration).toBe(1);

		ctx.sessionFactory.processingStates.set(group.workerSessionId, 'idle');
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === group.leaderSessionId) return false;
			return true;
		};

		await ctx.runtime.tick();
		await new Promise((r) => setTimeout(r, 5));

		// Should NOT re-trigger routing because feedbackIteration > 0
		const leaderCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCalls).toHaveLength(1);
	});

	it('should skip stuck-worker recovery for groups awaiting human review', async () => {
		const group = await spawnGroup();

		// Mark as submitted for review
		ctx.groupRepo.setSubmittedForReview(group.id, true);

		ctx.sessionFactory.processingStates.set(group.workerSessionId, 'idle');
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === group.leaderSessionId) return false;
			return true;
		};

		await ctx.runtime.tick();
		await new Promise((r) => setTimeout(r, 5));

		// Should NOT re-trigger because group is in submitted_for_review state
		const leaderCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCalls).toHaveLength(1);
	});

	it('should route worker to existing leader when leader already exists in session factory', async () => {
		// With eager init, the leader is always created in spawn(). When worker is idle and
		// feedbackIteration == 0, recoverStuckWorkers fires routing regardless of leader existence.
		// routeWorkerToLeader() detects leaderAlreadyExists=true and just injects the message.
		const group = await spawnGroup();

		ctx.sessionFactory.processingStates.set(group.workerSessionId, 'idle');
		// Leader EXISTS in session factory (default mock returns true for all)
		// recoverStuckWorkers now triggers routing (we removed the leaderExists skip guard)
		// but routeWorkerToLeader skips creation since leader already exists — only injects

		await ctx.runtime.tick();
		await new Promise((r) => setTimeout(r, 5));

		// Only 1 leader creation total (from eager spawn — no second creation in routing)
		const leaderCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCalls).toHaveLength(1);
	});

	it('should NOT re-trigger routing when worker is in waiting_for_input (intentional pause)', async () => {
		// Since PR #330, waiting_for_input means the worker asked a question and the task
		// is intentionally paused — recoverStuckWorkers must skip these groups.
		const group = await spawnGroup();

		ctx.sessionFactory.processingStates.set(group.workerSessionId, 'waiting_for_input');
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === group.leaderSessionId) return false;
			return true;
		};

		// Simulate that onWorkerTerminalState already set waitingForQuestion=true
		ctx.groupRepo.setWaitingForQuestion(group.id, true, 'worker');

		await ctx.runtime.tick();
		// Give any fire-and-forget tasks a chance to run
		await new Promise((r) => setTimeout(r, 5));

		// No leader should have been created — the group is intentionally paused
		const leaderCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
		);
		expect(leaderCalls).toHaveLength(1);

		// The group should still be active (not failed, not routed)
		const updated = ctx.groupRepo.getGroup(group.id);
		expect(updated!.completedAt).toBeNull();
		expect(updated!.waitingForQuestion).toBe(true);
	});

	it('should not fire duplicate routing on successive ticks while recovery is in-flight', async () => {
		const group = await spawnGroup();

		ctx.sessionFactory.processingStates.set(group.workerSessionId, 'idle');
		ctx.sessionFactory.hasSession = (sessionId: string) => {
			if (sessionId === group.leaderSessionId) return false;
			return true;
		};

		// Track how many times leader creation is attempted
		let leaderCreateCount = 0;
		const firstLeaderCreated = new Promise<void>((resolve) => {
			const orig = ctx.sessionFactory.createAndStartSession.bind(ctx.sessionFactory);
			ctx.sessionFactory.createAndStartSession = async (init: unknown, role: string) => {
				if (role === 'leader') {
					leaderCreateCount++;
					if (leaderCreateCount === 1) resolve();
				}
				await orig(init, role);
			};
		});

		// Tick 1: triggers fire-and-forget recovery (routing is in-flight)
		await ctx.runtime.tick();
		// Tick 2: recovery is still in-flight — should be skipped due to in-flight guard
		await ctx.runtime.tick();

		// Wait for the first (and only) leader creation to complete
		await firstLeaderCreated;
		// Brief drain to ensure any second attempt would have fired by now
		await new Promise((r) => setTimeout(r, 5));

		// Only one leader creation should have been attempted despite two ticks
		expect(leaderCreateCount).toBe(1);
	});
});
