/**
 * Measurable Mission — MCP Tools and Planner Context Tests
 *
 * Tests for:
 * - record_metric and get_metrics room agent tools
 * - buildPlannerTaskMessage metric context injection
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';
import { TaskManager } from '../../../src/lib/room/managers/task-manager';
import { RoomManager } from '../../../src/lib/room/managers/room-manager';
import { createRoomAgentToolHandlers } from '../../../src/lib/room/tools/room-agent-tools';
import { buildPlannerTaskMessage } from '../../../src/lib/room/agents/planner-agent';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';
import type { ReplanContext } from '../../../src/lib/room/agents/planner-agent';

// Inline goals/metric tables DDL (same as in goal-manager-measurable.test.ts)
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
		status TEXT NOT NULL DEFAULT 'running',
		result_summary TEXT,
		task_ids TEXT NOT NULL DEFAULT '[]',
		planning_attempts INTEGER NOT NULL DEFAULT 0,
		FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
		UNIQUE(goal_id, execution_number)
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running
		ON mission_executions(goal_id) WHERE status = 'running';
`;

function makeRoom(id: string): Room {
	return {
		id,
		name: 'Test Room',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	} as Room;
}

function makeTask(id: string): NeoTask {
	return {
		id,
		roomId: 'room1',
		title: 'Test Task',
		description: '',
		status: 'pending',
		progress: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	} as NeoTask;
}

describe('Measurable Mission — Tools', () => {
	let db: Database;
	let goalManager: GoalManager;
	let taskManager: TaskManager;
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
		taskManager = new TaskManager(db, roomId);
	});

	afterEach(() => {
		db.close();
	});

	function makeHandlers() {
		return createRoomAgentToolHandlers({
			roomId,
			goalManager,
			taskManager,
			groupRepo: {
				getActiveGroups: () => [],
				getGroupByTaskId: () => null,
				resetGroupForRestart: () => null,
				reviveGroup: () => null,
			} as unknown as Parameters<typeof createRoomAgentToolHandlers>[0]['groupRepo'],
		});
	}

	// =========================================================================
	// record_metric tool
	// =========================================================================

	describe('record_metric tool', () => {
		it('should reject non-measurable goals', async () => {
			const goal = await goalManager.createGoal({ title: 'One-Shot Goal' });
			const handlers = makeHandlers();
			const result = await handlers.record_metric({
				goal_id: goal.id,
				metric_name: 'kpi',
				value: 42,
			});
			const body = JSON.parse(result.content[0].text);
			expect(body.success).toBe(false);
			expect(body.error).toContain('not a measurable mission');
		});

		it('should reject non-existent goal', async () => {
			const handlers = makeHandlers();
			const result = await handlers.record_metric({
				goal_id: 'non-existent',
				metric_name: 'kpi',
				value: 42,
			});
			const body = JSON.parse(result.content[0].text);
			expect(body.success).toBe(false);
			expect(body.error).toContain('not found');
		});

		it('should record metric for measurable goal', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable Goal',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 0 }],
			});

			const handlers = makeHandlers();
			const result = await handlers.record_metric({
				goal_id: goal.id,
				metric_name: 'coverage',
				value: 60,
			});

			const body = JSON.parse(result.content[0].text);
			expect(body.success).toBe(true);
			expect(body.metric.name).toBe('coverage');
			expect(body.metric.value).toBe(60);
			// progress = 60/80 = 75%
			expect(body.metric.goalProgress).toBe(75);
		});

		it('should update structuredMetrics current in DB', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable Goal',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 100, current: 0 }],
			});

			const handlers = makeHandlers();
			await handlers.record_metric({ goal_id: goal.id, metric_name: 'coverage', value: 75 });

			const updated = await goalManager.getGoal(goal.id);
			expect(updated?.structuredMetrics?.[0].current).toBe(75);
		});
	});

	// =========================================================================
	// get_metrics tool
	// =========================================================================

	describe('get_metrics tool', () => {
		it('should return empty metrics for goal with no structuredMetrics', async () => {
			const goal = await goalManager.createGoal({ title: 'Legacy Goal' });
			const handlers = makeHandlers();

			const result = await handlers.get_metrics({ goal_id: goal.id });
			const body = JSON.parse(result.content[0].text);
			expect(body.success).toBe(true);
			expect(body.structuredMetrics).toHaveLength(0);
		});

		it('should return metric state for measurable goal', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable Goal',
				missionType: 'measurable',
				structuredMetrics: [
					{ name: 'coverage', target: 80, current: 50 },
					{ name: 'perf', target: 200, current: 300, direction: 'decrease', baseline: 1000 },
				],
			});

			const handlers = makeHandlers();
			const result = await handlers.get_metrics({ goal_id: goal.id });
			const body = JSON.parse(result.content[0].text);

			expect(body.success).toBe(true);
			expect(body.missionType).toBe('measurable');
			expect(body.metrics).toHaveLength(2);

			const coverage = body.metrics.find((m: { name: string }) => m.name === 'coverage');
			expect(coverage.current).toBe(50);
			expect(coverage.target).toBe(80);
			expect(coverage.met).toBe(false);
			expect(coverage.direction).toBe('increase');

			const perf = body.metrics.find((m: { name: string }) => m.name === 'perf');
			expect(perf.direction).toBe('decrease');
			expect(perf.baseline).toBe(1000);
		});

		it('should report allTargetsMet=true when all met', async () => {
			const goal = await goalManager.createGoal({
				title: 'Measurable Goal',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 90 }],
			});

			const handlers = makeHandlers();
			const result = await handlers.get_metrics({ goal_id: goal.id });
			const body = JSON.parse(result.content[0].text);

			expect(body.allTargetsMet).toBe(true);
		});

		it('should return error for non-existent goal', async () => {
			const handlers = makeHandlers();
			const result = await handlers.get_metrics({ goal_id: 'non-existent' });
			const body = JSON.parse(result.content[0].text);
			expect(body.success).toBe(false);
		});
	});
});

// =========================================================================
// buildPlannerTaskMessage — metric context
// =========================================================================

describe('buildPlannerTaskMessage — metric context', () => {
	const baseGoal: RoomGoal = {
		id: 'goal1',
		roomId: 'room1',
		title: 'Improve System Performance',
		description: 'Reduce latency and increase test coverage',
		status: 'active',
		priority: 'normal',
		progress: 30,
		linkedTaskIds: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		missionType: 'measurable',
		structuredMetrics: [
			{ name: 'coverage', target: 80, current: 50, direction: 'increase' },
			{ name: 'latency_p99', target: 100, current: 250, direction: 'decrease', baseline: 500 },
		],
	};

	const baseRoom: Room = {
		id: 'room1',
		name: 'Test Room',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	} as Room;

	const baseTask: NeoTask = makeTask('task1');

	const baseConfig = {
		task: baseTask,
		goal: baseGoal,
		room: baseRoom,
		sessionId: 'session1',
		workspacePath: '/workspace',
		createDraftTask: async () => ({ id: 'draft1', title: 'draft' }),
		updateDraftTask: async () => ({ id: 'draft1', title: 'draft' }),
		removeDraftTask: async () => true,
	};

	it('should not include metric section without replanContext', () => {
		const msg = buildPlannerTaskMessage(baseConfig);
		expect(msg).not.toContain('Metric Targets');
	});

	it('should include metric section when metricContext is provided', () => {
		const rc: ReplanContext = {
			completedTasks: [{ title: 'Task A', result: 'done' }],
			failedTask: { title: 'Metric targets not met', error: 'coverage not met' },
			attempt: 2,
			metricContext: {
				metrics: [
					{
						name: 'coverage',
						current: 50,
						target: 80,
						direction: 'increase',
						met: false,
						recentHistory: [30, 40, 50],
					},
					{
						name: 'latency_p99',
						current: 250,
						target: 100,
						direction: 'decrease',
						baseline: 500,
						met: false,
						recentHistory: [450, 350, 250],
					},
				],
			},
		};

		const msg = buildPlannerTaskMessage({ ...baseConfig, replanContext: rc });

		expect(msg).toContain('Metric Targets');
		expect(msg).toContain('coverage');
		expect(msg).toContain('current=50');
		expect(msg).toContain('target=80');
		expect(msg).toContain('[NOT MET]');
		expect(msg).toContain('latency_p99');
		expect(msg).toContain('baseline=500');
		expect(msg).toContain('30 → 40 → 50');
	});

	it('should mark met metrics as MET', () => {
		const rc: ReplanContext = {
			completedTasks: [],
			failedTask: { title: 'Metric targets not met', error: 'some not met' },
			attempt: 1,
			metricContext: {
				metrics: [
					{
						name: 'coverage',
						current: 90,
						target: 80,
						direction: 'increase',
						met: true,
					},
				],
			},
		};

		const msg = buildPlannerTaskMessage({ ...baseConfig, replanContext: rc });
		expect(msg).toContain('[MET]');
		expect(msg).not.toContain('[NOT MET]');
	});

	it('should handle replanContext without metricContext (backward compat)', () => {
		const rc: ReplanContext = {
			completedTasks: [{ title: 'Task A', result: 'done' }],
			failedTask: { title: 'Task B', error: 'build failed' },
			attempt: 2,
		};

		const msg = buildPlannerTaskMessage({ ...baseConfig, replanContext: rc });
		expect(msg).toContain('Replanning Context');
		expect(msg).toContain('Task B');
		expect(msg).not.toContain('Metric Targets');
	});

	it('should include attempt number in replanning context', () => {
		const rc: ReplanContext = {
			completedTasks: [],
			failedTask: { title: 'Failed Task', error: 'error' },
			attempt: 3,
		};

		const msg = buildPlannerTaskMessage({ ...baseConfig, replanContext: rc });
		expect(msg).toContain('Attempt 3');
	});
});
