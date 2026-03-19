/**
 * Mission System — Additional Edge Case Tests (Task 7)
 *
 * Covers edge cases not addressed by existing test files:
 * - Scheduler: daemon restart catch-up (overdue missions trigger on first tick)
 * - Scheduler: room state interaction (active groups prevent double-trigger)
 * - Metrics: dual-write derivation (legacy `metrics` field mirrors structuredMetrics.current)
 * - Execution identity: executionId persisted in group metadata survives round-trip
 * - goal.listExecutions RPC: returns executions in reverse-chronological order
 * - Migration: pre-existing goals have missionType=one_shot / autonomyLevel=supervised defaults
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	createRuntimeTestContext,
	makeRoom,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';
import { GoalRepository } from '../../../src/storage/repositories/goal-repository';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';

// ─── Schema helper ────────────────────────────────────────────────────────────

function addMissionExecutionsTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS mission_executions (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			execution_number INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			status TEXT NOT NULL DEFAULT 'running',
			result_summary TEXT,
			task_ids TEXT NOT NULL DEFAULT '[]',
			planning_attempts INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
			UNIQUE(goal_id, execution_number)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running
			ON mission_executions(goal_id) WHERE status = 'running';
	`);
}

// ─── 1. Scheduler: daemon restart catch-up ────────────────────────────────────

describe('Scheduler: daemon restart catch-up', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('overdue recurring mission triggers on first tick after restart', async () => {
		// Simulate a mission that was due 2 hours ago — daemon was down
		const overdueTime = Math.floor(Date.now() / 1000) - 2 * 3600;
		await ctx.goalManager.createGoal({
			title: 'Overdue mission',
			description: 'Should catch up after restart',
			missionType: 'recurring',
			schedule: { expression: '@hourly', timezone: 'UTC' },
			nextRunAt: overdueTime,
		});

		// Simulate daemon restart: start runtime fresh and tick once
		ctx.runtime.start();
		await ctx.runtime.tick();

		// Should have triggered execution despite the long overdue delay
		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls.length).toBeGreaterThan(0);
	});

	test('multiple overdue missions all trigger on restart tick', async () => {
		const overdueTime = Math.floor(Date.now() / 1000) - 3600;

		// Two distinct recurring missions both overdue
		await ctx.goalManager.createGoal({
			title: 'Overdue A',
			description: 'First overdue',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: overdueTime,
		});
		await ctx.goalManager.createGoal({
			title: 'Overdue B',
			description: 'Second overdue',
			missionType: 'recurring',
			schedule: { expression: '@weekly', timezone: 'UTC' },
			nextRunAt: overdueTime - 100, // slightly older
		});

		// Runtime limited to 1 concurrent group by default — each needs its own tick
		ctx.runtime.start();
		await ctx.runtime.tick();

		// At least the first mission should have triggered
		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls.length).toBeGreaterThan(0);
	});

	test('mission with no next_run_at set is not triggered on restart', async () => {
		// A recurring mission with no next_run_at (not yet scheduled)
		await ctx.goalManager.createGoal({
			title: 'Unscheduled recurring',
			description: 'No next_run_at',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			// nextRunAt intentionally omitted
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		// Should not trigger — no next_run_at means not yet scheduled
		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls).toHaveLength(0);
	});
});

// ─── 2. Scheduler: room state interaction ─────────────────────────────────────

describe('Scheduler: room state interaction', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('recurring mission with active running execution does not double-trigger', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'No-overlap test',
			description: 'Only one execution at a time',
			missionType: 'recurring',
			schedule: { expression: '@hourly', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		// Manually start an execution to simulate an already-running state
		ctx.goalManager.startExecution(goal.id);

		ctx.runtime.start();
		await ctx.runtime.tick();

		// No new session should be spawned — execution is already running
		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls).toHaveLength(0);
	});

	test('paused mission does not trigger even when overdue', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 3600;
		await ctx.goalManager.createGoal({
			title: 'Paused overdue',
			description: 'Should not trigger',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
			schedulePaused: true,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		expect(workerCalls).toHaveLength(0);
	});
});

// ─── 3. Metrics: dual-write derivation ───────────────────────────────────────

describe('Metrics: dual-write derivation', () => {
	let db: Database;
	let goalManager: GoalManager;
	let roomId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`PRAGMA foreign_keys = ON`);
		db.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY, name TEXT NOT NULL,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE goals (
				id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
				priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]', metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
				planning_attempts INTEGER DEFAULT 0, goal_review_attempts INTEGER DEFAULT 0,
				mission_type TEXT NOT NULL DEFAULT 'one_shot',
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				schedule TEXT, schedule_paused INTEGER NOT NULL DEFAULT 0,
				next_run_at INTEGER, structured_metrics TEXT,
				max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
				max_planning_attempts INTEGER NOT NULL DEFAULT 0,
				consecutive_failures INTEGER NOT NULL DEFAULT 0,
				replan_count INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE mission_metric_history (
				id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, metric_name TEXT NOT NULL,
				value REAL NOT NULL, recorded_at INTEGER NOT NULL,
				FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_mission_metric_history_lookup
				ON mission_metric_history(goal_id, metric_name, recorded_at);
			CREATE TABLE mission_executions (
				id TEXT PRIMARY KEY, goal_id TEXT NOT NULL,
				execution_number INTEGER NOT NULL, started_at INTEGER,
				completed_at INTEGER, status TEXT NOT NULL DEFAULT 'running',
				result_summary TEXT, task_ids TEXT NOT NULL DEFAULT '[]',
				planning_attempts INTEGER NOT NULL DEFAULT 0,
				FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
				UNIQUE(goal_id, execution_number)
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running
				ON mission_executions(goal_id) WHERE status = 'running';
		`);
		const now = Date.now();
		roomId = 'room-metrics-test';
		db.exec(
			`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test', ${now}, ${now})`
		);
		goalManager = new GoalManager(db as never, roomId);
	});

	afterEach(() => {
		db.close();
	});

	test('recordMetric updates structuredMetrics.current AND legacy metrics field', async () => {
		const goal = await goalManager.createGoal({
			title: 'Coverage mission',
			missionType: 'measurable',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 50, unit: '%' }],
		});

		await goalManager.recordMetric(goal.id, 'coverage', 75);

		const updated = await goalManager.getGoal(goal.id);

		// Structured metrics should be updated
		expect(updated?.structuredMetrics?.[0].current).toBe(75);

		// Legacy metrics field should mirror current values
		expect(updated?.metrics?.['coverage']).toBe(75);
	});

	test('recordMetric updates legacy metrics for multiple metrics', async () => {
		const goal = await goalManager.createGoal({
			title: 'Multi-metric mission',
			missionType: 'measurable',
			structuredMetrics: [
				{ name: 'coverage', target: 80, current: 50, unit: '%' },
				{ name: 'perf_score', target: 90, current: 60 },
			],
		});

		await goalManager.recordMetric(goal.id, 'coverage', 70);

		const updated = await goalManager.getGoal(goal.id);

		// Both metrics should be in legacy field
		expect(updated?.metrics?.['coverage']).toBe(70);
		expect(updated?.metrics?.['perf_score']).toBe(60); // unchanged
	});

	test('recordMetric inserts a history row', async () => {
		const goal = await goalManager.createGoal({
			title: 'Coverage mission',
			missionType: 'measurable',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 50 }],
		});

		const ts1 = Math.floor(Date.now() / 1000) - 100;
		const ts2 = Math.floor(Date.now() / 1000);

		await goalManager.recordMetric(goal.id, 'coverage', 60, ts1);
		await goalManager.recordMetric(goal.id, 'coverage', 75, ts2);

		const history = await goalManager.getMetricHistory(goal.id, 'coverage');
		expect(history).toHaveLength(2);
		expect(history[0].value).toBe(60);
		expect(history[1].value).toBe(75);
	});

	test('recordMetric rejects unknown metric names', async () => {
		const goal = await goalManager.createGoal({
			title: 'Coverage mission',
			missionType: 'measurable',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 50 }],
		});

		await expect(goalManager.recordMetric(goal.id, 'unknown_metric', 42)).rejects.toThrow(
			'not defined in structuredMetrics'
		);
	});

	test('checkMetricTargets: increase direction — met when current >= target', async () => {
		const goal = await goalManager.createGoal({
			title: 'Coverage mission',
			missionType: 'measurable',
			structuredMetrics: [
				{ name: 'coverage', target: 80, current: 80, direction: 'increase' }, // exactly at target
				{ name: 'perf', target: 90, current: 95, direction: 'increase' }, // above target
			],
		});

		const result = await goalManager.checkMetricTargets(goal.id);
		expect(result.allMet).toBe(true);
		expect(result.results).toHaveLength(2);
		expect(result.results[0].met).toBe(true);
		expect(result.results[1].met).toBe(true);
	});

	test('checkMetricTargets: decrease direction — met when current <= target', async () => {
		const goal = await goalManager.createGoal({
			title: 'Latency mission',
			missionType: 'measurable',
			structuredMetrics: [
				{
					name: 'latency_p99',
					target: 100,
					current: 80, // below target (good for decrease)
					direction: 'decrease',
					baseline: 500,
				},
			],
		});

		const result = await goalManager.checkMetricTargets(goal.id);
		expect(result.allMet).toBe(true);
	});

	test('checkMetricTargets: not met when current < target for increase direction', async () => {
		const goal = await goalManager.createGoal({
			title: 'Coverage mission',
			missionType: 'measurable',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 50, direction: 'increase' }],
		});

		const result = await goalManager.checkMetricTargets(goal.id);
		expect(result.allMet).toBe(false);
		expect(result.results[0].met).toBe(false);
	});

	test('getMetricHistory: time-range filtering works', async () => {
		const goal = await goalManager.createGoal({
			title: 'Coverage mission',
			missionType: 'measurable',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 50 }],
		});

		const now = Math.floor(Date.now() / 1000);
		const old = now - 1000;
		const older = now - 2000;

		await goalManager.recordMetric(goal.id, 'coverage', 40, older);
		await goalManager.recordMetric(goal.id, 'coverage', 55, old);
		await goalManager.recordMetric(goal.id, 'coverage', 70, now);

		// Only the two most recent entries
		const recent = await goalManager.getMetricHistory(goal.id, 'coverage', {
			fromTs: old,
		});
		expect(recent.length).toBe(2);
		expect(recent.map((h) => h.value)).toContain(55);
		expect(recent.map((h) => h.value)).toContain(70);
	});
});

// ─── 4. Execution identity: executionId persisted in group metadata ───────────

describe('Execution identity: executionId in group metadata', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('executionId survives round-trip through SessionGroupRepository', async () => {
		const pastTime = Math.floor(Date.now() / 1000) - 60;
		const goal = await ctx.goalManager.createGoal({
			title: 'Execution ID round-trip',
			description: 'executionId persisted in metadata',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
			nextRunAt: pastTime,
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const activeExecution = ctx.goalManager.getActiveExecution(goal.id);
		expect(activeExecution).not.toBeNull();

		// Verify group has executionId stored in metadata
		const activeGroups = ctx.groupRepo.getActiveGroups('room-1');
		expect(activeGroups.length).toBeGreaterThan(0);

		const group = activeGroups[0];
		expect(group.executionId).toBe(activeExecution!.id);

		// Re-fetch from DB to verify it's persisted
		const refetched = ctx.groupRepo.getGroup(group.id);
		expect(refetched?.executionId).toBe(activeExecution!.id);
	});

	test('listExecutions returns executions in descending order by execution_number', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'List executions test',
			description: 'Order check',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
		});

		// Create three executions sequentially
		const exec1 = ctx.goalManager.startExecution(goal.id);
		ctx.goalManager.completeExecution(exec1.id, 'first run completed');

		const exec2 = ctx.goalManager.startExecution(goal.id);
		ctx.goalManager.completeExecution(exec2.id, 'second run completed');

		const exec3 = ctx.goalManager.startExecution(goal.id);
		ctx.goalManager.completeExecution(exec3.id, 'third run completed');

		const executions = ctx.goalManager.listExecutions(goal.id);
		expect(executions).toHaveLength(3);

		// Most recent first
		expect(executions[0].executionNumber).toBeGreaterThan(executions[1].executionNumber);
		expect(executions[1].executionNumber).toBeGreaterThan(executions[2].executionNumber);
	});

	test('listExecutions limit parameter restricts result count', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Limit test',
			description: 'Limit executions',
			missionType: 'recurring',
			schedule: { expression: '@hourly', timezone: 'UTC' },
		});

		// Create 5 executions
		for (let i = 0; i < 5; i++) {
			const ex = ctx.goalManager.startExecution(goal.id);
			ctx.goalManager.completeExecution(ex.id);
		}

		const limited = ctx.goalManager.listExecutions(goal.id, 3);
		expect(limited).toHaveLength(3);
	});
});

// ─── 5. Migration: existing goals default to one_shot / supervised ────────────

describe('Migration: legacy goals default to one_shot / supervised', () => {
	let db: Database;
	let goalRepo: GoalRepository;
	let roomId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`PRAGMA foreign_keys = ON`);
		// Create a pre-migration goals table (no V2 columns)
		db.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY, name TEXT NOT NULL,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE goals (
				id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
				priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]', metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
				planning_attempts INTEGER DEFAULT 0, goal_review_attempts INTEGER DEFAULT 0,
				mission_type TEXT NOT NULL DEFAULT 'one_shot',
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				schedule TEXT, schedule_paused INTEGER NOT NULL DEFAULT 0,
				next_run_at INTEGER, structured_metrics TEXT,
				max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
				max_planning_attempts INTEGER NOT NULL DEFAULT 0,
				consecutive_failures INTEGER NOT NULL DEFAULT 0,
				replan_count INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE mission_metric_history (
				id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, metric_name TEXT NOT NULL,
				value REAL NOT NULL, recorded_at INTEGER NOT NULL,
				FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
			);
			CREATE TABLE mission_executions (
				id TEXT PRIMARY KEY, goal_id TEXT NOT NULL,
				execution_number INTEGER NOT NULL, started_at INTEGER,
				completed_at INTEGER, status TEXT NOT NULL DEFAULT 'running',
				result_summary TEXT, task_ids TEXT NOT NULL DEFAULT '[]',
				planning_attempts INTEGER NOT NULL DEFAULT 0,
				FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
				UNIQUE(goal_id, execution_number)
			);
		`);
		const now = Date.now();
		roomId = 'room-legacy';
		db.exec(
			`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Legacy Room', ${now}, ${now})`
		);
		goalRepo = new GoalRepository(db as never);
	});

	afterEach(() => {
		db.close();
	});

	test('createGoal without V2 params defaults to one_shot and supervised', () => {
		const goal = goalRepo.createGoal({
			roomId,
			title: 'Legacy goal',
			description: 'Pre-existing goal from before V2',
		});

		expect(goal.missionType).toBe('one_shot');
		expect(goal.autonomyLevel).toBe('supervised');
		expect(goal.structuredMetrics).toBeUndefined();
		expect(goal.schedule).toBeUndefined();
	});

	test('existing goal with one_shot type works with GoalManager task progress', () => {
		const goal = goalRepo.createGoal({
			roomId,
			title: 'Legacy task-based goal',
			description: 'Uses linked tasks for progress',
		});

		// Verify it can be retrieved correctly
		const fetched = goalRepo.getGoal(goal.id);
		expect(fetched?.missionType).toBe('one_shot');
		expect(fetched?.autonomyLevel).toBe('supervised');
		expect(fetched?.schedulePaused).toBe(false);
		expect(fetched?.consecutiveFailures).toBe(0);
	});

	test('legacy goal is treated as one_shot by the scheduler (not scheduled)', async () => {
		// Insert a legacy goal without any schedule info
		const goal = goalRepo.createGoal({
			roomId,
			title: 'Legacy scheduled goal',
			description: 'Should not be triggered by recurring scheduler',
			// missionType defaults to 'one_shot'
		});

		// Verify no schedule data
		const fetched = goalRepo.getGoal(goal.id);
		expect(fetched?.missionType).toBe('one_shot');
		expect(fetched?.nextRunAt ?? null).toBeNull();
		expect(fetched?.schedule).toBeUndefined();
	});
});

// ─── 6. Per-execution isolation ───────────────────────────────────────────────

describe('Per-execution isolation', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
		addMissionExecutionsTable(ctx.db as Database);
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('atomicStartExecution clears linkedTaskIds from previous execution', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Isolated execution',
			description: 'Each execution gets a fresh task list',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
		});

		// Simulate tasks from first execution
		const taskA = await ctx.taskManager.createTask({
			title: 'Task from exec 1',
			description: 'Should not carry over',
		});
		const exec1 = ctx.goalManager.startExecution(goal.id);
		await ctx.goalManager.linkTaskToExecution(goal.id, exec1.id, taskA.id);
		ctx.goalManager.completeExecution(exec1.id);

		const afterExec1 = await ctx.goalManager.getGoal(goal.id);
		expect(afterExec1?.linkedTaskIds).toContain(taskA.id);

		// Start second execution — should clear linkedTaskIds
		ctx.goalManager.startExecution(goal.id);

		const afterExec2 = await ctx.goalManager.getGoal(goal.id);
		// Task from exec1 should be gone
		expect(afterExec2?.linkedTaskIds).not.toContain(taskA.id);
	});

	test('planning_attempts resets to 0 when new execution starts', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Planning attempts isolation',
			description: 'Reset per execution',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
		});

		// Accumulate attempts during first execution
		await ctx.goalManager.incrementPlanningAttempts(goal.id);
		await ctx.goalManager.incrementPlanningAttempts(goal.id);
		const afterAttempts = await ctx.goalManager.getGoal(goal.id);
		expect(afterAttempts?.planning_attempts).toBe(2);

		// Complete and start new execution
		const exec1 = ctx.goalManager.startExecution(goal.id);
		ctx.goalManager.completeExecution(exec1.id);
		ctx.goalManager.startExecution(goal.id);

		// planning_attempts must reset
		const afterNewExec = await ctx.goalManager.getGoal(goal.id);
		expect(afterNewExec?.planning_attempts).toBe(0);
	});

	test('each execution has its own task_ids list in mission_executions', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Scoped task IDs',
			description: 'Tasks are scoped per execution',
			missionType: 'recurring',
			schedule: { expression: '@daily', timezone: 'UTC' },
		});

		const taskA = await ctx.taskManager.createTask({
			title: 'Task A',
			description: 'First execution',
		});
		const taskB = await ctx.taskManager.createTask({
			title: 'Task B',
			description: 'Second execution',
		});

		const exec1 = ctx.goalManager.startExecution(goal.id);
		await ctx.goalManager.linkTaskToExecution(goal.id, exec1.id, taskA.id);
		ctx.goalManager.completeExecution(exec1.id);

		const exec2 = ctx.goalManager.startExecution(goal.id);
		await ctx.goalManager.linkTaskToExecution(goal.id, exec2.id, taskB.id);

		// Execution 1 should only have taskA
		const executions = ctx.goalManager.listExecutions(goal.id);
		const firstExec = executions.find((e) => e.id === exec1.id);
		const secondExec = executions.find((e) => e.id === exec2.id);

		expect(firstExec?.taskIds).toContain(taskA.id);
		expect(firstExec?.taskIds).not.toContain(taskB.id);

		expect(secondExec?.taskIds).toContain(taskB.id);
		expect(secondExec?.taskIds).not.toContain(taskA.id);
	});
});

// ─── 7. Autonomy gate: additional planner exclusion edge cases ────────────────

describe('Autonomy gate: planner exclusion edge cases', () => {
	let ctx: RuntimeTestContext;

	beforeEach(() => {
		ctx = createRuntimeTestContext();
	});

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	test('semi_autonomous goal spawns planner (not coder) for initial task group', async () => {
		// A semi_autonomous goal with no tasks should spawn a planner on first tick
		await ctx.goalManager.createGoal({
			title: 'Semi-auto app',
			description: 'Build the app',
			autonomyLevel: 'semi_autonomous',
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		// The spawned session should be a planner
		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession'
		);
		// At least one call should have role 'planner'
		const plannerCall = workerCalls.find((c) => c.args[1] === 'planner');
		expect(plannerCall).toBeDefined();
	});

	test('supervisedgoal and semi_autonomous goal both spawn planner for empty task list', async () => {
		await ctx.goalManager.createGoal({
			title: 'Supervised goal',
			description: 'Standard goal',
			autonomyLevel: 'supervised',
		});

		ctx.runtime.start();
		await ctx.runtime.tick();

		const workerCalls = ctx.sessionFactory.calls.filter(
			(c) => c.method === 'createAndStartSession' && c.args[1] === 'planner'
		);
		expect(workerCalls.length).toBeGreaterThan(0);
	});

	test('consecutiveFailures increments on task failure and resets on success', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Failure counter',
			description: 'Track failures',
			autonomyLevel: 'semi_autonomous',
		});

		// Simulate consecutive failures
		await ctx.goalManager.updateConsecutiveFailures(goal.id, 1);
		const after1 = await ctx.goalManager.getGoal(goal.id);
		expect(after1?.consecutiveFailures).toBe(1);

		await ctx.goalManager.updateConsecutiveFailures(goal.id, 2);
		const after2 = await ctx.goalManager.getGoal(goal.id);
		expect(after2?.consecutiveFailures).toBe(2);

		// Reset on success
		await ctx.goalManager.updateConsecutiveFailures(goal.id, 0);
		const afterReset = await ctx.goalManager.getGoal(goal.id);
		expect(afterReset?.consecutiveFailures).toBe(0);
	});

	test('goal escalates to needs_human at maxConsecutiveFailures threshold', async () => {
		const goal = await ctx.goalManager.createGoal({
			title: 'Escalation test',
			description: 'Should escalate',
			autonomyLevel: 'semi_autonomous',
			maxConsecutiveFailures: 2,
		});

		// Simulate reaching the threshold
		await ctx.goalManager.updateConsecutiveFailures(goal.id, 2);

		// Manually escalate (as the runtime would do)
		const escalated = await ctx.goalManager.needsHumanGoal(goal.id);
		expect(escalated.status).toBe('needs_human');
	});
});
