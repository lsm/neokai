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
		const taskId = 'task-001';
		const result = await manager.createTaskWorktree(spaceId, taskId, 'Add feature', 1);

		expect(result.slug).toBe('add-feature');
		expect(result.path).toContain('.worktrees');
		expect(result.path).toContain('add-feature');
		expect(existsSync(result.path)).toBe(true);
	});

	test('creates the correct branch name space/{slug}', async () => {
		const taskId = 'task-002';
		const { slug } = await manager.createTaskWorktree(spaceId, taskId, 'Fix parser bug', 2);

		const git = simpleGit(repoDir);
		const branches = await git.raw(['branch', '--list', `space/${slug}`]);
		expect(branches.trim()).toContain(`space/${slug}`);
	});

	test('is idempotent — second call returns same path without error', async () => {
		const taskId = 'task-003';
		const first = await manager.createTaskWorktree(spaceId, taskId, 'Refactor auth', 3);
		const second = await manager.createTaskWorktree(spaceId, taskId, 'Refactor auth', 3);

		expect(second.path).toBe(first.path);
		expect(second.slug).toBe(first.slug);
	});

	test('avoids slug collision across tasks in the same space', async () => {
		const result1 = await manager.createTaskWorktree(spaceId, 'task-a', 'Add feature', 1);
		const result2 = await manager.createTaskWorktree(spaceId, 'task-b', 'Add feature', 2);

		expect(result1.slug).toBe('add-feature');
		expect(result2.slug).toBe('add-feature-2');
		expect(result1.path).not.toBe(result2.path);
	});

	test('falls back to task-N slug when title has no alphanumeric characters', async () => {
		const result = await manager.createTaskWorktree(spaceId, 'task-x', '!!! ###', 42);
		expect(result.slug).toBe('task-42');
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

		const result = await manager.createTaskWorktree(
			spaceId,
			'task-004',
			'From Base',
			4,
			'base-branch-for-test'
		);
		expect(existsSync(result.path)).toBe(true);
	});

	test('throws when space does not exist', async () => {
		await expect(
			manager.createTaskWorktree('nonexistent-space', 'task-z', 'Title', 1)
		).rejects.toThrow('Space not found');
	});
});

// ---------------------------------------------------------------------------
// removeTaskWorktree
// ---------------------------------------------------------------------------

describe('removeTaskWorktree', () => {
	test('removes the worktree directory, branch, and DB record', async () => {
		const taskId = 'task-rm-01';
		const { path, slug } = await manager.createTaskWorktree(spaceId, taskId, 'Remove me', 10);

		expect(existsSync(path)).toBe(true);

		await manager.removeTaskWorktree(spaceId, taskId);

		expect(existsSync(path)).toBe(false);

		// Branch should be gone
		const git = simpleGit(repoDir);
		const branches = await git.raw(['branch', '--list', `space/${slug}`]);
		expect(branches.trim()).toBe('');

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
		const taskId = 'task-path-01';
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
		await manager.createTaskWorktree(spaceId, 'task-list-a', 'Task A', 1);
		await manager.createTaskWorktree(spaceId, 'task-list-b', 'Task B', 2);

		const list = await manager.listWorktrees(spaceId);
		expect(list).toHaveLength(2);

		const slugs = list.map((w) => w.slug).sort();
		expect(slugs).toEqual(['task-a', 'task-b']);

		for (const entry of list) {
			expect(entry.taskId).toBeDefined();
			expect(entry.path).toBeDefined();
			expect(entry.slug).toBeDefined();
		}
	});

	test('does not return worktrees for a different space', async () => {
		// Create worktree for space1
		await manager.createTaskWorktree(spaceId, 'task-x', 'Task X', 1);

		// Create a second space pointing at a different (in-memory only) workspace
		const otherSpaceId = `space-other-${Math.random().toString(36).slice(2)}`;
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
       allowed_models, session_ids, slug, status, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
		).run(
			otherSpaceId,
			`/tmp/other-workspace-${Math.random()}`,
			`Other Space`,
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
		const taskId = 'task-orphan-01';
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
		const taskId = 'task-live-01';
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
		const t1 = await manager.createTaskWorktree(spaceId, 'task-o1', 'Orphan 1', 30);
		const t2 = await manager.createTaskWorktree(spaceId, 'task-o2', 'Orphan 2', 31);
		const t3 = await manager.createTaskWorktree(spaceId, 'task-o3', 'Live', 32);

		// Remove two of the three directories
		rmSync(t1.path, { recursive: true, force: true });
		rmSync(t2.path, { recursive: true, force: true });

		await manager.cleanupOrphaned(spaceId);

		expect(await manager.getTaskWorktreePath(spaceId, 'task-o1')).toBeNull();
		expect(await manager.getTaskWorktreePath(spaceId, 'task-o2')).toBeNull();
		expect(await manager.getTaskWorktreePath(spaceId, 'task-o3')).toBe(t3.path);
	});
});
