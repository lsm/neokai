import simpleGit, { SimpleGit } from 'simple-git';
import { dirname, join, normalize } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { WorktreeMetadata, CommitInfo, WorktreeCommitStatus } from '@neokai/shared';
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
	 * Detect if workspace supports worktrees (is a git repository)
	 * WITHOUT creating a worktree
	 *
	 * @param workspacePath - Path to check for git repository
	 * @returns Object with isGitRepo flag and gitRoot path
	 */
	async detectGitSupport(workspacePath: string): Promise<{
		isGitRepo: boolean;
		gitRoot: string | null;
	}> {
		const gitRoot = await this.findGitRoot(workspacePath);
		return {
			isGitRepo: gitRoot !== null,
			gitRoot,
		};
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
	 * Format: ~/.neokai/projects/{encoded-repo-path}/worktrees/
	 * Example: ~/.neokai/projects/-Users-alice-project/worktrees/
	 *
	 * For testing, set TEST_WORKTREE_BASE_DIR to override the base directory
	 */
	private getWorktreeBaseDir(gitRoot: string): string {
		const encodedPath = this.encodeRepoPath(gitRoot);

		// Check for test environment variable
		const testBaseDir = process.env.TEST_WORKTREE_BASE_DIR;
		if (testBaseDir) {
			return join(testBaseDir, encodedPath, 'worktrees');
		}

		return join(homedir(), '.neokai', 'projects', encodedPath, 'worktrees');
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
			return null;
		}

		const git = this.getGit(gitRoot);

		// Create worktree base directory if it doesn't exist
		// Format: ~/.neokai/projects/{encoded-repo-path}/worktrees/
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
				throw new Error(`Worktree directory already exists: ${worktreePath}`);
			}

			// Check if branch already exists (and fallback to UUID if it does)
			if (customBranchName) {
				const branchExists = await this.checkBranchExists(gitRoot, customBranchName);
				if (branchExists) {
					branchName = `session/${sessionId}`; // Fallback to UUID-based branch
				}
			}

			// Create worktree with new branch
			await git.raw(['worktree', 'add', worktreePath, '-b', branchName, baseBranch]);

			// Initialize git submodules in the new worktree (no-op if no submodules)
			try {
				const worktreeGit = this.getGit(worktreePath);
				await worktreeGit.raw(['submodule', 'update', '--init', '--recursive']);
				/* v8 ignore next 2 */
			} catch {
				// Submodule initialization failed, but this is non-fatal
			}

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
				// --force flag handles uncommitted changes
				await git.raw(['worktree', 'remove', worktreePath, '--force']);
			}

			// Delete branch (auto-delete strategy as specified)
			if (deleteBranch && branch) {
				try {
					// -D force deletes even if not merged
					await git.branch(['-D', branch]);
				} catch {
					// Branch might not exist or already deleted
				}
			}
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
			return [];
		}

		const git = this.getGit(gitRoot);
		const cleaned: string[] = [];

		try {
			// Prune removes worktree information for directories that no longer exist
			await git.raw(['worktree', 'prune', '--verbose']);

			// List remaining worktrees and check for prunable ones
			const worktrees = await this.listWorktrees(gitRoot);

			for (const worktree of worktrees) {
				// Skip main worktree
				if (worktree.path === gitRoot) {
					continue;
				}

				// Check if worktree is prunable (directory missing) or if it's a session worktree that doesn't exist
				// Support session worktrees (both production .neokai/projects and test directories)
				const testBaseDir = process.env.TEST_WORKTREE_BASE_DIR;
				const isSessionWorktree = testBaseDir
					? worktree.path.startsWith(testBaseDir)
					: worktree.path.includes('.neokai/projects');

				if (worktree.isPrunable || (!existsSync(worktree.path) && isSessionWorktree)) {
					try {
						await git.raw(['worktree', 'remove', worktree.path, '--force']);
						cleaned.push(worktree.path);

						// Also try to delete the branch if it's a session branch
						if (worktree.branch.startsWith('session/')) {
							try {
								await git.branch(['-D', worktree.branch]);
							} catch {
								// Could not delete branch, but this is non-fatal
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
			return false;
		}

		// Check if it's still in git's worktree list
		const worktrees = await this.listWorktrees(mainRepoPath);
		const exists = worktrees.some((w) => w.path === worktreePath);

		if (!exists) {
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
				return false;
			}

			await git.branch(['-m', oldBranch, newBranch]);
			return true;
		} catch (error) {
			this.logger.error('Failed to rename branch:', error);
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
				return branchName;
			}
		} catch {
			// origin/HEAD not set, continue to fallback
		}

		// Fallback: try common branch names
		try {
			await git.revparse(['--verify', 'main']);
			return 'main';
		} catch {
			try {
				await git.revparse(['--verify', 'master']);
				return 'master';
			} catch {
				// Ultimate fallback
				return 'HEAD';
			}
		}
	}

	/**
	 * Detect the current branch of the repository
	 * Returns the branch that HEAD is currently on
	 * @private
	 */
	private async detectCurrentBranch(repoPath: string): Promise<string> {
		const git = this.getGit(repoPath);

		try {
			const currentBranch = (await git.raw(['branch', '--show-current'])).trim();
			if (currentBranch) {
				return currentBranch;
			}
		} catch {
			// Error getting current branch, fall through to default
		}

		// Fallback to default branch
		return await this.getDefaultBranch(repoPath);
	}

	/**
	 * Get the base branch to compare against for commit checking
	 * Strategy:
	 * 1. If main repo is on a session branch, use dev/develop/main/master as the base
	 * 2. If main repo is on dev/develop, use that as the base
	 * 3. Otherwise prefer main/master over current branch
	 */
	private async getBaseBranch(repoPath: string): Promise<string> {
		const git = this.getGit(repoPath);
		const currentBranch = await this.detectCurrentBranch(repoPath);

		// If current branch is a session branch, look for a development branch to use as base
		if (currentBranch.startsWith('session/')) {
			// Try common development branches in order
			const devBranches = ['dev', 'develop', 'development', 'main', 'master'];
			for (const branch of devBranches) {
				try {
					await git.revparse(['--verify', branch]);
					return branch;
				} catch {
					// Branch doesn't exist, continue
				}
			}
		}

		// If current branch is dev/develop, use it (this is the integration branch)
		if (['dev', 'develop', 'development'].includes(currentBranch)) {
			return currentBranch;
		}

		// Try to use main or master if they exist (preferred for production workflows)
		for (const preferredBranch of ['main', 'master']) {
			try {
				await git.revparse(['--verify', preferredBranch]);
				return preferredBranch;
			} catch {
				// Branch doesn't exist, continue
			}
		}

		// Fallback to current branch
		return currentBranch;
	}

	/**
	 * Check if a commit is an ancestor of a branch
	 * Returns true if the commit is reachable from the branch
	 *
	 * Uses git merge-base to determine ancestry:
	 * If git merge-base(branch, commit) returns commit, then commit is an ancestor of branch
	 */
	private async isCommitAncestor(
		repoPath: string,
		commitHash: string,
		branch: string
	): Promise<boolean> {
		try {
			const git = this.getGit(repoPath);
			// Get the merge base between the branch and the commit
			const mergeBase = (await git.raw(['merge-base', branch, commitHash])).trim();

			// If merge base equals the commit hash, the commit is an ancestor of the branch
			// (The merge base is the best common ancestor; if it's the commit itself,
			// then the commit is reachable from the branch)
			return mergeBase === commitHash || mergeBase.startsWith(commitHash);
		} catch {
			// On error, assume not an ancestor (safe default)
			return false;
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
				const defaultBranch = await this.getDefaultBranch(mainRepoPath);
				return {
					hasCommitsAhead: false,
					commits: [],
					baseBranch: baseBranch || defaultBranch,
				};
			}

			// Auto-detect base branch
			// Prefer main/master for production branches, fallback to current branch for dev branches
			let base = baseBranch;
			if (!base) {
				base = await this.getBaseBranch(mainRepoPath);
			}

			// Verify base branch exists
			try {
				await git.revparse(['--verify', base]);
			} catch {
				// Base branch doesn't exist - this is an edge case
				return {
					hasCommitsAhead: false,
					commits: [],
					baseBranch: base,
				};
			}

			// Check if session branch's changes are already on base (handles squash merges)
			// Get the merge base to understand what files the session branch changed
			const mergeBase = (await git.raw(['merge-base', base, branch])).trim();

			// Get files modified by the session branch (from merge-base)
			const sessionChangedFiles = await git.raw(['diff', '--name-only', mergeBase, branch]);
			const changedFiles = sessionChangedFiles.trim().split('\n').filter(Boolean);

			if (changedFiles.length === 0) {
				// No files changed by session branch
				return {
					hasCommitsAhead: false,
					commits: [],
					baseBranch: base,
				};
			}

			// For each file the session branch changed, check if it matches base
			// If session branch's version matches base's version, the changes are already on base
			let hasUniqueChanges = false;
			for (const file of changedFiles) {
				try {
					// Compare the file content between session branch and base
					const diff = await git.raw(['diff', `${branch}:${file}`, `${base}:${file}`]);
					if (diff.trim()) {
						// File differs - session has changes not on base
						hasUniqueChanges = true;
						break;
					}
				} catch {
					// File might not exist on one side - that's a real difference
					hasUniqueChanges = true;
					break;
				}
			}

			if (!hasUniqueChanges) {
				// All files match - changes already on base (squash merged)
				return {
					hasCommitsAhead: false,
					commits: [],
					baseBranch: base,
				};
			}

			// Get commits: format as hash|author|date|message
			const logFormat = '--format=%H|%an|%ai|%s';
			const logOutput = await git.raw(['log', `${base}..${branch}`, logFormat]);

			// Parse commits and store both full hash and display info
			const commits: Array<{ fullHash: string; info: CommitInfo }> = [];
			if (logOutput.trim()) {
				for (const line of logOutput.trim().split('\n')) {
					const [fullHash, author, date, ...messageParts] = line.split('|');
					commits.push({
						fullHash,
						info: {
							hash: fullHash.substring(0, 7), // Short hash for display
							author,
							date,
							message: messageParts.join('|'),
						},
					});
				}
			}

			// Filter out commits already reachable from base via merge commits
			const unmergedCommits: CommitInfo[] = [];

			for (const commit of commits) {
				const isAncestor = await this.isCommitAncestor(mainRepoPath, commit.fullHash, base);

				if (!isAncestor) {
					unmergedCommits.push(commit.info);
				}
			}

			return {
				hasCommitsAhead: unmergedCommits.length > 0,
				commits: unmergedCommits,
				baseBranch: base,
			};
		} catch (error) {
			throw new Error(
				`Failed to check commits: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}
