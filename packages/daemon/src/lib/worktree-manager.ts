import simpleGit, { SimpleGit } from 'simple-git';
import { dirname, join, normalize } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { WorktreeMetadata, CommitInfo, WorktreeCommitStatus } from '@liuboer/shared';
import { Logger } from './logger';

export interface WorktreeInfo {
	path: string;
	branch: string;
	commit: string;
	isPrunable: boolean;
}

export interface CreateWorktreeOptions {
	sessionId: string;
	repoPath: string;
	branchName?: string; // Optional custom branch name
	baseBranch?: string;
}

export class WorktreeManager {
	private gitCache = new Map<string, SimpleGit>();
	private logger = new Logger('WorktreeManager');

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
	 * Check if a git branch exists
	 */
	private async checkBranchExists(repoPath: string, branchName: string): Promise<boolean> {
		try {
			const git = this.getGit(repoPath);
			const result = await git.raw(['branch', '--list', branchName]);
			return result.trim().length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Encode an absolute path to a filesystem-safe directory name
	 * Uses the same approach as Claude Code (~/.claude/projects/)
	 *
	 * Examples:
	 * - /Users/alice/project → -Users-alice-project
	 * - /home/john_doe/my_project → -home-john_doe-my_project
	 * - C:\Users\alice\project → -C--Users-alice-project
	 */
	private encodeRepoPath(repoPath: string): string {
		// Normalize path separators (handle both Unix and Windows)
		const normalizedPath = repoPath.replace(/\\/g, '/');

		// Strip leading slash (if any) and replace remaining slashes with dashes
		// Then prepend a dash to indicate it was an absolute path
		const encoded = normalizedPath.startsWith('/')
			? '-' + normalizedPath.slice(1).replace(/\//g, '-')
			: '-' + normalizedPath.replace(/\//g, '-');

		return encoded;
	}

	/**
	 * Get the worktree base directory for a repository
	 * Format: ~/.liuboer/projects/{encoded-repo-path}/worktrees/
	 * Example: ~/.liuboer/projects/-Users-alice-project/worktrees/
	 */
	private getWorktreeBaseDir(gitRoot: string): string {
		const encodedPath = this.encodeRepoPath(gitRoot);
		return join(homedir(), '.liuboer', 'projects', encodedPath, 'worktrees');
	}

	/**
	 * Create a new worktree for a session
	 * Returns WorktreeMetadata on success, null if repo is not a git repository
	 */
	async createWorktree(options: CreateWorktreeOptions): Promise<WorktreeMetadata | null> {
		const { sessionId, repoPath, branchName: customBranchName, baseBranch = 'HEAD' } = options;

		// Find git root
		const gitRoot = await this.findGitRoot(repoPath);
		if (!gitRoot) {
			this.logger.info(`[WorktreeManager] Not a git repository: ${repoPath}`);
			return null;
		}

		const git = this.getGit(gitRoot);

		// Create worktree base directory if it doesn't exist
		// Format: ~/.liuboer/projects/{encoded-repo-path}/worktrees/
		const worktreesDir = this.getWorktreeBaseDir(gitRoot);
		if (!existsSync(worktreesDir)) {
			mkdirSync(worktreesDir, { recursive: true });
		}

		// Generate worktree path and branch name
		const worktreePath = join(worktreesDir, sessionId);
		let branchName = customBranchName || `session/${sessionId}`;

		try {
			// Check if worktree already exists (shouldn't happen, but safety check)
			if (existsSync(worktreePath)) {
				this.logger.warn(`[WorktreeManager] Worktree already exists: ${worktreePath}`);
				throw new Error(`Worktree directory already exists: ${worktreePath}`);
			}

			// Check if branch already exists (and fallback to UUID if it does)
			if (customBranchName) {
				const branchExists = await this.checkBranchExists(gitRoot, customBranchName);
				if (branchExists) {
					this.logger.warn(
						`[WorktreeManager] Branch ${customBranchName} already exists, using UUID fallback`
					);
					branchName = `session/${sessionId}`; // Fallback to UUID-based branch
				}
			}

			// Create worktree with new branch
			this.logger.info(
				`[WorktreeManager] Creating worktree at ${worktreePath} with branch ${branchName} from ${baseBranch}`
			);
			await git.raw(['worktree', 'add', worktreePath, '-b', branchName, baseBranch]);

			this.logger.info(`[WorktreeManager] Successfully created worktree for session ${sessionId}`);

			return {
				isWorktree: true,
				worktreePath,
				mainRepoPath: gitRoot,
				branch: branchName,
			};
		} catch (error) {
			this.logger.error(' Failed to create worktree:', error);

			// Try to clean up if worktree directory was created
			if (existsSync(worktreePath)) {
				try {
					await git.raw(['worktree', 'remove', worktreePath, '--force']);
				} catch (cleanupError) {
					this.logger.error(' Failed to clean up worktree:', cleanupError);
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
				this.logger.info(`[WorktreeManager] Removing worktree: ${worktreePath}`);
				// --force flag handles uncommitted changes
				await git.raw(['worktree', 'remove', worktreePath, '--force']);
			} else {
				this.logger.info(
					`[WorktreeManager] Worktree not found in git, may have been manually removed: ${worktreePath}`
				);
			}

			// Delete branch (auto-delete strategy as specified)
			if (deleteBranch && branch) {
				try {
					this.logger.info(`[WorktreeManager] Deleting branch: ${branch}`);
					// -D force deletes even if not merged
					await git.branch(['-D', branch]);
				} catch (error) {
					// Branch might not exist or already deleted
					this.logger.warn(`[WorktreeManager] Failed to delete branch ${branch}:`, error);
				}
			}

			this.logger.info(`[WorktreeManager] Successfully removed worktree: ${worktreePath}`);
		} catch (error) {
			this.logger.error(' Failed to remove worktree:', error);
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
			this.logger.error(' Failed to list worktrees:', error);
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
			this.logger.info(' Not a git repository, no worktrees to clean up');
			return [];
		}

		const git = this.getGit(gitRoot);
		const cleaned: string[] = [];

		try {
			// Prune removes worktree information for directories that no longer exist
			this.logger.info(' Pruning stale worktree metadata...');
			const pruneOutput = await git.raw(['worktree', 'prune', '--verbose']);

			if (pruneOutput.trim()) {
				this.logger.info(' Prune output:', pruneOutput);
			}

			// List remaining worktrees and check for prunable ones
			const worktrees = await this.listWorktrees(gitRoot);

			for (const worktree of worktrees) {
				// Skip main worktree
				if (worktree.path === gitRoot) {
					continue;
				}

				// Check if worktree is prunable (directory missing) or if it's a session worktree that doesn't exist
				// Support old paths (.worktrees, .liuboer/worktrees) and new path (.liuboer/projects)
				if (
					worktree.isPrunable ||
					(!existsSync(worktree.path) &&
						(worktree.path.includes('.worktrees') ||
							worktree.path.includes('.liuboer/worktrees') ||
							worktree.path.includes('.liuboer/projects')))
				) {
					this.logger.info(`[WorktreeManager] Removing orphaned worktree: ${worktree.path}`);

					try {
						await git.raw(['worktree', 'remove', worktree.path, '--force']);
						cleaned.push(worktree.path);

						// Also try to delete the branch if it's a session branch
						if (worktree.branch.startsWith('session/')) {
							try {
								await git.branch(['-D', worktree.branch]);
								this.logger.info(`[WorktreeManager] Deleted orphaned branch: ${worktree.branch}`);
							} catch (error) {
								this.logger.warn(
									`[WorktreeManager] Could not delete branch ${worktree.branch}:`,
									error
								);
							}
						}
					} catch (error) {
						this.logger.error(
							`[WorktreeManager] Failed to remove worktree ${worktree.path}:`,
							error
						);
					}
				}
			}

			this.logger.info(
				`[WorktreeManager] Cleanup complete. Removed ${cleaned.length} orphaned worktrees`
			);
			return cleaned;
		} catch (error) {
			this.logger.error(' Failed to cleanup orphaned worktrees:', error);
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
			this.logger.warn(`[WorktreeManager] Worktree directory missing: ${worktreePath}`);
			return false;
		}

		// Check if it's still in git's worktree list
		const worktrees = await this.listWorktrees(mainRepoPath);
		const exists = worktrees.some((w) => w.path === worktreePath);

		if (!exists) {
			this.logger.warn(`[WorktreeManager] Worktree not in git worktree list: ${worktreePath}`);
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
			this.logger.error(' Failed to get current branch:', error);
			return null;
		}
	}

	/**
	 * Rename a branch (works even when branch is checked out in a worktree)
	 * Can be called from root repo or from within the worktree itself
	 *
	 * @param repoPath - Path to the git repository (root or worktree)
	 * @param oldBranch - Current branch name
	 * @param newBranch - New branch name
	 * @returns true if rename succeeded, false otherwise
	 */
	async renameBranch(repoPath: string, oldBranch: string, newBranch: string): Promise<boolean> {
		try {
			const git = this.getGit(repoPath);

			// Check if new branch name already exists
			const branchExists = await this.checkBranchExists(repoPath, newBranch);
			if (branchExists) {
				this.logger.warn(`[WorktreeManager] Branch ${newBranch} already exists, cannot rename`);
				return false;
			}

			this.logger.info(`[WorktreeManager] Renaming branch ${oldBranch} to ${newBranch}`);
			await git.branch(['-m', oldBranch, newBranch]);
			this.logger.info(`[WorktreeManager] Successfully renamed branch to ${newBranch}`);
			return true;
		} catch (error) {
			this.logger.error(' Failed to rename branch:', error);
			return false;
		}
	}

	/**
	 * Get the default branch of the repository
	 * Uses symbolic-ref to get the branch that HEAD points to on the remote
	 */
	private async getDefaultBranch(repoPath: string): Promise<string> {
		const git = this.getGit(repoPath);

		try {
			// Try to get the default branch from origin/HEAD
			const defaultBranch = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
			// Returns "origin/main" or "origin/master", extract just the branch name
			const branchName = defaultBranch.trim().replace('origin/', '');
			if (branchName) {
				this.logger.info(
					`[WorktreeManager] Detected default branch from origin/HEAD: ${branchName}`
				);
				return branchName;
			}
		} catch {
			// origin/HEAD not set, continue to fallback
		}

		// Fallback: try common branch names
		try {
			await git.revparse(['--verify', 'main']);
			this.logger.info(' Using fallback default branch: main');
			return 'main';
		} catch {
			try {
				await git.revparse(['--verify', 'master']);
				this.logger.info(' Using fallback default branch: master');
				return 'master';
			} catch {
				// Ultimate fallback
				this.logger.info(' Using ultimate fallback: HEAD');
				return 'HEAD';
			}
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
				this.logger.info(
					`[WorktreeManager] Branch ${branch} does not exist yet, no commits to check`
				);
				const defaultBranch = await this.getDefaultBranch(mainRepoPath);
				return {
					hasCommitsAhead: false,
					commits: [],
					baseBranch: baseBranch || defaultBranch,
				};
			}

			// Auto-detect base branch from repository's default branch
			let base = baseBranch;
			if (!base) {
				base = await this.getDefaultBranch(mainRepoPath);
			}

			// Verify base branch exists
			try {
				await git.revparse(['--verify', base]);
			} catch {
				// Base branch doesn't exist - this is an edge case
				this.logger.info(`[WorktreeManager] Base branch ${base} does not exist`);
				return {
					hasCommitsAhead: false,
					commits: [],
					baseBranch: base,
				};
			}

			// First check if there's an actual diff between branches
			// This handles squash merges where commits have different hashes but same content
			const diffOutput = await git.raw(['diff', '--stat', `${base}..${branch}`]);
			if (!diffOutput.trim()) {
				// No actual diff - changes already merged (likely via squash merge)
				this.logger.info(
					`[WorktreeManager] Branch ${branch} has same content as ${base} (squash merged)`
				);
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
