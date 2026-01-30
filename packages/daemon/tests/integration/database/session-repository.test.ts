/**
 * Session Repository Integration Tests
 *
 * Tests for session CRUD operations through the Database facade.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../src/storage/database';
import type { Session } from '@neokai/shared';
import { createTestSession } from './fixtures/database-test-utils';

describe('SessionRepository', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database(':memory:');
		await db.initialize();
	});

	afterEach(() => {
		db.close();
	});

	describe('createSession', () => {
		it('should create a basic session', () => {
			const session = createTestSession('session-1');

			db.createSession(session);

			const retrieved = db.getSession('session-1');
			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe('session-1');
			expect(retrieved?.title).toBe('Test Session session-1');
		});

		it('should create a session with worktree', () => {
			const session: Session = {
				...createTestSession('session-wt'),
				worktree: {
					isWorktree: true,
					worktreePath: '/worktrees/session-wt',
					mainRepoPath: '/main/repo',
					branch: 'session/session-wt',
				},
			};

			db.createSession(session);

			const retrieved = db.getSession('session-wt');
			expect(retrieved?.worktree).toBeDefined();
			expect(retrieved?.worktree?.isWorktree).toBe(true);
			expect(retrieved?.worktree?.worktreePath).toBe('/worktrees/session-wt');
			expect(retrieved?.worktree?.mainRepoPath).toBe('/main/repo');
			expect(retrieved?.worktree?.branch).toBe('session/session-wt');
		});

		it('should create a session with optional fields', () => {
			const session: Session = {
				...createTestSession('session-full'),
				gitBranch: 'main',
				sdkSessionId: 'sdk-123',
				availableCommands: ['/help', '/commit', '/review'],
				processingState: 'processing',
				archivedAt: '2024-01-01T00:00:00Z',
			};

			db.createSession(session);

			const retrieved = db.getSession('session-full');
			expect(retrieved?.gitBranch).toBe('main');
			expect(retrieved?.sdkSessionId).toBe('sdk-123');
			expect(retrieved?.availableCommands).toEqual(['/help', '/commit', '/review']);
			expect(retrieved?.processingState).toBe('processing');
			expect(retrieved?.archivedAt).toBe('2024-01-01T00:00:00Z');
		});
	});

	describe('getSession', () => {
		it('should return null for non-existent session', () => {
			const session = db.getSession('non-existent');

			expect(session).toBeNull();
		});

		it('should return session with parsed JSON fields', () => {
			const session = createTestSession('session-json');
			db.createSession(session);

			const retrieved = db.getSession('session-json');

			expect(retrieved?.config).toEqual(session.config);
			expect(retrieved?.metadata).toEqual(session.metadata);
		});
	});

	describe('listSessions', () => {
		it('should return empty array when no sessions exist', () => {
			const sessions = db.listSessions();

			expect(sessions).toEqual([]);
		});

		it('should return all sessions', () => {
			db.createSession(createTestSession('session-1'));
			db.createSession(createTestSession('session-2'));
			db.createSession(createTestSession('session-3'));

			const sessions = db.listSessions();

			expect(sessions.length).toBe(3);
		});

		it('should return sessions ordered by last active time (most recent first)', () => {
			// Create sessions with different last active times
			const session1 = createTestSession('session-1');
			session1.lastActiveAt = '2024-01-01T00:00:00Z';
			db.createSession(session1);

			const session2 = createTestSession('session-2');
			session2.lastActiveAt = '2024-01-03T00:00:00Z';
			db.createSession(session2);

			const session3 = createTestSession('session-3');
			session3.lastActiveAt = '2024-01-02T00:00:00Z';
			db.createSession(session3);

			const sessions = db.listSessions();

			expect(sessions[0].id).toBe('session-2'); // Most recent
			expect(sessions[1].id).toBe('session-3');
			expect(sessions[2].id).toBe('session-1'); // Oldest
		});
	});

	describe('updateSession', () => {
		beforeEach(() => {
			db.createSession(createTestSession('session-update'));
		});

		it('should update title', () => {
			db.updateSession('session-update', { title: 'New Title' });

			const updated = db.getSession('session-update');
			expect(updated?.title).toBe('New Title');
		});

		it('should update workspacePath', () => {
			db.updateSession('session-update', { workspacePath: '/new/path' });

			const updated = db.getSession('session-update');
			expect(updated?.workspacePath).toBe('/new/path');
		});

		it('should update status', () => {
			db.updateSession('session-update', { status: 'archived' });

			const updated = db.getSession('session-update');
			expect(updated?.status).toBe('archived');
		});

		it('should update lastActiveAt', () => {
			const newTime = '2024-12-25T12:00:00Z';
			db.updateSession('session-update', { lastActiveAt: newTime });

			const updated = db.getSession('session-update');
			expect(updated?.lastActiveAt).toBe(newTime);
		});

		it('should merge metadata updates', () => {
			db.updateSession('session-update', {
				metadata: { messageCount: 10, totalTokens: 1000 },
			});

			const updated = db.getSession('session-update');
			expect(updated?.metadata.messageCount).toBe(10);
			expect(updated?.metadata.totalTokens).toBe(1000);
			// Other fields should be preserved
			expect(updated?.metadata.inputTokens).toBe(0);
		});

		it('should merge config updates', () => {
			db.updateSession('session-update', {
				config: { temperature: 0.5 },
			});

			const updated = db.getSession('session-update');
			expect(updated?.config.temperature).toBe(0.5);
			// Other fields should be preserved
			expect(updated?.config.model).toBe('claude-sonnet-4-5-20250929');
		});

		it('should update sdkSessionId', () => {
			db.updateSession('session-update', { sdkSessionId: 'new-sdk-id' });

			const updated = db.getSession('session-update');
			expect(updated?.sdkSessionId).toBe('new-sdk-id');
		});

		it('should clear sdkSessionId when set to null', () => {
			// First set it
			db.updateSession('session-update', { sdkSessionId: 'old-sdk-id' });
			expect(db.getSession('session-update')?.sdkSessionId).toBe('old-sdk-id');

			// Then clear it using null (undefined is ignored in updates)
			db.updateSession('session-update', { sdkSessionId: null as unknown as undefined });
			expect(db.getSession('session-update')?.sdkSessionId).toBeUndefined();
		});

		it('should update availableCommands', () => {
			db.updateSession('session-update', {
				availableCommands: ['/help', '/test'],
			});

			const updated = db.getSession('session-update');
			expect(updated?.availableCommands).toEqual(['/help', '/test']);
		});

		it('should update processingState', () => {
			db.updateSession('session-update', { processingState: 'thinking' });

			const updated = db.getSession('session-update');
			expect(updated?.processingState).toBe('thinking');
		});

		it('should update archivedAt', () => {
			const archivedAt = '2024-01-15T10:00:00Z';
			db.updateSession('session-update', { archivedAt });

			const updated = db.getSession('session-update');
			expect(updated?.archivedAt).toBe(archivedAt);
		});

		it('should update worktree', () => {
			db.updateSession('session-update', {
				worktree: {
					isWorktree: true,
					worktreePath: '/new/worktree',
					mainRepoPath: '/main/repo',
					branch: 'session/new',
				},
			});

			const updated = db.getSession('session-update');
			expect(updated?.worktree?.isWorktree).toBe(true);
			expect(updated?.worktree?.worktreePath).toBe('/new/worktree');
		});

		it('should clear worktree when set to null', () => {
			// First set worktree
			db.updateSession('session-update', {
				worktree: {
					isWorktree: true,
					worktreePath: '/worktree',
					mainRepoPath: '/repo',
					branch: 'branch',
				},
			});
			expect(db.getSession('session-update')?.worktree).toBeDefined();

			// Then clear it
			db.updateSession('session-update', { worktree: null as unknown as undefined });

			const updated = db.getSession('session-update');
			expect(updated?.worktree).toBeUndefined();
		});

		it('should handle multiple updates at once', () => {
			db.updateSession('session-update', {
				title: 'Multi Update',
				status: 'paused',
				metadata: { messageCount: 50 },
			});

			const updated = db.getSession('session-update');
			expect(updated?.title).toBe('Multi Update');
			expect(updated?.status).toBe('paused');
			expect(updated?.metadata.messageCount).toBe(50);
		});

		it('should do nothing with empty updates', () => {
			const before = db.getSession('session-update');
			db.updateSession('session-update', {});
			const after = db.getSession('session-update');

			expect(after).toEqual(before);
		});
	});

	describe('deleteSession', () => {
		it('should delete a session', () => {
			db.createSession(createTestSession('session-delete'));
			expect(db.getSession('session-delete')).not.toBeNull();

			db.deleteSession('session-delete');

			expect(db.getSession('session-delete')).toBeNull();
		});

		it('should not throw when deleting non-existent session', () => {
			// Should not throw
			db.deleteSession('non-existent');
		});
	});

	describe('rowToSession mapping', () => {
		it('should handle session without worktree', () => {
			const session = createTestSession('no-worktree');
			db.createSession(session);

			const retrieved = db.getSession('no-worktree');

			expect(retrieved?.worktree).toBeUndefined();
		});

		it('should handle session with empty availableCommands', () => {
			const session = createTestSession('empty-commands');
			db.createSession(session);

			const retrieved = db.getSession('empty-commands');

			expect(retrieved?.availableCommands).toBeUndefined();
		});

		it('should handle all status types', () => {
			const statuses: Array<'active' | 'paused' | 'ended' | 'archived'> = [
				'active',
				'paused',
				'ended',
				'archived',
			];

			for (const status of statuses) {
				const session = createTestSession(`status-${status}`);
				session.status = status;
				db.createSession(session);

				const retrieved = db.getSession(`status-${status}`);
				expect(retrieved?.status).toBe(status);
			}
		});
	});
});
