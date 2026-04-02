/**
 * RoomRuntime — triggerNow() Integration Tests
 *
 * Tests for the runtime-level triggerNow method for recurring missions:
 * - Validation: rejects non-recurring, non-active, paused, no-schedule goals
 * - Overlap prevention: rejects when an active execution exists
 * - Successful trigger: creates execution, advances nextRunAt to next cron time
 * - Does NOT clobber nextRunAt with current time (P0 regression test)
 * - Spawns a planner session for first execution
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { createRuntimeTestContext, type RuntimeTestContext } from './room-runtime-test-helpers';

describe('RoomRuntime — triggerNow', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('throws when goal is not found', async () => {
		await expect(ctx.runtime.triggerNow('nonexistent')).rejects.toThrow('Goal not found');
	});

	it('throws when goal is not recurring', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'One-shot goal',
			missionType: 'one_shot',
		});
		await expect(ctx.runtime.triggerNow(goal.id)).rejects.toThrow('not a recurring mission');
	});

	it('throws when goal is not active', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Inactive recurring',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
		});
		// patchGoal to set status without going through state machine
		await ctx.goalManager.patchGoal(goal.id, { status: 'completed' });
		await expect(ctx.runtime.triggerNow(goal.id)).rejects.toThrow('not active');
	});

	it('throws when schedule is paused', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Paused recurring',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			schedulePaused: true,
		});
		await expect(ctx.runtime.triggerNow(goal.id)).rejects.toThrow('schedule is paused');
	});

	it('throws when goal has no schedule configured', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'No schedule recurring',
			missionType: 'recurring',
		});
		await expect(ctx.runtime.triggerNow(goal.id)).rejects.toThrow('no schedule configured');
	});

	it('throws when an active execution already exists', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Already running',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
		});

		// Manually insert a running execution into the DB to simulate an active execution
		ctx.db.exec(
			`INSERT INTO mission_executions (id, goal_id, execution_number, status, started_at, task_ids)
			 VALUES ('exec-fake', '${goal.id}', 1, 'running', strftime('%s', 'now'), '[]')`
		);

		await expect(ctx.runtime.triggerNow(goal.id)).rejects.toThrow(
			'already has an active execution'
		);
	});

	it('creates execution and advances nextRunAt to next cron time (not now)', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Hourly runner',
			missionType: 'recurring',
			schedule: { expression: '@hourly', timezone: 'UTC' },
		});

		ctx.runtime.start();

		const result = await ctx.runtime.triggerNow(goal.id);

		// Execution should have been created
		const executions = ctx.goalManager.listExecutions(goal.id, 10);
		expect(executions).toHaveLength(1);
		expect(executions[0].status).toBe('running');

		// nextRunAt should be the NEXT cron time (next hourly slot),
		// NOT the current time — this is the P0 regression check.
		// @hourly from UTC: next slot is always 0–3600s away, so nextRunAt
		// must be strictly greater than now (not "now" or in the past).
		const nowSec = Math.floor(Date.now() / 1000);
		expect(result.nextRunAt).toBeGreaterThan(nowSec);

		// Upper bound: next hourly slot plus a few seconds of grace
		const secondsUntilNext = result.nextRunAt! - nowSec;
		expect(secondsUntilNext).toBeLessThan(3700);

		// A planner session should have been spawned for execution #1
		const plannerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'planner'
		);
		expect(plannerCalls).toHaveLength(1);
	});

	it('does not call updateNextRunAt separately (P0: no double-write)', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Hourly runner',
			missionType: 'recurring',
			schedule: { expression: '@hourly', timezone: 'UTC' },
		});

		// Spy on updateNextRunAt by wrapping it
		let updateNextRunAtCalls = 0;
		const original = ctx.goalManager.updateNextRunAt.bind(ctx.goalManager);
		ctx.goalManager.updateNextRunAt = async (...args) => {
			updateNextRunAtCalls++;
			return original(...args);
		};

		ctx.runtime.start();

		await ctx.runtime.triggerNow(goal.id);

		// triggerNow must NOT call updateNextRunAt — startExecution handles
		// nextRunAt atomically in its transaction. This catches regressions
		// where someone re-adds the separate updateNextRunAt call.
		expect(updateNextRunAtCalls).toBe(0);
	});
});
