import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AutomationRepository } from '../../../../src/storage/repositories/automation-repository';
import { runMigration105 } from '../../../../src/storage/schema/migrations';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import { AutomationManager } from '../../../../src/lib/automation/automation-manager';

describe('AutomationRepository', () => {
	let db: Database;
	let repository: AutomationRepository;
	let changedTables: string[];

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		runMigration105(db as never);
		changedTables = [];
		const reactiveDb = {
			notifyChange(table: string) {
				changedTables.push(table);
			},
		} as Pick<ReactiveDatabase, 'notifyChange'>;
		repository = new AutomationRepository(db as never, reactiveDb as ReactiveDatabase);
	});

	afterEach(() => {
		db.close();
	});

	it('creates automation definitions with defaults and JSON config', () => {
		const automation = repository.createTask({
			ownerType: 'room',
			ownerId: 'room-1',
			title: 'Daily OKR check',
			triggerType: 'cron',
			triggerConfig: { expression: '0 9 * * *', timezone: 'UTC' },
			targetType: 'room_task',
			targetConfig: { roomId: 'room-1' },
			conditionConfig: { type: 'always' },
		});

		expect(automation.status).toBe('active');
		expect(automation.description).toBe('');
		expect(automation.concurrencyPolicy).toBe('skip');
		expect(automation.notifyPolicy).toBe('done_only');
		expect(automation.maxRetries).toBe(3);
		expect(automation.triggerConfig).toEqual({ expression: '0 9 * * *', timezone: 'UTC' });
		expect(automation.targetConfig).toEqual({ roomId: 'room-1' });
		expect(automation.conditionConfig).toEqual({ type: 'always' });
		expect(changedTables).toContain('automation_tasks');
	});

	it('requires ownerId for room and space automations', () => {
		expect(() =>
			repository.createTask({
				ownerType: 'room',
				title: 'Invalid',
				triggerType: 'manual',
				targetType: 'room_task',
			})
		).toThrow('ownerId is required');
	});

	it('lists due active automations only', () => {
		const now = Date.now();
		const due = repository.createTask({
			ownerType: 'global',
			title: 'Due',
			triggerType: 'interval',
			targetType: 'job_handler',
			nextRunAt: now - 1,
		});
		repository.createTask({
			ownerType: 'global',
			title: 'Future',
			triggerType: 'interval',
			targetType: 'job_handler',
			nextRunAt: now + 60_000,
		});
		const paused = repository.createTask({
			ownerType: 'global',
			title: 'Paused',
			status: 'paused',
			triggerType: 'interval',
			targetType: 'job_handler',
			nextRunAt: now - 1,
		});

		const dueTasks = repository.listDueTasks(now);

		expect(dueTasks.map((task) => task.id)).toEqual([due.id]);
		expect(dueTasks.map((task) => task.id)).not.toContain(paused.id);
	});

	it('creates and lists run ledger rows', () => {
		const automation = repository.createTask({
			ownerType: 'space',
			ownerId: 'space-1',
			title: 'Space workflow check',
			triggerType: 'manual',
			targetType: 'space_workflow',
		});

		const run = repository.createRun({
			automationTaskId: automation.id,
			ownerType: automation.ownerType,
			ownerId: automation.ownerId,
			triggerType: 'manual',
			triggerReason: 'user',
			metadata: { source: 'test' },
		});

		expect(run.status).toBe('queued');
		expect(run.metadata).toEqual({ source: 'test' });
		expect(repository.listRuns({ automationTaskId: automation.id })).toHaveLength(1);
		expect(changedTables).toContain('automation_runs');
	});

	it('tracks active runs and stamps terminal completion time', () => {
		const automation = repository.createTask({
			ownerType: 'global',
			title: 'Global check',
			triggerType: 'manual',
			targetType: 'neo_agent',
		});
		const run = repository.createRun({
			automationTaskId: automation.id,
			ownerType: 'global',
			triggerType: 'manual',
			status: 'running',
		});

		expect(repository.listActiveRuns(automation.id)).toHaveLength(1);

		const completed = repository.updateRun(run.id, {
			status: 'succeeded',
			resultSummary: 'OKR check completed',
		});

		expect(completed?.completedAt).not.toBeNull();
		expect(completed?.resultSummary).toBe('OKR check completed');
		expect(repository.listActiveRuns(automation.id)).toHaveLength(0);
	});

	it('manager rejects owner and target scope mismatches', () => {
		const manager = new AutomationManager(repository);

		expect(() =>
			manager.createTask({
				ownerType: 'room',
				ownerId: 'room-1',
				title: 'Bad target',
				triggerType: 'manual',
				targetType: 'space_workflow',
				targetConfig: {
					spaceId: 'space-1',
					titleTemplate: 'Run workflow',
					descriptionTemplate: 'Run the workflow',
				},
			})
		).toThrow('space targets require space-scoped automations');
	});

	it('manager rejects owner and condition scope mismatches', () => {
		const manager = new AutomationManager(repository);

		expect(() =>
			manager.createTask({
				ownerType: 'room',
				ownerId: 'room-1',
				title: 'Bad condition',
				triggerType: 'manual',
				targetType: 'room_task',
				targetConfig: {
					roomId: 'room-1',
					titleTemplate: 'Check OKR',
					descriptionTemplate: 'Check the OKR.',
				},
				conditionConfig: {
					type: 'room_goal_health',
					roomId: 'room-2',
					goalId: 'goal-1',
				},
			})
		).toThrow('Automation ownerId (room-1) must match target roomId (room-2)');
	});

	it('manager allows clearing an existing condition config', () => {
		const manager = new AutomationManager(repository);
		const automation = manager.createTask({
			ownerType: 'room',
			ownerId: 'room-1',
			title: 'Conditional automation',
			triggerType: 'manual',
			targetType: 'room_task',
			targetConfig: {
				roomId: 'room-1',
				titleTemplate: 'Check OKR',
				descriptionTemplate: 'Check the OKR.',
			},
			conditionConfig: {
				type: 'room_goal_health',
				roomId: 'room-1',
				goalId: 'goal-1',
			},
		});

		const updated = manager.updateTask(automation.id, { conditionConfig: null });

		expect(updated.conditionConfig).toBeNull();
		expect(repository.getTask(automation.id)?.conditionConfig).toBeNull();
	});

	it('manager validates typed trigger and target configs', () => {
		const manager = new AutomationManager(repository);

		expect(() =>
			manager.createTask({
				ownerType: 'global',
				title: 'Missing interval',
				triggerType: 'interval',
				targetType: 'job_handler',
				targetConfig: { queue: 'test.queue' },
			})
		).toThrow('interval trigger requires positive intervalMs');

		const automation = manager.createTask({
			ownerType: 'room',
			ownerId: 'room-1',
			title: 'Room OKR check',
			triggerType: 'interval',
			triggerConfig: { intervalMs: 60_000 },
			targetType: 'room_task',
			targetConfig: {
				roomId: 'room-1',
				titleTemplate: 'Check OKR',
				descriptionTemplate: 'Review current key results and propose next action.',
			},
			conditionConfig: { type: 'always' },
		});

		expect(automation.targetType).toBe('room_task');
	});

	it('manager validates room_mission actions', () => {
		const manager = new AutomationManager(repository);

		expect(() =>
			manager.createTask({
				ownerType: 'room',
				ownerId: 'room-1',
				title: 'Bad mission action',
				triggerType: 'manual',
				targetType: 'room_mission',
				targetConfig: {
					roomId: 'room-1',
					goalId: 'goal-1',
					action: 'delete' as never,
				},
			})
		).toThrow('room_mission target action must be one of: trigger, check');
	});
});
