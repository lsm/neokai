/**
 * Project Structure Integration Tests
 *
 * Validates that worktrees and databases are co-located under the same project directory.
 * Ensures the project-based path structure works end-to-end:
 * ~/.liuboer/projects/{encoded-repo-path}/
 * ├── database/daemon.db
 * └── worktrees/{sessionId}/
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { WorktreeManager } from '../../../../src/lib/worktree-manager';
import { getConfig } from '../../../../src/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { homedir } from 'node:os';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Project Structure Integration', () => {
	let testRepoPath: string;
	let worktreeManager: WorktreeManager;
	let createdWorktrees: string[] = [];
	let originalDbPath: string | undefined;

	beforeEach(async () => {
		// Save and clear DB_PATH env var to test default project-based path behavior
		originalDbPath = process.env.DB_PATH;
		delete process.env.DB_PATH;

		// Create unique test repository
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(7);

		testRepoPath = path.join(TMP_DIR, `test-project-structure-${timestamp}-${random}`);
		fs.mkdirSync(testRepoPath, { recursive: true });

		// Initialize git repo with initial commit
		execSync('git init', { cwd: testRepoPath });
		execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
		execSync('git config user.name "Test User"', { cwd: testRepoPath });

		// Create initial commit on main branch
		fs.writeFileSync(path.join(testRepoPath, 'README.md'), '# Test Repo');
		execSync('git add .', { cwd: testRepoPath });
		execSync('git commit -m "Initial commit"', { cwd: testRepoPath });
		execSync('git branch -M main', { cwd: testRepoPath });

		worktreeManager = new WorktreeManager();
		createdWorktrees = [];
	});

	afterEach(async () => {
		// Restore DB_PATH env var
		if (originalDbPath !== undefined) {
			process.env.DB_PATH = originalDbPath;
		} else {
			delete process.env.DB_PATH;
		}

		// Cleanup created worktrees
		for (const worktreePath of createdWorktrees) {
			try {
				if (fs.existsSync(worktreePath)) {
					const repoPath = worktreePath.startsWith(path.join(homedir(), '.liuboer', 'projects'))
						? testRepoPath
						: path.dirname(path.dirname(worktreePath));

					try {
						execSync(`git worktree remove "${worktreePath}" --force`, {
							cwd: repoPath,
						});
					} catch {
						fs.rmSync(worktreePath, { recursive: true, force: true });
					}
				}
			} catch {
				// Ignore cleanup errors
			}
		}

		// Cleanup test repo
		if (fs.existsSync(testRepoPath)) {
			fs.rmSync(testRepoPath, { recursive: true, force: true });
		}

		// Cleanup project directory
		const encodedPath = encodeRepoPath(testRepoPath);
		const projectDir = path.join(homedir(), '.liuboer', 'projects', encodedPath);
		if (fs.existsSync(projectDir)) {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// Helper to encode repo path (same logic as config.ts and worktree-manager.ts)
	function encodeRepoPath(repoPath: string): string {
		const normalizedPath = repoPath.replace(/\\/g, '/');
		const encoded = normalizedPath.startsWith('/')
			? '-' + normalizedPath.slice(1).replace(/\//g, '-')
			: '-' + normalizedPath.replace(/\//g, '-');
		return encoded;
	}

	test('worktree and database paths share the same project directory', async () => {
		const sessionId = 'test-session-123';

		// Create worktree
		const worktree = await worktreeManager.createWorktree({
			sessionId,
			repoPath: testRepoPath,
		});

		expect(worktree).not.toBeNull();
		if (!worktree) return;

		createdWorktrees.push(worktree.worktreePath);

		// Get config for same workspace
		const config = getConfig({ workspace: testRepoPath });

		// Extract project directories from both paths
		const extractProjectDir = (fullPath: string) => {
			const parts = fullPath.split(path.sep);
			const projectsIndex = parts.indexOf('projects');
			if (projectsIndex === -1) return null;
			// Return path up to and including the encoded repo path
			return parts.slice(0, projectsIndex + 2).join(path.sep);
		};

		const worktreeProjectDir = extractProjectDir(worktree.worktreePath);
		const dbProjectDir = extractProjectDir(config.dbPath);

		// Both should be in the same project directory
		expect(worktreeProjectDir).toBe(dbProjectDir);
		expect(worktreeProjectDir).toContain('.liuboer/projects');

		// Verify the structure
		const encodedPath = encodeRepoPath(testRepoPath);
		const expectedProjectDir = path.join(homedir(), '.liuboer', 'projects', encodedPath);

		expect(worktreeProjectDir).toBe(expectedProjectDir);
		expect(dbProjectDir).toBe(expectedProjectDir);
	});

	test('project directory contains both worktrees and database subdirectories', async () => {
		const sessionId = 'test-session-456';

		// Create worktree
		const worktree = await worktreeManager.createWorktree({
			sessionId,
			repoPath: testRepoPath,
		});

		expect(worktree).not.toBeNull();
		if (!worktree) return;

		createdWorktrees.push(worktree.worktreePath);

		// Get config
		const config = getConfig({ workspace: testRepoPath });

		// Calculate project directory
		const encodedPath = encodeRepoPath(testRepoPath);
		const projectDir = path.join(homedir(), '.liuboer', 'projects', encodedPath);

		// Verify project directory exists
		expect(fs.existsSync(projectDir)).toBe(true);

		// Verify worktrees subdirectory exists
		const worktreesDir = path.join(projectDir, 'worktrees');
		expect(fs.existsSync(worktreesDir)).toBe(true);
		expect(worktree.worktreePath).toStartWith(worktreesDir);

		// Database subdirectory may not exist yet (created on first use)
		// but the path should point to it
		expect(config.dbPath).toStartWith(path.join(projectDir, 'database'));
	});

	test('multiple worktrees for same repo share project directory', async () => {
		const sessionId1 = 'test-session-1';
		const sessionId2 = 'test-session-2';

		// Create two worktrees
		const worktree1 = await worktreeManager.createWorktree({
			sessionId: sessionId1,
			repoPath: testRepoPath,
		});

		const worktree2 = await worktreeManager.createWorktree({
			sessionId: sessionId2,
			repoPath: testRepoPath,
		});

		expect(worktree1).not.toBeNull();
		expect(worktree2).not.toBeNull();
		if (!worktree1 || !worktree2) return;

		createdWorktrees.push(worktree1.worktreePath, worktree2.worktreePath);

		// Extract project directories
		const extractProjectDir = (fullPath: string) => {
			const parts = fullPath.split(path.sep);
			const projectsIndex = parts.indexOf('projects');
			return parts.slice(0, projectsIndex + 2).join(path.sep);
		};

		const projectDir1 = extractProjectDir(worktree1.worktreePath);
		const projectDir2 = extractProjectDir(worktree2.worktreePath);

		// Both worktrees should share the same project directory
		expect(projectDir1).toBe(projectDir2);

		// Get config - should also point to same project
		const config = getConfig({ workspace: testRepoPath });
		const dbProjectDir = extractProjectDir(config.dbPath);

		expect(dbProjectDir).toBe(projectDir1);
	});

	test('path encoding is consistent across worktree and database paths', async () => {
		const sessionId = 'test-encoding-consistency';

		// Create worktree
		const worktree = await worktreeManager.createWorktree({
			sessionId,
			repoPath: testRepoPath,
		});

		expect(worktree).not.toBeNull();
		if (!worktree) return;

		createdWorktrees.push(worktree.worktreePath);

		// Get config
		const config = getConfig({ workspace: testRepoPath });

		// Extract encoded path from both
		const extractEncodedPath = (fullPath: string) => {
			const parts = fullPath.split(path.sep);
			const projectsIndex = parts.indexOf('projects');
			return parts[projectsIndex + 1];
		};

		const worktreeEncodedPath = extractEncodedPath(worktree.worktreePath);
		const dbEncodedPath = extractEncodedPath(config.dbPath);

		// Both should use the same encoding
		expect(worktreeEncodedPath).toBe(dbEncodedPath);

		// Verify encoding format (should start with dash, contain path components)
		expect(worktreeEncodedPath.startsWith('-')).toBe(true);
		expect(dbEncodedPath.startsWith('-')).toBe(true);
	});
});
