import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
	createRuntimeTestContext,
	spawnAndRouteToLeader,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';

/**
 * Tests for semi-autonomous mode:
 * - Auto-approve coder/general tasks (no human required)
 * - Planner tasks always require human approval
 * - approvalSource correctly recorded
 * - Consecutive failure escalation
 * - Counter reset on success
 * - goal.task.auto_completed event emitted
 */
describe('RoomRuntime semi-autonomous mode', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	// =========================================================================
	// Helpers
	// =========================================================================

	/** Create a semi-autonomous goal + task and route worker to leader. */
	async function spawnSemiAutoToLeader(opts?: { assignedAgent?: 'coder' | 'general' }) {
		const goal = await ctx.goalManager.createGoal({
			title: 'Health check',
			description: 'Add health endpoint',
			autonomyLevel: 'semi_autonomous',
		});
		const task = await ctx.taskManager.createTask({
			title: 'Add GET /health',
			description: 'Returns 200 OK',
			assignedAgent: opts?.assignedAgent ?? 'coder',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];

		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		return { goal, task, group };
	}

	// =========================================================================
	// Gate behavior: supervised vs semi_autonomous
	// =========================================================================

	it('supervised mode is unchanged — submit_for_review still awaits human', async () => {
		// Default goal has autonomyLevel = 'supervised'
		const { group } = await spawnAndRouteToLeader(ctx, { assignedAgent: 'coder' });
		ctx.groupRepo.setSubmittedForReview(group.id, false);

		const result = await ctx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
			pr_url: 'https://github.com/org/repo/pull/1',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		// Supervised: message says waiting for human
		expect(parsed.message).toContain('Waiting for human approval');

		// Group should still be awaiting review (not auto-approved)
		const updatedGroup = ctx.groupRepo.getGroup(group.id)!;
		expect(updatedGroup.submittedForReview).toBe(true);
		expect(updatedGroup.approved).toBe(false);
		expect(updatedGroup.approvalSource).toBeNull();
	});

	it('semi_autonomous coder task — submit_for_review auto-approves with deferred callback', async () => {
		const { task, group } = await spawnSemiAutoToLeader({ assignedAgent: 'coder' });

		const result = await ctx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
			pr_url: 'https://github.com/org/repo/pull/1',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.message).toContain('Auto-approving under semi-autonomous mode');

		// Deferred callback hasn't fired yet — need to yield to event loop
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		// After defer: approvalSource set, approved=true, leader received continuation
		const updatedGroup = ctx.groupRepo.getGroup(group.id)!;
		expect(updatedGroup.approvalSource).toBe('leader_semi_auto');
		expect(updatedGroup.approved).toBe(true);

		// Leader should have received continuation message via injectMessage
		const injectCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === group.leaderSessionId
		);
		expect(injectCalls.length).toBeGreaterThan(0);
		const continuationMsg = injectCalls.at(-1)!.args[1] as string;
		expect(continuationMsg).toContain('auto-approved');

		// Task should still exist (not yet completed — leader needs to call complete_task)
		const updatedTask = await ctx.taskManager.getTask(task.id);
		expect(updatedTask!.status).not.toBe('completed');
	});

	it('semi_autonomous general task — also auto-approves', async () => {
		const { group } = await spawnSemiAutoToLeader({ assignedAgent: 'general' });

		const result = await ctx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
			pr_url: 'https://github.com/org/repo/pull/2',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.message).toContain('Auto-approving');

		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		const updatedGroup = ctx.groupRepo.getGroup(group.id)!;
		expect(updatedGroup.approvalSource).toBe('leader_semi_auto');
		expect(updatedGroup.approved).toBe(true);
	});

	// =========================================================================
	// Planner exclusion
	// =========================================================================

	it('planner task always requires human approval even with semi_autonomous goal', async () => {
		// Create a semi-autonomous goal — planning task is spawned automatically
		await ctx.goalManager.createGoal({
			title: 'Build app',
			description: 'Semi-autonomous app goal',
			autonomyLevel: 'semi_autonomous',
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		expect(groups).toHaveLength(1);
		const group = groups[0];
		expect(group.workerRole).toBe('planner');

		// Route planner to leader
		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		const result = await ctx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
			pr_url: 'https://github.com/org/repo/pull/3',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		// Yield to let deferred callback run (it should NOT run for planners)
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		// Planner: should NOT auto-approve — group still awaiting human
		const updatedGroup = ctx.groupRepo.getGroup(group.id)!;
		expect(updatedGroup.approvalSource).toBeNull();
		expect(updatedGroup.approved).toBe(false);
		expect(updatedGroup.submittedForReview).toBe(true);
		// Message should say "Waiting for human approval"
		expect(parsed.message).toContain('Waiting for human approval');
	});

	// =========================================================================
	// approvalSource recording
	// =========================================================================

	it('human approval via resumeWorkerFromHuman sets approvalSource=human', async () => {
		// Use supervised goal so human approval is needed
		const { task, group } = await spawnAndRouteToLeader(ctx, { assignedAgent: 'coder' });
		ctx.groupRepo.setSubmittedForReview(group.id, true);

		await ctx.runtime.resumeWorkerFromHuman(task.id, 'LGTM, please merge.', {
			approved: true,
		});

		const updatedGroup = ctx.groupRepo.getGroup(group.id)!;
		expect(updatedGroup.approved).toBe(true);
		expect(updatedGroup.approvalSource).toBe('human');
	});

	it('idempotency guard — deferred callback skipped if approvalSource already set', async () => {
		const { group } = await spawnSemiAutoToLeader({ assignedAgent: 'coder' });

		// Pre-set approvalSource to simulate a restart where it was already set
		ctx.groupRepo.setApprovalSource(group.id, 'leader_semi_auto');

		const injectCallsBefore = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === group.leaderSessionId
		).length;

		await ctx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
			pr_url: 'https://github.com/org/repo/pull/99',
		});

		// Yield to let deferred callback run
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		const injectCallsAfter = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'injectMessage' && c.args[0] === group.leaderSessionId
		).length;

		// No new inject calls (guard should have skipped)
		expect(injectCallsAfter).toBe(injectCallsBefore);
	});

	it('deferred auto-approve: approvalSource cleared when resumeWorkerFromHuman returns false', async () => {
		// By resetting submittedForReview to false AFTER handleLeaderTool completes but
		// BEFORE yielding to the event loop, resumeLeaderFromHuman will see
		// submittedForReview=false and return false. Without the fix, approvalSource would
		// remain 'leader_semi_auto' permanently, blocking all future auto-approve retries.
		const { group } = await spawnSemiAutoToLeader({ assignedAgent: 'coder' });

		// submit_for_review: sets submittedForReview=true internally and schedules setTimeout(0)
		await ctx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
			pr_url: 'https://github.com/org/repo/pull/77',
		});

		// Synchronously reset submittedForReview to false — the setTimeout(0) hasn't fired
		// yet because we haven't yielded to the event loop. resumeLeaderFromHuman will see
		// this and return false, triggering the rollback path in the deferred callback.
		ctx.groupRepo.setSubmittedForReview(group.id, false);

		// Yield to let the deferred callback execute
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		// approvalSource must be cleared (null) — not stuck at 'leader_semi_auto'
		const updatedGroup = ctx.groupRepo.getGroup(group.id)!;
		expect(updatedGroup.approvalSource).toBeNull();
		expect(updatedGroup.approved).toBe(false);
	});

	// =========================================================================
	// Auto-completed event + consecutive failures reset
	// =========================================================================

	it('complete_task after auto-approve emits goal.task.auto_completed and resets failures', async () => {
		const { goal, task, group } = await spawnSemiAutoToLeader({ assignedAgent: 'coder' });

		// Manually set up goal with some prior failures to verify reset
		await ctx.goalManager.updateConsecutiveFailures(goal.id, 2);

		// Submit for review (auto-approve flow)
		await ctx.runtime.handleLeaderTool(group.id, 'submit_for_review', {
			pr_url: 'https://github.com/org/repo/pull/5',
		});

		// Wait for deferred auto-approve callback
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		// Verify auto-approved
		const approvedGroup = ctx.groupRepo.getGroup(group.id)!;
		expect(approvedGroup.approved).toBe(true);
		expect(approvedGroup.approvalSource).toBe('leader_semi_auto');

		// Clear emitted events so we can assert only on what complete_task emits
		ctx.hub.emittedEvents.length = 0;

		// Now leader calls complete_task (would happen in a new turn after injection)
		const completeResult = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
			summary: 'Health endpoint added',
		});

		const parsed = JSON.parse(completeResult.content[0].text);
		expect(parsed.success).toBe(true);

		// Task should be completed
		const updatedTask = await ctx.taskManager.getTask(task.id);
		expect(updatedTask!.status).toBe('completed');

		// Consecutive failures should be reset
		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(updatedGoal!.consecutiveFailures).toBe(0);

		// goal.task.auto_completed event should have been emitted with correct payload
		const autoCompletedEvents = ctx.hub.emittedEvents.filter(
			(e) => e.event === 'goal.task.auto_completed'
		);
		expect(autoCompletedEvents).toHaveLength(1);
		const eventData = autoCompletedEvents[0].data as Record<string, unknown>;
		expect(eventData.goalId).toBe(goal.id);
		expect(eventData.taskId).toBe(task.id);
		expect(eventData.approvalSource).toBe('leader_semi_auto');
		expect(eventData.roomId).toBe('room-1');
	});

	// =========================================================================
	// Escalation policy
	// =========================================================================

	it('fail_task increments consecutiveFailures for semi_autonomous goals', async () => {
		const { goal, group } = await spawnSemiAutoToLeader({ assignedAgent: 'coder' });

		const before = (await ctx.goalManager.getGoal(goal.id))!;
		expect(before.consecutiveFailures ?? 0).toBe(0);

		await ctx.runtime.handleLeaderTool(group.id, 'fail_task', { reason: 'Tests broken' });

		const after = await ctx.goalManager.getGoal(goal.id);
		expect(after!.consecutiveFailures).toBe(1);
	});

	it('fail_task escalates goal to needs_human when max consecutive failures reached', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Flaky goal',
			description: 'Keeps failing',
			autonomyLevel: 'semi_autonomous',
			maxConsecutiveFailures: 2,
		});
		// Update consecutive failures to 1 (one away from max)
		await ctx.goalManager.updateConsecutiveFailures(goal.id, 1);

		const task = await ctx.taskManager.createTask({
			title: 'Failing task',
			description: 'Will fail',
			assignedAgent: 'coder',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, task.id);

		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];

		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		// Leader fails the task — this should push consecutiveFailures to 2 (= max)
		await ctx.runtime.handleLeaderTool(group.id, 'fail_task', { reason: 'Still broken' });

		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(updatedGoal!.consecutiveFailures).toBe(2);
		expect(updatedGoal!.status).toBe('needs_human');
	});

	it('fail_task does NOT increment failures for supervised goals', async () => {
		// Use a supervised goal (default)
		const { goal, group } = await spawnAndRouteToLeader(ctx, { assignedAgent: 'coder' });

		await ctx.runtime.handleLeaderTool(group.id, 'fail_task', { reason: 'Compilation error' });

		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		// consecutiveFailures unchanged (supervised mode does not track)
		expect(updatedGoal!.consecutiveFailures ?? 0).toBe(0);
	});

	it('complete_task resets consecutiveFailures to 0 for semi_autonomous goals', async () => {
		const { goal, group } = await spawnSemiAutoToLeader({ assignedAgent: 'coder' });

		// Pre-load some failures
		await ctx.goalManager.updateConsecutiveFailures(goal.id, 3);

		// Set up for complete_task: approved + submitted
		ctx.groupRepo.setSubmittedForReview(group.id, true);
		ctx.groupRepo.setApproved(group.id, true);

		const result = await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
			summary: 'Finally done',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		expect(updatedGoal!.consecutiveFailures).toBe(0);
	});

	it('complete_task does NOT reset failures for supervised goals', async () => {
		// Supervised goal — but set consecutive_failures manually to verify no reset
		const { goal, group } = await spawnAndRouteToLeader(ctx, { assignedAgent: 'coder' });

		// Artificially set consecutive failures (shouldn't happen in supervised but tests isolation)
		await ctx.goalManager.updateConsecutiveFailures(goal.id, 2);

		ctx.groupRepo.setSubmittedForReview(group.id, true);
		ctx.groupRepo.setApproved(group.id, true);

		await ctx.runtime.handleLeaderTool(group.id, 'complete_task', {
			summary: 'Done with supervised goal',
		});

		const updatedGoal = await ctx.goalManager.getGoal(goal.id);
		// Supervised goals don't reset consecutive failures (no-op)
		expect(updatedGoal!.consecutiveFailures).toBe(2);
	});
});
