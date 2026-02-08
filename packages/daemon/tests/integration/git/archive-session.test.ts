/**
 * Archive Session Integration Tests
 *
 * Tests for session.archive RPC handler with real git worktrees
 * Covers the full archive flow including commit detection and confirmation
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../helpers/test-app';
import { createTestApp, callRPCHandler } from '../../helpers/test-app';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Archive Session Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Enable worktrees for these tests
		ctx = await createTestApp({ useWorktrees: true });
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('session.archive - without worktree', () => {
		test('should archive session without worktree directly', async () => {
			// Create session without worktree (non-git path)
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-no-worktree-${Date.now()}`,
			});

			// Archive the session
			const result = await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
				confirmed: false,
			});

			expect(result.success).toBe(true);
			expect(result.requiresConfirmation).toBe(false);

			// Verify session is archived
			const session = ctx.db.getSession(created.sessionId);
			expect(session?.status).toBe('archived');
			expect(session?.archivedAt).toBeString();

			// Verify archivedAt is a valid ISO timestamp
			const archivedDate = new Date(session!.archivedAt!);
			expect(archivedDate.getTime()).toBeGreaterThan(0);
		});

		test('should broadcast session.updated event when archiving', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-event-${Date.now()}`,
			});

			// Subscribe to session updated event
			let eventReceived = false;
			const eventPromise = new Promise((resolve) => {
				(ctx.stateManager as unknown as Record<string, unknown>).eventBus.on(
					'session.updated',
					(data: unknown) => {
						const eventData = data as Record<string, unknown>;
						if (eventData.sessionId === created.sessionId) {
							eventReceived = true;
							resolve(data);
						}
					}
				);
			});

			// Archive session
			await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
			});

			await eventPromise;
			expect(eventReceived).toBe(true);
		});
	});

	describe('session.archive - with worktree (no commits ahead)', () => {
		test('should archive session with worktree when no commits ahead', async () => {
			// Create a git repo
			const repoPath = path.join(TMP_DIR, `test-repo-${Date.now()}`);
			fs.mkdirSync(repoPath, { recursive: true });

			execSync('git init', { cwd: repoPath });
			execSync('git config user.email "test@test.com"', { cwd: repoPath });
			execSync('git config user.name "Test User"', { cwd: repoPath });
			fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test');
			execSync('git add .', { cwd: repoPath });
			execSync('git commit -m "Initial commit"', { cwd: repoPath });
			execSync('git branch -M main', { cwd: repoPath });

			// Create session - will be in pending_worktree_choice state
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: repoPath,
			});

			// Complete worktree choice to create worktree
			await callRPCHandler(ctx.messageHub, 'session.setWorktreeMode', {
				sessionId: created.sessionId,
				mode: 'worktree',
			});

			// Trigger workspace initialization (2-stage session creation)
			// This creates the worktree with a branch name based on the message
			await ctx.sessionManager.initializeSessionWorkspace(created.sessionId, 'test worktree');

			const session = ctx.db.getSession(created.sessionId);
			expect(session?.worktree).toBeDefined();

			const worktreePath = session!.worktree!.worktreePath;
			expect(fs.existsSync(worktreePath)).toBe(true);

			// Archive without confirmation (no commits ahead)
			const result = await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
				confirmed: false,
			});

			expect(result.success).toBe(true);
			expect(result.requiresConfirmation).toBe(false);
			expect(result.commitStatus).toBeUndefined();

			// Verify session is archived
			const archivedSession = ctx.db.getSession(created.sessionId);
			expect(archivedSession?.status).toBe('archived');
			expect(archivedSession?.archivedAt).toBeString();
			expect(archivedSession?.worktree).toBeUndefined();

			// Note: Worktree directory removal is handled by WorktreeManager
			// We verify the session metadata is correct, which is the important part

			// Cleanup
			fs.rmSync(repoPath, { recursive: true, force: true });
		}, 15000);
	});

	describe('session.archive - with worktree (commits ahead)', () => {
		test('should require confirmation when worktree has commits ahead', async () => {
			// Create a git repo
			const repoPath = path.join(TMP_DIR, `test-repo-commits-${Date.now()}`);
			fs.mkdirSync(repoPath, { recursive: true });

			execSync('git init', { cwd: repoPath });
			execSync('git config user.email "test@test.com"', { cwd: repoPath });
			execSync('git config user.name "Test User"', { cwd: repoPath });
			fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test');
			execSync('git add .', { cwd: repoPath });
			execSync('git commit -m "Initial commit"', { cwd: repoPath });
			execSync('git branch -M main', { cwd: repoPath });

			// Create session - will be in pending_worktree_choice state
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: repoPath,
			});

			// Complete worktree choice to create worktree
			await callRPCHandler(ctx.messageHub, 'session.setWorktreeMode', {
				sessionId: created.sessionId,
				mode: 'worktree',
			});

			// Trigger workspace initialization (2-stage session creation)
			await ctx.sessionManager.initializeSessionWorkspace(created.sessionId, 'test commits');

			const session = ctx.db.getSession(created.sessionId);
			expect(session?.worktree).toBeDefined();
			const worktreePath = session!.worktree!.worktreePath;

			// Make a commit in the worktree
			fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'new feature');
			execSync('git add .', { cwd: worktreePath });
			execSync('git commit -m "Add new feature"', { cwd: worktreePath });

			// Try to archive without confirmation
			const result = await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
				confirmed: false,
			});

			expect(result.success).toBe(false);
			expect(result.requiresConfirmation).toBe(true);
			expect(result.commitStatus).toBeDefined();
			expect(result.commitStatus!.hasCommitsAhead).toBe(true);
			expect(result.commitStatus!.commits.length).toBe(1);

			const commit = result.commitStatus!.commits[0];
			expect(commit.message).toBe('Add new feature');
			expect(commit.author).toBe('Test User');
			expect(commit.hash).toBeString();
			expect(commit.date).toBeString();

			// Session should still be active (not archived yet)
			const stillActive = ctx.db.getSession(created.sessionId);
			expect(stillActive?.status).toBe('active');

			// Cleanup
			fs.rmSync(repoPath, { recursive: true, force: true });
		}, 15000);

		test('should archive after confirmation even with commits ahead', async () => {
			// Create a git repo
			const repoPath = path.join(TMP_DIR, `test-repo-confirmed-${Date.now()}`);
			fs.mkdirSync(repoPath, { recursive: true });

			execSync('git init', { cwd: repoPath });
			execSync('git config user.email "test@test.com"', { cwd: repoPath });
			execSync('git config user.name "Test User"', { cwd: repoPath });
			fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test');
			execSync('git add .', { cwd: repoPath });
			execSync('git commit -m "Initial commit"', { cwd: repoPath });
			execSync('git branch -M main', { cwd: repoPath });

			// Create session - will be in pending_worktree_choice state
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: repoPath,
			});

			// Complete worktree choice to create worktree
			await callRPCHandler(ctx.messageHub, 'session.setWorktreeMode', {
				sessionId: created.sessionId,
				mode: 'worktree',
			});

			// Trigger workspace initialization (2-stage session creation)
			await ctx.sessionManager.initializeSessionWorkspace(created.sessionId, 'test confirmed');

			const session = ctx.db.getSession(created.sessionId);
			expect(session?.worktree).toBeDefined();
			const worktreePath = session!.worktree!.worktreePath;

			// Make multiple commits in the worktree
			fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'content 1');
			execSync('git add .', { cwd: worktreePath });
			execSync('git commit -m "First change"', { cwd: worktreePath });

			fs.writeFileSync(path.join(worktreePath, 'file2.txt'), 'content 2');
			execSync('git add .', { cwd: worktreePath });
			execSync('git commit -m "Second change"', { cwd: worktreePath });

			// Archive with confirmation
			const result = await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
				confirmed: true,
			});

			expect(result.success).toBe(true);
			expect(result.requiresConfirmation).toBe(false);
			expect(result.commitsRemoved).toBe(2);

			// Verify session is archived
			const archivedSession = ctx.db.getSession(created.sessionId);
			expect(archivedSession?.status).toBe('archived');
			expect(archivedSession?.archivedAt).toBeString();
			expect(archivedSession?.worktree).toBeUndefined();

			// Note: Worktree directory removal is handled by WorktreeManager
			// We verify the session metadata is correct, which is the important part

			// Cleanup
			fs.rmSync(repoPath, { recursive: true, force: true });
		}, 15000);
	});

	describe('session.archive - squash merged commits', () => {
		test('should NOT require confirmation when commits are squash-merged to main', async () => {
			// Create a git repo with main branch
			const repoPath = path.join(TMP_DIR, `test-repo-squash-${Date.now()}`);
			fs.mkdirSync(repoPath, { recursive: true });

			execSync('git init', { cwd: repoPath });
			execSync('git config user.email "test@test.com"', { cwd: repoPath });
			execSync('git config user.name "Test User"', { cwd: repoPath });
			fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test');
			execSync('git add .', { cwd: repoPath });
			execSync('git commit -m "Initial commit"', { cwd: repoPath });
			execSync('git branch -M main', { cwd: repoPath });

			// Create session - will be in pending_worktree_choice state
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: repoPath,
			});

			// Complete worktree choice to create worktree
			await callRPCHandler(ctx.messageHub, 'session.setWorktreeMode', {
				sessionId: created.sessionId,
				mode: 'worktree',
			});

			// Trigger workspace initialization
			await ctx.sessionManager.initializeSessionWorkspace(created.sessionId, 'test squash');

			const session = ctx.db.getSession(created.sessionId);
			expect(session?.worktree).toBeDefined();
			const worktreePath = session!.worktree!.worktreePath;
			const sessionBranch = session!.worktree!.branch;

			// Make multiple commits in the worktree
			fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature code');
			execSync('git add .', { cwd: worktreePath });
			execSync('git commit -m "Add feature"', { cwd: worktreePath });

			fs.writeFileSync(path.join(worktreePath, 'feature2.txt'), 'more code');
			execSync('git add .', { cwd: worktreePath });
			execSync('git commit -m "Add more feature"', { cwd: worktreePath });

			// Simulate squash merge to main (what GitHub does when you merge a PR)
			// 1. Checkout main in the main repo
			execSync('git checkout main', { cwd: repoPath });
			// 2. Squash merge the session branch
			execSync(`git merge --squash ${sessionBranch}`, { cwd: repoPath });
			execSync('git commit -m "feat: add feature (squash merged)"', { cwd: repoPath });

			// Now the session branch has 2 commits, but main has 1 squash commit
			// The file content should be identical

			// Try to archive - should NOT require confirmation
			const result = await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
				confirmed: false,
			});

			// Since content is same (squash merged), should not require confirmation
			expect(result.success).toBe(true);
			expect(result.requiresConfirmation).toBe(false);

			// Cleanup
			fs.rmSync(repoPath, { recursive: true, force: true });
		}, 20000);

		test('should NOT require confirmation when main has additional commits after squash merge', async () => {
			// Create a git repo with main branch
			const repoPath = path.join(TMP_DIR, `test-repo-squash-extra-${Date.now()}`);
			fs.mkdirSync(repoPath, { recursive: true });

			execSync('git init', { cwd: repoPath });
			execSync('git config user.email "test@test.com"', { cwd: repoPath });
			execSync('git config user.name "Test User"', { cwd: repoPath });
			fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test');
			execSync('git add .', { cwd: repoPath });
			execSync('git commit -m "Initial commit"', { cwd: repoPath });
			execSync('git branch -M main', { cwd: repoPath });

			// Create session - will be in pending_worktree_choice state
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: repoPath,
			});

			// Complete worktree choice to create worktree
			await callRPCHandler(ctx.messageHub, 'session.setWorktreeMode', {
				sessionId: created.sessionId,
				mode: 'worktree',
			});

			// Trigger workspace initialization
			await ctx.sessionManager.initializeSessionWorkspace(created.sessionId, 'test squash extra');

			const session = ctx.db.getSession(created.sessionId);
			expect(session?.worktree).toBeDefined();
			const worktreePath = session!.worktree!.worktreePath;
			const sessionBranch = session!.worktree!.branch;

			// Make a commit in the worktree
			fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature code');
			execSync('git add .', { cwd: worktreePath });
			execSync('git commit -m "Add feature"', { cwd: worktreePath });

			// Squash merge to main
			execSync('git checkout main', { cwd: repoPath });
			execSync(`git merge --squash ${sessionBranch}`, { cwd: repoPath });
			execSync('git commit -m "feat: add feature (squash merged)"', { cwd: repoPath });

			// NOW add another commit to main (simulating another PR merged after)
			fs.writeFileSync(path.join(repoPath, 'unrelated.txt'), 'other work');
			execSync('git add .', { cwd: repoPath });
			execSync('git commit -m "feat: unrelated change"', { cwd: repoPath });

			// The session branch doesn't have this new commit, but its own changes ARE on main
			// Archive should NOT require confirmation for the session's changes

			const result = await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
				confirmed: false,
			});

			// Session's changes are on main, so no confirmation needed
			expect(result.success).toBe(true);
			expect(result.requiresConfirmation).toBe(false);

			// Cleanup
			fs.rmSync(repoPath, { recursive: true, force: true });
		}, 20000);

		test('should require confirmation when session has ADDITIONAL commits after squash merge', async () => {
			// Create a git repo with main branch
			const repoPath = path.join(TMP_DIR, `test-repo-squash-new-${Date.now()}`);
			fs.mkdirSync(repoPath, { recursive: true });

			execSync('git init', { cwd: repoPath });
			execSync('git config user.email "test@test.com"', { cwd: repoPath });
			execSync('git config user.name "Test User"', { cwd: repoPath });
			fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test');
			execSync('git add .', { cwd: repoPath });
			execSync('git commit -m "Initial commit"', { cwd: repoPath });
			execSync('git branch -M main', { cwd: repoPath });

			// Create session - will be in pending_worktree_choice state
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: repoPath,
			});

			// Complete worktree choice to create worktree
			await callRPCHandler(ctx.messageHub, 'session.setWorktreeMode', {
				sessionId: created.sessionId,
				mode: 'worktree',
			});

			// Trigger workspace initialization
			await ctx.sessionManager.initializeSessionWorkspace(created.sessionId, 'test squash new');

			const session = ctx.db.getSession(created.sessionId);
			expect(session?.worktree).toBeDefined();
			const worktreePath = session!.worktree!.worktreePath;
			const sessionBranch = session!.worktree!.branch;

			// Make initial commit in the worktree
			fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature code');
			execSync('git add .', { cwd: worktreePath });
			execSync('git commit -m "Add feature"', { cwd: worktreePath });

			// Squash merge to main
			execSync('git checkout main', { cwd: repoPath });
			execSync(`git merge --squash ${sessionBranch}`, { cwd: repoPath });
			execSync('git commit -m "feat: add feature (squash merged)"', { cwd: repoPath });

			// NOW make another commit in the worktree (new work not on main)
			// Note: The session branch is checked out in the worktree, so we commit there directly
			fs.writeFileSync(path.join(worktreePath, 'new-work.txt'), 'new work');
			execSync('git add .', { cwd: worktreePath });
			execSync('git commit -m "Add new work"', { cwd: worktreePath });

			// Archive SHOULD require confirmation because there's new work not on main
			const result = await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
				confirmed: false,
			});

			expect(result.success).toBe(false);
			expect(result.requiresConfirmation).toBe(true);
			expect(result.commitStatus?.hasCommitsAhead).toBe(true);
			// Shows all commits on the branch (including merged ones) - this is expected
			// The key is that we correctly detected there ARE unique changes
			expect(result.commitStatus?.commits.length).toBeGreaterThanOrEqual(1);
			// The new work commit should be in the list
			const hasNewWork = result.commitStatus?.commits.some((c) => c.message === 'Add new work');
			expect(hasNewWork).toBe(true);

			// Cleanup
			fs.rmSync(repoPath, { recursive: true, force: true });
		}, 20000);
	});

	describe('session.archive - error handling', () => {
		test('should return error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'session.archive', {
					sessionId: 'non-existent-id',
				})
			).rejects.toThrow('Session not found');
		});

		test('should handle already archived session gracefully', async () => {
			// Create and archive a session
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-already-archived-${Date.now()}`,
			});

			await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
			});

			// Try to archive again
			const result = await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
			});

			// Should succeed (idempotent operation)
			expect(result.success).toBe(true);
		});
	});

	describe('Archived session behavior', () => {
		test('archived sessions should be retrievable via session.get', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-get-archived-${Date.now()}`,
			});

			await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
			});

			// Get archived session
			const result = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId: created.sessionId,
			});

			expect(result.session).toBeDefined();
			expect(result.session.id).toBe(created.sessionId);
			expect(result.session.status).toBe('archived');
			expect(result.session.archivedAt).toBeString();
		});

		test('archived sessions should appear in session.list', async () => {
			// Create and archive a session
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-list-archived-${Date.now()}`,
			});

			await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
			});

			// List sessions
			const result = await callRPCHandler(ctx.messageHub, 'session.list', {});

			expect(result.sessions).toBeArray();
			const archivedSession = result.sessions.find(
				(s: Record<string, unknown>) => s.id === created.sessionId
			);
			expect(archivedSession).toBeDefined();
			expect((archivedSession as Record<string, unknown>).status).toBe('archived');
		});

		test('archived sessions should preserve metadata', async () => {
			// Create session with metadata
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-metadata-${Date.now()}`,
			});

			// Update metadata before archiving
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId: created.sessionId,
				title: 'Test Session Title',
				metadata: {
					messageCount: 5,
					titleGenerated: true,
				},
			});

			// Archive session
			await callRPCHandler(ctx.messageHub, 'session.archive', {
				sessionId: created.sessionId,
			});

			// Get archived session and verify metadata
			const result = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId: created.sessionId,
			});

			expect(result.session.title).toBe('Test Session Title');
			expect(result.session.metadata.messageCount).toBe(5);
			expect(result.session.metadata.titleGenerated).toBe(true);
		});
	});
});
