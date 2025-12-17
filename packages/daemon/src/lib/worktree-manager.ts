import simpleGit, { SimpleGit } from 'simple-git';
import { dirname, join, normalize } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { WorktreeMetadata, CommitInfo, WorktreeCommitStatus } from '@liuboer/shared';

export interface WorktreeInfo {
	path: string;
	branch: string;
	commit: string;
	isPrunable: boolean;
}

export interface CreateWorktreeOptions {
	sessionId: string;
	repoPath: string;
	baseBranch?: string;
}

export class WorktreeManager {
	private gitCache = new Map<string, SimpleGit>();

	/**
	 * Get or create a SimpleGit instance for a repository
	 */
	private getGit(repoPath: string): SimpleGit {
		if (!this.gitCache.has(repoPath)) {
			this.gitCache.set(repoPath, simpleGit(repoPath));
		}
		return this.gitCache.get(repoPath)!;
	}

	/**
	 * Find the git repository root for a given path
	 * Returns null if path is not in a git repository
	 */
	async findGitRoot(path: string): Promise<string | null> {
		try {
			let currentPath = normalize(path);
			const root = dirname(currentPath);

			// Traverse up to find .git directory
			while (currentPath !== root) {
				if (existsSync(join(currentPath, '.git'))) {
					// Verify it's actually a git repo
					const git = this.getGit(currentPath);
					await git.revparse(['--git-dir']);
					return currentPath;
				}
				currentPath = dirname(currentPath);
			}

			// Check root directory
			if (existsSync(join(root, '.git'))) {
				const git = this.getGit(root);
				await git.revparse(['--git-dir']);
				return root;
			}

			return null;
		} catch {
			// Not a git repository or git command failed
			return null;
		}
	}

