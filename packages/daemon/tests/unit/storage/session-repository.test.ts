/**
 * Session Repository Unit Tests
 *
 * Tests for session CRUD operations and data mapping.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionRepository } from '../../../src/storage/repositories/session-repository';
import type { Session } from '@liuboer/shared';

describe('SessionRepository', () => {
	let db: Database;
	let repo: SessionRepository;

	const createTestSession = (overrides?: Partial<Session>): Session => ({
		id: 'test-session-1',
		title: 'Test Session',
		workspacePath: '/test/workspace',
		createdAt: '2024-01-01T00:00:00.000Z',
		lastActiveAt: '2024-01-01T01:00:00.000Z',
		status: 'active',
		config: {
			model: 'claude-sonnet-4-20250514',
			maxTokens: 8192,
			temperature: 1.0,
		},
		metadata: {
			messageCount: 5,
			totalTokens: 1000,
			inputTokens: 400,
			outputTokens: 600,
			totalCost: 0.01,
			toolCallCount: 2,
		},
		...overrides,
	});

	beforeEach(() => {
		// Create in-memory database
		db = new Database(':memory:');

		// Create sessions table
		db.run(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'active',
				config TEXT NOT NULL DEFAULT '{}',
				metadata TEXT NOT NULL DEFAULT '{}',
				is_worktree INTEGER DEFAULT 0,
				worktree_path TEXT,
				main_repo_path TEXT,
				worktree_branch TEXT,
				git_branch TEXT,
				sdk_session_id TEXT,
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT
			)
		`);

		repo = new SessionRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	describe('createSession', () => {
		it('should create a basic session', () => {
			const session = createTestSession();
			repo.createSession(session);

			const result = repo.getSession(session.id);
			expect(result).not.toBeNull();
			expect(result!.id).toBe(session.id);
			expect(result!.title).toBe(session.title);
			expect(result!.workspacePath).toBe(session.workspacePath);
			expect(result!.status).toBe('active');
		});

		it('should create session with worktree info', () => {
			const session = createTestSession({
				worktree: {
					isWorktree: true,
					worktreePath: '/worktrees/test',
					mainRepoPath: '/main/repo',
					branch: 'feature-branch',
				},
			});
			repo.createSession(session);

			const result = repo.getSession(session.id);
			expect(result!.worktree).toBeDefined();
			expect(result!.worktree!.isWorktree).toBe(true);
			expect(result!.worktree!.worktreePath).toBe('/worktrees/test');
			expect(result!.worktree!.mainRepoPath).toBe('/main/repo');
			expect(result!.worktree!.branch).toBe('feature-branch');
		});

		it('should create session with optional fields', () => {
			const session = createTestSession({
				gitBranch: 'main',
				sdkSessionId: 'sdk-123',
				availableCommands: ['/help', '/clear'],
				processingState: 'idle',
				archivedAt: '2024-01-02T00:00:00.000Z',
			});
			repo.createSession(session);

			const result = repo.getSession(session.id);
			expect(result!.gitBranch).toBe('main');
			expect(result!.sdkSessionId).toBe('sdk-123');
			expect(result!.availableCommands).toEqual(['/help', '/clear']);
			expect(result!.processingState).toBe('idle');
			expect(result!.archivedAt).toBe('2024-01-02T00:00:00.000Z');
		});
	});

	describe('getSession', () => {
		it('should return null for non-existent session', () => {
			const result = repo.getSession('nonexistent');
			expect(result).toBeNull();
		});

		it('should return session with parsed config and metadata', () => {
			const session = createTestSession();
			repo.createSession(session);

			const result = repo.getSession(session.id);
			expect(result!.config.model).toBe('claude-sonnet-4-20250514');
			expect(result!.metadata.messageCount).toBe(5);
		});
	});

	describe('listSessions', () => {
		it('should return empty array when no sessions exist', () => {
			const result = repo.listSessions();
			expect(result).toEqual([]);
		});

		it('should return sessions ordered by lastActiveAt DESC', () => {
			repo.createSession(
				createTestSession({
					id: 'session-1',
					lastActiveAt: '2024-01-01T00:00:00.000Z',
				})
			);
			repo.createSession(
				createTestSession({
					id: 'session-2',
					lastActiveAt: '2024-01-03T00:00:00.000Z',
				})
			);
			repo.createSession(
				createTestSession({
					id: 'session-3',
					lastActiveAt: '2024-01-02T00:00:00.000Z',
				})
			);

			const result = repo.listSessions();
			expect(result).toHaveLength(3);
			expect(result[0].id).toBe('session-2');
			expect(result[1].id).toBe('session-3');
			expect(result[2].id).toBe('session-1');
		});
	});

	describe('updateSession', () => {
		it('should update title', () => {
			const session = createTestSession();
			repo.createSession(session);

			repo.updateSession(session.id, { title: 'Updated Title' });

			const result = repo.getSession(session.id);
			expect(result!.title).toBe('Updated Title');
		});

		it('should update status', () => {
			const session = createTestSession();
			repo.createSession(session);

			repo.updateSession(session.id, { status: 'paused' });

			const result = repo.getSession(session.id);
			expect(result!.status).toBe('paused');
		});

		it('should merge metadata updates', () => {
			const session = createTestSession();
			repo.createSession(session);

			repo.updateSession(session.id, {
				metadata: { messageCount: 10 },
			});

			const result = repo.getSession(session.id);
			expect(result!.metadata.messageCount).toBe(10);
			// Other metadata should be preserved
			expect(result!.metadata.totalTokens).toBe(1000);
		});

		it('should merge config updates', () => {
			const session = createTestSession();
			repo.createSession(session);

			repo.updateSession(session.id, {
				config: { maxTokens: 16384 },
			});

			const result = repo.getSession(session.id);
			expect(result!.config.maxTokens).toBe(16384);
			// Other config should be preserved
			expect(result!.config.model).toBe('claude-sonnet-4-20250514');
		});

		it('should update sdkSessionId', () => {
			const session = createTestSession();
			repo.createSession(session);

			repo.updateSession(session.id, { sdkSessionId: 'new-sdk-id' });

			const result = repo.getSession(session.id);
			expect(result!.sdkSessionId).toBe('new-sdk-id');
		});

		it('should clear sdkSessionId when set to null', () => {
			const session = createTestSession({ sdkSessionId: 'old-sdk-id' });
			repo.createSession(session);

			repo.updateSession(session.id, { sdkSessionId: null as unknown as undefined });

			const result = repo.getSession(session.id);
			expect(result!.sdkSessionId).toBeUndefined();
		});

		it('should update worktree info', () => {
			const session = createTestSession();
			repo.createSession(session);

			repo.updateSession(session.id, {
				worktree: {
					isWorktree: true,
					worktreePath: '/new/worktree',
					mainRepoPath: '/main',
					branch: 'new-branch',
				},
			});

			const result = repo.getSession(session.id);
			expect(result!.worktree!.isWorktree).toBe(true);
			expect(result!.worktree!.worktreePath).toBe('/new/worktree');
		});

		it('should clear worktree when set to null', () => {
			const session = createTestSession({
				worktree: {
					isWorktree: true,
					worktreePath: '/old/worktree',
					mainRepoPath: '/main',
					branch: 'old-branch',
				},
			});
			repo.createSession(session);

			repo.updateSession(session.id, { worktree: undefined });

			const result = repo.getSession(session.id);
			expect(result!.worktree).toBeUndefined();
		});

		it('should do nothing when no updates provided', () => {
			const session = createTestSession();
			repo.createSession(session);

			repo.updateSession(session.id, {});

			const result = repo.getSession(session.id);
			expect(result!.title).toBe(session.title);
		});
	});

	describe('deleteSession', () => {
		it('should delete existing session', () => {
			const session = createTestSession();
			repo.createSession(session);

			repo.deleteSession(session.id);

			const result = repo.getSession(session.id);
			expect(result).toBeNull();
		});

		it('should not throw when deleting non-existent session', () => {
			expect(() => repo.deleteSession('nonexistent')).not.toThrow();
		});
	});

	describe('rowToSession', () => {
		it('should handle session without worktree', () => {
			const row = {
				id: 'test',
				title: 'Test',
				workspace_path: '/test',
				created_at: '2024-01-01T00:00:00.000Z',
				last_active_at: '2024-01-01T00:00:00.000Z',
				status: 'active',
				config: '{"model":"claude-sonnet-4-20250514"}',
				metadata: '{"messageCount":0}',
				is_worktree: 0,
				worktree_path: null,
				main_repo_path: null,
				worktree_branch: null,
				git_branch: null,
				sdk_session_id: null,
				available_commands: null,
				processing_state: null,
				archived_at: null,
			};

			const result = repo.rowToSession(row);
			expect(result.worktree).toBeUndefined();
			expect(result.gitBranch).toBeUndefined();
			expect(result.sdkSessionId).toBeUndefined();
		});

		it('should parse available_commands from JSON', () => {
			const row = {
				id: 'test',
				title: 'Test',
				workspace_path: '/test',
				created_at: '2024-01-01T00:00:00.000Z',
				last_active_at: '2024-01-01T00:00:00.000Z',
				status: 'active',
				config: '{}',
				metadata: '{}',
				is_worktree: 0,
				worktree_path: null,
				main_repo_path: null,
				worktree_branch: null,
				git_branch: null,
				sdk_session_id: null,
				available_commands: '["/help","/clear"]',
				processing_state: null,
				archived_at: null,
			};

			const result = repo.rowToSession(row);
			expect(result.availableCommands).toEqual(['/help', '/clear']);
		});
	});
});
