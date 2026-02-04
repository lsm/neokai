/**
 * Worktree Git Commits Tests
 *
 * Unit tests for WorktreeManager.getCommitsAhead() method
 * Tests git commit detection and parsing for worktree branches
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { WorktreeManager } from '../../../src/lib/worktree-manager';
import type { WorktreeMetadata, CommitInfo } from '@neokai/shared';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('WorktreeManager - getCommitsAhead', () => {
	let testRepoPath: string;
	let worktreeManager: WorktreeManager;

	beforeEach(async () => {
		// Create a unique test directory for each test
		testRepoPath = path.join(
			TMP_DIR,
			`test-git-repo-${Date.now()}-${Math.random().toString(36).substring(7)}`
		);
		fs.mkdirSync(testRepoPath, { recursive: true });

		// Initialize git repo with initial commit
		execSync('git init', { cwd: testRepoPath });
		execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
		execSync('git config user.name "Test User"', { cwd: testRepoPath });

		// Create initial commit on main branch
		fs.writeFileSync(path.join(testRepoPath, 'README.md'), '# Test Repo');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

		// Create main branch explicitly (in case default was master)
		execSync('git branch -M main', { cwd: testRepoPath });

		worktreeManager = new WorktreeManager();
	});

	afterEach(() => {
		// Cleanup test repo
		if (fs.existsSync(testRepoPath)) {
			fs.rmSync(testRepoPath, { recursive: true, force: true });
		}
	});

	test('should return empty commits array when branch has no commits ahead', async () => {
		// Create a test branch from main with no new commits
		execSync('git checkout -b test-branch', { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'test-branch',
		};

		const result = await worktreeManager.getCommitsAhead(worktree);

		expect(result.hasCommitsAhead).toBe(false);
		expect(result.commits).toBeArray();
		expect(result.commits.length).toBe(0);
		expect(result.baseBranch).toBe('main');
	});

	test('should detect and parse single commit ahead of main', async () => {
		// Create a branch with one commit
		execSync('git checkout -b feature-branch', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'feature.txt'), 'new feature');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Add new feature"', { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'feature-branch',
		};

		const result = await worktreeManager.getCommitsAhead(worktree);

		expect(result.hasCommitsAhead).toBe(true);
		expect(result.commits.length).toBe(1);
		expect(result.baseBranch).toBe('main');

		const commit = result.commits[0];
		expect(commit.message).toBe('Add new feature');
		expect(commit.author).toBe('Test User');
		expect(commit.hash).toBeString();
		expect(commit.hash.length).toBeGreaterThan(0);
		expect(commit.date).toBeString();
	});

	test('should detect and parse multiple commits ahead', async () => {
		// Create a branch with multiple commits
		execSync('git checkout -b multi-commit-branch', { cwd: testRepoPath });

		// First commit
		fs.writeFileSync(path.join(testRepoPath, 'file1.txt'), 'content 1');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "First commit"', { cwd: testRepoPath });

		// Second commit
		fs.writeFileSync(path.join(testRepoPath, 'file2.txt'), 'content 2');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Second commit"', { cwd: testRepoPath });

		// Third commit
		fs.writeFileSync(path.join(testRepoPath, 'file3.txt'), 'content 3');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Third commit"', { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'multi-commit-branch',
		};

		const result = await worktreeManager.getCommitsAhead(worktree);

		expect(result.hasCommitsAhead).toBe(true);
		expect(result.commits.length).toBe(3);
		expect(result.baseBranch).toBe('main');

		// Commits should be in reverse chronological order (newest first)
		expect(result.commits[0].message).toBe('Third commit');
		expect(result.commits[1].message).toBe('Second commit');
		expect(result.commits[2].message).toBe('First commit');

		// All commits should have required fields
		result.commits.forEach((commit: CommitInfo) => {
			expect(commit.hash).toBeString();
			expect(commit.message).toBeString();
			expect(commit.author).toBe('Test User');
			expect(commit.date).toBeString();
		});
	});

	test('should auto-detect master as base branch if main does not exist', async () => {
		// Create a new repo with master as default
		const masterRepoPath = path.join(
			TMP_DIR,
			`test-master-repo-${Date.now()}-${Math.random().toString(36).substring(7)}`
		);
		fs.mkdirSync(masterRepoPath, { recursive: true });

		execSync('git init', { cwd: masterRepoPath });
		execSync('git config user.email "test@test.com"', { cwd: masterRepoPath });
		execSync('git config user.name "Test User"', { cwd: masterRepoPath });

		// Create initial commit on master
		fs.writeFileSync(path.join(masterRepoPath, 'README.md'), '# Master Repo');
		execSync('git add .', { cwd: masterRepoPath });
		execSync('git commit -m "Initial commit on master"', {
			cwd: masterRepoPath,
		});

		// Create feature branch
		execSync('git checkout -b feature', { cwd: masterRepoPath });
		fs.writeFileSync(path.join(masterRepoPath, 'feature.txt'), 'feature');
		execSync('git add .', { cwd: masterRepoPath });
		execSync('git commit -m "Add feature"', { cwd: masterRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: masterRepoPath,
			mainRepoPath: masterRepoPath,
			branch: 'feature',
		};

		const result = await worktreeManager.getCommitsAhead(worktree);

		expect(result.hasCommitsAhead).toBe(true);
		expect(result.commits.length).toBe(1);
		expect(result.baseBranch).toBe('master');

		// Cleanup
		fs.rmSync(masterRepoPath, { recursive: true, force: true });
	});

	test('should use explicitly provided base branch', async () => {
		// Create a custom base branch
		execSync('git checkout -b custom-base', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'base.txt'), 'base content');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Custom base commit"', { cwd: testRepoPath });

		// Create feature branch from custom base
		execSync('git checkout -b feature-from-custom', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'feature.txt'), 'feature content');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Feature from custom base"', { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'feature-from-custom',
		};

		// Use custom-base as the base branch
		const result = await worktreeManager.getCommitsAhead(worktree, 'custom-base');

		expect(result.hasCommitsAhead).toBe(true);
		expect(result.commits.length).toBe(1);
		expect(result.baseBranch).toBe('custom-base');
		expect(result.commits[0].message).toBe('Feature from custom base');
	});

	test('should handle commit messages with special characters', async () => {
		execSync('git checkout -b special-chars', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'file.txt'), 'content');
		execSync('git add .', { cwd: testRepoPath });

		// Commit with special characters in message (git strips outer quotes)
		const specialMessage = 'feat(archive): add | pipe and & ampersand';
		execSync(`git commit -m "${specialMessage}"`, { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'special-chars',
		};

		const result = await worktreeManager.getCommitsAhead(worktree);

		expect(result.hasCommitsAhead).toBe(true);
		expect(result.commits.length).toBe(1);
		expect(result.commits[0].message).toBe(specialMessage);
	});

	test('should handle author names with special characters', async () => {
		execSync('git checkout -b author-test', { cwd: testRepoPath });

		// Change git config to use special characters in name
		execSync('git config user.name "Test O\'Neill (Dev)"', {
			cwd: testRepoPath,
		});

		fs.writeFileSync(path.join(testRepoPath, 'file.txt'), 'content');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Test commit"', { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'author-test',
		};

		const result = await worktreeManager.getCommitsAhead(worktree);

		expect(result.hasCommitsAhead).toBe(true);
		expect(result.commits.length).toBe(1);
		expect(result.commits[0].author).toBe("Test O'Neill (Dev)");
	});

	test('should filter out commits already merged via merge commit', async () => {
		// Create session branch with commits
		execSync('git checkout -b session-branch', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'file1.txt'), 'content 1');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Commit 1"', { cwd: testRepoPath });

		fs.writeFileSync(path.join(testRepoPath, 'file2.txt'), 'content 2');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Commit 2"', { cwd: testRepoPath });

		// Merge session branch into main
		execSync('git checkout main', { cwd: testRepoPath });
		execSync('git merge --no-ff session-branch -m "Merge session branch"', {
			cwd: testRepoPath,
		});

		// Go back to session branch
		execSync('git checkout session-branch', { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'session-branch',
		};

		const result = await worktreeManager.getCommitsAhead(worktree, 'main');

		// Should report no commits ahead (they're merged via merge commit)
		expect(result.hasCommitsAhead).toBe(false);
		expect(result.commits).toBeArray();
		expect(result.commits.length).toBe(0);
	});

	test('should only report unmerged commits when some are merged', async () => {
		// Create session branch
		execSync('git checkout -b session-branch', { cwd: testRepoPath });

		// Commit 1
		fs.writeFileSync(path.join(testRepoPath, 'file1.txt'), 'content 1');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Commit 1"', { cwd: testRepoPath });

		// Commit 2
		fs.writeFileSync(path.join(testRepoPath, 'file2.txt'), 'content 2');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Commit 2"', { cwd: testRepoPath });

		// Merge to main
		execSync('git checkout main', { cwd: testRepoPath });
		execSync('git merge --no-ff session-branch -m "Merge"', {
			cwd: testRepoPath,
		});

		// Add more commits to session branch
		execSync('git checkout session-branch', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'file3.txt'), 'content 3');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Commit 3 (new)"', { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'session-branch',
		};

		const result = await worktreeManager.getCommitsAhead(worktree, 'main');

		// Should only report Commit 3
		expect(result.hasCommitsAhead).toBe(true);
		expect(result.commits.length).toBe(1);
		expect(result.commits[0].message).toBe('Commit 3 (new)');
	});

	test('should still detect squash-merged commits', async () => {
		// Create session branch
		execSync('git checkout -b session-branch', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'file1.txt'), 'content 1');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Commit 1"', { cwd: testRepoPath });

		// Squash merge to main
		execSync('git checkout main', { cwd: testRepoPath });
		execSync('git merge --squash session-branch', { cwd: testRepoPath });
		execSync('git commit -m "Squashed changes"', { cwd: testRepoPath });

		// Back to session branch
		execSync('git checkout session-branch', { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'session-branch',
		};

		const result = await worktreeManager.getCommitsAhead(worktree, 'main');

		// Should detect squash merge via file content check
		expect(result.hasCommitsAhead).toBe(false);
		expect(result.commits).toBeArray();
		expect(result.commits.length).toBe(0);
	});

	test('should handle bidirectional merge commits (PR workflow)', async () => {
		// Step 1: Create session branch with 2 commits
		execSync('git checkout -b session-branch', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'file1.txt'), 'content 1');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Commit 1"', { cwd: testRepoPath });

		fs.writeFileSync(path.join(testRepoPath, 'file2.txt'), 'content 2');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Commit 2"', { cwd: testRepoPath });

		// Step 2: Merge session branch to main with merge commit M1 (simulating PR merge)
		execSync('git checkout main', { cwd: testRepoPath });
		execSync('git merge --no-ff session-branch -m "Merge session-branch into main"', {
			cwd: testRepoPath,
		});

		// Step 3: Merge main back to session branch (creating merge commit M2)
		execSync('git checkout session-branch', { cwd: testRepoPath });
		execSync('git merge --no-ff main -m "Merge main into session-branch"', {
			cwd: testRepoPath,
		});

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'session-branch',
		};

		const result = await worktreeManager.getCommitsAhead(worktree, 'main');

		// Should report no commits ahead since Commit 1 and Commit 2 are already in main
		// via the merge commit M1
		expect(result.hasCommitsAhead).toBe(false);
		expect(result.commits).toBeArray();
		expect(result.commits.length).toBe(0);
		expect(result.baseBranch).toBe('main');
	});

	test('should filter out commits merged via PR even when git log shows them', async () => {
		// This test specifically validates the scenario where:
		// 1. Session branch has commits
		// 2. Session branch is merged to main via a PR (creates merge commit on main)
		// 3. The merge commit message "Merge session branch into main" exists on main
		// 4. When checking getCommitsAhead, it should filter out the individual commits
		//    even though git log main..session-branch might show them

		// Step 1: Create session branch with 3 content commits
		execSync('git checkout -b session-branch', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'feature1.txt'), 'feature 1');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "feat: add feature 1"', { cwd: testRepoPath });
		const commit1Hash = execSync('git rev-parse HEAD', { cwd: testRepoPath }).toString().trim();

		fs.writeFileSync(path.join(testRepoPath, 'feature2.txt'), 'feature 2');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "feat: add feature 2"', { cwd: testRepoPath });
		const commit2Hash = execSync('git rev-parse HEAD', { cwd: testRepoPath }).toString().trim();

		fs.writeFileSync(path.join(testRepoPath, 'feature3.txt'), 'feature 3');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "feat: add feature 3"', { cwd: testRepoPath });
		const commit3Hash = execSync('git rev-parse HEAD', { cwd: testRepoPath }).toString().trim();

		// Step 2: Simulate a PR merge by creating a merge commit on main
		execSync('git checkout main', { cwd: testRepoPath });
		execSync('git merge --no-ff session-branch -m "Merge session branch into main"', {
			cwd: testRepoPath,
			env: { ...process.env, GIT_EDITOR: ':' },
		});

		// Step 3: Merge main back to session branch (simulating updating session branch after PR merge)
		// This creates a merge commit "Merge origin/dev into session branch" or similar
		execSync('git checkout session-branch', { cwd: testRepoPath });
		execSync('git merge --no-ff main -m "Merge origin/main into session-branch"', {
			cwd: testRepoPath,
			env: { ...process.env, GIT_EDITOR: ':' },
		});

		// Step 4: Verify git log behavior - this is what we're testing against
		// git log main..session-branch will show commits, but getCommitsAhead should filter them
		const gitLogOutput = execSync('git log main..session-branch --oneline', {
			cwd: testRepoPath,
		})
			.toString()
			.trim();

		// git log SHOULD show the merge commit and potentially the original commits
		// This demonstrates why we need the ancestry filtering logic
		expect(gitLogOutput.length).toBeGreaterThan(0);

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'session-branch',
		};

		const result = await worktreeManager.getCommitsAhead(worktree, 'main');

		// CRITICAL ASSERTION: Even though git log main..session-branch shows commits,
		// getCommitsAhead should filter them out because they're reachable from main
		// via the merge commit "Merge session branch into main"
		expect(result.hasCommitsAhead).toBe(false);
		expect(result.commits).toBeArray();
		expect(result.commits.length).toBe(0);
		expect(result.baseBranch).toBe('main');

		// Additional verification: ensure the original commits are reachable from main
		const isCommit1Ancestor = execSync(
			`git merge-base --is-ancestor ${commit1Hash} main && echo "true" || echo "false"`,
			{ cwd: testRepoPath }
		)
			.toString()
			.trim();
		expect(isCommit1Ancestor).toBe('true');

		const isCommit2Ancestor = execSync(
			`git merge-base --is-ancestor ${commit2Hash} main && echo "true" || echo "false"`,
			{ cwd: testRepoPath }
		)
			.toString()
			.trim();
		expect(isCommit2Ancestor).toBe('true');

		const isCommit3Ancestor = execSync(
			`git merge-base --is-ancestor ${commit3Hash} main && echo "true" || echo "false"`,
			{ cwd: testRepoPath }
		)
			.toString()
			.trim();
		expect(isCommit3Ancestor).toBe('true');
	});

	test('should handle merge commits from origin/dev correctly', async () => {
		// This test validates that merge commits like "Merge origin/dev into session branch"
		// are handled correctly - they might show up in git log but their content is already merged

		// Step 1: Create session branch with feature 1
		execSync('git checkout -b session-branch', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'feature1.txt'), 'feature 1');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "feat: add feature 1"', { cwd: testRepoPath });

		// Step 2: Merge session-branch to main (simulating PR merge)
		execSync('git checkout main', { cwd: testRepoPath });
		execSync('git merge --no-ff session-branch -m "Merge session-branch into main"', {
			cwd: testRepoPath,
			env: { ...process.env, GIT_EDITOR: ':' },
		});

		// Step 3: Create dev branch with dev feature
		execSync('git checkout -b dev', { cwd: testRepoPath });
		fs.writeFileSync(path.join(testRepoPath, 'dev-feature.txt'), 'dev feature');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "feat: add dev feature"', { cwd: testRepoPath });

		// Step 4: Merge dev to main
		execSync('git checkout main', { cwd: testRepoPath });
		execSync('git merge --no-ff dev -m "Merge dev into main"', {
			cwd: testRepoPath,
			env: { ...process.env, GIT_EDITOR: ':' },
		});

		// Step 5: Merge main to session branch (creating "Merge origin/main into session-branch")
		execSync('git checkout session-branch', { cwd: testRepoPath });
		execSync('git merge --no-ff main -m "Merge origin/main into session-branch"', {
			cwd: testRepoPath,
			env: { ...process.env, GIT_EDITOR: ':' },
		});

		// Step 6: Add another commit to session branch
		fs.writeFileSync(path.join(testRepoPath, 'feature2.txt'), 'feature 2');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "feat: add feature 2"', { cwd: testRepoPath });

		const worktree: WorktreeMetadata = {
			isWorktree: true,
			worktreePath: testRepoPath,
			mainRepoPath: testRepoPath,
			branch: 'session-branch',
		};

		const result = await worktreeManager.getCommitsAhead(worktree, 'main');

		// Currently, the implementation reports both "feat: add feature 2" and the merge commit
		// "Merge origin/main into session-branch". This is because the merge commit is not
		// an ancestor of main (it's on session-branch), even though its CONTENT is already on main.
		//
		// TODO: The ideal behavior would be to filter out merge commits whose content is
		// already on main, even if the merge commit itself is not an ancestor of main.
		// For now, we accept this behavior and test the current implementation.
		expect(result.hasCommitsAhead).toBe(true);
		expect(result.commits.length).toBe(2);
		expect(result.commits[0].message).toBe('feat: add feature 2');
		expect(result.commits[1].message).toBe('Merge origin/main into session-branch');
		expect(result.baseBranch).toBe('main');
	});
});
