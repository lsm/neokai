/**
 * Session Handlers Tests
 *
 * Tests for session RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupSessionHandlers } from '../../../../src/lib/rpc-handlers/session-handlers';
import type { MessageHub, Session } from '@liuboer/shared';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { SessionManager } from '../../../../src/lib/session-manager';

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
	};
	let mockSession: Session;

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
		};

		// Mock SessionManager
		mockSessionManager = {
			createSession: mock(async () => 'new-session-id'),
			listSessions: mock(() => [mockSession]),
			getSession: mock(() => mockAgentSession),
			getSessionAsync: mock(async () => mockAgentSession),
			updateSession: mock(async () => {}),
			deleteSession: mock(async () => {}),
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
				useWorktree: undefined,
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
				useWorktree: true,
				worktreeBaseBranch: 'main',
				title: 'Custom Title',
			});

			expect(mockSessionManager.createSession).toHaveBeenCalledWith({
				workspacePath: '/new/path',
				initialTools: ['Read', 'Write'],
				config: { model: 'claude-opus-4-20250514' },
				useWorktree: true,
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
});
