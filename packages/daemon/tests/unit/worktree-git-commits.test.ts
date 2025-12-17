/**
 * Worktree Git Commits Tests
 *
 * Unit tests for WorktreeManager.getCommitsAhead() method
 * Tests git commit detection and parsing for worktree branches
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { WorktreeManager } from '../../src/lib/worktree-manager';
import type { WorktreeMetadata, CommitInfo } from '@liuboer/shared';
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
		execSync('git commit -m "Initial commit on master"', { cwd: masterRepoPath });

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
		execSync('git config user.name "Test O\'Neill (Dev)"', { cwd: testRepoPath });

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
});
