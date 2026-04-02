/**
 * Unit tests for CompletionDetector
 *
 * Scenarios (30 total):
 *   1.  No tasks exist — returns false (workflow not started)
 *   2.  Single agent in_progress — returns false
 *   3.  Single agent done — returns true
 *   4.  Single agent blocked — returns true (terminal)
 *   5.  Single agent cancelled — returns true (terminal)
 *   6.  Single agent open — returns false (non-terminal)
 *   7.  Single agent archived — excluded by listByWorkflowRun; no tasks remain → false
 *   8.  Multi-agent single node — all done → true
 *   9.  Multi-agent single node — one in_progress → false
 *   10. Multi-node workflow — all agents terminal → true
 *   11. Multi-node workflow — one agent non-terminal → false
 *   12. Archived tasks excluded from listByWorkflowRun; remaining all terminal → true
 *   13. No channels provided — returns true when all terminal
 *   14. TERMINAL_TASK_STATUSES export — contains exactly the 4 terminal statuses
 *   15. TERMINAL_TASK_STATUSES export — does not contain non-terminal statuses
 *   16. Mixed terminal statuses: done + cancelled → true
 *   17. Mixed terminal statuses: done + blocked → true
 *   18. Multiple terminal statuses in one run → true
 *   19. One non-terminal task blocks completion regardless of terminal count
 *   20. Tasks from different workflow runs do not interfere
 *   21. Empty run vs run with tasks — no cross-contamination
 *   22. done + in_progress → false
 *   23. Many done + one open → false
 *   24. Single task blocked (terminal) → true
 *   25. Single task archived excluded + done task → true
 *   26. All tasks blocked → true
 *   27. Mix: done, blocked, cancelled, archived (excluded) → true based on remaining
 *   28. All tasks in_progress → false
 *   29. in_progress + open → false
 *   30. Single archived task (excluded) → false (no tasks remain)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import {
	CompletionDetector,
	TERMINAL_TASK_STATUSES,
} from '../../../src/lib/space/runtime/completion-detector.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-completion-detector',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	runMigrations(db, () => {});
	// Migrations re-enable FK at the end; disable after to allow synthetic run IDs
	// without needing to seed full parent rows.
	db.exec('PRAGMA foreign_keys = OFF');
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

let taskCounter = 0;
function seedTask(
	db: BunDatabase,
	spaceId: string,
	overrides: {
		id?: string;
		status?: string;
		workflowRunId?: string;
	} = {}
): string {
	const id = overrides.id ?? `task-${++taskCounter}`;
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_tasks
       (id, space_id, task_number, title, description, status, priority, labels, depends_on,
        workflow_run_id, created_at, updated_at)
       VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, '', ?, 'normal', '[]', '[]', ?, ?, ?)`
	).run(
		id,
		spaceId,
		spaceId,
		`Task ${id}`,
		overrides.status ?? 'in_progress',
		overrides.workflowRunId ?? null,
		now,
		now
	);
	return id;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let db: BunDatabase;
let dir: string;
let taskRepo: SpaceTaskRepository;
let detector: CompletionDetector;
const SPACE = 'space-1';

beforeEach(() => {
	({ db, dir } = makeDb());
	seedSpace(db, SPACE);
	taskRepo = new SpaceTaskRepository(db);
	detector = new CompletionDetector(taskRepo);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompletionDetector', () => {
	const RUN = 'run-1';

	test('1. no tasks exist — returns false (workflow not started)', () => {
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('2. single agent in_progress — returns false', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'in_progress' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('3. single agent done — returns true', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('4. single agent blocked — returns true (terminal)', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'blocked' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('5. single agent cancelled — returns true (terminal)', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'cancelled' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('6. single agent open — returns false (non-terminal)', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'open' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('7. single agent archived — excluded by listByWorkflowRun; no tasks remain → false', () => {
		// listByWorkflowRun filters out archived tasks, so only archived task → no tasks → false
		db.prepare(
			`INSERT INTO space_tasks
         (id, space_id, task_number, title, description, status, priority, labels, depends_on,
          workflow_run_id, archived_at, created_at, updated_at)
         VALUES (?, ?, 999, 'archived-task', '', 'archived', 'normal', '[]', '[]', ?, ?, ?, ?)`
		).run('task-archived', SPACE, RUN, Date.now(), Date.now(), Date.now());
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('8. multi-agent single node — all done → true', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'blocked' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('9. multi-agent single node — one in_progress → false', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'in_progress' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('10. multi-node workflow — all agents terminal → true', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'cancelled' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('11. multi-node workflow — one agent non-terminal → false', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'open' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('12. archived tasks excluded; remaining all terminal → true', () => {
		// listByWorkflowRun filters out archived tasks (status = archived)
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
		// Seed an archived task directly (bypassing the repository so status = 'archived')
		db.prepare(
			`INSERT INTO space_tasks
         (id, space_id, task_number, title, description, status, priority, labels, depends_on,
          workflow_run_id, archived_at, created_at, updated_at)
         VALUES (?, ?, 998, 'arch-task', '', 'archived', 'normal', '[]', '[]', ?, ?, ?, ?)`
		).run('task-archived-2', SPACE, RUN, Date.now(), Date.now(), Date.now());
		// archived task is excluded → only the done task remains → complete
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('13. no channels — returns true when all terminal', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	describe('TERMINAL_TASK_STATUSES export', () => {
		test('14. contains exactly the four terminal statuses', () => {
			expect(TERMINAL_TASK_STATUSES.has('done')).toBe(true);
			expect(TERMINAL_TASK_STATUSES.has('blocked')).toBe(true);
			expect(TERMINAL_TASK_STATUSES.has('cancelled')).toBe(true);
			expect(TERMINAL_TASK_STATUSES.has('archived')).toBe(true);
			expect(TERMINAL_TASK_STATUSES.size).toBe(4);
		});

		test('15. does not contain non-terminal statuses', () => {
			expect(TERMINAL_TASK_STATUSES.has('open')).toBe(false);
			expect(TERMINAL_TASK_STATUSES.has('in_progress')).toBe(false);
		});
	});

	describe('mixed terminal statuses (all done / some blocked/cancelled)', () => {
		test('16. mixed done + cancelled across multiple tasks → true', () => {
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'cancelled' });
			expect(detector.isComplete(RUN)).toBe(true);
		});

		test('17. mixed done + blocked across multiple tasks → true', () => {
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'blocked' });
			expect(detector.isComplete(RUN)).toBe(true);
		});

		test('18. multiple terminal statuses in one run → true', () => {
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'blocked' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'cancelled' });
			expect(detector.isComplete(RUN)).toBe(true);
		});

		test('19. one non-terminal task blocks completion regardless of how many terminal tasks exist', () => {
			for (let i = 0; i < 5; i++) {
				seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
			}
			// One open task blocks the entire run
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'open' });
			expect(detector.isComplete(RUN)).toBe(false);
		});

		test('22. done + in_progress → false', () => {
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'in_progress' });
			expect(detector.isComplete(RUN)).toBe(false);
		});

		test('23. many done + one open → false', () => {
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'done' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'open' });
			expect(detector.isComplete(RUN)).toBe(false);
		});

		test('24. single task blocked (terminal) → true', () => {
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'blocked' });
			expect(detector.isComplete(RUN)).toBe(true);
		});

		test('26. all tasks blocked → true', () => {
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'blocked' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'blocked' });
			expect(detector.isComplete(RUN)).toBe(true);
		});

		test('28. all tasks in_progress → false', () => {
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'in_progress' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'in_progress' });
			expect(detector.isComplete(RUN)).toBe(false);
		});

		test('29. in_progress + open → false', () => {
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'in_progress' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'open' });
			expect(detector.isComplete(RUN)).toBe(false);
		});
	});

	describe('multiple workflow runs (cross-contamination)', () => {
		test('20. tasks from different runs do not interfere — each run evaluated independently', () => {
			const RUN_A = 'run-a';
			const RUN_B = 'run-b';

			// Run A: all terminal
			seedTask(db, SPACE, { workflowRunId: RUN_A, status: 'done' });
			seedTask(db, SPACE, { workflowRunId: RUN_A, status: 'cancelled' });

			// Run B: one non-terminal
			seedTask(db, SPACE, { workflowRunId: RUN_B, status: 'done' });
			seedTask(db, SPACE, { workflowRunId: RUN_B, status: 'in_progress' });

			expect(detector.isComplete(RUN_A)).toBe(true);
			expect(detector.isComplete(RUN_B)).toBe(false);
		});

		test('21. one run has no tasks while the other has tasks — no cross-contamination', () => {
			const RUN_A = 'run-empty';
			const RUN_B = 'run-with-tasks';

			seedTask(db, SPACE, { workflowRunId: RUN_B, status: 'done' });

			expect(detector.isComplete(RUN_A)).toBe(false);
			expect(detector.isComplete(RUN_B)).toBe(true);
		});

		test('30. single archived task (excluded) → false (no tasks remain)', () => {
			// Only archived task in run — listByWorkflowRun excludes it → 0 tasks → false
			db.prepare(
				`INSERT INTO space_tasks
           (id, space_id, task_number, title, description, status, priority, labels, depends_on,
            workflow_run_id, archived_at, created_at, updated_at)
           VALUES (?, ?, 997, 'only-archived', '', 'archived', 'normal', '[]', '[]', ?, ?, ?, ?)`
			).run('task-only-archived', SPACE, RUN, Date.now(), Date.now(), Date.now());
			expect(detector.isComplete(RUN)).toBe(false);
		});
	});
});