	/**
	 * Create a new worktree for a session
	 * Returns WorktreeMetadata on success, null if repo is not a git repository
	 */
	async createWorktree(options: CreateWorktreeOptions): Promise<WorktreeMetadata | null> {
		const { sessionId, repoPath, baseBranch = 'HEAD' } = options;

		// Find git root
		const gitRoot = await this.findGitRoot(repoPath);
		if (!gitRoot) {
			console.log(`[WorktreeManager] Not a git repository: ${repoPath}`);
			return null;
		}

		const git = this.getGit(gitRoot);

		// Create .worktrees directory if it doesn't exist
		const worktreesDir = join(gitRoot, '.worktrees');
		if (!existsSync(worktreesDir)) {
			mkdirSync(worktreesDir, { recursive: true });
		}

		// Generate worktree path and branch name
		const worktreePath = join(worktreesDir, sessionId);
		const branchName = `session/${sessionId}`;

		try {
			// Check if worktree already exists (shouldn't happen, but safety check)
			if (existsSync(worktreePath)) {
				console.warn(`[WorktreeManager] Worktree already exists: ${worktreePath}`);
				throw new Error(`Worktree directory already exists: ${worktreePath}`);
			}

			// Create worktree with new branch
			console.log(`[WorktreeManager] Creating worktree at ${worktreePath} from ${baseBranch}`);
			await git.raw(['worktree', 'add', worktreePath, '-b', branchName, baseBranch]);

			console.log(`[WorktreeManager] Successfully created worktree for session ${sessionId}`);

			return {
				isWorktree: true,
				worktreePath,
				mainRepoPath: gitRoot,
				branch: branchName,
			};
		} catch (error) {
			console.error('[WorktreeManager] Failed to create worktree:', error);

			// Try to clean up if worktree directory was created
			if (existsSync(worktreePath)) {
				try {
					await git.raw(['worktree', 'remove', worktreePath, '--force']);
				} catch (cleanupError) {
					console.error('[WorktreeManager] Failed to clean up worktree:', cleanupError);
				}
			}

			throw new Error(
				`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Remove a worktree and optionally delete its branch
	 */
	async removeWorktree(worktree: WorktreeMetadata, deleteBranch = true): Promise<void> {
		const { worktreePath, mainRepoPath, branch } = worktree;

		const git = this.getGit(mainRepoPath);

		try {
			// Check if worktree still exists in git's worktree list
			const worktrees = await this.listWorktrees(mainRepoPath);
			const exists = worktrees.some((w) => w.path === worktreePath);

			if (exists) {
				console.log(`[WorktreeManager] Removing worktree: ${worktreePath}`);
				// --force flag handles uncommitted changes
				await git.raw(['worktree', 'remove', worktreePath, '--force']);
			} else {
				console.log(
					`[WorktreeManager] Worktree not found in git, may have been manually removed: ${worktreePath}`
				);
			}

			// Delete branch (auto-delete strategy as specified)
			if (deleteBranch && branch) {
				try {
					console.log(`[WorktreeManager] Deleting branch: ${branch}`);
					// -D force deletes even if not merged
					await git.branch(['-D', branch]);
				} catch (error) {
					// Branch might not exist or already deleted
					console.warn(`[WorktreeManager] Failed to delete branch ${branch}:`, error);
				}
			}

			console.log(`[WorktreeManager] Successfully removed worktree: ${worktreePath}`);
		} catch (error) {
			console.error('[WorktreeManager] Failed to remove worktree:', error);
			throw new Error(
				`Failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * List all worktrees for a repository
	 */
	async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
		const gitRoot = await this.findGitRoot(repoPath);
		if (!gitRoot) {
			return [];
		}

		const git = this.getGit(gitRoot);

		try {
			// Use --porcelain for machine-readable output
			const output = await git.raw(['worktree', 'list', '--porcelain']);
			return this.parseWorktreeList(output);
		} catch (error) {
			console.error('[WorktreeManager] Failed to list worktrees:', error);
			return [];
		}
	}

	/**
	 * Parse output from `git worktree list --porcelain`
	 */
	private parseWorktreeList(output: string): WorktreeInfo[] {
		const worktrees: WorktreeInfo[] = [];
		const lines = output.trim().split('\n');

		let currentWorktree: Partial<WorktreeInfo> = {};

		for (const line of lines) {
			if (line.startsWith('worktree ')) {
				// Start of new worktree entry
				if (currentWorktree.path) {
					worktrees.push(currentWorktree as WorktreeInfo);
				}
				currentWorktree = {
					path: line.substring('worktree '.length),
					branch: '',
					commit: '',
					isPrunable: false,
				};
			} else if (line.startsWith('HEAD ')) {
				currentWorktree.commit = line.substring('HEAD '.length);
			} else if (line.startsWith('branch ')) {
				currentWorktree.branch = line.substring('branch '.length).replace('refs/heads/', '');
			} else if (line === 'prunable') {
				currentWorktree.isPrunable = true;
			} else if (line === '') {
				// Empty line separates worktrees
				if (currentWorktree.path) {
					worktrees.push(currentWorktree as WorktreeInfo);
					currentWorktree = {};
				}
			}
		}

		// Add last worktree if exists
		if (currentWorktree.path) {
			worktrees.push(currentWorktree as WorktreeInfo);
		}

		return worktrees;
	}

	/**
	 * Cleanup orphaned worktrees (manual cleanup as specified)
	 * This should be called manually via a command, not automatically
	 *
	 * Returns array of cleaned up worktree paths
	 */
	async cleanupOrphanedWorktrees(repoPath: string): Promise<string[]> {
		const gitRoot = await this.findGitRoot(repoPath);
		if (!gitRoot) {
			console.log('[WorktreeManager] Not a git repository, no worktrees to clean up');
			return [];
		}

		const git = this.getGit(gitRoot);
		const cleaned: string[] = [];

		try {
			// Prune removes worktree information for directories that no longer exist
			console.log('[WorktreeManager] Pruning stale worktree metadata...');
			const pruneOutput = await git.raw(['worktree', 'prune', '--verbose']);

			if (pruneOutput.trim()) {
				console.log('[WorktreeManager] Prune output:', pruneOutput);
			}

			// List remaining worktrees and check for prunable ones
			const worktrees = await this.listWorktrees(gitRoot);

			for (const worktree of worktrees) {
				// Skip main worktree
				if (worktree.path === gitRoot) {
					continue;
				}

				// Check if worktree is prunable (directory missing) or if it's a session worktree that doesn't exist
				if (
					worktree.isPrunable ||
					(!existsSync(worktree.path) && worktree.path.includes('.worktrees'))
				) {
					console.log(`[WorktreeManager] Removing orphaned worktree: ${worktree.path}`);

					try {
						await git.raw(['worktree', 'remove', worktree.path, '--force']);
						cleaned.push(worktree.path);

						// Also try to delete the branch if it's a session branch
						if (worktree.branch.startsWith('session/')) {
							try {
								await git.branch(['-D', worktree.branch]);
								console.log(`[WorktreeManager] Deleted orphaned branch: ${worktree.branch}`);
							} catch (error) {
								console.warn(
									`[WorktreeManager] Could not delete branch ${worktree.branch}:`,
									error
								);
							}
						}
					} catch (error) {
						console.error(`[WorktreeManager] Failed to remove worktree ${worktree.path}:`, error);
					}
				}
			}

			console.log(
				`[WorktreeManager] Cleanup complete. Removed ${cleaned.length} orphaned worktrees`
			);
			return cleaned;
		} catch (error) {
			console.error('[WorktreeManager] Failed to cleanup orphaned worktrees:', error);
			throw new Error(
				`Failed to cleanup: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Verify that a worktree is valid and accessible
	 */
	async verifyWorktree(worktree: WorktreeMetadata): Promise<boolean> {
		const { worktreePath, mainRepoPath } = worktree;

		// Check if directory exists
		if (!existsSync(worktreePath)) {
			console.warn(`[WorktreeManager] Worktree directory missing: ${worktreePath}`);
			return false;
		}

		// Check if it's still in git's worktree list
		const worktrees = await this.listWorktrees(mainRepoPath);
		const exists = worktrees.some((w) => w.path === worktreePath);

		if (!exists) {
			console.warn(`[WorktreeManager] Worktree not in git worktree list: ${worktreePath}`);
			return false;
		}

		return true;
	}

	/**
	 * Get the current branch name for a worktree
	 */
	async getCurrentBranch(worktreePath: string): Promise<string | null> {
		try {
			const git = simpleGit(worktreePath);
			const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
			return branch.trim();
		} catch (error) {
			console.error('[WorktreeManager] Failed to get current branch:', error);
			return null;
		}
	}

	/**
	 * Check if worktree branch has commits ahead of the base branch
	 * Returns commit information for user confirmation before archiving
	 */
	async getCommitsAhead(
		worktree: WorktreeMetadata,
		baseBranch?: string
	): Promise<WorktreeCommitStatus> {
		const { mainRepoPath, branch } = worktree;

		try {
			const git = this.getGit(mainRepoPath);

			// Verify the worktree branch exists
			try {
				await git.revparse(['--verify', branch]);
			} catch {
				// Branch doesn't exist yet - no commits ahead
				console.log(`[WorktreeManager] Branch ${branch} does not exist yet, no commits to check`);
				return {
					hasCommitsAhead: false,
					commits: [],
					baseBranch: baseBranch || 'main',
				};
			}

			// Auto-detect base branch: try main, fallback to master, then HEAD
			let base = baseBranch;
			if (!base) {
				try {
					await git.revparse(['--verify', 'main']);
					base = 'main';
				} catch {
					try {
						await git.revparse(['--verify', 'master']);
						base = 'master';
					} catch {
						base = 'HEAD';
					}
				}
			}

			// Verify base branch exists
			try {
				await git.revparse(['--verify', base]);
			} catch {
				// Base branch doesn't exist - this is an edge case
				console.log(`[WorktreeManager] Base branch ${base} does not exist`);
				return {
					hasCommitsAhead: false,
					commits: [],
					baseBranch: base,
				};
			}

			// Get commits: format as hash|author|date|message
			const logFormat = '--format=%H|%an|%ai|%s';
			const logOutput = await git.raw(['log', `${base}..${branch}`, logFormat]);

			const commits: CommitInfo[] = [];
			if (logOutput.trim()) {
				for (const line of logOutput.trim().split('\n')) {
					const [hash, author, date, ...messageParts] = line.split('|');
					commits.push({
						hash: hash.substring(0, 7), // Short hash
						author,
						date,
						message: messageParts.join('|'), // Rejoin in case message had |
					});
				}
			}

			return {
				hasCommitsAhead: commits.length > 0,
				commits,
				baseBranch: base,
			};
		} catch (error) {
			throw new Error(
				`Failed to check commits: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}
