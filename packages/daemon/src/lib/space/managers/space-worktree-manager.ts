/**
 * SpaceWorktreeManager
 *
 * Manages git worktrees for Space tasks. One worktree per task, created from
 * the space's repository workspace path.
 *
 * Worktree location : {spaceWorkspacePath}/.worktrees/{slug}/
 * Branch naming     : space/{slug}
 *
 * Does NOT extend Room's WorktreeManager — uses execSync directly.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { Database as BunDatabase } from 'bun:sqlite';
import { SpaceWorktreeRepository } from '../../../storage/repositories/space-worktree-repository';
import { SpaceRepository } from '../../../storage/repositories/space-repository';
import { worktreeSlug } from '../worktree-slug';
import { Logger } from '../../logger';

export interface SpaceWorktreeInfo {
	slug: string;
	taskId: string;
	path: string;
}

export class SpaceWorktreeManager {
	private worktreeRepo: SpaceWorktreeRepository;
	private spaceRepo: SpaceRepository;
	private logger = new Logger('SpaceWorktreeManager');

	constructor(db: BunDatabase) {
		this.worktreeRepo = new SpaceWorktreeRepository(db);
		this.spaceRepo = new SpaceRepository(db);
	}

	/**
	 * Create a git worktree for a task.
	 *
	 * If a worktree already exists for this (spaceId, taskId) pair the existing
	 * record is returned without touching the filesystem — idempotent.
	 *
	 * @param spaceId     - Space UUID
	 * @param taskId      - Task UUID
	 * @param taskTitle   - Human-readable title used to derive the slug
	 * @param taskNumber  - Numeric task ID (fallback for slug when title has no alphanumeric chars)
	 * @param baseBranch  - Git ref to base the new branch on (default: 'HEAD')
	 * @returns           - { path, slug } of the created (or existing) worktree
	 */
	async createTaskWorktree(
		spaceId: string,
		taskId: string,
		taskTitle: string,
		taskNumber: number,
		baseBranch?: string
	): Promise<{ path: string; slug: string }> {
		const space = this.spaceRepo.getSpace(spaceId);
		if (!space) {
			throw new Error(`Space not found: ${spaceId}`);
		}

		// Idempotent: return existing record if the worktree was already created
		const existing = this.worktreeRepo.getByTaskId(spaceId, taskId);
		if (existing) {
			return { path: existing.path, slug: existing.slug };
		}

		// Generate a slug that is unique within this space
		const existingSlugs = this.worktreeRepo.listSlugs(spaceId);
		const slug = worktreeSlug(taskTitle, taskNumber, existingSlugs);

		// Ensure the .worktrees directory exists inside the workspace
		const worktreesDir = join(space.workspacePath, '.worktrees');
		if (!existsSync(worktreesDir)) {
			mkdirSync(worktreesDir, { recursive: true });
		}

		const worktreePath = join(worktreesDir, slug);
		const branchName = `space/${slug}`;

		// If a stale branch with the same name exists (from a previous crashed run),
		// delete it so we can recreate it cleanly.
		try {
			const branches = execFileSync('git', ['branch', '--list', branchName], {
				cwd: space.workspacePath,
				encoding: 'utf8',
				timeout: 30_000,
			});
			if (branches.trim().length > 0) {
				this.logger.warn(`Stale branch detected: ${branchName} — deleting before recreating`);
				execFileSync('git', ['branch', '-D', branchName], {
					cwd: space.workspacePath,
					timeout: 30_000,
				});
			}
		} catch (err) {
			// Non-fatal: branch check/delete failure should not block worktree creation
			this.logger.warn(
				`Failed to check/delete stale branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`
			);
		}

		// If a stale directory exists at the worktree path (from a previous crashed run),
		// remove it so git worktree add can proceed cleanly.
		if (existsSync(worktreePath)) {
			this.logger.warn(
				`Stale directory detected at ${worktreePath} — removing before recreating worktree`
			);
			rmSync(worktreePath, { recursive: true, force: true });
		}

		try {
			execFileSync(
				'git',
				['worktree', 'add', worktreePath, '-b', branchName, baseBranch ?? 'HEAD'],
				{
					cwd: space.workspacePath,
					timeout: 30_000,
				}
			);
		} catch (err) {
			// Clean up the directory if it was partially created
			if (existsSync(worktreePath)) {
				try {
					rmSync(worktreePath, { recursive: true, force: true });
				} catch {
					// Ignore cleanup errors
				}
			}
			throw new Error(
				`Failed to create worktree for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
			);
		}

		// Persist the mapping to SQLite after the filesystem operation succeeds
		this.worktreeRepo.create({ spaceId, taskId, slug, path: worktreePath });

		this.logger.info(
			`Created worktree for task ${taskId} at ${worktreePath} (branch: ${branchName})`
		);
		return { path: worktreePath, slug };
	}

	/**
	 * Remove a task's worktree from the filesystem and delete its branch.
	 * Removes the SQLite record regardless of whether the filesystem operation succeeds.
	 */
	async removeTaskWorktree(spaceId: string, taskId: string): Promise<void> {
		const record = this.worktreeRepo.getByTaskId(spaceId, taskId);
		if (!record) {
			return; // Nothing to do
		}

		const space = this.spaceRepo.getSpace(spaceId);
		if (!space) {
			// Space is gone; just clean up the DB record
			this.worktreeRepo.delete(spaceId, taskId);
			return;
		}

		// Remove the worktree directory via git
		try {
			execFileSync('git', ['worktree', 'remove', record.path, '--force'], {
				cwd: space.workspacePath,
				timeout: 30_000,
			});
		} catch (err) {
			this.logger.warn(
				`Failed to remove git worktree at ${record.path} (continuing with cleanup): ${err instanceof Error ? err.message : String(err)}`
			);
		}

		// Delete the branch
		const branchName = `space/${record.slug}`;
		try {
			execFileSync('git', ['branch', '-D', branchName], {
				cwd: space.workspacePath,
				timeout: 30_000,
			});
		} catch (err) {
			// Branch may already be gone; non-fatal
			this.logger.warn(
				`Failed to delete branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`
			);
		}

		// Remove the SQLite record
		this.worktreeRepo.delete(spaceId, taskId);
		this.logger.info(`Removed worktree for task ${taskId} (branch: ${branchName})`);
	}

	/**
	 * Return the filesystem path for a task's worktree, or null if none exists.
	 */
	async getTaskWorktreePath(spaceId: string, taskId: string): Promise<string | null> {
		const record = this.worktreeRepo.getByTaskId(spaceId, taskId);
		return record?.path ?? null;
	}

	/**
	 * List all worktrees tracked for a space.
	 */
	async listWorktrees(spaceId: string): Promise<SpaceWorktreeInfo[]> {
		const records = this.worktreeRepo.listBySpace(spaceId);
		return records.map((r) => ({ slug: r.slug, taskId: r.taskId, path: r.path }));
	}

	/**
	 * Remove SQLite records whose worktree directories no longer exist on disk,
	 * then prune git's internal worktree metadata.
	 *
	 * This is safe to call at any time — it only removes records for missing
	 * directories and does not touch live worktrees.
	 */
	async cleanupOrphaned(spaceId: string): Promise<void> {
		const records = this.worktreeRepo.listBySpace(spaceId);
		const space = this.spaceRepo.getSpace(spaceId);

		for (const record of records) {
			if (!existsSync(record.path)) {
				// Also delete the orphaned branch to match removeTaskWorktree behavior
				if (space) {
					const branchName = `space/${record.slug}`;
					try {
						execFileSync('git', ['branch', '-D', branchName], {
							cwd: space.workspacePath,
							timeout: 30_000,
						});
					} catch {
						// Branch may already be gone; non-fatal
					}
				}
				this.worktreeRepo.delete(spaceId, record.taskId);
				this.logger.info(
					`Cleaned up orphaned worktree record for task ${record.taskId} (path was: ${record.path})`
				);
			}
		}

		// Prune git's internal worktree state as well
		if (space) {
			try {
				execFileSync('git', ['worktree', 'prune'], {
					cwd: space.workspacePath,
					timeout: 30_000,
				});
			} catch (err) {
				this.logger.warn(
					`git worktree prune failed for space ${spaceId}: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
	}
}
