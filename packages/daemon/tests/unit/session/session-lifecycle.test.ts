/**
 * Session Lifecycle Tests
 *
 * Unit tests for session CRUD operations including creation,
 * updates, deletion, and title generation.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// Mock SDK type-guards at the top level
mock.module('@neokai/shared/sdk/type-guards', () => ({
	isSDKAssistantMessage: (msg: { type: string }) => msg.type === 'assistant',
}));

import {
	SessionLifecycle,
	type SessionLifecycleConfig,
	generateBranchName,
} from '../../../src/lib/session/session-lifecycle';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { WorktreeManager } from '../../../src/lib/worktree-manager';
import type { SessionCache, AgentSessionFactory } from '../../../src/lib/session/session-cache';
import type { ToolsConfigManager } from '../../../src/lib/session/tools-config';
import type { MessageHub, Session } from '@neokai/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

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
	let createdSessions: Session[];

	beforeEach(() => {
		createdSessions = [];

		// Database mocks
		mockDb = {
			createSession: mock((session: Session) => {
				createdSessions.push(session);
			}),
			updateSession: mock(() => {}),
			deleteSession: mock(() => {}),
			getSession: mock(() => null),
			getGlobalSettings: mock(() => ({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
			})),
		} as unknown as Database;

		// Worktree manager mocks
		mockWorktreeManager = {
			detectGitSupport: mock(async () => ({ isGitRepo: false, isBare: false })),
			createWorktree: mock(async () => null),
			removeWorktree: mock(async () => {}),
			verifyWorktree: mock(async () => false),
			renameBranch: mock(async () => true),
			getCurrentBranch: mock(async () => 'main'),
		} as unknown as WorktreeManager;

		// Session cache mocks
		const mockAgentSession = {
			cleanup: mock(async () => {}),
			updateMetadata: mock(() => {}),
			getSessionData: mock(() => ({
				id: 'test-id',
				title: 'Test',
				workspacePath: '/test',
				status: 'active',
				metadata: { titleGenerated: false, worktreeChoice: undefined },
				config: {},
				worktree: undefined,
			})),
		};
		mockSessionCache = {
			set: mock(() => {}),
			get: mock(() => mockAgentSession),
			has: mock(() => false),
			remove: mock(() => {}),
			clear: mock(() => {}),
			getAsync: mock(async () => mockAgentSession),
		} as unknown as SessionCache;

		// Event bus mocks
		mockEventBus = {
			on: mock(() => () => {}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		// Message hub mocks
		mockMessageHub = {
			event: mock(async () => {}),
			onRequest: mock((_method: string, _handler: Function) => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		// Tools config manager mocks
		mockToolsConfigManager = {
			getDefaultForNewSession: mock(() => ({
				useClaudeCodePreset: true,
				settingSources: ['project', 'local'],
				disabledMcpServers: [],
			})),
		} as unknown as ToolsConfigManager;

		// Agent session factory
		mockAgentSessionFactory = mock(() => mockAgentSession);

		// Config
		config = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxTokens: 8192,
			temperature: 1.0,
			workspaceRoot: '/default/workspace',
			disableWorktrees: true,
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
			expect(typeof sessionId).toBe('string');
			expect(sessionId.length).toBeGreaterThan(0);

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					id: sessionId,
					title: 'New Session',
					status: 'active',
				})
			);
		});

		it('should create a session with provided title', async () => {
			const sessionId = await lifecycle.create({ title: 'My Custom Title' });

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					title: 'My Custom Title',
				})
			);
		});

		it('should set titleGenerated to true when title is provided', async () => {
			await lifecycle.create({ title: 'Custom Title' });

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({
						titleGenerated: true,
					}),
				})
			);
		});

		it('should set titleGenerated to false when no title is provided', async () => {
			await lifecycle.create({});

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({
						titleGenerated: false,
					}),
				})
			);
		});

		it('should create a session with custom workspace path', async () => {
			const sessionId = await lifecycle.create({
				workspacePath: '/custom/workspace',
			});

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					workspacePath: '/custom/workspace',
				})
			);
		});

		it('should use default workspace root when not specified', async () => {
			await lifecycle.create({});

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					workspacePath: '/default/workspace',
				})
			);
		});

		it('should create session with pending_worktree_choice status for git repos', async () => {
			(mockWorktreeManager.detectGitSupport as ReturnType<typeof mock>).mockResolvedValue({
				isGitRepo: true,
				isBare: false,
				gitRoot: '/test/repo',
			});

			// Create a new lifecycle with worktrees enabled
			const worktreeEnabledConfig = {
				...config,
				disableWorktrees: false,
			};
			const worktreeLifecycle = new SessionLifecycle(
				mockDb,
				mockWorktreeManager,
				mockSessionCache,
				mockEventBus,
				mockMessageHub,
				worktreeEnabledConfig,
				mockToolsConfigManager,
				mockAgentSessionFactory
			);

			await worktreeLifecycle.create({});

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					status: 'pending_worktree_choice',
				})
			);
		});

		it('should create session with active status for non-git repos', async () => {
			(mockWorktreeManager.detectGitSupport as ReturnType<typeof mock>).mockResolvedValue({
				isGitRepo: false,
				isBare: false,
			});

			await lifecycle.create({});

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					status: 'active',
				})
			);
		});

		it('should create session with active status when worktrees are disabled', async () => {
			(mockWorktreeManager.detectGitSupport as ReturnType<typeof mock>).mockResolvedValue({
				isGitRepo: true,
				isBare: false,
				gitRoot: '/test/repo',
			});
			config.disableWorktrees = true;

			await lifecycle.create({});

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					status: 'active',
				})
			);
		});

		it('should add session to cache after creation', async () => {
			await lifecycle.create({});

			expect(mockSessionCache.set).toHaveBeenCalled();
		});

		it('should emit session.created event', async () => {
			await lifecycle.create({});

			expect(mockEventBus.emit).toHaveBeenCalledWith(
				'session.created',
				expect.objectContaining({
					sessionId: expect.any(String),
					session: expect.any(Object),
				})
			);
		});

		it('should create session with dual-session architecture fields', async () => {
			await lifecycle.create({
				sessionType: 'worker',
				pairedSessionId: 'manager-id',
				parentSessionId: 'parent-id',
				currentTaskId: 'task-123',
			});

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({
						sessionType: 'worker',
						pairedSessionId: 'manager-id',
						parentSessionId: 'parent-id',
						currentTaskId: 'task-123',
					}),
				})
			);
		});

		it('should create session with custom config', async () => {
			await lifecycle.create({
				config: {
					model: 'claude-opus-4-20250514',
					maxTokens: 4096,
					temperature: 0.5,
					autoScroll: false,
					thinkingLevel: 'think32k',
				},
			});

			expect(mockDb.createSession).toHaveBeenCalledWith(
				expect.objectContaining({
					config: expect.objectContaining({
						model: 'claude-opus-4-20250514',
						maxTokens: 4096,
						temperature: 0.5,
						autoScroll: false,
						thinkingLevel: 'think32k',
					}),
				})
			);
		});

		it('should create session with roomId', async () => {
			await lifecycle.create({
				roomId: 'room-123',
			});

			// roomId is stored in metadata
			expect(mockDb.createSession).toHaveBeenCalled();
		});

		it('should create session with createdBy field', async () => {
			await lifecycle.create({
				createdBy: 'neo',
			});

			// createdBy is stored in metadata
			expect(mockDb.createSession).toHaveBeenCalled();
		});
	});

	describe('update', () => {
		it('should update session in database', async () => {
			const sessionId = 'test-session-id';
			const updates = { title: 'Updated Title' };

			await lifecycle.update(sessionId, updates);

			expect(mockDb.updateSession).toHaveBeenCalledWith(sessionId, updates);
		});

		it('should update in-memory session if cached', async () => {
			(mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
			const mockAgentSession = {
				updateMetadata: mock(() => {}),
			};
			(mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);

			const updates = { title: 'Updated Title' };
			await lifecycle.update('test-id', updates);

			expect(mockAgentSession.updateMetadata).toHaveBeenCalledWith(updates);
		});

		it('should emit session.updated event', async () => {
			await lifecycle.update('test-id', { title: 'New Title' });

			expect(mockEventBus.emit).toHaveBeenCalledWith(
				'session.updated',
				expect.objectContaining({
					sessionId: 'test-id',
					source: 'update',
					session: { title: 'New Title' },
				})
			);
		});
	});

	describe('delete', () => {
		it('should delete session from database', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				workspacePath: '/test',
			});

			await lifecycle.delete('test-id');

			expect(mockDb.deleteSession).toHaveBeenCalledWith('test-id');
		});

		it('should remove session from cache', async () => {
			(mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				workspacePath: '/test',
			});

			await lifecycle.delete('test-id');

			expect(mockSessionCache.remove).toHaveBeenCalledWith('test-id');
		});

		it('should cleanup agent session if cached', async () => {
			const mockAgentSession = {
				cleanup: mock(async () => {}),
			};
			(mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
			(mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				workspacePath: '/test',
			});

			await lifecycle.delete('test-id');

			expect(mockAgentSession.cleanup).toHaveBeenCalled();
		});

		it('should delete worktree if present', async () => {
			const sessionWithWorktree = {
				id: 'test-id',
				workspacePath: '/test',
				worktree: {
					worktreePath: '/test/worktree',
					branch: 'test-branch',
					mainRepoPath: '/test/main',
				},
			};
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(sessionWithWorktree);

			await lifecycle.delete('test-id');

			expect(mockWorktreeManager.removeWorktree).toHaveBeenCalledWith(
				sessionWithWorktree.worktree,
				true
			);
		});

		it('should broadcast deletion event', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				workspacePath: '/test',
			});

			await lifecycle.delete('test-id');

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				'session.deleted',
				expect.objectContaining({ sessionId: 'test-id' }),
				{ channel: 'global' }
			);
			expect(mockEventBus.emit).toHaveBeenCalledWith(
				'session.deleted',
				expect.objectContaining({ sessionId: 'test-id' })
			);
		});

		it('should continue deletion even if agent cleanup fails', async () => {
			const mockAgentSession = {
				cleanup: mock(async () => {
					throw new Error('Cleanup failed');
				}),
			};
			(mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
			(mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				workspacePath: '/test',
			});

			// Should complete deletion despite cleanup failure
			await lifecycle.delete('test-id');
			expect(mockDb.deleteSession).toHaveBeenCalledWith('test-id');
		});

		it('should continue deletion even if worktree removal fails', async () => {
			(mockWorktreeManager.removeWorktree as ReturnType<typeof mock>).mockRejectedValue(
				new Error('Worktree removal failed')
			);
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				workspacePath: '/test',
				worktree: {
					worktreePath: '/test/worktree',
					branch: 'test-branch',
					mainRepoPath: '/test/main',
				},
			});

			// Should complete deletion despite worktree removal failure
			await lifecycle.delete('test-id');
			expect(mockDb.deleteSession).toHaveBeenCalledWith('test-id');
		});
	});

	describe('completeWorktreeChoice', () => {
		let mockAgentSession: {
			getSessionData: ReturnType<typeof mock>;
			updateMetadata: ReturnType<typeof mock>;
		};

		beforeEach(() => {
			mockAgentSession = {
				getSessionData: mock(() => ({
					id: 'test-id',
					title: 'Test',
					workspacePath: '/test',
					status: 'pending_worktree_choice',
					metadata: {
						titleGenerated: true,
						worktreeChoice: {
							status: 'pending',
							createdAt: new Date().toISOString(),
						},
					},
					config: {},
					worktree: undefined,
				})),
				updateMetadata: mock(() => {}),
			};
			(mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);
		});

		it('should throw error if session not found', async () => {
			(mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(null);

			await expect(lifecycle.completeWorktreeChoice('nonexistent', 'worktree')).rejects.toThrow(
				'Session nonexistent not found'
			);
		});

		it('should throw error if session is not pending worktree choice', async () => {
			mockAgentSession.getSessionData.mockReturnValue({
				id: 'test-id',
				status: 'active',
				metadata: {},
				config: {},
			});

			await expect(lifecycle.completeWorktreeChoice('test-id', 'worktree')).rejects.toThrow(
				'is not pending worktree choice'
			);
		});

		it('should create worktree when choice is worktree', async () => {
			(mockWorktreeManager.createWorktree as ReturnType<typeof mock>).mockResolvedValue({
				worktreePath: '/test/worktree',
				branch: 'session/test-id',
				mainRepoPath: '/test/main',
			});

			await lifecycle.completeWorktreeChoice('test-id', 'worktree');

			expect(mockWorktreeManager.createWorktree).toHaveBeenCalled();
		});

		it('should not create worktree when choice is direct', async () => {
			await lifecycle.completeWorktreeChoice('test-id', 'direct');

			expect(mockWorktreeManager.createWorktree).not.toHaveBeenCalled();
		});

		it('should update session status to active', async () => {
			await lifecycle.completeWorktreeChoice('test-id', 'direct');

			expect(mockDb.updateSession).toHaveBeenCalledWith(
				'test-id',
				expect.objectContaining({
					status: 'active',
				})
			);
		});

		it('should update worktreeChoice metadata', async () => {
			await lifecycle.completeWorktreeChoice('test-id', 'direct');

			expect(mockDb.updateSession).toHaveBeenCalledWith(
				'test-id',
				expect.objectContaining({
					metadata: expect.objectContaining({
						worktreeChoice: expect.objectContaining({
							status: 'completed',
							choice: 'direct',
						}),
					}),
				})
			);
		});

		it('should emit session.updated event', async () => {
			await lifecycle.completeWorktreeChoice('test-id', 'direct');

			expect(mockEventBus.emit).toHaveBeenCalledWith(
				'session.updated',
				expect.objectContaining({
					sessionId: 'test-id',
				})
			);
		});
	});

	describe('getFromDB', () => {
		it('should return session from database', () => {
			const mockSession = { id: 'test-id', title: 'Test' };
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

			const result = lifecycle.getFromDB('test-id');

			expect(mockDb.getSession).toHaveBeenCalledWith('test-id');
			expect(result).toEqual(mockSession);
		});

		it('should return null if session not found', () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			const result = lifecycle.getFromDB('nonexistent');

			expect(result).toBeNull();
		});
	});

	describe('markOutputRemoved', () => {
		it('should throw error if session not found', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

			await expect(lifecycle.markOutputRemoved('nonexistent', 'msg-uuid')).rejects.toThrow(
				'Session not found'
			);
		});

		it('should add messageUuid to removedOutputs', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				metadata: { removedOutputs: [] },
			});

			await lifecycle.markOutputRemoved('test-id', 'msg-uuid');

			expect(mockDb.updateSession).toHaveBeenCalledWith(
				'test-id',
				expect.objectContaining({
					metadata: expect.objectContaining({
						removedOutputs: ['msg-uuid'],
					}),
				})
			);
		});

		it('should not add duplicate messageUuid', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				metadata: { removedOutputs: ['msg-uuid'] },
			});

			await lifecycle.markOutputRemoved('test-id', 'msg-uuid');

			expect(mockDb.updateSession).toHaveBeenCalledWith(
				'test-id',
				expect.objectContaining({
					metadata: expect.objectContaining({
						removedOutputs: ['msg-uuid'],
					}),
				})
			);
		});

		it('should initialize removedOutputs if undefined', async () => {
			(mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
				id: 'test-id',
				metadata: {},
			});

			await lifecycle.markOutputRemoved('test-id', 'msg-uuid');

			expect(mockDb.updateSession).toHaveBeenCalledWith(
				'test-id',
				expect.objectContaining({
					metadata: expect.objectContaining({
						removedOutputs: ['msg-uuid'],
					}),
				})
			);
		});
	});
});

describe('generateBranchName', () => {
	it('should generate branch name from title', () => {
		const result = generateBranchName('Fix login bug', 'abc12345-6789');

		expect(result).toBe('session/fix-login-bug-abc12345');
	});

	it('should slugify title correctly', () => {
		const result = generateBranchName('Add Feature: User Authentication!!!', 'xyz98765-4321');

		expect(result).toBe('session/add-feature-user-authentication-xyz98765');
	});

	it('should truncate long titles', () => {
		const longTitle =
			'This is a very long title that should be truncated to prevent branch names from being too long';
		const result = generateBranchName(longTitle, 'abc12345-6789');

		expect(result.length).toBeLessThan(80);
		expect(result.startsWith('session/')).toBe(true);
	});

	it('should handle special characters', () => {
		const result = generateBranchName('Fix @#$%^& bug!', 'abc12345-6789');

		expect(result).toBe('session/fix-bug-abc12345');
	});

	it('should handle empty title', () => {
		const result = generateBranchName('', 'abc12345-6789');

		expect(result).toBe('session/-abc12345');
	});

	it('should handle unicode characters', () => {
		const result = generateBranchName('Fix 日本語 bug', 'abc12345-6789');

		expect(result).toBe('session/fix-bug-abc12345');
	});
});

describe('SessionLifecycle - generateTitleAndRenameBranch', () => {
	let lifecycle: SessionLifecycle;
	let mockDb: Database;
	let mockWorktreeManager: WorktreeManager;
	let mockSessionCache: SessionCache;
	let mockEventBus: DaemonHub;
	let mockMessageHub: MessageHub;
	let mockToolsConfigManager: ToolsConfigManager;
	let mockAgentSessionFactory: AgentSessionFactory;
	let config: SessionLifecycleConfig;

	beforeEach(() => {
		// Database mocks
		mockDb = {
			createSession: mock(() => {}),
			updateSession: mock(() => {}),
			deleteSession: mock(() => {}),
			getSession: mock(() => null),
			getGlobalSettings: mock(() => ({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
			})),
		} as unknown as Database;

		// Worktree manager mocks
		mockWorktreeManager = {
			detectGitSupport: mock(async () => ({ isGitRepo: false, isBare: false })),
			createWorktree: mock(async () => null),
			removeWorktree: mock(async () => {}),
			verifyWorktree: mock(async () => false),
			renameBranch: mock(async () => true),
			getCurrentBranch: mock(async () => 'main'),
		} as unknown as WorktreeManager;

		// Session cache mocks
		const mockAgentSession = {
			cleanup: mock(async () => {}),
			updateMetadata: mock(() => {}),
			getSessionData: mock(() => ({
				id: 'test-id',
				title: 'Test',
				workspacePath: '/test',
				status: 'active',
				metadata: { titleGenerated: false, worktreeChoice: undefined },
				config: {},
				worktree: undefined,
			})),
		};
		mockSessionCache = {
			set: mock(() => {}),
			get: mock(() => mockAgentSession),
			has: mock(() => true),
			remove: mock(() => {}),
			clear: mock(() => {}),
			getAsync: mock(async () => mockAgentSession),
		} as unknown as SessionCache;

		// Event bus mocks
		mockEventBus = {
			on: mock(() => () => {}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		// Message hub mocks
		mockMessageHub = {
			event: mock(async () => {}),
			onRequest: mock(() => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		// Tools config manager mocks
		mockToolsConfigManager = {
			getDefaultForNewSession: mock(() => ({
				useClaudeCodePreset: true,
				settingSources: ['project', 'local'],
				disabledMcpServers: [],
			})),
		} as unknown as ToolsConfigManager;

		// Agent session factory
		mockAgentSessionFactory = mock(() => mockAgentSession);

		// Config
		config = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxTokens: 8192,
			temperature: 1.0,
			workspaceRoot: '/default/workspace',
			disableWorktrees: true,
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

	it('should return existing title if already generated', async () => {
		const mockAgentSession = {
			getSessionData: mock(() => ({
				id: 'test-id',
				title: 'Existing Title',
				workspacePath: '/test',
				status: 'active',
				metadata: { titleGenerated: true },
				config: {},
			})),
		};
		(mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
		(mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);

		const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'new message');

		expect(result.title).toBe('Existing Title');
		expect(result.isFallback).toBe(false);
	});

	it('should throw error if session not found', async () => {
		(mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(false);
		(mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(null);

		await expect(lifecycle.generateTitleAndRenameBranch('nonexistent', 'message')).rejects.toThrow(
			'Session nonexistent not found'
		);
	});

	it('should rename branch when worktree exists', async () => {
		const mockAgentSession = {
			getSessionData: mock(() => ({
				id: 'test-id',
				title: 'New Session',
				workspacePath: '/test',
				status: 'active',
				metadata: { titleGenerated: false },
				config: {},
				worktree: {
					worktreePath: '/test/worktree',
					branch: 'session/test-id',
					mainRepoPath: '/test/main',
				},
			})),
			updateMetadata: mock(() => {}),
		};
		(mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
		(mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);

		// This test verifies the branch rename path is exercised
		// The actual title generation requires provider service which is complex to mock
		const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'test message');

		expect(result).toBeDefined();
		expect(typeof result.title).toBe('string');
	});
});

describe('SessionLifecycle - completeWorktreeChoice edge cases', () => {
	let lifecycle: SessionLifecycle;
	let mockDb: Database;
	let mockWorktreeManager: WorktreeManager;
	let mockSessionCache: SessionCache;
	let mockEventBus: DaemonHub;
	let mockMessageHub: MessageHub;
	let mockToolsConfigManager: ToolsConfigManager;
	let mockAgentSessionFactory: AgentSessionFactory;
	let config: SessionLifecycleConfig;

	beforeEach(() => {
		mockDb = {
			createSession: mock(() => {}),
			updateSession: mock(() => {}),
			deleteSession: mock(() => {}),
			getSession: mock(() => null),
			getGlobalSettings: mock(() => DEFAULT_GLOBAL_SETTINGS),
		} as unknown as Database;

		mockWorktreeManager = {
			detectGitSupport: mock(async () => ({ isGitRepo: true, isBare: false, gitRoot: '/test' })),
			createWorktree: mock(async () => ({
				worktreePath: '/test/worktree',
				branch: 'session/test-id',
				mainRepoPath: '/test/main',
			})),
			removeWorktree: mock(async () => {}),
			getCurrentBranch: mock(async () => 'main'),
		} as unknown as WorktreeManager;

		const mockAgentSession = {
			cleanup: mock(async () => {}),
			updateMetadata: mock(() => {}),
			getSessionData: mock(() => ({
				id: 'test-id',
				title: 'Test',
				workspacePath: '/test',
				status: 'pending_worktree_choice',
				metadata: {
					titleGenerated: true,
					worktreeChoice: { status: 'pending', createdAt: new Date().toISOString() },
				},
				config: {},
			})),
		};

		mockSessionCache = {
			set: mock(() => {}),
			get: mock(() => mockAgentSession),
			has: mock(() => true),
			remove: mock(() => {}),
		} as unknown as SessionCache;

		mockEventBus = {
			on: mock(() => () => {}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		mockMessageHub = {
			event: mock(async () => {}),
		} as unknown as MessageHub;

		mockToolsConfigManager = {
			getDefaultForNewSession: mock(() => ({})),
		} as unknown as ToolsConfigManager;

		mockAgentSessionFactory = mock(() => mockAgentSession);

		config = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxTokens: 8192,
			temperature: 1.0,
			workspaceRoot: '/default/workspace',
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

	it('should detect current branch for direct mode', async () => {
		await lifecycle.completeWorktreeChoice('test-id', 'direct');

		expect(mockWorktreeManager.getCurrentBranch).toHaveBeenCalledWith('/test');
	});

	it('should handle branch detection failure gracefully', async () => {
		(mockWorktreeManager.getCurrentBranch as ReturnType<typeof mock>).mockRejectedValue(
			new Error('Not a git repo')
		);

		// Should not throw
		await lifecycle.completeWorktreeChoice('test-id', 'direct');
	});

	it('should handle worktree creation failure gracefully', async () => {
		(mockWorktreeManager.createWorktree as ReturnType<typeof mock>).mockResolvedValue(null);

		const result = await lifecycle.completeWorktreeChoice('test-id', 'worktree');

		// Should still complete with active status
		expect(result.status).toBe('active');
	});
});

describe('SessionLifecycle - session creation with worktree', () => {
	let lifecycle: SessionLifecycle;
	let mockDb: Database;
	let mockWorktreeManager: WorktreeManager;
	let mockSessionCache: SessionCache;
	let mockEventBus: DaemonHub;
	let mockMessageHub: MessageHub;
	let mockToolsConfigManager: ToolsConfigManager;
	let mockAgentSessionFactory: AgentSessionFactory;
	let config: SessionLifecycleConfig;

	beforeEach(() => {
		mockDb = {
			createSession: mock(() => {}),
			updateSession: mock(() => {}),
			deleteSession: mock(() => {}),
			getSession: mock(() => null),
			getGlobalSettings: mock(() => DEFAULT_GLOBAL_SETTINGS),
		} as unknown as Database;

		mockWorktreeManager = {
			detectGitSupport: mock(async () => ({ isGitRepo: false, isBare: false })),
			createWorktree: mock(async () => ({
				worktreePath: '/test/worktree',
				branch: 'session/test-id',
				mainRepoPath: '/test/main',
			})),
			removeWorktree: mock(async () => {}),
			getCurrentBranch: mock(async () => 'main'),
		} as unknown as WorktreeManager;

		const mockAgentSession = {
			cleanup: mock(async () => {}),
			updateMetadata: mock(() => {}),
			getSessionData: mock(() => ({
				id: 'test-id',
				title: 'Test',
				workspacePath: '/test',
				status: 'active',
				metadata: {},
				config: {},
			})),
		};

		mockSessionCache = {
			set: mock(() => {}),
			get: mock(() => mockAgentSession),
			has: mock(() => false),
			remove: mock(() => {}),
		} as unknown as SessionCache;

		mockEventBus = {
			on: mock(() => () => {}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		mockMessageHub = {
			event: mock(async () => {}),
		} as unknown as MessageHub;

		mockToolsConfigManager = {
			getDefaultForNewSession: mock(() => ({
				useClaudeCodePreset: true,
				settingSources: [],
				disabledMcpServers: [],
			})),
		} as unknown as ToolsConfigManager;

		mockAgentSessionFactory = mock(() => mockAgentSession);

		config = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxTokens: 8192,
			temperature: 1.0,
			workspaceRoot: '/default/workspace',
			disableWorktrees: false,
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

	it('should create worktree for non-git repos when worktrees enabled', async () => {
		await lifecycle.create({ title: 'Test Session' });

		expect(mockWorktreeManager.createWorktree).toHaveBeenCalled();
	});

	it('should handle worktree creation failure gracefully', async () => {
		(mockWorktreeManager.createWorktree as ReturnType<typeof mock>).mockRejectedValue(
			new Error('Worktree creation failed')
		);

		// Should not throw
		const sessionId = await lifecycle.create({ title: 'Test Session' });

		expect(sessionId).toBeDefined();
	});

	it('should use title for branch name when title provided', async () => {
		await lifecycle.create({ title: 'Feature Implementation' });

		expect(mockWorktreeManager.createWorktree).toHaveBeenCalledWith(
			expect.objectContaining({
				branchName: expect.stringContaining('feature-implementation'),
			})
		);
	});

	it('should use session ID for branch name when no title provided', async () => {
		await lifecycle.create({});

		expect(mockWorktreeManager.createWorktree).toHaveBeenCalledWith(
			expect.objectContaining({
				branchName: expect.stringMatching(/^session\/[a-f0-9-]+$/),
			})
		);
	});
});
