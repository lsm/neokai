/**
 * SessionGroupRepository — ReactiveDatabase integration tests
 *
 * Verifies:
 * - notifyChange('session_groups') fires after writes
 * - LiveQueryEngine subscription on session_groups fires after writes
 * - createGroup transaction: abortTransaction() is called on error; transactionDepth doesn't get stuck
 * - recordGateFailure transaction: abortTransaction() is called on error; transactionDepth doesn't get stuck
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import type { ReactiveDatabase } from '../../../src/storage/reactive-database';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'normal',
    depends_on TEXT DEFAULT '[]',
    task_type TEXT DEFAULT 'coding',
    created_by_task_id TEXT,
    assigned_agent TEXT DEFAULT 'coder',
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    archived_at INTEGER,
    active_session TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    pr_created_at INTEGER,
    updated_at INTEGER
);
CREATE TABLE session_groups (
    id TEXT PRIMARY KEY,
    group_type TEXT NOT NULL DEFAULT 'task',
    ref_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'awaiting_worker'
        CHECK(state IN ('awaiting_worker', 'awaiting_leader', 'awaiting_human', 'completed', 'failed')),
    version INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE TABLE session_group_members (
    group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, session_id)
);
CREATE TABLE task_group_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): {
	db: Database;
	reactiveDb: ReactiveDatabase;
	repo: SessionGroupRepository;
} {
	const db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	const now = Date.now();
	db.exec(SCHEMA);
	db.exec(
		`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${now}, ${now})`
	);
	db.exec(
		`INSERT INTO tasks (id, room_id, title, description, created_at) VALUES ('task-1', 'room-1', 'Task', 'desc', ${now})`
	);

	const reactiveDb = createReactiveDatabase(db);
	const repo = new SessionGroupRepository(db, reactiveDb);
	return { db, reactiveDb, repo };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionGroupRepository — notifyChange integration', () => {
	let db: Database;
	let reactiveDb: ReactiveDatabase;
	let repo: SessionGroupRepository;

	beforeEach(() => {
		({ db, reactiveDb, repo } = createTestDb());
	});

	afterEach(() => {
		db.close();
	});

	describe('createGroup', () => {
		it('emits change event for session_groups after createGroup', () => {
			let fired = false;
			reactiveDb.on('change:session_groups', () => {
				fired = true;
			});

			repo.createGroup('task-1', 'worker-1', 'leader-1');
			expect(fired).toBe(true);
		});

		it('increments session_groups version after createGroup', () => {
			const versionBefore = reactiveDb.getTableVersion('session_groups');
			repo.createGroup('task-1', 'worker-1', 'leader-1');
			expect(reactiveDb.getTableVersion('session_groups')).toBe(versionBefore + 1);
		});

		it('batches notifications — only one change event per createGroup call', () => {
			let count = 0;
			reactiveDb.on('change:session_groups', () => {
				count++;
			});

			repo.createGroup('task-1', 'worker-1', 'leader-1');
			expect(count).toBe(1);
		});
	});

	describe('completeGroup', () => {
		it('emits change event for session_groups after completeGroup', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			let fired = false;
			reactiveDb.on('change:session_groups', () => {
				fired = true;
			});

			repo.completeGroup(group.id, group.version);
			expect(fired).toBe(true);
		});

		it('does not emit change event when version mismatch prevents update', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			let count = 0;
			reactiveDb.on('change:session_groups', () => {
				count++;
			});

			// Wrong version — no rows changed, no notification
			repo.completeGroup(group.id, 999);
			expect(count).toBe(0);
		});
	});

	describe('setApproved / metadata writes', () => {
		it('emits change event for session_groups after setApproved', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			let fired = false;
			reactiveDb.on('change:session_groups', () => {
				fired = true;
			});

			repo.setApproved(group.id, true);
			expect(fired).toBe(true);
		});

		it('increments session_groups version on each write', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			const v1 = reactiveDb.getTableVersion('session_groups');
			repo.setApproved(group.id, true);
			const v2 = reactiveDb.getTableVersion('session_groups');
			repo.setSubmittedForReview(group.id, true);
			const v3 = reactiveDb.getTableVersion('session_groups');

			expect(v2).toBe(v1 + 1);
			expect(v3).toBe(v2 + 1);
		});
	});

	describe('deleteGroup', () => {
		it('emits change event for session_groups after deleteGroup', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			let fired = false;
			reactiveDb.on('change:session_groups', () => {
				fired = true;
			});

			repo.deleteGroup(group.id);
			expect(fired).toBe(true);
		});

		it('does not emit when group does not exist', () => {
			let count = 0;
			reactiveDb.on('change:session_groups', () => {
				count++;
			});

			repo.deleteGroup('nonexistent-id');
			expect(count).toBe(0);
		});
	});

	describe('recordGateFailure transaction', () => {
		it('emits change event after recordGateFailure', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			let fired = false;
			reactiveDb.on('change:session_groups', () => {
				fired = true;
			});

			repo.recordGateFailure(group.id, 'worker_exit', 'No PR found');
			expect(fired).toBe(true);
		});
	});

	describe('appendEvent', () => {
		it('emits change event for task_group_events after appendEvent', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			let fired = false;
			reactiveDb.on('change:task_group_events', () => {
				fired = true;
			});

			repo.appendEvent({ groupId: group.id, kind: 'status', payloadJson: '{}' });
			expect(fired).toBe(true);
		});

		it('increments task_group_events version on each appendEvent', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');
			const v0 = reactiveDb.getTableVersion('task_group_events');
			repo.appendEvent({ groupId: group.id, kind: 'status' });
			repo.appendEvent({ groupId: group.id, kind: 'log' });
			expect(reactiveDb.getTableVersion('task_group_events')).toBe(v0 + 2);
		});
	});

	describe('updateWorkerSession', () => {
		it('emits change event for session_group_members after updateWorkerSession', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			let fired = false;
			reactiveDb.on('change:session_group_members', () => {
				fired = true;
			});

			repo.updateWorkerSession(group.id, 'worker-2');
			expect(fired).toBe(true);
		});
	});

	describe('updateMetadata (version-checked writes)', () => {
		it('emits change event after incrementFeedbackIteration', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			let fired = false;
			reactiveDb.on('change:session_groups', () => {
				fired = true;
			});

			repo.incrementFeedbackIteration(group.id, group.version);
			expect(fired).toBe(true);
		});

		it('does not emit when version check fails', () => {
			const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

			let count = 0;
			reactiveDb.on('change:session_groups', () => {
				count++;
			});

			repo.incrementFeedbackIteration(group.id, 999); // wrong version
			expect(count).toBe(0);
		});
	});
});

describe('SessionGroupRepository — transaction safety', () => {
	let db: Database;
	let reactiveDb: ReactiveDatabase;
	let repo: SessionGroupRepository;

	beforeEach(() => {
		({ db, reactiveDb, repo } = createTestDb());
	});

	afterEach(() => {
		db.close();
	});

	it('createGroup is atomic — session_groups row is rolled back if members insert fails', () => {
		// Add a constraint that makes the second INSERT fail
		db.exec(`CREATE UNIQUE INDEX unique_worker ON session_group_members(group_id, role)`);

		// Force session_group_members insert to fail by pre-inserting a conflicting row.
		// We do this by making the table unusable for new inserts.
		db.exec('DROP TABLE session_group_members');
		db.exec(`
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL CHECK(role = 'blocked'),
				joined_at INTEGER NOT NULL
			)
		`);

		expect(() => {
			repo.createGroup('task-1', 'worker-1', 'leader-1');
		}).toThrow();

		// The session_groups insert must have been rolled back
		const rows = db.prepare('SELECT * FROM session_groups').all();
		expect(rows).toHaveLength(0);
	});

	it('abortTransaction is called on createGroup error; transactionDepth does not get stuck', () => {
		// Track transaction depth via the notifications — if depth is stuck,
		// subsequent notifyChange calls are silently buffered.
		// Strategy: break the DB, attempt createGroup (will throw), verify
		// that the next successful write still emits notifications.

		// Track begin/commit/abort calls
		let abortCount = 0;
		const origAbort = reactiveDb.abortTransaction.bind(reactiveDb);
		reactiveDb.abortTransaction = () => {
			abortCount++;
			origAbort();
		};

		// Force an error by dropping the session_group_members table mid-flight
		db.exec('DROP TABLE session_group_members');

		// createGroup will fail because session_group_members doesn't exist
		expect(() => {
			repo.createGroup('task-1', 'worker-1', 'leader-1');
		}).toThrow();

		expect(abortCount).toBe(1);

		// Restore the table and verify subsequent writes still emit events
		db.exec(`
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, session_id)
			)
		`);

		let fired = false;
		reactiveDb.on('change:session_groups', () => {
			fired = true;
		});

		// Should succeed now and still emit notifications
		repo.createGroup('task-1', 'worker-1', 'leader-1');
		expect(fired).toBe(true);
	});

	it('abortTransaction is called on recordGateFailure error; transactionDepth does not get stuck', () => {
		const group = repo.createGroup('task-1', 'worker-1', 'leader-1');

		let abortCount = 0;
		const origAbort = reactiveDb.abortTransaction.bind(reactiveDb);
		reactiveDb.abortTransaction = () => {
			abortCount++;
			origAbort();
		};

		// Force an error inside recordGateFailure by dropping the table
		db.exec('DROP TABLE session_groups');

		expect(() => {
			repo.recordGateFailure(group.id, 'worker_exit', 'test error');
		}).toThrow();

		expect(abortCount).toBe(1);

		// Verify transactionDepth is back to 0 — notifyChange now emits immediately
		// (if depth were stuck at 1, all subsequent notifyChange would be buffered)
		let notifyCount = 0;
		const origNotify = reactiveDb.notifyChange.bind(reactiveDb);
		reactiveDb.notifyChange = (table: string) => {
			notifyCount++;
			origNotify(table);
		};

		// Directly call notifyChange — if depth is stuck, this will be buffered
		reactiveDb.notifyChange('session_groups');
		expect(notifyCount).toBe(1);

		// Verify the change was emitted, not buffered
		let emitFired = false;
		// Note: we need to listen before emitting for this check
		// Re-check by monitoring future notifications:
		reactiveDb.on('change:session_groups', () => {
			emitFired = true;
		});
		reactiveDb.notifyChange('session_groups');
		expect(emitFired).toBe(true);
	});

	it('nested transactions: transactionDepth returns to 0 after nested commit', () => {
		// Manual transaction nesting test
		reactiveDb.beginTransaction();
		reactiveDb.beginTransaction(); // depth=2
		reactiveDb.commitTransaction(); // depth=1 — not yet flushed
		reactiveDb.commitTransaction(); // depth=0 — flush

		// After all commits, future notifyChange should emit immediately
		let fired = false;
		reactiveDb.on('change:session_groups', () => {
			fired = true;
		});
		reactiveDb.notifyChange('session_groups');
		expect(fired).toBe(true);
	});
});
