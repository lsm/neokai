/**
 * Tests for Session RPC Handlers
 *
 * Tests the RPC handlers for session operations:
 * - session.create - Create a new session
 * - session.setWorktreeMode - Set worktree mode for a session
 * - session.list - List all sessions
 * - session.get - Get session details
 * - session.validate - Validate session health
 * - session.update - Update session
 * - session.delete - Delete session
 * - session.archive - Archive session
 * - message.send - Send message to session
 * - client.interrupt - Interrupt session
 * - session.model.get - Get current model
 * - session.model.switch - Switch model
 * - session.coordinator.switch - Switch coordinator mode
 * - session.sandbox.switch - Switch sandbox mode
 * - session.thinking.set - Set thinking level
 * - models.list - List available models
 * - models.clearCache - Clear model cache
 * - agent.getState - Get agent processing state
 * - worktree.cleanup - Cleanup orphaned worktrees
 * - sdk.scan - Scan SDK session files
 * - sdk.cleanup - Cleanup SDK session files
 * - session.resetQuery - Reset SDK query
 * - session.query.trigger - Trigger query (manual mode)
 * - session.messages.countByStatus - Count messages by status
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupSessionHandlers } from '../../../src/lib/rpc-handlers/session-handlers';
import type { SessionManager } from '../../../src/lib/session-manager';
import type { AgentSession } from '../../../src/lib/agent/agent-session';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomManager } from '../../../src/lib/room/room-manager';
import type { Session } from '@neokai/shared';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Helper to create a minimal mock MessageHub that captures handlers
function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

// Helper to create mock DaemonHub
function createMockDaemonHub(): {
	daemonHub: DaemonHub;
	emit: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emit: emitMock };
}

// Helper to create mock RoomManager
function createMockRoomManager(): RoomManager {
	return {
		createRoom: mock(() => ({ id: 'room-123' })),
		listRooms: mock(() => []),
		getRoom: mock(() => null),
		getRoomOverview: mock(() => null),
		updateRoom: mock(() => null),
		archiveRoom: mock(() => null),
		getRoomStatus: mock(() => null),
		assignSession: mock(() => null),
		unassignSession: mock(() => null),
		addAllowedPath: mock(() => null),
		removeAllowedPath: mock(() => null),
	} as unknown as RoomManager;
}

// Helper to create a mock AgentSession
function createMockAgentSession(overrides: Partial<AgentSession> = {}): {
	agentSession: AgentSession;
	mocks: {
		getSessionData: ReturnType<typeof mock>;
		getContextInfo: ReturnType<typeof mock>;
		getSDKSessionId: ReturnType<typeof mock>;
		getProcessingState: ReturnType<typeof mock>;
		getCurrentModel: ReturnType<typeof mock>;
		handleModelSwitch: ReturnType<typeof mock>;
		resetQuery: ReturnType<typeof mock>;
		handleQueryTrigger: ReturnType<typeof mock>;
		setMaxThinkingTokens: ReturnType<typeof mock>;
		setPermissionMode: ReturnType<typeof mock>;
		updateConfig: ReturnType<typeof mock>;
		getSDKMessages: ReturnType<typeof mock>;
		getSDKMessageCount: ReturnType<typeof mock>;
		getMcpServerStatus: ReturnType<typeof mock>;
	};
} {
	const sessionData: Session = {
		id: 'session-123',
		workspacePath: '/workspace/test',
		status: 'active',
		config: {
			model: 'claude-sonnet-4-20250514',
			coordinatorMode: false,
			sandbox: { enabled: true },
			thinkingLevel: 'auto',
		},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	} as Session;

	const mocks = {
		getSessionData: mock(() => sessionData),
		getContextInfo: mock(() => ({ inputTokens: 100, outputTokens: 50 })),
		getSDKSessionId: mock(() => 'sdk-session-123'),
		getProcessingState: mock(() => ({ status: 'idle', phase: 'ready' })),
		getCurrentModel: mock(() => ({ id: 'claude-sonnet-4-20250514' })),
		handleModelSwitch: mock(async () => ({ success: true, model: 'claude-opus-4-6' })),
		resetQuery: mock(async () => ({ success: true })),
		handleQueryTrigger: mock(async () => ({ triggered: true, count: 1 })),
		setMaxThinkingTokens: mock(async () => ({ success: true })),
		setPermissionMode: mock(async () => ({ success: true })),
		updateConfig: mock(async () => {}),
		getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
		getSDKMessageCount: mock(() => 0),
		getMcpServerStatus: mock(async () => ({})),
	};

	const agentSession = {
		...mocks,
		...overrides,
	} as unknown as AgentSession;

	return { agentSession, mocks };
}

// Helper to create mock SessionManager
function createMockSessionManager(): {
	sessionManager: SessionManager;
	mocks: {
		createSession: ReturnType<typeof mock>;
		getSession: ReturnType<typeof mock>;
		getSessionAsync: ReturnType<typeof mock>;
		getSessionFromDB: ReturnType<typeof mock>;
		listSessions: ReturnType<typeof mock>;
		updateSession: ReturnType<typeof mock>;
		deleteSession: ReturnType<typeof mock>;
		cleanupOrphanedWorktrees: ReturnType<typeof mock>;
		markOutputRemoved: ReturnType<typeof mock>;
		getDatabase: ReturnType<typeof mock>;
		getSessionLifecycle: ReturnType<typeof mock>;
		getGlobalToolsConfig: ReturnType<typeof mock>;
		saveGlobalToolsConfig: ReturnType<typeof mock>;
	};
} {
	const { agentSession } = createMockAgentSession();

	const mocks = {
		createSession: mock(async () => 'session-123'),
		getSession: mock(() => agentSession),
		getSessionAsync: mock(async () => agentSession),
		getSessionFromDB: mock(() => null),
		listSessions: mock(() => []),
		updateSession: mock(async () => {}),
		deleteSession: mock(async () => {}),
		cleanupOrphanedWorktrees: mock(async () => []),
		markOutputRemoved: mock(async () => {}),
		getDatabase: mock(() => ({
			getMessageCountByStatus: mock(() => 0),
		})),
		getSessionLifecycle: mock(() => ({
			completeWorktreeChoice: mock(async () => ({
				id: 'session-123',
				status: 'active',
			})),
		})),
		getGlobalToolsConfig: mock(() => ({
			disabledMcpServers: [],
		})),
		saveGlobalToolsConfig: mock(() => {}),
	};

	const sessionManager = {
		...mocks,
	} as unknown as SessionManager;

	return { sessionManager, mocks };
}

describe('Session RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	let roomManager: RoomManager;
	let sessionManagerData: ReturnType<typeof createMockSessionManager>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();
		roomManager = createMockRoomManager();
		sessionManagerData = createMockSessionManager();

		// Setup handlers with mocked dependencies
		setupSessionHandlers(
			messageHubData.hub,
			sessionManagerData.sessionManager,
			daemonHubData.daemonHub,
			roomManager
		);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('session.create', () => {
		it('creates session with all parameters', async () => {
			const handler = messageHubData.handlers.get('session.create');
			expect(handler).toBeDefined();

			const params = {
				workspacePath: '/workspace/test',
				initialTools: ['Read', 'Write'],
				config: { model: 'claude-sonnet' },
				worktreeBaseBranch: 'main',
				title: 'Test Session',
				roomId: 'room-123',
				createdBy: 'human',
			};

			sessionManagerData.mocks.createSession.mockResolvedValueOnce('new-session-456');
			const { agentSession } = createMockAgentSession();
			sessionManagerData.mocks.getSession.mockReturnValueOnce(agentSession);

			const result = await handler!(params, {});

			expect(sessionManagerData.mocks.createSession).toHaveBeenCalledWith({
				workspacePath: '/workspace/test',
				initialTools: ['Read', 'Write'],
				config: { model: 'claude-sonnet' },
				worktreeBaseBranch: 'main',
				title: 'Test Session',
				roomId: 'room-123',
				createdBy: 'human',
			});
			expect(result).toEqual({
				sessionId: 'new-session-456',
				session: expect.any(Object),
			});
		});

		it('creates session with minimal parameters', async () => {
			const handler = messageHubData.handlers.get('session.create');
			expect(handler).toBeDefined();

			const params = {
				workspacePath: '/workspace/test',
			};

			sessionManagerData.mocks.createSession.mockResolvedValueOnce('new-session-789');
			const { agentSession } = createMockAgentSession();
			sessionManagerData.mocks.getSession.mockReturnValueOnce(agentSession);

			const result = await handler!(params, {});

			expect(sessionManagerData.mocks.createSession).toHaveBeenCalled();
			expect(result).toHaveProperty('sessionId');
		});

		it('assigns session to room when roomId is provided', async () => {
			const handler = messageHubData.handlers.get('session.create');
			expect(handler).toBeDefined();

			const params = {
				workspacePath: '/workspace/test',
				roomId: 'room-123',
			};

			sessionManagerData.mocks.createSession.mockResolvedValueOnce('session-456');
			const { agentSession } = createMockAgentSession();
			sessionManagerData.mocks.getSession.mockReturnValueOnce(agentSession);

			await handler!(params, {});

			expect(roomManager.assignSession).toHaveBeenCalledWith('room-123', 'session-456');
		});
	});

	describe('session.setWorktreeMode', () => {
		it('sets worktree mode successfully', async () => {
			const handler = messageHubData.handlers.get('session.setWorktreeMode');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				mode: 'worktree' as const,
			};

			const result = await handler!(params, {});

			expect(result).toEqual({
				success: true,
				session: expect.any(Object),
			});
		});

		it('sets direct mode successfully', async () => {
			const handler = messageHubData.handlers.get('session.setWorktreeMode');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				mode: 'direct' as const,
			};

			const result = await handler!(params, {});

			expect(result).toEqual({
				success: true,
				session: expect.any(Object),
			});
		});

		it('throws error when sessionId is missing', async () => {
			const handler = messageHubData.handlers.get('session.setWorktreeMode');
			expect(handler).toBeDefined();

			await expect(handler!({ mode: 'worktree' }, {})).rejects.toThrow(
				'Missing required fields: sessionId and mode'
			);
		});

		it('throws error when mode is missing', async () => {
			const handler = messageHubData.handlers.get('session.setWorktreeMode');
			expect(handler).toBeDefined();

			await expect(handler!({ sessionId: 'session-123' }, {})).rejects.toThrow(
				'Missing required fields: sessionId and mode'
			);
		});

		it('throws error for invalid mode', async () => {
			const handler = messageHubData.handlers.get('session.setWorktreeMode');
			expect(handler).toBeDefined();

			await expect(handler!({ sessionId: 'session-123', mode: 'invalid' }, {})).rejects.toThrow(
				"Invalid mode: invalid. Must be 'worktree' or 'direct'"
			);
		});

		it('broadcasts session.updated event', async () => {
			const handler = messageHubData.handlers.get('session.setWorktreeMode');
			expect(handler).toBeDefined();

			await handler!({ sessionId: 'session-123', mode: 'worktree' }, {});

			expect(messageHubData.hub.event).toHaveBeenCalledWith('session.updated', expect.any(Object), {
				channel: 'session:session-123',
			});
		});
	});

	describe('session.list', () => {
		it('returns empty array when no sessions', async () => {
			const handler = messageHubData.handlers.get('session.list');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.listSessions.mockReturnValueOnce([]);

			const result = await handler!({}, {});

			expect(result).toEqual({ sessions: [] });
		});

		it('returns list of sessions', async () => {
			const handler = messageHubData.handlers.get('session.list');
			expect(handler).toBeDefined();

			const mockSessions = [
				{ id: 'session-1', status: 'active' },
				{ id: 'session-2', status: 'active' },
			];
			sessionManagerData.mocks.listSessions.mockReturnValueOnce(mockSessions as Session[]);

			const result = (await handler!({}, {})) as { sessions: Session[] };

			expect(result.sessions).toHaveLength(2);
		});
	});

	describe('session.get', () => {
		it('returns session details', async () => {
			const handler = messageHubData.handlers.get('session.get');
			expect(handler).toBeDefined();

			const { agentSession, mocks } = createMockAgentSession();
			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(agentSession);

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(mocks.getSessionData).toHaveBeenCalled();
			expect(mocks.getContextInfo).toHaveBeenCalled();
			expect(result).toHaveProperty('session');
			expect(result).toHaveProperty('context');
			expect(result).toHaveProperty('contextInfo');
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.get');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.validate', () => {
		it('returns valid for existing session', async () => {
			const handler = messageHubData.handlers.get('session.validate');
			expect(handler).toBeDefined();

			const { agentSession } = createMockAgentSession();
			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(agentSession);

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toEqual({ valid: true, error: null });
		});

		it('returns invalid for non-existent session', async () => {
			const handler = messageHubData.handlers.get('session.validate');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			const result = await handler!({ sessionId: 'non-existent' }, {});

			expect(result).toEqual({ valid: false, error: null });
		});

		it('returns error message on exception', async () => {
			const handler = messageHubData.handlers.get('session.validate');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockRejectedValueOnce(new Error('Database error'));

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toEqual({ valid: false, error: 'Database error' });
		});
	});

	describe('session.update', () => {
		it('updates session successfully', async () => {
			const handler = messageHubData.handlers.get('session.update');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				title: 'Updated Title',
			};

			const result = await handler!(params, {});

			expect(sessionManagerData.mocks.updateSession).toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});

		it('broadcasts session.updated event', async () => {
			const handler = messageHubData.handlers.get('session.update');
			expect(handler).toBeDefined();

			await handler!({ sessionId: 'session-123', title: 'New Title' }, {});

			expect(messageHubData.hub.event).toHaveBeenCalledWith('session.updated', expect.any(Object), {
				channel: 'session:session-123',
			});
		});
	});

	describe('session.delete', () => {
		it('deletes session successfully', async () => {
			const handler = messageHubData.handlers.get('session.delete');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(sessionManagerData.mocks.deleteSession).toHaveBeenCalledWith('session-123');
			expect(result).toEqual({ success: true });
		});

		it('broadcasts session.deleted event', async () => {
			const handler = messageHubData.handlers.get('session.delete');
			expect(handler).toBeDefined();

			await handler!({ sessionId: 'session-123' }, {});

			expect(messageHubData.hub.event).toHaveBeenCalledWith(
				'session.deleted',
				{ sessionId: 'session-123' },
				{ channel: 'global' }
			);
		});
	});

	describe('session.archive', () => {
		it('archives session without worktree', async () => {
			const handler = messageHubData.handlers.get('session.archive');
			expect(handler).toBeDefined();

			const { agentSession } = createMockAgentSession({
				worktree: undefined,
			} as Partial<AgentSession>);
			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(agentSession);

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toEqual({
				success: true,
				requiresConfirmation: false,
			});
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.archive');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('message.send', () => {
		it('sends message successfully', async () => {
			const handler = messageHubData.handlers.get('message.send');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				content: 'Hello, world!',
			};

			const result = await handler!(params, {});

			expect(result).toHaveProperty('messageId');
			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'message.sendRequest',
				expect.objectContaining({
					sessionId: 'session-123',
					content: 'Hello, world!',
				})
			);
		});

		it('sends message with images', async () => {
			const handler = messageHubData.handlers.get('message.send');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				content: 'Check this image',
				images: [{ source: { data: 'base64data' } }],
			};

			const result = await handler!(params, {});

			expect(result).toHaveProperty('messageId');
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('message.send');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent', content: 'test' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('client.interrupt', () => {
		it('interrupts session successfully', async () => {
			const handler = messageHubData.handlers.get('client.interrupt');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toEqual({ accepted: true });
			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'agent.interruptRequest',
				expect.objectContaining({ sessionId: 'session-123' })
			);
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('client.interrupt');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.model.get', () => {
		it('returns current model', async () => {
			const handler = messageHubData.handlers.get('session.model.get');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toHaveProperty('currentModel');
			expect(result).toHaveProperty('modelInfo');
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.model.get');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.model.switch', () => {
		it('switches model successfully', async () => {
			const handler = messageHubData.handlers.get('session.model.switch');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				model: 'claude-opus-4-6',
			};

			const { mocks } = createMockAgentSession();
			mocks.handleModelSwitch.mockResolvedValueOnce({
				success: true,
				model: 'claude-opus-4-6',
			});

			const result = await handler!(params, {});

			expect(result).toHaveProperty('success');
		});

		it('broadcasts session.updated on successful switch', async () => {
			const handler = messageHubData.handlers.get('session.model.switch');
			expect(handler).toBeDefined();

			await handler!({ sessionId: 'session-123', model: 'claude-opus-4-6' }, {});

			expect(messageHubData.hub.event).toHaveBeenCalledWith('session.updated', expect.any(Object), {
				channel: 'session:session-123',
			});
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.model.switch');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(
				handler!({ sessionId: 'non-existent', model: 'claude-opus' }, {})
			).rejects.toThrow('Session not found');
		});
	});

	describe('session.coordinator.switch', () => {
		it('enables coordinator mode', async () => {
			const handler = messageHubData.handlers.get('session.coordinator.switch');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-123',
				coordinatorMode: true,
			};

			const result = await handler!(params, {});

			expect(result).toHaveProperty('success');
			expect(result).toHaveProperty('coordinatorMode', true);
		});

		it('disables coordinator mode', async () => {
			const handler = messageHubData.handlers.get('session.coordinator.switch');
			expect(handler).toBeDefined();

			const { agentSession } = createMockAgentSession();
			(agentSession.getSessionData as ReturnType<typeof mock>).mockReturnValue({
				id: 'session-123',
				config: { coordinatorMode: true },
			});
			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(agentSession);

			const result = await handler!({ sessionId: 'session-123', coordinatorMode: false }, {});

			expect(result).toHaveProperty('success');
		});

		it('returns early if mode unchanged', async () => {
			const handler = messageHubData.handlers.get('session.coordinator.switch');
			expect(handler).toBeDefined();

			// Session has coordinatorMode: false by default
			const result = await handler!({ sessionId: 'session-123', coordinatorMode: false }, {});

			expect(result).toEqual({ success: true, coordinatorMode: false });
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.coordinator.switch');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(
				handler!({ sessionId: 'non-existent', coordinatorMode: true }, {})
			).rejects.toThrow('Session not found');
		});
	});

	describe('session.sandbox.switch', () => {
		it('enables sandbox mode', async () => {
			const handler = messageHubData.handlers.get('session.sandbox.switch');
			expect(handler).toBeDefined();

			const { agentSession } = createMockAgentSession();
			(agentSession.getSessionData as ReturnType<typeof mock>).mockReturnValue({
				id: 'session-123',
				config: { sandbox: { enabled: false } },
			});
			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(agentSession);

			const result = await handler!({ sessionId: 'session-123', sandboxEnabled: true }, {});

			expect(result).toHaveProperty('success');
			expect(result).toHaveProperty('sandboxEnabled', true);
		});

		it('disables sandbox mode', async () => {
			const handler = messageHubData.handlers.get('session.sandbox.switch');
			expect(handler).toBeDefined();

			// Default has sandbox.enabled: true
			const result = await handler!({ sessionId: 'session-123', sandboxEnabled: false }, {});

			expect(result).toHaveProperty('success');
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.sandbox.switch');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(
				handler!({ sessionId: 'non-existent', sandboxEnabled: true }, {})
			).rejects.toThrow('Session not found');
		});
	});

	describe('session.thinking.set', () => {
		it('sets thinking level to auto', async () => {
			const handler = messageHubData.handlers.get('session.thinking.set');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123', level: 'auto' }, {});

			expect(result).toEqual({ success: true, thinkingLevel: 'auto' });
		});

		it('sets thinking level to think8k', async () => {
			const handler = messageHubData.handlers.get('session.thinking.set');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123', level: 'think8k' }, {});

			expect(result).toEqual({ success: true, thinkingLevel: 'think8k' });
		});

		it('sets thinking level to think16k', async () => {
			const handler = messageHubData.handlers.get('session.thinking.set');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123', level: 'think16k' }, {});

			expect(result).toEqual({ success: true, thinkingLevel: 'think16k' });
		});

		it('sets thinking level to think32k', async () => {
			const handler = messageHubData.handlers.get('session.thinking.set');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123', level: 'think32k' }, {});

			expect(result).toEqual({ success: true, thinkingLevel: 'think32k' });
		});

		it('defaults to auto for invalid level', async () => {
			const handler = messageHubData.handlers.get('session.thinking.set');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123', level: 'invalid' }, {});

			expect(result).toEqual({ success: true, thinkingLevel: 'auto' });
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.thinking.set');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent', level: 'auto' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('models.list', () => {
		it('returns list of models', async () => {
			const handler = messageHubData.handlers.get('models.list');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as { models: unknown[]; cached: boolean };

			expect(Array.isArray(result.models)).toBe(true);
			expect(result).toHaveProperty('cached');
		});

		it('accepts forceRefresh parameter', async () => {
			const handler = messageHubData.handlers.get('models.list');
			expect(handler).toBeDefined();

			const result = (await handler!({ forceRefresh: true }, {})) as {
				models: unknown[];
				cached: boolean;
			};

			expect(result.cached).toBe(false);
		});

		it('accepts useCache parameter', async () => {
			const handler = messageHubData.handlers.get('models.list');
			expect(handler).toBeDefined();

			const result = (await handler!({ useCache: false }, {})) as {
				models: unknown[];
				cached: boolean;
			};

			expect(result.cached).toBe(false);
		});
	});

	describe('models.clearCache', () => {
		it('clears model cache', async () => {
			const handler = messageHubData.handlers.get('models.clearCache');
			expect(handler).toBeDefined();

			const result = await handler!({}, {});

			expect(result).toEqual({ success: true });
		});
	});

	describe('agent.getState', () => {
		it('returns processing state', async () => {
			const handler = messageHubData.handlers.get('agent.getState');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toHaveProperty('state');
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('agent.getState');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('worktree.cleanup', () => {
		it('cleans up orphaned worktrees', async () => {
			const handler = messageHubData.handlers.get('worktree.cleanup');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.cleanupOrphanedWorktrees.mockResolvedValueOnce([
				'/path/to/worktree1',
				'/path/to/worktree2',
			]);

			const result = await handler!({}, {});

			expect(result).toEqual({
				success: true,
				cleanedPaths: ['/path/to/worktree1', '/path/to/worktree2'],
				message: 'Cleaned up 2 orphaned worktree(s)',
			});
		});

		it('accepts workspacePath parameter', async () => {
			const handler = messageHubData.handlers.get('worktree.cleanup');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.cleanupOrphanedWorktrees.mockResolvedValueOnce([]);

			await handler!({ workspacePath: '/custom/workspace' }, {});

			expect(sessionManagerData.mocks.cleanupOrphanedWorktrees).toHaveBeenCalledWith(
				'/custom/workspace'
			);
		});
	});

	describe('session.resetQuery', () => {
		it('resets query with restart', async () => {
			const handler = messageHubData.handlers.get('session.resetQuery');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123', restartQuery: true }, {});

			expect(result).toHaveProperty('success');
		});

		it('resets query without restart', async () => {
			const handler = messageHubData.handlers.get('session.resetQuery');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123', restartQuery: false }, {});

			expect(result).toHaveProperty('success');
		});

		it('defaults restartQuery to true', async () => {
			const handler = messageHubData.handlers.get('session.resetQuery');
			expect(handler).toBeDefined();

			const { agentSession, mocks } = createMockAgentSession();
			mocks.resetQuery.mockResolvedValueOnce({ success: true });
			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(agentSession);

			await handler!({ sessionId: 'session-123' }, {});

			expect(mocks.resetQuery).toHaveBeenCalledWith({ restartQuery: true });
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.resetQuery');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.query.trigger', () => {
		it('triggers query successfully', async () => {
			const handler = messageHubData.handlers.get('session.query.trigger');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toHaveProperty('triggered');
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.query.trigger');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.messages.countByStatus', () => {
		it('returns count for saved status', async () => {
			const handler = messageHubData.handlers.get('session.messages.countByStatus');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getDatabase.mockReturnValueOnce({
				getMessageCountByStatus: mock(() => 5),
			} as unknown as ReturnType<typeof mock> extends ReturnType<typeof mock> ? object : never);

			const result = await handler!({ sessionId: 'session-123', status: 'saved' }, {});

			expect(result).toEqual({ count: 5 });
		});

		it('returns count for queued status', async () => {
			const handler = messageHubData.handlers.get('session.messages.countByStatus');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getDatabase.mockReturnValueOnce({
				getMessageCountByStatus: mock(() => 3),
			} as unknown as ReturnType<typeof mock> extends ReturnType<typeof mock> ? object : never);

			const result = await handler!({ sessionId: 'session-123', status: 'queued' }, {});

			expect(result).toEqual({ count: 3 });
		});

		it('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.messages.countByStatus');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent', status: 'saved' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});
});
