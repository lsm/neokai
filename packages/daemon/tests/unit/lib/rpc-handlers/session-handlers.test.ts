/**
 * Session Handlers Tests
 *
 * Tests for session RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupSessionHandlers } from '../../../../src/lib/rpc-handlers/session-handlers';
import type { MessageHub, Session } from '@neokai/shared';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { Database } from '../../../../src/storage/database';

// Mock the sdk-session-file-manager module
mock.module('../../../../src/lib/sdk-session-file-manager', () => ({
	archiveSDKSessionFiles: mock(
		(_workspacePath: string, _sdkSessionId: string | null, _kaiSessionId: string) => ({
			success: true,
			archivePath: '/archive/path',
			archivedFiles: ['file1.jsonl'],
			totalSize: 1000,
			errors: [],
		})
	),
	deleteSDKSessionFiles: mock(
		(_workspacePath: string, _sdkSessionId: string, _kaiSessionId: string) => ({
			success: true,
			deletedFiles: ['file1.jsonl'],
			deletedSize: 1000,
			errors: [],
		})
	),
	scanSDKSessionFiles: mock((_workspacePath: string) => [
		{
			sdkSessionId: 'sdk-session-1',
			filepath: '/path/to/file.jsonl',
			size: 1000,
			kaiSessionIds: ['session-1'],
		},
	]),
	identifyOrphanedSDKFiles: mock(
		(
			_files: Array<{ sdkSessionId: string }>,
			_activeIds: Set<string>,
			_archivedIds: Set<string>
		) => []
	),
}));

// Mock the model-service module
mock.module('../../../../src/lib/model-service', () => ({
	resolveModelAlias: mock(async (modelId: string) => modelId),
	getModelInfo: mock(async (_modelId: string) => ({
		id: 'claude-sonnet-4-20250514',
		name: 'Claude Sonnet',
		description: 'Fast and capable',
	})),
	getAvailableModels: mock((_cacheKey: string) => [
		{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet', description: 'Fast and capable' },
		{ id: 'claude-opus-4-20250514', name: 'Claude Opus', description: 'Most powerful' },
	]),
	clearModelsCache: mock(() => {}),
}));

describe('Session Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let mockDaemonHub: DaemonHub;
	let handlers: Map<string, (data: unknown, ctx?: unknown) => Promise<unknown>>;
	let mockAgentSession: {
		getSessionData: ReturnType<typeof mock>;
		getContextInfo: ReturnType<typeof mock>;
		getCurrentModel: ReturnType<typeof mock>;
		handleModelSwitch: ReturnType<typeof mock>;
		setMaxThinkingTokens: ReturnType<typeof mock>;
		getProcessingState: ReturnType<typeof mock>;
		resetQuery: ReturnType<typeof mock>;
		handleQueryTrigger: ReturnType<typeof mock>;
	};
	let mockSession: Session;
	let mockDb: Database;

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown, ctx?: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
			publish: mock(async () => {}),
		} as unknown as MessageHub;

		// Mock session data
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/path',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-20250514',
				maxTokens: 8192,
				temperature: 1.0,
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
			},
		};

		// Mock AgentSession
		mockAgentSession = {
			getSessionData: mock(() => mockSession),
			getContextInfo: mock(() => ({ totalTokens: 1000, maxTokens: 128000 })),
			getCurrentModel: mock(() => ({ id: 'claude-sonnet-4-20250514' })),
			handleModelSwitch: mock(async () => ({ success: true, model: 'claude-opus-4-20250514' })),
			setMaxThinkingTokens: mock(async () => ({ success: true })),
			getProcessingState: mock(() => ({ phase: 'idle', isProcessing: false })),
			resetQuery: mock(async () => ({ success: true })),
			handleQueryTrigger: mock(async () => ({ success: true, messageCount: 2 })),
		};

		// Mock Database
		mockDb = {
			getMessageCountByStatus: mock(() => 3),
		} as unknown as Database;

		// Mock SessionManager
		mockSessionManager = {
			createSession: mock(async () => 'new-session-id'),
			listSessions: mock(() => [mockSession]),
			getSession: mock(() => mockAgentSession),
			getSessionAsync: mock(async () => mockAgentSession),
			updateSession: mock(async () => {}),
			deleteSession: mock(async () => {}),
			cleanupOrphanedWorktrees: mock(async () => ['/cleaned/path1']),
			getDatabase: mock(() => mockDb),
		} as unknown as SessionManager;

		// Mock DaemonHub
		mockDaemonHub = {
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		// Setup handlers
		setupSessionHandlers(mockMessageHub, mockSessionManager, mockDaemonHub);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data, {});
	}

	describe('setup', () => {
		it('should register all session handlers', () => {
			expect(handlers.has('session.create')).toBe(true);
			expect(handlers.has('session.list')).toBe(true);
			expect(handlers.has('session.get')).toBe(true);
			expect(handlers.has('session.validate')).toBe(true);
			expect(handlers.has('session.update')).toBe(true);
			expect(handlers.has('session.delete')).toBe(true);
			expect(handlers.has('session.archive')).toBe(true);
			expect(handlers.has('message.send')).toBe(true);
			expect(handlers.has('client.interrupt')).toBe(true);
			expect(handlers.has('session.model.get')).toBe(true);
			expect(handlers.has('session.model.switch')).toBe(true);
		});
	});

	describe('session.create', () => {
		it('should create a new session', async () => {
			const result = (await callHandler('session.create', {
				workspacePath: '/new/path',
			})) as { sessionId: string; session: Session };

			expect(mockSessionManager.createSession).toHaveBeenCalledWith({
				workspacePath: '/new/path',
				initialTools: undefined,
				config: undefined,
				worktreeBaseBranch: undefined,
				title: undefined,
			});
			expect(result.sessionId).toBe('new-session-id');
		});

		it('should pass all options to createSession', async () => {
			await callHandler('session.create', {
				workspacePath: '/new/path',
				initialTools: ['Read', 'Write'],
				config: { model: 'claude-opus-4-20250514' },
				worktreeBaseBranch: 'main',
				title: 'Custom Title',
			});

			expect(mockSessionManager.createSession).toHaveBeenCalledWith({
				workspacePath: '/new/path',
				initialTools: ['Read', 'Write'],
				config: { model: 'claude-opus-4-20250514' },
				worktreeBaseBranch: 'main',
				title: 'Custom Title',
			});
		});
	});

	describe('session.list', () => {
		it('should return list of sessions', async () => {
			const result = (await callHandler('session.list', {})) as { sessions: Session[] };

			expect(result.sessions).toEqual([mockSession]);
		});
	});

	describe('session.get', () => {
		it('should return session data', async () => {
			const result = (await callHandler('session.get', {
				sessionId: 'test-session-id',
			})) as { session: Session };

			expect(result.session).toEqual(mockSession);
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('session.get', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});

		it('should include context info', async () => {
			const result = (await callHandler('session.get', {
				sessionId: 'test-session-id',
			})) as { contextInfo: unknown };

			expect(result.contextInfo).toEqual({ totalTokens: 1000, maxTokens: 128000 });
		});
	});

	describe('session.validate', () => {
		it('should return valid for existing session', async () => {
			const result = (await callHandler('session.validate', {
				sessionId: 'test-session-id',
			})) as { valid: boolean };

			expect(result.valid).toBe(true);
		});

		it('should return invalid for non-existing session', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			const result = (await callHandler('session.validate', {
				sessionId: 'nonexistent',
			})) as { valid: boolean };

			expect(result.valid).toBe(false);
		});

		it('should return error message on exception', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockRejectedValue(
				new Error('Load failed')
			);

			const result = (await callHandler('session.validate', {
				sessionId: 'broken',
			})) as { valid: boolean; error: string };

			expect(result.valid).toBe(false);
			expect(result.error).toBe('Load failed');
		});
	});

	describe('session.update', () => {
		it('should update session', async () => {
			const result = (await callHandler('session.update', {
				sessionId: 'test-session-id',
				title: 'New Title',
			})) as { success: boolean };

			expect(mockSessionManager.updateSession).toHaveBeenCalled();
			expect(result.success).toBe(true);
		});

		it('should publish session.updated event', async () => {
			await callHandler('session.update', {
				sessionId: 'test-session-id',
				title: 'New Title',
			});

			expect(mockMessageHub.publish).toHaveBeenCalledWith(
				'session.updated',
				expect.objectContaining({ title: 'New Title' }),
				{ sessionId: 'test-session-id' }
			);
		});
	});

	describe('session.delete', () => {
		it('should delete session', async () => {
			const result = (await callHandler('session.delete', {
				sessionId: 'test-session-id',
			})) as { success: boolean };

			expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('test-session-id');
			expect(result.success).toBe(true);
		});

		it('should publish session.deleted event', async () => {
			await callHandler('session.delete', {
				sessionId: 'test-session-id',
			});

			expect(mockMessageHub.publish).toHaveBeenCalledWith(
				'session.deleted',
				{},
				{ sessionId: 'test-session-id' }
			);
		});
	});

	describe('message.send', () => {
		it('should emit message.sendRequest event', async () => {
			const result = (await callHandler('message.send', {
				sessionId: 'test-session-id',
				content: 'Hello',
			})) as { messageId: string };

			expect(result.messageId).toBeDefined();
			expect(mockDaemonHub.emit).toHaveBeenCalledWith(
				'message.sendRequest',
				expect.objectContaining({
					sessionId: 'test-session-id',
					content: 'Hello',
				})
			);
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('message.send', { sessionId: 'nonexistent', content: 'Hello' })
			).rejects.toThrow('Session not found');
		});
	});

	describe('client.interrupt', () => {
		it('should emit agent.interruptRequest event', async () => {
			const result = (await callHandler('client.interrupt', {
				sessionId: 'test-session-id',
			})) as { accepted: boolean };

			expect(result.accepted).toBe(true);
			expect(mockDaemonHub.emit).toHaveBeenCalledWith('agent.interruptRequest', {
				sessionId: 'test-session-id',
			});
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('client.interrupt', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.model.switch', () => {
		it('should switch model', async () => {
			const result = (await callHandler('session.model.switch', {
				sessionId: 'test-session-id',
				model: 'claude-opus-4-20250514',
			})) as { success: boolean; model: string };

			expect(mockAgentSession.handleModelSwitch).toHaveBeenCalledWith('claude-opus-4-20250514');
			expect(result.success).toBe(true);
		});

		it('should publish session.updated event on success', async () => {
			await callHandler('session.model.switch', {
				sessionId: 'test-session-id',
				model: 'claude-opus-4-20250514',
			});

			expect(mockMessageHub.publish).toHaveBeenCalledWith(
				'session.updated',
				{ model: 'claude-opus-4-20250514' },
				{ sessionId: 'test-session-id' }
			);
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('session.model.switch', { sessionId: 'nonexistent', model: 'test' })
			).rejects.toThrow('Session not found');
		});
	});

	describe('session.model.get', () => {
		it('should return current model info', async () => {
			const result = (await callHandler('session.model.get', {
				sessionId: 'test-session-id',
			})) as { currentModel: string; modelInfo: unknown };

			expect(result.currentModel).toBe('claude-sonnet-4-20250514');
			expect(result.modelInfo).toBeDefined();
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('session.model.get', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.thinking.set', () => {
		it('should set thinking level', async () => {
			const result = (await callHandler('session.thinking.set', {
				sessionId: 'test-session-id',
				level: 'think8k',
			})) as { success: boolean; thinkingLevel: string };

			expect(result.success).toBe(true);
			expect(result.thinkingLevel).toBe('think8k');
			expect(mockSessionManager.updateSession).toHaveBeenCalled();
		});

		it('should default to auto for invalid level', async () => {
			const result = (await callHandler('session.thinking.set', {
				sessionId: 'test-session-id',
				level: 'invalid',
			})) as { thinkingLevel: string };

			expect(result.thinkingLevel).toBe('auto');
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('session.thinking.set', { sessionId: 'nonexistent', level: 'auto' })
			).rejects.toThrow('Session not found');
		});
	});

	describe('models.list', () => {
		it('should return list of models', async () => {
			const result = (await callHandler('models.list', {})) as { models: unknown[] };

			expect(result.models).toHaveLength(2);
			expect(result.models[0]).toHaveProperty('id');
			expect(result.models[0]).toHaveProperty('display_name');
		});

		it('should handle forceRefresh parameter', async () => {
			const result = (await callHandler('models.list', { forceRefresh: true })) as {
				cached: boolean;
			};

			expect(result.cached).toBe(false);
		});
	});

	describe('models.clearCache', () => {
		it('should clear model cache', async () => {
			const result = (await callHandler('models.clearCache', {})) as { success: boolean };

			expect(result.success).toBe(true);
		});
	});

	describe('agent.getState', () => {
		it('should return agent processing state', async () => {
			const result = (await callHandler('agent.getState', {
				sessionId: 'test-session-id',
			})) as { state: unknown };

			expect(result.state).toEqual({ phase: 'idle', isProcessing: false });
			expect(mockAgentSession.getProcessingState).toHaveBeenCalled();
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('agent.getState', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('worktree.cleanup', () => {
		it('should cleanup orphaned worktrees', async () => {
			const result = (await callHandler('worktree.cleanup', {
				workspacePath: '/test/path',
			})) as { cleanedPaths: string[]; message: string };

			expect(result.cleanedPaths).toEqual(['/cleaned/path1']);
			expect(result.message).toContain('1');
			expect(mockSessionManager.cleanupOrphanedWorktrees).toHaveBeenCalledWith('/test/path');
		});
	});

	describe('sdk.scan', () => {
		it('should scan SDK session files', async () => {
			const result = (await callHandler('sdk.scan', {
				workspacePath: '/test/path',
			})) as { success: boolean; summary: unknown };

			expect(result.success).toBe(true);
			expect(result.summary).toHaveProperty('totalFiles');
		});
	});

	describe('sdk.cleanup', () => {
		it('should cleanup SDK files in delete mode', async () => {
			const result = (await callHandler('sdk.cleanup', {
				workspacePath: '/test/path',
				mode: 'delete',
			})) as { success: boolean; mode: string };

			expect(result.success).toBe(true);
			expect(result.mode).toBe('delete');
		});

		it('should cleanup SDK files in archive mode', async () => {
			const result = (await callHandler('sdk.cleanup', {
				workspacePath: '/test/path',
				mode: 'archive',
			})) as { success: boolean; mode: string };

			expect(result.success).toBe(true);
			expect(result.mode).toBe('archive');
		});

		it('should filter by sdkSessionIds', async () => {
			const result = (await callHandler('sdk.cleanup', {
				workspacePath: '/test/path',
				mode: 'delete',
				sdkSessionIds: ['sdk-session-1'],
			})) as { success: boolean };

			expect(result.success).toBe(true);
		});
	});

	describe('session.resetQuery', () => {
		it('should reset query', async () => {
			const result = (await callHandler('session.resetQuery', {
				sessionId: 'test-session-id',
			})) as { success: boolean };

			expect(result.success).toBe(true);
			expect(mockAgentSession.resetQuery).toHaveBeenCalledWith({ restartQuery: true });
			expect(mockDaemonHub.emit).toHaveBeenCalledWith(
				'agent.reset',
				expect.objectContaining({ sessionId: 'test-session-id', success: true })
			);
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('session.resetQuery', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.coordinator.switch', () => {
		it('should switch coordinator mode and restart query', async () => {
			const result = (await callHandler('session.coordinator.switch', {
				sessionId: 'test-session-id',
				coordinatorMode: true,
			})) as { success: boolean; coordinatorMode: boolean };

			expect(result.success).toBe(true);
			expect(result.coordinatorMode).toBe(true);
			expect(mockSessionManager.updateSession).toHaveBeenCalledWith(
				'test-session-id',
				expect.objectContaining({
					config: expect.objectContaining({ coordinatorMode: true }),
				})
			);
			expect(mockAgentSession.resetQuery).toHaveBeenCalledWith({ restartQuery: true });
			expect(mockMessageHub.publish).toHaveBeenCalledWith(
				'session.updated',
				{ config: { coordinatorMode: true } },
				{ sessionId: 'test-session-id' }
			);
		});

		it('should no-op if mode is already the same', async () => {
			(mockAgentSession.getSessionData as ReturnType<typeof mock>).mockReturnValue({
				...mockSession,
				config: { ...mockSession.config, coordinatorMode: true },
			});

			const result = (await callHandler('session.coordinator.switch', {
				sessionId: 'test-session-id',
				coordinatorMode: true,
			})) as { success: boolean; coordinatorMode: boolean };

			expect(result.success).toBe(true);
			expect(result.coordinatorMode).toBe(true);
			expect(mockAgentSession.resetQuery).not.toHaveBeenCalled();
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('session.coordinator.switch', {
					sessionId: 'nonexistent',
					coordinatorMode: true,
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('session.query.trigger', () => {
		it('should trigger query', async () => {
			const result = (await callHandler('session.query.trigger', {
				sessionId: 'test-session-id',
			})) as { success: boolean; messageCount: number };

			expect(result.success).toBe(true);
			expect(result.messageCount).toBe(2);
			expect(mockAgentSession.handleQueryTrigger).toHaveBeenCalled();
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('session.query.trigger', { sessionId: 'nonexistent' })
			).rejects.toThrow('Session not found');
		});
	});

	describe('session.messages.countByStatus', () => {
		it('should return message count by status', async () => {
			const result = (await callHandler('session.messages.countByStatus', {
				sessionId: 'test-session-id',
				status: 'saved',
			})) as { count: number };

			expect(result.count).toBe(3);
			expect(mockDb.getMessageCountByStatus).toHaveBeenCalledWith('test-session-id', 'saved');
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('session.messages.countByStatus', { sessionId: 'nonexistent', status: 'saved' })
			).rejects.toThrow('Session not found');
		});
	});

	describe('session.archive', () => {
		it('should archive session without worktree', async () => {
			// Session without worktree
			mockSession.worktree = undefined;

			const result = (await callHandler('session.archive', {
				sessionId: 'test-session-id',
			})) as { success: boolean; requiresConfirmation: boolean };

			expect(result.success).toBe(true);
			expect(result.requiresConfirmation).toBe(false);
			expect(mockSessionManager.updateSession).toHaveBeenCalledWith(
				'test-session-id',
				expect.objectContaining({ status: 'archived' })
			);
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('session.archive', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});

		it('should archive session with worktree when confirmed', async () => {
			// Setup session with worktree
			mockSession.worktree = {
				isWorktree: true,
				worktreePath: '/test/worktree',
				mainRepoPath: '/test/repo',
				branch: 'session/test-branch',
			};

			// Mock worktree manager via module mock
			const { WorktreeManager } = await import('../../../../src/lib/worktree-manager');
			const mockWorktreeManager = {
				getCommitsAhead: mock(async () => ({
					hasCommitsAhead: false,
					commits: [],
				})),
				removeWorktree: mock(async () => {}),
			};

			// @ts-ignore - Mock for testing
			WorktreeManager.prototype.getCommitsAhead = mockWorktreeManager.getCommitsAhead;
			// @ts-ignore
			WorktreeManager.prototype.removeWorktree = mockWorktreeManager.removeWorktree;

			const result = (await callHandler('session.archive', {
				sessionId: 'test-session-id',
				confirmed: true,
			})) as { success: boolean; requiresConfirmation: boolean };

			expect(result.success).toBe(true);
			expect(result.requiresConfirmation).toBe(false);
			expect(mockSessionManager.updateSession).toHaveBeenCalledWith(
				'test-session-id',
				expect.objectContaining({ status: 'archived' })
			);
		});

		it('should require confirmation when worktree has commits ahead', async () => {
			// Setup session with worktree
			mockSession.worktree = {
				isWorktree: true,
				worktreePath: '/test/worktree',
				mainRepoPath: '/test/repo',
				branch: 'session/test-branch',
			};

			// Mock worktree manager to return commits ahead
			const { WorktreeManager } = await import('../../../../src/lib/worktree-manager');
			WorktreeManager.prototype.getCommitsAhead = mock(async () => ({
				hasCommitsAhead: true,
				commits: [{ hash: 'abc123', message: 'Test commit', author: 'Test', date: '2024-01-01' }],
			}));

			const result = (await callHandler('session.archive', {
				sessionId: 'test-session-id',
				confirmed: false,
			})) as {
				success: boolean;
				requiresConfirmation: boolean;
				commitStatus: { hasCommitsAhead: boolean };
			};

			expect(result.success).toBe(false);
			expect(result.requiresConfirmation).toBe(true);
			expect(result.commitStatus.hasCommitsAhead).toBe(true);
		});
	});

	describe('session.setWorktreeMode', () => {
		it('should complete worktree choice successfully', async () => {
			const updatedSession = {
				...mockSession,
				status: 'active' as const,
				worktree: {
					isWorktree: true,
					worktreePath: '/test/worktree',
					branch: 'session/test-session-id',
				},
			};

			const mockSessionLifecycle = {
				completeWorktreeChoice: mock(
					async (_sessionId: string, _mode: 'worktree' | 'direct') => updatedSession
				),
			};
			(mockSessionManager as { getSessionLifecycle: ReturnType<typeof mock> }).getSessionLifecycle =
				mock(() => mockSessionLifecycle);

			const result = (await callHandler('session.setWorktreeMode', {
				sessionId: 'test-session-id',
				mode: 'worktree',
			})) as {
				success: boolean;
				session: Session;
			};

			expect(result.success).toBe(true);
			expect(result.session).toEqual(updatedSession);
			expect(mockSessionLifecycle.completeWorktreeChoice).toHaveBeenCalledWith(
				'test-session-id',
				'worktree'
			);
			expect(mockMessageHub.publish).toHaveBeenCalledWith('session.updated', updatedSession, {
				sessionId: 'test-session-id',
			});
		});

		it('should throw error when sessionId is missing', async () => {
			await expect(
				callHandler('session.setWorktreeMode', {
					sessionId: '',
					mode: 'worktree',
				})
			).rejects.toThrow('Missing required fields: sessionId and mode');
		});

		it('should throw error when mode is missing', async () => {
			await expect(
				callHandler('session.setWorktreeMode', {
					sessionId: 'test-session-id',
					mode: undefined as unknown as 'worktree',
				})
			).rejects.toThrow('Missing required fields: sessionId and mode');
		});

		it('should throw error when mode is invalid', async () => {
			await expect(
				callHandler('session.setWorktreeMode', {
					sessionId: 'test-session-id',
					mode: 'invalid' as unknown as 'worktree',
				})
			).rejects.toThrow("Invalid mode: invalid. Must be 'worktree' or 'direct'");
		});

		it('should handle direct mode', async () => {
			const updatedSession = {
				...mockSession,
				status: 'active' as const,
			};

			const mockSessionLifecycle = {
				completeWorktreeChoice: mock(
					async (_sessionId: string, _mode: 'worktree' | 'direct') => updatedSession
				),
			};
			(mockSessionManager as { getSessionLifecycle: ReturnType<typeof mock> }).getSessionLifecycle =
				mock(() => mockSessionLifecycle);

			const result = (await callHandler('session.setWorktreeMode', {
				sessionId: 'test-session-id',
				mode: 'direct',
			})) as {
				success: boolean;
				session: Session;
			};

			expect(result.success).toBe(true);
			expect(mockSessionLifecycle.completeWorktreeChoice).toHaveBeenCalledWith(
				'test-session-id',
				'direct'
			);
		});
	});
});
