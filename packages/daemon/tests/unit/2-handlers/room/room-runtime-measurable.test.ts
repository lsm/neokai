/**
 * RoomRuntime — Measurable Mission Integration Tests
 *
 * Tests for the runtime-level orchestration of measurable missions:
 * - Auto-complete when all metric targets are met after execution tasks complete
 * - Trigger metric-context replanning when targets are not met
 * - Escalate to needs_human after exhausting max planning attempts
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { createRuntimeTestContext, type RuntimeTestContext } from './room-runtime-test-helpers';

describe('RoomRuntime — measurable missions', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	it('should auto-complete measurable goal when all metric targets are met', async () => {
		// Create a measurable goal where the target is already satisfied
		const goal = await ctx.goalManager.createGoal({
			title: 'Improve coverage',
			missionType: 'measurable',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 90 }],
		});

		const task = await ctx.taskManager.createTask({
			title: 'Write unit tests',
			description: 'Increase test coverage',
			assignedAgent: 'coder',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, task.id);
		await ctx.taskManager.updateTaskStatus(task.id, 'completed');

		ctx.runtime.start();
		await ctx.runtime.tick();

		const updated = await ctx.goalManager.getGoal(goal.id);
		expect(updated?.status).toBe('completed');
		expect(updated?.progress).toBe(100);

		// No planner session should be spawned — the goal was auto-completed
		const createCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(createCalls).toHaveLength(0);
	});

	it('should spawn a planner with metric replan context when targets are not met', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Improve coverage',
			missionType: 'measurable',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 50 }],
		});

		const task = await ctx.taskManager.createTask({
			title: 'Write unit tests',
			description: 'Increase test coverage',
			assignedAgent: 'coder',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, task.id);
		await ctx.taskManager.updateTaskStatus(task.id, 'completed');

		ctx.runtime.start();
		await ctx.runtime.tick();

		// A planner session should be spawned for the metric-based replan (+ leader eagerly)
		const createCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(createCalls).toHaveLength(2);
		const plannerCall = createCalls.find((c) => c.args[1] === 'planner');
		expect(plannerCall).toBeDefined();

		// Goal should still be active (not completed)
		const updated = await ctx.goalManager.getGoal(goal.id);
		expect(updated?.status).toBe('active');
	});

	it('should escalate to needs_human after max planning attempts for metric replan', async () => {
		// Set maxPlanningAttempts: 1 explicitly so effectiveMax = 1.
		// (GoalRepository defaults max_planning_attempts to 5 if not provided, which would
		// require 5 increments before escalation triggers.)
		const goal = await ctx.goalManager.createGoal({
			title: 'Improve coverage',
			missionType: 'measurable',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 50 }],
			maxPlanningAttempts: 1,
		});

		const task = await ctx.taskManager.createTask({
			title: 'Write unit tests',
			description: 'Increase test coverage',
			assignedAgent: 'coder',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, task.id);
		await ctx.taskManager.updateTaskStatus(task.id, 'completed');

		// Simulate that one planning attempt has already been consumed
		// (effectiveMax = 1, so attempts >= 1 triggers escalation)
		await ctx.goalManager.incrementPlanningAttempts(goal.id);

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Goal should escalate to needs_human
		const updated = await ctx.goalManager.getGoal(goal.id);
		expect(updated?.status).toBe('needs_human');

		// No new planner session should be spawned
		const createCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(createCalls).toHaveLength(0);
	});

	it('should not trigger measurable check when execution tasks are still in progress', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Improve coverage',
			missionType: 'measurable',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 50 }],
		});

		const task = await ctx.taskManager.createTask({
			title: 'Write unit tests',
			description: 'Increase test coverage',
			assignedAgent: 'coder',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, task.id);
		// Task remains pending — not completed

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Runtime should spawn a worker for the pending task, not a planner
		const createCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		// A worker + leader are spawned eagerly for the task (not a planner)
		expect(createCalls).toHaveLength(2);
		expect(createCalls[0].args[1]).not.toBe('planner');

		// Goal remains active
		const updated = await ctx.goalManager.getGoal(goal.id);
		expect(updated?.status).toBe('active');
	});

	it('should auto-complete when decrease-direction target is met', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Reduce latency',
			missionType: 'measurable',
			structuredMetrics: [
				{ name: 'latency_p99', target: 100, current: 80, direction: 'decrease', baseline: 500 },
			],
		});

		const task = await ctx.taskManager.createTask({
			title: 'Optimize DB queries',
			description: 'Reduce query time',
			assignedAgent: 'coder',
		});
		await ctx.goalManager.linkTaskToGoal(goal.id, task.id);
		await ctx.taskManager.updateTaskStatus(task.id, 'completed');

		ctx.runtime.start();
		await ctx.runtime.tick();

		// current=80 <= target=100 → met for 'decrease'
		const updated = await ctx.goalManager.getGoal(goal.id);
		expect(updated?.status).toBe('completed');
		expect(updated?.progress).toBe(100);
	});
});
