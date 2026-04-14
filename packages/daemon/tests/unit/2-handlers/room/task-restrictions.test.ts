/**
 * Tests for task restriction persistence and rate/usage limit status.
 *
 * Verifies:
 * - rate_limited / usage_limited task statuses
 * - restrictions field persisted on task record
 * - VALID_STATUS_TRANSITIONS include new statuses
 * - TaskManager.setTaskStatus clears restrictions when resuming
 * - Migration 49 adds restrictions column and expands status CHECK constraint
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables, runMigration49 } from '../../../../src/storage/schema';
import {
	TaskManager,
	VALID_STATUS_TRANSITIONS,
	isValidStatusTransition,
} from '../../../../src/lib/room/managers/task-manager';
import { RoomManager } from '../../../../src/lib/room/managers/room-manager';
import { noOpReactiveDb } from '../../../helpers/reactive-database';
import type { TaskRestriction } from '@neokai/shared';

describe('Task restrictions (rate_limited / usage_limited)', () => {
	let db: Database;
	let taskManager: TaskManager;
	let roomId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createTables(db);

		const roomManager = new RoomManager(db, noOpReactiveDb);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: [{ path: '/workspace/test' }],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;
		taskManager = new TaskManager(db, roomId, noOpReactiveDb);
	});

	afterEach(() => {
		db.close();
	});

	// ─── Status transitions ────────────────────────────────────────────────────

	describe('VALID_STATUS_TRANSITIONS', () => {
		it('allows in_progress → rate_limited', () => {
			expect(isValidStatusTransition('in_progress', 'rate_limited')).toBe(true);
		});

		it('allows in_progress → usage_limited', () => {
			expect(isValidStatusTransition('in_progress', 'usage_limited')).toBe(true);
		});

		it('allows rate_limited → in_progress (resume)', () => {
			expect(isValidStatusTransition('rate_limited', 'in_progress')).toBe(true);
		});

		it('allows usage_limited → in_progress (resume)', () => {
			expect(isValidStatusTransition('usage_limited', 'in_progress')).toBe(true);
		});

		it('allows rate_limited → needs_attention', () => {
			expect(isValidStatusTransition('rate_limited', 'needs_attention')).toBe(true);
		});

		it('allows usage_limited → cancelled', () => {
			expect(isValidStatusTransition('usage_limited', 'cancelled')).toBe(true);
		});

		it('rejects pending → rate_limited directly', () => {
			expect(isValidStatusTransition('pending', 'rate_limited')).toBe(false);
		});

		it('includes rate_limited and usage_limited in transition map', () => {
			expect(VALID_STATUS_TRANSITIONS).toHaveProperty('rate_limited');
			expect(VALID_STATUS_TRANSITIONS).toHaveProperty('usage_limited');
		});
	});

	// ─── Persistence ──────────────────────────────────────────────────────────

	describe('restrictions field persistence', () => {
		it('persists restrictions when transitioning to rate_limited', async () => {
			const task = await taskManager.createTask({
				title: 'Test task',
				description: 'desc',
			});
			// Manually start the task
			await taskManager.updateTaskStatus(task.id, 'in_progress');

			const restriction: TaskRestriction = {
				type: 'rate_limit',
				limit: 'API rate limit (HTTP 429)',
				resetAt: Date.now() + 3600_000,
				sessionRole: 'worker',
			};

			const updated = await taskManager.updateTaskStatus(task.id, 'rate_limited', {
				restrictions: restriction,
			});

			expect(updated.status).toBe('rate_limited');
			expect(updated.restrictions).toBeDefined();
			expect(updated.restrictions!.type).toBe('rate_limit');
			expect(updated.restrictions!.sessionRole).toBe('worker');
			expect(updated.restrictions!.resetAt).toBeGreaterThan(Date.now());
		});

		it('persists restrictions when transitioning to usage_limited', async () => {
			const task = await taskManager.createTask({
				title: 'Test task',
				description: 'desc',
			});
			await taskManager.updateTaskStatus(task.id, 'in_progress');

			const restriction: TaskRestriction = {
				type: 'usage_limit',
				limit: 'Daily/weekly usage cap',
				resetAt: Date.now() + 7200_000,
				sessionRole: 'leader',
			};

			const updated = await taskManager.updateTaskStatus(task.id, 'usage_limited', {
				restrictions: restriction,
			});

			expect(updated.status).toBe('usage_limited');
			expect(updated.restrictions!.type).toBe('usage_limit');
			expect(updated.restrictions!.sessionRole).toBe('leader');
		});

		it('restrictions survive a roundtrip through the database', async () => {
			const task = await taskManager.createTask({
				title: 'Test task',
				description: 'desc',
			});
			await taskManager.updateTaskStatus(task.id, 'in_progress');

			const resetAt = Date.now() + 3600_000;
			const restriction: TaskRestriction = {
				type: 'rate_limit',
				limit: 'API rate limit (HTTP 429)',
				resetAt,
				sessionRole: 'worker',
				retryAfter: 60,
			};

			await taskManager.updateTaskStatus(task.id, 'rate_limited', {
				restrictions: restriction,
			});

			// Re-fetch from DB
			const fetched = await taskManager.getTask(task.id);
			expect(fetched!.restrictions).toBeDefined();
			expect(fetched!.restrictions!.type).toBe('rate_limit');
			expect(fetched!.restrictions!.limit).toBe('API rate limit (HTTP 429)');
			expect(fetched!.restrictions!.resetAt).toBe(resetAt);
			expect(fetched!.restrictions!.retryAfter).toBe(60);
		});

		it('tasks without restrictions have null restrictions field', async () => {
			const task = await taskManager.createTask({
				title: 'Test task',
				description: 'desc',
			});
			expect(task.restrictions).toBeNull();
		});
	});

	// ─── setTaskStatus clears restrictions on resume ──────────────────────────

	describe('setTaskStatus clears restrictions when resuming', () => {
		it('clears restrictions when rate_limited → in_progress', async () => {
			const task = await taskManager.createTask({
				title: 'Test task',
				description: 'desc',
			});
			await taskManager.updateTaskStatus(task.id, 'in_progress');

			const restriction: TaskRestriction = {
				type: 'rate_limit',
				limit: 'API rate limit (HTTP 429)',
				resetAt: Date.now() + 3600_000,
				sessionRole: 'worker',
			};
			await taskManager.updateTaskStatus(task.id, 'rate_limited', {
				restrictions: restriction,
			});

			// Now resume via setTaskStatus
			const resumed = await taskManager.setTaskStatus(task.id, 'in_progress');
			expect(resumed.status).toBe('in_progress');
			expect(resumed.restrictions).toBeNull();
		});

		it('clears restrictions when usage_limited → in_progress', async () => {
			const task = await taskManager.createTask({
				title: 'Test task',
				description: 'desc',
			});
			await taskManager.updateTaskStatus(task.id, 'in_progress');

			const restriction: TaskRestriction = {
				type: 'usage_limit',
				limit: 'Daily cap',
				resetAt: Date.now() + 3600_000,
				sessionRole: 'leader',
			};
			await taskManager.updateTaskStatus(task.id, 'usage_limited', {
				restrictions: restriction,
			});

			const resumed = await taskManager.setTaskStatus(task.id, 'in_progress');
			expect(resumed.status).toBe('in_progress');
			expect(resumed.restrictions).toBeNull();
		});

		it('does NOT clear restrictions on unrelated transitions', async () => {
			const task = await taskManager.createTask({
				title: 'Test task',
				description: 'desc',
			});
			await taskManager.updateTaskStatus(task.id, 'in_progress');

			// Going to review (not resuming from rate limit) — restrictions should not be touched
			const reviewed = await taskManager.updateTaskStatus(task.id, 'review');
			expect(reviewed.restrictions).toBeNull();
		});
	});

	// ─── Migration 49 ────────────────────────────────────────────────────────

	/** Old-style tasks table (no restrictions column, no rate_limited/usage_limited in CHECK) */
	const OLD_TASKS_SCHEMA = `
		CREATE TABLE rooms (
			id TEXT PRIMARY KEY, name TEXT NOT NULL,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE TABLE tasks (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('draft','pending','in_progress','review','completed','needs_attention','cancelled','archived')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low','normal','high','urgent')),
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT DEFAULT '[]',
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			task_type TEXT DEFAULT 'coding'
				CHECK(task_type IN ('planning','coding','research','design','goal_review')),
			assigned_agent TEXT DEFAULT 'coder',
			created_by_task_id TEXT,
			archived_at INTEGER,
			active_session TEXT,
			pr_url TEXT,
			pr_number INTEGER,
			pr_created_at INTEGER,
			input_draft TEXT,
			updated_at INTEGER,
			short_id TEXT,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		);
	`;

	describe('Migration 49', () => {
		it('adds restrictions column to existing tasks table', () => {
			const migDb = new Database(':memory:');
			migDb.exec(OLD_TASKS_SCHEMA);

			// Column should not exist before migration
			const colsBefore = migDb.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
			expect(colsBefore.some((c) => c.name === 'restrictions')).toBe(false);

			// Run migration
			runMigration49(migDb);

			// Column should exist after migration
			const colsAfter = migDb.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
			expect(colsAfter.some((c) => c.name === 'restrictions')).toBe(true);

			migDb.close();
		});

		it('is idempotent — running twice does not throw', () => {
			const migDb = new Database(':memory:');
			createTables(migDb);
			expect(() => {
				runMigration49(migDb);
				runMigration49(migDb);
			}).not.toThrow();
			migDb.close();
		});

		it('preserves existing rows when recreating the table', () => {
			const migDb = new Database(':memory:');
			migDb.exec(OLD_TASKS_SCHEMA);
			migDb.exec(`INSERT INTO rooms VALUES ('r1', 'Room', 1000, 1000)`);
			migDb
				.prepare(
					`INSERT INTO tasks (id, room_id, title, description, created_at) VALUES (?, ?, ?, ?, ?)`
				)
				.run('t1', 'r1', 'My task', 'desc', 1000);

			runMigration49(migDb);

			const row = migDb.prepare(`SELECT * FROM tasks WHERE id = 't1'`).get() as Record<
				string,
				unknown
			>;
			expect(row).toBeDefined();
			expect(row.title).toBe('My task');
			expect(row.restrictions).toBeNull();

			migDb.close();
		});

		it('allows inserting tasks with rate_limited status after migration', () => {
			const migDb = new Database(':memory:');
			migDb.exec(OLD_TASKS_SCHEMA);
			migDb.exec(`INSERT INTO rooms VALUES ('r1', 'Room', 1000, 1000)`);

			runMigration49(migDb);

			// Should not throw with the new status value
			expect(() => {
				migDb
					.prepare(
						`INSERT INTO tasks (id, room_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
					)
					.run('t1', 'r1', 'Test', 'desc', 'rate_limited', 1000);
			}).not.toThrow();

			expect(() => {
				migDb
					.prepare(
						`INSERT INTO tasks (id, room_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
					)
					.run('t2', 'r1', 'Test2', 'desc2', 'usage_limited', 1000);
			}).not.toThrow();

			migDb.close();
		});
	});
});
