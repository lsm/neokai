/**
 * SpaceWorktreeManager unit tests
 *
 * Tests use a real temporary git repository to exercise actual git worktree
 * operations.  Each test suite creates its own isolated git repo and SQLite
 * database so that tests are fully independent.
 *
 * Covered scenarios:
 * - createTaskWorktree: creates filesystem worktree + DB record
 * - createTaskWorktree: idempotent (returns existing record on second call)
 * - createTaskWorktree: stale branch cleanup before recreation
 * - removeTaskWorktree: removes worktree dir, branch, and DB record
 * - removeTaskWorktree: no-op when no record exists
 * - getTaskWorktreePath: returns path for existing task, null for missing
 * - listWorktrees: returns all tracked worktrees for a space
 * - cleanupOrphaned: removes DB records whose directories are missing
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorktreeManager } from '../../../src/lib/space/managers/space-worktree-manager.ts';
import { worktreeSlug } from '../../../src/lib/space/worktree-slug.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(process.cwd(), 'tmp', 'test-space-worktree-manager');

/**
 * Create a fresh temporary directory, initialise a git repo with an initial
 * commit, and return its path.
 */
async function makeGitRepo(label: string): Promise<string> {
	const dir = join(TMP_ROOT, `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });

	const git = simpleGit(dir);
	await git.init();
	await git.addConfig('user.name', 'Test User');
	await git.addConfig('user.email', 'test@example.com');

	// Create an initial commit so HEAD exists and worktrees can be based on it
	writeFileSync(join(dir, 'README.md'), '# test\n');
	await git.add('.');
	await git.commit('initial commit');

	return dir;
}

/**
 * Create an in-memory SQLite database with all migrations applied, seed a
 * space row pointing at the given workspace path, and return the db + spaceId.
 */
function makeDb(workspacePath: string): { db: BunDatabase; spaceId: string } {
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});

	const spaceId = `space-${Math.random().toString(36).slice(2)}`;
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());

	return { db, spaceId };
}

/**
 * Seed a space_tasks row so FK constraints on space_worktrees.task_id are satisfied.
 * Returns the inserted task ID.
 */
function seedTask(db: BunDatabase, spaceId: string, taskId: string, taskNumber: number): string {
	db.prepare(
		`INSERT INTO space_tasks
       (id, space_id, task_number, title, description, status, priority, depends_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'pending', 'normal', '[]', ?, ?)`
	).run(taskId, spaceId, taskNumber, `Task ${taskNumber}`, Date.now(), Date.now());
	return taskId;
}

let repoDir: string;
let db: BunDatabase;
let spaceId: string;
let manager: SpaceWorktreeManager;

beforeEach(async () => {
	repoDir = await makeGitRepo('repo');
	const setup = makeDb(repoDir);
	db = setup.db;
	spaceId = setup.spaceId;
	manager = new SpaceWorktreeManager(db);
});

afterEach(() => {
	db.close();
	try {
		rmSync(repoDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup failures in CI
	}
});

// ---------------------------------------------------------------------------
// createTaskWorktree
// ---------------------------------------------------------------------------

describe('createTaskWorktree', () => {
	test('creates a worktree directory and returns slug + path', async () => {
		const taskId = seedTask(db, spaceId, 'task-001', 1);
		const result = await manager.createTaskWorktree(spaceId, taskId, 'Add feature', 1);

		expect(result.slug).toBe(worktreeSlug('Add feature', 1));
		expect(result.path).toContain('.worktrees');
		expect(result.path).toContain(result.slug);
		expect(existsSync(result.path)).toBe(true);
	});

	test('creates the correct branch name space/{slug}', async () => {
		const taskId = seedTask(db, spaceId, 'task-002', 2);
		const { slug } = await manager.createTaskWorktree(spaceId, taskId, 'Fix parser bug', 2);

		const git = simpleGit(repoDir);
		const branches = await git.raw(['branch', '--list', `space/${slug}`]);
		expect(branches.trim()).toContain(`space/${slug}`);
	});

	test('is idempotent — second call returns same path without error', async () => {
		const taskId = seedTask(db, spaceId, 'task-003', 3);
		const first = await manager.createTaskWorktree(spaceId, taskId, 'Refactor auth', 3);
		const second = await manager.createTaskWorktree(spaceId, taskId, 'Refactor auth', 3);

		expect(second.path).toBe(first.path);
		expect(second.slug).toBe(first.slug);
	});

	test('avoids slug collision across tasks in the same space', async () => {
		const tidA = seedTask(db, spaceId, 'task-col-a', 10);
		const tidB = seedTask(db, spaceId, 'task-col-b', 11);
		const result1 = await manager.createTaskWorktree(spaceId, tidA, 'Add feature', 10);
		const result2 = await manager.createTaskWorktree(spaceId, tidB, 'Add feature', 11);

		expect(result1.slug).toBe(worktreeSlug('Add feature', 10));
		expect(result2.slug).toBe(worktreeSlug('Add feature', 11, [result1.slug]));
		expect(result1.path).not.toBe(result2.path);
	});

	test('falls back to task-N slug when title has no alphanumeric characters', async () => {
		const taskId = seedTask(db, spaceId, 'task-x', 42);
		const result = await manager.createTaskWorktree(spaceId, taskId, '!!! ###', 42);
		expect(result.slug).toBe(worktreeSlug('!!! ###', 42));
	});

	test('uses custom baseBranch when provided', async () => {
		// Create a feature branch to base the worktree on; use -B to force-create
		// so the test is not sensitive to the repo's default branch name.
		const git = simpleGit(repoDir);
		await git.raw(['checkout', '-B', 'base-branch-for-test']);
		writeFileSync(join(repoDir, 'base.txt'), 'base\n');
		await git.add('.');
		await git.commit('base commit');
		// Go back to the initial branch (main/master/dev — whatever init defaulted to)
		const branches = await git.branchLocal();
		const initialBranch = branches.all.find((b) => b !== 'base-branch-for-test') ?? 'HEAD';
		await git.checkout(initialBranch);

		const taskId = seedTask(db, spaceId, 'task-004', 4);
		const result = await manager.createTaskWorktree(
			spaceId,
			taskId,
			'From Base',
			4,
			'base-branch-for-test'
		);
		expect(existsSync(result.path)).toBe(true);
	});

	test('throws when space does not exist', async () => {
		await expect(
			manager.createTaskWorktree('nonexistent-space', 'any-task-id', 'Title', 1)
		).rejects.toThrow('Space not found');
	});
});

// ---------------------------------------------------------------------------
// removeTaskWorktree
// ---------------------------------------------------------------------------

describe('removeTaskWorktree', () => {
	test('removes the worktree directory, branch, and DB record', async () => {
		const taskId = seedTask(db, spaceId, 'task-rm-01', 10);
		const { path, slug } = await manager.createTaskWorktree(spaceId, taskId, 'Remove me', 10);

		expect(existsSync(path)).toBe(true);

		await manager.removeTaskWorktree(spaceId, taskId);

		expect(existsSync(path)).toBe(false);

		// Branch should be gone
		const git = simpleGit(repoDir);
		const branchList = await git.raw(['branch', '--list', `space/${slug}`]);
		expect(branchList.trim()).toBe('');

		// DB record should be gone
		const retrieved = await manager.getTaskWorktreePath(spaceId, taskId);
		expect(retrieved).toBeNull();
	});

	test('is a no-op when no record exists for the task', async () => {
		// Should not throw
		await expect(manager.removeTaskWorktree(spaceId, 'nonexistent-task')).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// getTaskWorktreePath
// ---------------------------------------------------------------------------

describe('getTaskWorktreePath', () => {
	test('returns the path for an existing task worktree', async () => {
		const taskId = seedTask(db, spaceId, 'task-path-01', 5);
		const { path } = await manager.createTaskWorktree(spaceId, taskId, 'My Task', 5);

		const retrieved = await manager.getTaskWorktreePath(spaceId, taskId);
		expect(retrieved).toBe(path);
	});

	test('returns null when no worktree exists for the task', async () => {
		const result = await manager.getTaskWorktreePath(spaceId, 'does-not-exist');
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// listWorktrees
// ---------------------------------------------------------------------------

describe('listWorktrees', () => {
	test('returns an empty array when no worktrees exist', async () => {
		const list = await manager.listWorktrees(spaceId);
		expect(list).toEqual([]);
	});

	test('lists all created worktrees for a space', async () => {
		const tidA = seedTask(db, spaceId, 'task-list-a', 1);
		const tidB = seedTask(db, spaceId, 'task-list-b', 2);
		await manager.createTaskWorktree(spaceId, tidA, 'Task A', 1);
		await manager.createTaskWorktree(spaceId, tidB, 'Task B', 2);

		const list = await manager.listWorktrees(spaceId);
		expect(list).toHaveLength(2);

		// Derive expected slugs from worktreeSlug() to stay in sync with slugification rules
		const expectedSlugA = worktreeSlug('Task A', 1);
		const expectedSlugB = worktreeSlug('Task B', 2);
		const slugs = list.map((w) => w.slug).sort();
		expect(slugs).toEqual([expectedSlugA, expectedSlugB].sort());

		for (const entry of list) {
			expect(entry.taskId).toBeDefined();
			expect(entry.path).toBeDefined();
			expect(entry.slug).toBeDefined();
		}
	});

	test('does not return worktrees for a different space', async () => {
		const taskId = seedTask(db, spaceId, 'task-x', 1);
		await manager.createTaskWorktree(spaceId, taskId, 'Task X', 1);

		// Create a second space pointing at a different workspace
		const otherSpaceId = `space-other-${Math.random().toString(36).slice(2)}`;
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
       allowed_models, session_ids, slug, status, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
		).run(
			otherSpaceId,
			`/tmp/other-workspace-${Math.random()}`,
			'Other Space',
			otherSpaceId,
			Date.now(),
			Date.now()
		);

		const list = await manager.listWorktrees(otherSpaceId);
		expect(list).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// cleanupOrphaned
// ---------------------------------------------------------------------------

describe('cleanupOrphaned', () => {
	test('removes DB records for missing directories', async () => {
		const taskId = seedTask(db, spaceId, 'task-orphan-01', 20);
		const { path } = await manager.createTaskWorktree(spaceId, taskId, 'Orphan Task', 20);

		// Simulate the worktree directory disappearing without going through removeTaskWorktree
		// (e.g. manual deletion or OS cleanup)
		rmSync(path, { recursive: true, force: true });
		expect(existsSync(path)).toBe(false);

		// DB record still there
		expect(await manager.getTaskWorktreePath(spaceId, taskId)).toBe(path);

		await manager.cleanupOrphaned(spaceId);

		// DB record should now be gone
		expect(await manager.getTaskWorktreePath(spaceId, taskId)).toBeNull();
	});

	test('does not remove records for existing worktrees', async () => {
		const taskId = seedTask(db, spaceId, 'task-live-01', 21);
		const { path } = await manager.createTaskWorktree(spaceId, taskId, 'Live Task', 21);
		expect(existsSync(path)).toBe(true);

		await manager.cleanupOrphaned(spaceId);

		// Record should still be there
		expect(await manager.getTaskWorktreePath(spaceId, taskId)).toBe(path);
	});

	test('is a no-op when there are no worktrees', async () => {
		await expect(manager.cleanupOrphaned(spaceId)).resolves.toBeUndefined();
	});

	test('handles multiple orphaned records in one pass', async () => {
		const t1Id = seedTask(db, spaceId, 'task-o1', 30);
		const t2Id = seedTask(db, spaceId, 'task-o2', 31);
		const t3Id = seedTask(db, spaceId, 'task-o3', 32);
		const t1 = await manager.createTaskWorktree(spaceId, t1Id, 'Orphan 1', 30);
		const t2 = await manager.createTaskWorktree(spaceId, t2Id, 'Orphan 2', 31);
		const t3 = await manager.createTaskWorktree(spaceId, t3Id, 'Live', 32);

		// Remove two of the three directories
		rmSync(t1.path, { recursive: true, force: true });
		rmSync(t2.path, { recursive: true, force: true });

		await manager.cleanupOrphaned(spaceId);

		expect(await manager.getTaskWorktreePath(spaceId, t1Id)).toBeNull();
		expect(await manager.getTaskWorktreePath(spaceId, t2Id)).toBeNull();
		expect(await manager.getTaskWorktreePath(spaceId, t3Id)).toBe(t3.path);
	});
});
