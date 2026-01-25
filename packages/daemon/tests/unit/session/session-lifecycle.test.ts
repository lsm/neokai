/**
 * SessionLifecycle Tests
 *
 * Tests session CRUD operations including:
 * - Session creation with worktree support
 * - Session update
 * - Session deletion with cleanup cascade
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	SessionLifecycle,
	generateBranchName,
	slugify,
	type SessionLifecycleConfig,
} from '../../../src/lib/session/session-lifecycle';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { WorktreeManager } from '../../../src/lib/worktree-manager';
import type { SessionCache, AgentSessionFactory } from '../../../src/lib/session/session-cache';
import type { ToolsConfigManager } from '../../../src/lib/session/tools-config';
import type { MessageHub } from '@liuboer/shared';

describe('SessionLifecycle', () => {
	let lifecycle: SessionLifecycle;
	let mockDb: Database;
	let mockWorktreeManager: WorktreeManager;
	let mockSessionCache: SessionCache;
	let mockEventBus: DaemonHub;
	let mockMessageHub: MessageHub;
	let mockToolsConfigManager: ToolsConfigManager;
	let mockAgentSessionFactory: AgentSessionFactory;
	let config: SessionLifecycleConfig;

	// Mock spies
	let createSessionSpy: ReturnType<typeof mock>;
	let updateSessionSpy: ReturnType<typeof mock>;
	let deleteSessionSpy: ReturnType<typeof mock>;
	let getSessionSpy: ReturnType<typeof mock>;
	let createWorktreeSpy: ReturnType<typeof mock>;
	let removeWorktreeSpy: ReturnType<typeof mock>;
	let verifyWorktreeSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;
	let publishSpy: ReturnType<typeof mock>;
	let cacheSetSpy: ReturnType<typeof mock>;
	let cacheGetSpy: ReturnType<typeof mock>;
	let cacheHasSpy: ReturnType<typeof mock>;
	let cacheRemoveSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		// Database mocks
		createSessionSpy = mock(() => {});
		updateSessionSpy = mock(() => {});
		deleteSessionSpy = mock(() => {});
		getSessionSpy = mock(() => null);
		mockDb = {
			createSession: createSessionSpy,
			updateSession: updateSessionSpy,
			deleteSession: deleteSessionSpy,
			getSession: getSessionSpy,
		} as unknown as Database;

		// Worktree manager mocks
		createWorktreeSpy = mock(async () => null);
		removeWorktreeSpy = mock(async () => {});
		verifyWorktreeSpy = mock(async () => false);
		mockWorktreeManager = {
			createWorktree: createWorktreeSpy,
			removeWorktree: removeWorktreeSpy,
			verifyWorktree: verifyWorktreeSpy,
			renameBranch: mock(async () => true),
		} as unknown as WorktreeManager;

		// Session cache mocks
		const mockAgentSession = {
			cleanup: mock(async () => {}),
			updateMetadata: mock(() => {}),
			getSessionData: mock(() => ({
				id: 'test-id',
				title: 'Test',
				workspacePath: '/test',
				metadata: { titleGenerated: false },
			})),
		};
		cacheSetSpy = mock(() => {});
		cacheGetSpy = mock(() => mockAgentSession);
		cacheHasSpy = mock(() => false);
		cacheRemoveSpy = mock(() => {});
		mockSessionCache = {
			set: cacheSetSpy,
			get: cacheGetSpy,
			has: cacheHasSpy,
			remove: cacheRemoveSpy,
		} as unknown as SessionCache;

		// Event bus mocks
		emitSpy = mock(async () => {});
		mockEventBus = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		// MessageHub mocks
		publishSpy = mock(async () => {});
		mockMessageHub = {
			publish: publishSpy,
		} as unknown as MessageHub;

		// Tools config manager
		mockToolsConfigManager = {
			getDefaultForNewSession: mock(() => ({ useClaudeCodePreset: true })),
		} as unknown as ToolsConfigManager;

		// Agent session factory
		mockAgentSessionFactory = mock(() => ({
			cleanup: mock(async () => {}),
			updateMetadata: mock(() => {}),
		}));

		// Config
		config = {
			defaultModel: 'default',
			maxTokens: 8192,
			temperature: 1.0,
			workspaceRoot: '/default/workspace',
			disableWorktrees: true, // Disable worktrees for most tests
		};

		lifecycle = new SessionLifecycle(
			mockDb,
			mockWorktreeManager,
			mockSessionCache,
			mockEventBus,
			mockMessageHub,
			config,
			mockToolsConfigManager,
			mockAgentSessionFactory
		);
	});

	describe('create', () => {
		it('should create a session with default values', async () => {
			const sessionId = await lifecycle.create({});

			expect(sessionId).toBeDefined();
			expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
			expect(createSessionSpy).toHaveBeenCalled();
		});

		it('should use provided workspace path', async () => {
			await lifecycle.create({ workspacePath: '/custom/path' });

			expect(createSessionSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					workspacePath: '/custom/path',
				})
			);
		});

		it('should use default workspace root when not provided', async () => {
			await lifecycle.create({});

			expect(createSessionSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					workspacePath: '/default/workspace',
				})
			);
		});

		it('should set default title', async () => {
			await lifecycle.create({});

			expect(createSessionSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					title: 'New Session',
				})
			);
		});

		it('should set status to active', async () => {
			await lifecycle.create({});

			expect(createSessionSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					status: 'active',
				})
			);
		});

		it('should include config with model', async () => {
			await lifecycle.create({});

			expect(createSessionSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					config: expect.objectContaining({
						model: 'default',
						maxTokens: 8192,
						temperature: 1.0,
					}),
				})
			);
		});

		it('should override config values from params', async () => {
			await lifecycle.create({
				config: {
					model: 'opus',
					maxTokens: 4096,
					temperature: 0.5,
				},
			});

			expect(createSessionSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					config: expect.objectContaining({
						maxTokens: 4096,
						temperature: 0.5,
					}),
				})
			);
		});

		it('should add session to cache', async () => {
			const sessionId = await lifecycle.create({});

			expect(cacheSetSpy).toHaveBeenCalledWith(sessionId, expect.anything());
		});

		it('should emit session.created event', async () => {
			const sessionId = await lifecycle.create({});

			expect(emitSpy).toHaveBeenCalledWith('session.created', {
				sessionId,
				session: expect.anything(),
			});
		});

		it('should initialize metadata with zero counts', async () => {
			await lifecycle.create({});

			expect(createSessionSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({
						messageCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						toolCallCount: 0,
						titleGenerated: false,
						workspaceInitialized: true,
					}),
				})
			);
		});

		it('should include tools config from tools manager', async () => {
			await lifecycle.create({});

			expect(createSessionSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					config: expect.objectContaining({
						tools: { useClaudeCodePreset: true },
					}),
				})
			);
		});

		describe('with worktrees enabled', () => {
			beforeEach(() => {
				config.disableWorktrees = false;
				lifecycle = new SessionLifecycle(
					mockDb,
					mockWorktreeManager,
					mockSessionCache,
					mockEventBus,
					mockMessageHub,
					config,
					mockToolsConfigManager,
					mockAgentSessionFactory
				);
			});

			it('should create worktree when enabled', async () => {
				createWorktreeSpy.mockResolvedValue({
					worktreePath: '/worktree/path',
					mainRepoPath: '/main/repo',
					branch: 'session/test',
				});

				await lifecycle.create({});

				expect(createWorktreeSpy).toHaveBeenCalled();
			});

			it('should use worktree path as session workspace', async () => {
				createWorktreeSpy.mockResolvedValue({
					worktreePath: '/worktree/session',
					mainRepoPath: '/main/repo',
					branch: 'session/test',
				});

				await lifecycle.create({});

				expect(createSessionSpy).toHaveBeenCalledWith(
					expect.objectContaining({
						workspacePath: '/worktree/session',
					})
				);
			});

			it('should include worktree metadata in session', async () => {
				const worktreeMetadata = {
					worktreePath: '/worktree/session',
					mainRepoPath: '/main/repo',
					branch: 'session/test-id',
				};
				createWorktreeSpy.mockResolvedValue(worktreeMetadata);

				await lifecycle.create({});

				expect(createSessionSpy).toHaveBeenCalledWith(
					expect.objectContaining({
						worktree: worktreeMetadata,
						gitBranch: 'session/test-id',
					})
				);
			});

			it('should fallback to base workspace on worktree error', async () => {
				createWorktreeSpy.mockRejectedValue(new Error('Git error'));

				await lifecycle.create({ workspacePath: '/my/workspace' });

				expect(createSessionSpy).toHaveBeenCalledWith(
					expect.objectContaining({
						workspacePath: '/my/workspace',
						worktree: undefined,
					})
				);
			});

			it('should use custom base branch', async () => {
				createWorktreeSpy.mockResolvedValue({
					worktreePath: '/worktree',
					mainRepoPath: '/main',
					branch: 'session/test',
				});

				await lifecycle.create({ worktreeBaseBranch: 'develop' });

				expect(createWorktreeSpy).toHaveBeenCalledWith(
					expect.objectContaining({
						baseBranch: 'develop',
					})
				);
			});
		});
	});

	describe('update', () => {
		it('should update session in database', async () => {
			await lifecycle.update('session-123', { title: 'Updated Title' });

			expect(updateSessionSpy).toHaveBeenCalledWith('session-123', {
				title: 'Updated Title',
			});
		});

		it('should update in-memory session when cached', async () => {
			const mockAgentSession = {
				updateMetadata: mock(() => {}),
			};
			cacheHasSpy.mockReturnValue(true);
			cacheGetSpy.mockReturnValue(mockAgentSession);

			await lifecycle.update('session-123', { title: 'New Title' });

			expect(mockAgentSession.updateMetadata).toHaveBeenCalledWith({
				title: 'New Title',
			});
		});

		it('should emit session.updated event', async () => {
			await lifecycle.update('session-123', { title: 'Updated' });

			expect(emitSpy).toHaveBeenCalledWith('session.updated', {
				sessionId: 'session-123',
				source: 'update',
				session: { title: 'Updated' },
			});
		});
	});

	describe('delete', () => {
		it('should delete session from database', async () => {
			await lifecycle.delete('session-123');

			expect(deleteSessionSpy).toHaveBeenCalledWith('session-123');
		});

		it('should remove session from cache', async () => {
			await lifecycle.delete('session-123');

			expect(cacheRemoveSpy).toHaveBeenCalledWith('session-123');
		});

		it('should cleanup agent session when cached', async () => {
			const mockAgentSession = {
				cleanup: mock(async () => {}),
			};
			cacheHasSpy.mockReturnValue(true);
			cacheGetSpy.mockReturnValue(mockAgentSession);

			await lifecycle.delete('session-123');

			expect(mockAgentSession.cleanup).toHaveBeenCalled();
		});

		it('should broadcast session.deleted event', async () => {
			await lifecycle.delete('session-123');

			expect(publishSpy).toHaveBeenCalledWith(
				'session.deleted',
				{ sessionId: 'session-123', reason: 'deleted' },
				{ sessionId: 'global' }
			);
		});

		it('should emit session.deleted via DaemonHub', async () => {
			await lifecycle.delete('session-123');

			expect(emitSpy).toHaveBeenCalledWith('session.deleted', {
				sessionId: 'session-123',
			});
		});

		it('should remove worktree when session has one', async () => {
			const sessionWithWorktree = {
				workspacePath: '/worktree/path',
				worktree: {
					worktreePath: '/worktree/path',
					mainRepoPath: '/main',
					branch: 'session/test',
				},
			};
			getSessionSpy.mockReturnValue(sessionWithWorktree);

			await lifecycle.delete('session-123');

			expect(removeWorktreeSpy).toHaveBeenCalledWith(sessionWithWorktree.worktree, true);
		});

		it('should continue on worktree removal failure', async () => {
			const sessionWithWorktree = {
				workspacePath: '/worktree/path',
				worktree: {
					worktreePath: '/worktree/path',
					mainRepoPath: '/main',
					branch: 'session/test',
				},
			};
			getSessionSpy.mockReturnValue(sessionWithWorktree);
			removeWorktreeSpy.mockRejectedValue(new Error('Git error'));

			// Should not throw
			await expect(lifecycle.delete('session-123')).resolves.toBeUndefined();
			expect(deleteSessionSpy).toHaveBeenCalled();
		});

		it('should throw when database delete fails', async () => {
			deleteSessionSpy.mockImplementation(() => {
				throw new Error('DB error');
			});

			await expect(lifecycle.delete('session-123')).rejects.toThrow('DB error');
		});
	});

	describe('getFromDB', () => {
		it('should return session from database', () => {
			const mockSession = { id: 'test', title: 'Test Session' };
			getSessionSpy.mockReturnValue(mockSession);

			const result = lifecycle.getFromDB('test');

			expect(result).toEqual(mockSession);
			expect(getSessionSpy).toHaveBeenCalledWith('test');
		});

		it('should return null for non-existent session', () => {
			getSessionSpy.mockReturnValue(null);

			const result = lifecycle.getFromDB('non-existent');

			expect(result).toBeNull();
		});
	});

	describe('markOutputRemoved', () => {
		it('should add message UUID to removedOutputs', async () => {
			const session = {
				id: 'session-123',
				metadata: { removedOutputs: [] },
			};
			getSessionSpy.mockReturnValue(session);

			await lifecycle.markOutputRemoved('session-123', 'message-uuid-456');

			expect(updateSessionSpy).toHaveBeenCalledWith('session-123', {
				metadata: expect.objectContaining({
					removedOutputs: ['message-uuid-456'],
				}),
			});
		});

		it('should not duplicate message UUID', async () => {
			const session = {
				id: 'session-123',
				metadata: { removedOutputs: ['existing-uuid'] },
			};
			getSessionSpy.mockReturnValue(session);

			await lifecycle.markOutputRemoved('session-123', 'existing-uuid');

			expect(updateSessionSpy).toHaveBeenCalledWith('session-123', {
				metadata: expect.objectContaining({
					removedOutputs: ['existing-uuid'],
				}),
			});
		});

		it('should throw for non-existent session', async () => {
			getSessionSpy.mockReturnValue(null);

			await expect(lifecycle.markOutputRemoved('non-existent', 'uuid')).rejects.toThrow(
				'Session not found'
			);
		});
	});
});

describe('generateBranchName', () => {
	it('should create branch name from title and session ID', () => {
		const result = generateBranchName('Fix login bug', 'abc12345-def6-7890');
		expect(result).toBe('session/fix-login-bug-abc12345');
	});

	it('should slugify title', () => {
		const result = generateBranchName('Add New Feature!', 'test1234-5678-abcd');
		expect(result).toBe('session/add-new-feature-test1234');
	});

	it('should handle special characters', () => {
		const result = generateBranchName("What's the bug?", 'xyz98765-4321-efgh');
		expect(result).toBe('session/what-s-the-bug-xyz98765');
	});

	it('should truncate long titles', () => {
		const longTitle = 'This is a very long title that should be truncated to fit within limits';
		const result = generateBranchName(longTitle, 'short123-4567-89ab');
		expect(result.length).toBeLessThan(70); // session/ + 50 + - + 8
	});

	it('should use short session ID', () => {
		const result = generateBranchName('Test', '12345678-abcd-efgh-ijkl-mnopqrstuvwx');
		expect(result).toContain('12345678');
		expect(result).not.toContain('mnopqrstuvwx');
	});

	it('should lowercase the title', () => {
		const result = generateBranchName('UPPERCASE TITLE', 'test1234');
		expect(result).toBe('session/uppercase-title-test1234');
	});

	it('should remove leading/trailing hyphens', () => {
		const result = generateBranchName('  Spaces around  ', 'test1234');
		expect(result).toBe('session/spaces-around-test1234');
	});
});

describe('slugify', () => {
	it('should convert to lowercase', () => {
		expect(slugify('HELLO')).toBe('hello');
	});

	it('should replace spaces with hyphens', () => {
		expect(slugify('hello world')).toBe('hello-world');
	});

	it('should remove special characters', () => {
		expect(slugify("what's up?")).toBe('what-s-up');
	});

	it('should collapse multiple hyphens', () => {
		expect(slugify('hello---world')).toBe('hello-world');
	});

	it('should remove leading/trailing hyphens', () => {
		expect(slugify('--hello--')).toBe('hello');
	});

	it('should truncate to 50 characters', () => {
		const long = 'a'.repeat(100);
		expect(slugify(long).length).toBe(50);
	});

	it('should handle empty string', () => {
		expect(slugify('')).toBe('');
	});

	it('should handle only special characters', () => {
		expect(slugify('!@#$%')).toBe('');
	});
});
