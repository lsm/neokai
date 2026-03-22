/**
 * GoalRepository V2 Mission Fields Tests
 *
 * Tests that V2 mission fields (missionType, autonomyLevel, structuredMetrics,
 * schedule, schedulePaused, nextRunAt, maxConsecutiveFailures, maxPlanningAttempts,
 * consecutiveFailures, replanCount) are correctly persisted and retrieved.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { GoalRepository } from '../../../src/storage/repositories/goal-repository';
import { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { MissionMetric, CronSchedule } from '@neokai/shared';
import type { ReactiveDatabase } from '../../../src/storage/reactive-database';

const noOpReactiveDb = {
	notifyChange: () => {},
	on: () => {},
	off: () => {},
	getTableVersion: () => 0,
	beginTransaction: () => {},
	commitTransaction: () => {},
	abortTransaction: () => {},
	db: null as never,
} as ReactiveDatabase;

describe('GoalRepository — V2 Mission fields', () => {
	let db: Database;
	let repo: GoalRepository;
	let roomId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		// createTables creates goals with all V2 columns already included in the schema
		createTables(db);

		const roomManager = new RoomManager(db);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: [{ path: '/workspace/test' }],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;
		repo = new GoalRepository(db, noOpReactiveDb);
	});

	afterEach(() => {
		db.close();
	});

	describe('createGoal with V2 params', () => {
		it('should persist missionType and autonomyLevel', () => {
			const goal = repo.createGoal({
				roomId,
				title: 'Recurring Mission',
				missionType: 'recurring',
				autonomyLevel: 'semi_autonomous',
			});

			expect(goal.missionType).toBe('recurring');
			expect(goal.autonomyLevel).toBe('semi_autonomous');

			const fetched = repo.getGoal(goal.id);
			expect(fetched?.missionType).toBe('recurring');
			expect(fetched?.autonomyLevel).toBe('semi_autonomous');
		});

		it('should persist structuredMetrics as JSON', () => {
			const metrics: MissionMetric[] = [
				{ name: 'test_coverage', target: 80, current: 60, unit: '%', direction: 'increase' },
			];
			const goal = repo.createGoal({
				roomId,
				title: 'Measurable Mission',
				structuredMetrics: metrics,
			});

			const fetched = repo.getGoal(goal.id);
			expect(fetched?.structuredMetrics).toHaveLength(1);
			expect(fetched?.structuredMetrics?.[0].name).toBe('test_coverage');
			expect(fetched?.structuredMetrics?.[0].target).toBe(80);
			expect(fetched?.structuredMetrics?.[0].direction).toBe('increase');
		});

		it('should persist schedule as JSON', () => {
			const schedule: CronSchedule = { expression: '0 9 * * *', timezone: 'UTC' };
			const goal = repo.createGoal({ roomId, title: 'Scheduled Mission', schedule });

			const fetched = repo.getGoal(goal.id);
			expect(fetched?.schedule?.expression).toBe('0 9 * * *');
			expect(fetched?.schedule?.timezone).toBe('UTC');
		});

		it('should persist schedulePaused, nextRunAt, maxConsecutiveFailures, maxPlanningAttempts', () => {
			const goal = repo.createGoal({
				roomId,
				title: 'Full V2 Mission',
				schedulePaused: true,
				nextRunAt: 1700000000000,
				maxConsecutiveFailures: 3,
				maxPlanningAttempts: 5,
			});

			const fetched = repo.getGoal(goal.id);
			expect(fetched?.schedulePaused).toBe(true);
			expect(fetched?.nextRunAt).toBe(1700000000000);
			expect(fetched?.maxConsecutiveFailures).toBe(3);
			expect(fetched?.maxPlanningAttempts).toBe(5); // explicitly set to 5
		});

		it('should persist consecutiveFailures and replanCount', () => {
			const goal = repo.createGoal({
				roomId,
				title: 'Failure Tracking Mission',
				consecutiveFailures: 2,
				replanCount: 4,
			});

			const fetched = repo.getGoal(goal.id);
			expect(fetched?.consecutiveFailures).toBe(2);
			expect(fetched?.replanCount).toBe(4);
		});

		it('should default consecutiveFailures and replanCount to 0', () => {
			const goal = repo.createGoal({ roomId, title: 'Default Mission' });

			const fetched = repo.getGoal(goal.id);
			expect(fetched?.consecutiveFailures).toBe(0);
			expect(fetched?.replanCount).toBe(0);
		});

		it('should use V2 defaults when not provided', () => {
			const goal = repo.createGoal({ roomId, title: 'Simple Goal' });

			const fetched = repo.getGoal(goal.id);
			// Non-nullable fields get their schema defaults
			expect(fetched?.missionType).toBe('one_shot');
			expect(fetched?.autonomyLevel).toBe('supervised');
			expect(fetched?.maxConsecutiveFailures).toBe(3);
			expect(fetched?.maxPlanningAttempts).toBe(0); // 0 = no per-goal override, use room config
			// Nullable fields remain undefined when not provided
			expect(fetched?.structuredMetrics).toBeUndefined();
			expect(fetched?.schedule).toBeUndefined();
			expect(fetched?.nextRunAt).toBeUndefined();
		});
	});

	describe('updateGoal with V2 params', () => {
		it('should update missionType and autonomyLevel', () => {
			const goal = repo.createGoal({ roomId, title: 'Mission' });
			// Default is 'one_shot' — override via updateGoal
			expect(goal.missionType).toBe('one_shot');

			const updated = repo.updateGoal(goal.id, {
				missionType: 'measurable',
				autonomyLevel: 'supervised',
			});

			expect(updated?.missionType).toBe('measurable');
			expect(updated?.autonomyLevel).toBe('supervised');
		});

		it('should update structuredMetrics', () => {
			const goal = repo.createGoal({ roomId, title: 'Measurable' });

			const metrics: MissionMetric[] = [
				{
					name: 'latency_p99',
					target: 100,
					current: 250,
					unit: 'ms',
					direction: 'decrease',
					baseline: 300,
				},
			];
			const updated = repo.updateGoal(goal.id, { structuredMetrics: metrics });

			expect(updated?.structuredMetrics?.[0].name).toBe('latency_p99');
			expect(updated?.structuredMetrics?.[0].baseline).toBe(300);
		});

		it('should update schedule', () => {
			const goal = repo.createGoal({ roomId, title: 'Recurring' });

			const updated = repo.updateGoal(goal.id, {
				schedule: { expression: '0 0 * * 1', timezone: 'America/New_York' },
			});

			expect(updated?.schedule?.expression).toBe('0 0 * * 1');
			expect(updated?.schedule?.timezone).toBe('America/New_York');
		});

		it('should update consecutiveFailures independently of replanCount', () => {
			const goal = repo.createGoal({ roomId, title: 'Tracking' });

			repo.updateGoal(goal.id, { replanCount: 3 });
			const afterReplan = repo.getGoal(goal.id);
			expect(afterReplan?.replanCount).toBe(3);
			expect(afterReplan?.consecutiveFailures).toBe(0);

			repo.updateGoal(goal.id, { consecutiveFailures: 1 });
			const afterFailure = repo.getGoal(goal.id);
			expect(afterFailure?.consecutiveFailures).toBe(1);
			expect(afterFailure?.replanCount).toBe(3);
		});

		it('should update schedulePaused boolean correctly', () => {
			const goal = repo.createGoal({ roomId, title: 'Paused Schedule' });

			const paused = repo.updateGoal(goal.id, { schedulePaused: true });
			expect(paused?.schedulePaused).toBe(true);

			const resumed = repo.updateGoal(goal.id, { schedulePaused: false });
			expect(resumed?.schedulePaused).toBe(false);
		});
	});

	describe('listGoals includes V2 fields', () => {
		it('should return V2 fields in list results', () => {
			repo.createGoal({
				roomId,
				title: 'Recurring',
				missionType: 'recurring',
				schedule: { expression: '0 9 * * *', timezone: 'UTC' },
			});

			const goals = repo.listGoals(roomId);
			expect(goals).toHaveLength(1);
			expect(goals[0].missionType).toBe('recurring');
			expect(goals[0].schedule?.expression).toBe('0 9 * * *');
		});
	});
});
