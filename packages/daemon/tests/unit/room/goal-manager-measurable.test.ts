/**
 * GoalManager — Measurable Mission Tests
 *
 * Tests for structured KPI tracking and adaptive replanning:
 * - recordMetric (CRUD, legacy derivation, progress recalculation)
 * - getMetricHistory (time range, metric name filter)
 * - checkMetricTargets (increase/decrease directions)
 * - calculateMeasurableProgress (increase/decrease, edge cases)
 * - validateMetric (validation edge cases)
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';
import { GoalRepository } from '../../../src/storage/repositories/goal-repository';
import { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { MissionMetric } from '@neokai/shared';

// Inline goals table DDL matching the V2 schema (mirrors what migration 28 adds)
const GOALS_TABLE_DDL = `
	CREATE TABLE IF NOT EXISTS goals (
		id TEXT PRIMARY KEY,
		room_id TEXT NOT NULL,
		title TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'active'
			CHECK(status IN ('active', 'needs_human', 'completed', 'archived')),
		priority TEXT NOT NULL DEFAULT 'normal'
			CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
		progress INTEGER DEFAULT 0,
		linked_task_ids TEXT DEFAULT '[]',
		metrics TEXT DEFAULT '{}',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		completed_at INTEGER,
		planning_attempts INTEGER DEFAULT 0,
		goal_review_attempts INTEGER DEFAULT 0,
		mission_type TEXT NOT NULL DEFAULT 'one_shot'
			CHECK(mission_type IN ('one_shot', 'measurable', 'recurring')),
		autonomy_level TEXT NOT NULL DEFAULT 'supervised'
			CHECK(autonomy_level IN ('supervised', 'semi_autonomous')),
		structured_metrics TEXT,
		schedule TEXT,
		schedule_paused INTEGER NOT NULL DEFAULT 0,
		next_run_at INTEGER,
		max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
		max_planning_attempts INTEGER NOT NULL DEFAULT 5,
		consecutive_failures INTEGER NOT NULL DEFAULT 0,
		replan_count INTEGER NOT NULL DEFAULT 0,
		FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
	)
`;

const MISSION_METRIC_HISTORY_DDL = `
	CREATE TABLE IF NOT EXISTS mission_metric_history (
		id TEXT PRIMARY KEY,
		goal_id TEXT NOT NULL,
		metric_name TEXT NOT NULL,
		value REAL NOT NULL,
		recorded_at INTEGER NOT NULL,
		FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_mission_metric_history_lookup
		ON mission_metric_history(goal_id, metric_name, recorded_at);
`;

const MISSION_EXECUTIONS_DDL = `
	CREATE TABLE IF NOT EXISTS mission_executions (
		id TEXT PRIMARY KEY,
		goal_id TEXT NOT NULL,
		execution_number INTEGER NOT NULL,
		started_at INTEGER,
		completed_at INTEGER,
		status TEXT NOT NULL DEFAULT 'running'
			CHECK(status IN ('running', 'completed', 'failed')),
		result_summary TEXT,
		task_ids TEXT NOT NULL DEFAULT '[]',
		planning_attempts INTEGER NOT NULL DEFAULT 0,
		FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
		UNIQUE(goal_id, execution_number)
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running
		ON mission_executions(goal_id) WHERE status = 'running';
`;

describe('GoalManager — Measurable Missions', () => {
	let db: Database;
	let goalManager: GoalManager;
	let goalRepo: GoalRepository;
	let roomManager: RoomManager;
	let roomId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createTables(db);
		db.exec(GOALS_TABLE_DDL);
		db.exec(MISSION_METRIC_HISTORY_DDL);
		db.exec(MISSION_EXECUTIONS_DDL);

		roomManager = new RoomManager(db);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: [{ path: '/workspace/test' }],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;

		goalManager = new GoalManager(db, roomId);
		goalRepo = new GoalRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	// =========================================================================
	// validateMetric
	// =========================================================================

	describe('validateMetric', () => {
		it('should return null for valid increase metric', () => {
			const metric: MissionMetric = { name: 'coverage', target: 80, current: 0 };
			expect(goalManager.validateMetric(metric)).toBeNull();
		});

		it('should return null for valid decrease metric with baseline', () => {
			const metric: MissionMetric = {
				name: 'error_rate',
				target: 5,
				current: 20,
				direction: 'decrease',
				baseline: 100,
			};
			expect(goalManager.validateMetric(metric)).toBeNull();
		});

		it('should reject target <= 0 for increase direction', () => {
			const m1: MissionMetric = { name: 'm', target: 0, current: 0 };
			expect(goalManager.validateMetric(m1)).toContain('target must be > 0');

			const m2: MissionMetric = { name: 'm', target: -10, current: 0 };
			expect(goalManager.validateMetric(m2)).toContain('target must be > 0');
		});

		it('should reject missing baseline for decrease direction', () => {
			const metric: MissionMetric = {
				name: 'latency',
				target: 100,
				current: 500,
				direction: 'decrease',
			};
			expect(goalManager.validateMetric(metric)).toContain('baseline is required');
		});

		it('should reject baseline <= target for decrease direction', () => {
			const m1: MissionMetric = {
				name: 'latency',
				target: 100,
				current: 500,
				direction: 'decrease',
				baseline: 100, // baseline === target — invalid
			};
			expect(goalManager.validateMetric(m1)).toContain('baseline must be > target');

			const m2: MissionMetric = {
				name: 'latency',
				target: 100,
				current: 500,
				direction: 'decrease',
				baseline: 50, // baseline < target — invalid
			};
			expect(goalManager.validateMetric(m2)).toContain('baseline must be > target');
		});
	});

	// =========================================================================
	// calculateMeasurableProgress
	// =========================================================================

	describe('calculateMeasurableProgress', () => {
		it('should return 0 for empty metrics', () => {
			expect(goalManager.calculateMeasurableProgress([])).toBe(0);
		});

		it('should calculate increase direction: partial progress', () => {
			const metrics: MissionMetric[] = [{ name: 'coverage', target: 80, current: 40 }];
			// 40/80 = 50%
			expect(goalManager.calculateMeasurableProgress(metrics)).toBe(50);
		});

		it('should cap increase direction at 100%', () => {
			const metrics: MissionMetric[] = [{ name: 'coverage', target: 80, current: 100 }];
			// min(100/80, 1.0) * 100 = 100
			expect(goalManager.calculateMeasurableProgress(metrics)).toBe(100);
		});

		it('should calculate decrease direction correctly', () => {
			// baseline=100, target=50, current=75 → (100-75)/(100-50) = 25/50 = 50%
			const metrics: MissionMetric[] = [
				{
					name: 'error_rate',
					target: 50,
					current: 75,
					direction: 'decrease',
					baseline: 100,
				},
			];
			expect(goalManager.calculateMeasurableProgress(metrics)).toBe(50);
		});

		it('should cap decrease direction at 100%', () => {
			// current has passed target: current <= target
			// baseline=100, target=50, current=30 → (100-30)/(100-50) = 70/50 = 140% → capped at 100
			const metrics: MissionMetric[] = [
				{
					name: 'error_rate',
					target: 50,
					current: 30,
					direction: 'decrease',
					baseline: 100,
				},
			];
			expect(goalManager.calculateMeasurableProgress(metrics)).toBe(100);
		});

		it('should average multiple metrics', () => {
			const metrics: MissionMetric[] = [
				{ name: 'm1', target: 100, current: 50 }, // 50%
				{ name: 'm2', target: 100, current: 100 }, // 100%
			];
			// avg(50, 100) = 75
			expect(goalManager.calculateMeasurableProgress(metrics)).toBe(75);
		});

		it('should skip metrics with invalid target for increase direction', () => {
			const metrics: MissionMetric[] = [
				{ name: 'invalid', target: 0, current: 0 }, // skipped
				{ name: 'valid', target: 100, current: 50 }, // 50%
			];
			expect(goalManager.calculateMeasurableProgress(metrics)).toBe(50);
		});

		it('should skip decrease metrics with missing/invalid baseline', () => {
			const metrics: MissionMetric[] = [
				{ name: 'no_baseline', target: 50, current: 75, direction: 'decrease' }, // skipped
				{ name: 'valid', target: 100, current: 50 }, // 50%
			];
			expect(goalManager.calculateMeasurableProgress(metrics)).toBe(50);
		});

		it('should return 0 when all metrics are invalid', () => {
			const metrics: MissionMetric[] = [{ name: 'bad', target: 0, current: 0 }];
			expect(goalManager.calculateMeasurableProgress(metrics)).toBe(0);
		});
	});

	// =========================================================================
	// recordMetric
	// =========================================================================

	describe('recordMetric', () => {
		it('should update current value in structuredMetrics', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 0 }],
			});

			const updated = await goalManager.recordMetric(goal.id, 'coverage', 50);

			expect(updated.structuredMetrics).toBeDefined();
			const metric = updated.structuredMetrics!.find((m) => m.name === 'coverage');
			expect(metric?.current).toBe(50);
		});

		it('should insert history entry', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 0 }],
			});

			const ts = Math.floor(Date.now() / 1000);
			await goalManager.recordMetric(goal.id, 'coverage', 60, ts);

			const history = await goalManager.getMetricHistory(goal.id, 'coverage');
			expect(history).toHaveLength(1);
			expect(history[0].value).toBe(60);
			expect(history[0].recordedAt).toBe(ts);
		});

		it('should derive legacy metrics from structuredMetrics', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test Measurable',
				missionType: 'measurable',
				structuredMetrics: [
					{ name: 'coverage', target: 80, current: 0 },
					{ name: 'perf', target: 100, current: 50 },
				],
			});

			const updated = await goalManager.recordMetric(goal.id, 'coverage', 70);

			expect(updated.metrics).toEqual({ coverage: 70, perf: 50 });
		});

		it('should recalculate progress for measurable missions', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 100, current: 0 }],
			});

			const updated = await goalManager.recordMetric(goal.id, 'coverage', 75);

			// 75/100 = 75%
			expect(updated.progress).toBe(75);
		});

		it('should throw for metric name not in structuredMetrics', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 0 }],
			});

			await expect(
				goalManager.recordMetric(goal.id, 'unknown_metric', 42)
			).rejects.toThrow('not defined in structuredMetrics');
		});

		it('should throw for non-measurable goals', async () => {
			const goal = await goalManager.createGoal({
				title: 'One-Shot Goal',
				// default missionType is 'one_shot'
			});

			await expect(
				goalManager.recordMetric(goal.id, 'kpi', 42)
			).rejects.toThrow('not a measurable mission');
		});

		it('should throw for non-existent goal', async () => {
			await expect(
				goalManager.recordMetric('non-existent', 'coverage', 50)
			).rejects.toThrow('Goal not found: non-existent');
		});

		it('should accumulate multiple recordings as history', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'kpi', target: 100, current: 0 }],
			});

			const ts1 = Math.floor(Date.now() / 1000) - 100;
			const ts2 = Math.floor(Date.now() / 1000) - 50;
			const ts3 = Math.floor(Date.now() / 1000);
			await goalManager.recordMetric(goal.id, 'kpi', 10, ts1);
			await goalManager.recordMetric(goal.id, 'kpi', 30, ts2);
			await goalManager.recordMetric(goal.id, 'kpi', 60, ts3);

			const history = await goalManager.getMetricHistory(goal.id, 'kpi');
			expect(history).toHaveLength(3);
			expect(history.map((h) => h.value)).toEqual([10, 30, 60]);
		});
	});

	// =========================================================================
	// getMetricHistory
	// =========================================================================

	describe('getMetricHistory', () => {
		it('should return all history for a goal', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [
					{ name: 'a', target: 100, current: 0 },
					{ name: 'b', target: 100, current: 0 },
				],
			});

			const now = Math.floor(Date.now() / 1000);
			await goalManager.recordMetric(goal.id, 'a', 10, now - 200);
			await goalManager.recordMetric(goal.id, 'b', 20, now - 100);
			await goalManager.recordMetric(goal.id, 'a', 50, now);

			const allHistory = await goalManager.getMetricHistory(goal.id);
			expect(allHistory).toHaveLength(3);
		});

		it('should filter by metric name', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [
					{ name: 'a', target: 100, current: 0 },
					{ name: 'b', target: 100, current: 0 },
				],
			});

			const now = Math.floor(Date.now() / 1000);
			await goalManager.recordMetric(goal.id, 'a', 10, now - 200);
			await goalManager.recordMetric(goal.id, 'b', 20, now - 100);
			await goalManager.recordMetric(goal.id, 'a', 50, now);

			const aHistory = await goalManager.getMetricHistory(goal.id, 'a');
			expect(aHistory).toHaveLength(2);
			expect(aHistory.every((h) => h.metricName === 'a')).toBe(true);
		});

		it('should filter by time range', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'kpi', target: 100, current: 0 }],
			});

			const now = Math.floor(Date.now() / 1000);
			await goalManager.recordMetric(goal.id, 'kpi', 10, now - 300);
			await goalManager.recordMetric(goal.id, 'kpi', 20, now - 200);
			await goalManager.recordMetric(goal.id, 'kpi', 30, now - 100);
			await goalManager.recordMetric(goal.id, 'kpi', 40, now);

			const recent = await goalManager.getMetricHistory(goal.id, 'kpi', {
				fromTs: now - 150,
			});
			expect(recent).toHaveLength(2);
			expect(recent.map((h) => h.value)).toEqual([30, 40]);
		});

		it('should throw for non-existent goal', async () => {
			await expect(goalManager.getMetricHistory('non-existent')).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});
	});

	// =========================================================================
	// checkMetricTargets
	// =========================================================================

	describe('checkMetricTargets', () => {
		it('should return allMet=true with empty results when no structuredMetrics', async () => {
			const goal = await goalManager.createGoal({
				title: 'Legacy Goal',
			});

			const result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(true);
			expect(result.results).toHaveLength(0);
		});

		it('should detect met targets for increase direction', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 90 }],
			});

			const result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(true);
			expect(result.results[0].met).toBe(true);
		});

		it('should detect unmet targets for increase direction', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 50 }],
			});

			const result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(false);
			expect(result.results[0].met).toBe(false);
		});

		it('should detect met targets for decrease direction', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [
					{
						name: 'error_rate',
						target: 5,
						current: 3,
						direction: 'decrease',
						baseline: 50,
					},
				],
			});

			const result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(true);
			expect(result.results[0].met).toBe(true);
		});

		it('should detect unmet targets for decrease direction', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [
					{
						name: 'error_rate',
						target: 5,
						current: 20,
						direction: 'decrease',
						baseline: 50,
					},
				],
			});

			const result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(false);
			expect(result.results[0].met).toBe(false);
		});

		it('should require ALL targets met for allMet=true', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [
					{ name: 'coverage', target: 80, current: 90 }, // met
					{ name: 'perf', target: 100, current: 60 }, // not met
				],
			});

			const result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(false);
			expect(result.results.find((r) => r.name === 'coverage')?.met).toBe(true);
			expect(result.results.find((r) => r.name === 'perf')?.met).toBe(false);
		});

		it('should handle exact target equality as met for increase', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 80 }],
			});

			const result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(true);
			expect(result.results[0].met).toBe(true);
		});

		it('should handle exact target equality as met for decrease', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [
					{
						name: 'latency',
						target: 100,
						current: 100,
						direction: 'decrease',
						baseline: 500,
					},
				],
			});

			const result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(true);
			expect(result.results[0].met).toBe(true);
		});

		it('should throw for non-existent goal', async () => {
			await expect(goalManager.checkMetricTargets('non-existent')).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});

		it('should reflect updated current values after recordMetric', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 30 }],
			});

			// Initially not met
			let result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(false);

			// Record value that meets target
			await goalManager.recordMetric(goal.id, 'coverage', 85);

			result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(true);
		});
	});

	// =========================================================================
	// Legacy backward compatibility
	// =========================================================================

	describe('backward compatibility', () => {
		it('should treat goals with legacy metrics but no structuredMetrics as one-shot', async () => {
			const goal = await goalManager.createGoal({
				title: 'Legacy Goal',
			});

			// Update using raw repo to simulate old data
			goalRepo.updateGoal(goal.id, {
				metrics: { tasksCompleted: 5, totalTasks: 10 },
			});

			const retrieved = await goalManager.getGoal(goal.id);
			expect(retrieved?.missionType).toBe('one_shot');
			expect(retrieved?.structuredMetrics).toBeUndefined();

			// checkMetricTargets should return allMet with no results (no structured metrics)
			const result = await goalManager.checkMetricTargets(goal.id);
			expect(result.allMet).toBe(true);
			expect(result.results).toHaveLength(0);
		});

		it('should derive legacy metrics from structuredMetrics after recordMetric', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable Goal',
				missionType: 'measurable',
				structuredMetrics: [
					{ name: 'kpi_a', target: 100, current: 0 },
					{ name: 'kpi_b', target: 50, current: 25 },
				],
			});

			const updated = await goalManager.recordMetric(goal.id, 'kpi_a', 80);

			// Legacy metrics should be derived from structuredMetrics current values
			expect(updated.metrics).toEqual({ kpi_a: 80, kpi_b: 25 });
		});
	});

	// =========================================================================
	// Room isolation
	// =========================================================================

	describe('room isolation', () => {
		it('should not allow recording metric for goal in another room', async () => {
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const goalManager2 = new GoalManager(db, room2.id);

			const goal = await goalManager.createGoal({
				title: 'Room 1 Goal',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'kpi', target: 100, current: 0 }],
			});

			// goalManager2 operates on room2 — goal is in room1
			await expect(goalManager2.recordMetric(goal.id, 'kpi', 50)).rejects.toThrow(
				`Goal not found: ${goal.id}`
			);
		});
	});

	// =========================================================================
	// GoalManager.createGoal with V2 fields
	// =========================================================================

	describe('createGoal with structuredMetrics', () => {
		it('should persist structuredMetrics on creation', async () => {
			const metrics: MissionMetric[] = [
				{ name: 'coverage', target: 80, current: 0 },
				{ name: 'perf', target: 200, current: 0, unit: 'ms', direction: 'decrease', baseline: 1000 },
			];

			const goal = await goalManager.createGoal({
				title: 'Measurable Mission',
				missionType: 'measurable',
				structuredMetrics: metrics,
			});

			expect(goal.missionType).toBe('measurable');
			expect(goal.structuredMetrics).toBeDefined();
			expect(goal.structuredMetrics).toHaveLength(2);
			expect(goal.structuredMetrics![0].name).toBe('coverage');
			expect(goal.structuredMetrics![1].direction).toBe('decrease');
		});

		it('should start with progress=0 for new measurable mission', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable Mission',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'kpi', target: 100, current: 0 }],
			});

			expect(goal.progress).toBe(0);
		});
	});
});
