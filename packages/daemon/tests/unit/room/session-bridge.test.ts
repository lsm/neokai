/**
 * SessionBridge Tests
 *
 * Tests for session bridging between Worker and Manager sessions:
 * - Starting and stopping bridges
 * - Terminal state detection
 * - Message forwarding coordination
 * - Worker crash handling
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { SessionBridge } from '../../../src/lib/room/session-bridge';
import type {
	SessionState,
	AgentProcessingState,
	SessionPair,
	SessionError,
	SessionInfo,
	ContextInfo,
} from '@neokai/shared';
import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { SessionPairManager } from '../../../src/lib/room/session-pair-manager';
import type { SessionManager } from '../../../src/lib/session-manager';
import type { SDKMessageRepository } from '../../../src/storage/repositories/sdk-message-repository';

// Helper to create a mock SessionState
function createMockSessionState(
	sessionId: string,
	agentState: AgentProcessingState,
	error?: SessionError
): SessionState {
	return {
		sessionInfo: {
			id: sessionId,
			title: 'Test Session',
			status: 'active',
			workspacePath: '/test/workspace',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} as SessionInfo,
		agentState,
		commandsData: { availableCommands: [] },
		contextInfo: null as ContextInfo | null,
		error: error || null,
		timestamp: Date.now(),
	};
}

// Helper to create mock SessionPair
function createMockSessionPair(overrides?: Partial<SessionPair>): SessionPair {
	return {
		id: 'pair-123',
		roomId: 'room-456',
		roomSessionId: 'room-session-789',
		managerSessionId: 'manager-session-abc',
		workerSessionId: 'worker-session-def',
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as SessionPair;
}

// Helper to create mock MessageHub
function createMockMessageHub() {
	return {
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		onEvent: mock(() => () => {}),
		request: mock(async () => ({})),
	};
}

// Helper to create mock DaemonHub
function createMockDaemonHub() {
	return {
		emit: mock(async () => {}),
	};
}

// Helper to create mock SessionPairManager
function createMockSessionPairManager() {
	return {
		getPair: mock(() => null as SessionPair | null),
		updatePairStatus: mock(() => null as SessionPair | null),
	};
}

// Helper to create mock SessionManager
function createMockSessionManager() {
	return {
		getSession: mock(() => null),
	};
}

// Helper to create mock SDKMessageRepository
function createMockSDKMessageRepository() {
	return {
		getSDKMessages: mock(() => [] as unknown[]),
	};
}

describe('SessionBridge', () => {
	let sessionBridge: SessionBridge;
	let mockMessageHub: ReturnType<typeof createMockMessageHub>;
	let mockDaemonHub: ReturnType<typeof createMockDaemonHub>;
	let mockSessionPairManager: ReturnType<typeof createMockSessionPairManager>;
	let mockSessionManager: ReturnType<typeof createMockSessionManager>;
	let mockSDKMessageRepo: ReturnType<typeof createMockSDKMessageRepository>;

	beforeEach(() => {
		mockMessageHub = createMockMessageHub();
		mockDaemonHub = createMockDaemonHub();
		mockSessionPairManager = createMockSessionPairManager();
		mockSessionManager = createMockSessionManager();
		mockSDKMessageRepo = createMockSDKMessageRepository();

		sessionBridge = new SessionBridge(
			mockMessageHub as unknown as MessageHub,
			mockDaemonHub as unknown as DaemonHub,
			mockSessionPairManager as unknown as SessionPairManager,
			mockSessionManager as unknown as SessionManager,
			mockSDKMessageRepo as unknown as SDKMessageRepository
		);
	});

	afterEach(() => {
		// Cleanup
	});

	describe('startBridge', () => {
		it('should start bridging for a valid pair', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-123');

			expect(mockMessageHub.joinChannel).toHaveBeenCalledWith('session:worker-session-def');
			expect(mockMessageHub.joinChannel).toHaveBeenCalledWith('session:manager-session-abc');
			expect(mockMessageHub.onEvent).toHaveBeenCalledTimes(2);
			expect(sessionBridge.isBridgeActive('pair-123')).toBe(true);
		});

		it('should throw if pair does not exist', async () => {
			mockSessionPairManager.getPair.mockReturnValue(null);

			await expect(sessionBridge.startBridge('non-existent-pair')).rejects.toThrow(
				'Session pair not found: non-existent-pair'
			);
		});

		it('should subscribe to both session channels', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-123');

			expect(mockMessageHub.onEvent).toHaveBeenCalledTimes(2);
		});

		it('should not double-bridge the same pair', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-123');
			await sessionBridge.startBridge('pair-123');

			// Should only join channels once
			expect(mockMessageHub.joinChannel).toHaveBeenCalledTimes(2);
		});

		it('should fetch initial states after starting bridge', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-123');

			// Should request initial states for both worker and manager
			expect(mockMessageHub.request).toHaveBeenCalledWith('state.session', {
				sessionId: 'worker-session-def',
			});
			expect(mockMessageHub.request).toHaveBeenCalledWith('state.session', {
				sessionId: 'manager-session-abc',
			});
		});

		it('should handle errors when fetching initial states gracefully', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.request.mockRejectedValue(new Error('State not available'));

			// Should not throw
			await sessionBridge.startBridge('pair-123');

			expect(sessionBridge.isBridgeActive('pair-123')).toBe(true);
		});
	});

	describe('stopBridge', () => {
		it('should stop bridging and clean up subscriptions', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-123');
			await sessionBridge.stopBridge('pair-123');

			expect(mockMessageHub.leaveChannel).toHaveBeenCalledWith('session:worker-session-def');
			expect(mockMessageHub.leaveChannel).toHaveBeenCalledWith('session:manager-session-abc');
			expect(sessionBridge.isBridgeActive('pair-123')).toBe(false);
		});

		it('should handle non-existent pair gracefully', async () => {
			// Should not throw
			await sessionBridge.stopBridge('non-existent-pair');

			expect(mockMessageHub.leaveChannel).not.toHaveBeenCalled();
		});

		it('should call unsubscribe functions when stopping', async () => {
			const pair = createMockSessionPair();
			const mockUnsubscribe = mock(() => {});
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.onEvent.mockReturnValue(mockUnsubscribe);
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-123');
			await sessionBridge.stopBridge('pair-123');

			// Two subscriptions should be unsubscribed
			expect(mockUnsubscribe).toHaveBeenCalledTimes(2);
		});
	});

	describe('stopAllBridges', () => {
		it('should stop all active bridges', async () => {
			const pair1 = createMockSessionPair({ id: 'pair-1' });
			const pair2 = createMockSessionPair({ id: 'pair-2' });

			mockSessionPairManager.getPair.mockImplementation((id: string) => {
				if (id === 'pair-1') return pair1;
				if (id === 'pair-2') return pair2;
				return null;
			});
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-1');
			await sessionBridge.startBridge('pair-2');

			expect(sessionBridge.getActiveBridges()).toHaveLength(2);

			await sessionBridge.stopAllBridges();

			expect(sessionBridge.getActiveBridges()).toHaveLength(0);
			expect(mockMessageHub.leaveChannel).toHaveBeenCalledTimes(4); // 2 pairs x 2 channels
		});

		it('should handle no active bridges gracefully', async () => {
			await sessionBridge.stopAllBridges();

			expect(sessionBridge.getActiveBridges()).toHaveLength(0);
		});
	});

	describe('getActiveBridges', () => {
		it('should return list of active pair IDs', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-123');

			const activeBridges = sessionBridge.getActiveBridges();

			expect(activeBridges).toContain('pair-123');
		});

		it('should return empty array when no bridges active', () => {
			const activeBridges = sessionBridge.getActiveBridges();

			expect(activeBridges).toEqual([]);
		});
	});

	describe('isBridgeActive', () => {
		it('should return true for active bridge', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-123');

			expect(sessionBridge.isBridgeActive('pair-123')).toBe(true);
		});

		it('should return false for inactive bridge', () => {
			expect(sessionBridge.isBridgeActive('non-existent')).toBe(false);
		});
	});

	describe('isTerminalState', () => {
		it('should return true for idle state', () => {
			const agentState: AgentProcessingState = { status: 'idle' };

			expect(sessionBridge.isTerminalState(agentState)).toBe(true);
		});

		it('should return true for waiting_for_input state', () => {
			const agentState: AgentProcessingState = {
				status: 'waiting_for_input',
				pendingQuestion: {
					toolUseId: 'tool-123',
					questions: [],
					askedAt: Date.now(),
				},
			};

			expect(sessionBridge.isTerminalState(agentState)).toBe(true);
		});

		it('should return true for interrupted state', () => {
			const agentState: AgentProcessingState = { status: 'interrupted' };

			expect(sessionBridge.isTerminalState(agentState)).toBe(true);
		});

		it('should return false for processing state', () => {
			const agentState: AgentProcessingState = {
				status: 'processing',
				messageId: 'msg-123',
				phase: 'thinking',
			};

			expect(sessionBridge.isTerminalState(agentState)).toBe(false);
		});

		it('should return false for queued state', () => {
			const agentState: AgentProcessingState = {
				status: 'queued',
				messageId: 'msg-123',
			};

			expect(sessionBridge.isTerminalState(agentState)).toBe(false);
		});

		it('should return false for streaming phase', () => {
			const agentState: AgentProcessingState = {
				status: 'processing',
				messageId: 'msg-123',
				phase: 'streaming',
				streamingStartedAt: Date.now(),
			};

			expect(sessionBridge.isTerminalState(agentState)).toBe(false);
		});

		it('should return false for initializing phase', () => {
			const agentState: AgentProcessingState = {
				status: 'processing',
				messageId: 'msg-123',
				phase: 'initializing',
			};

			expect(sessionBridge.isTerminalState(agentState)).toBe(false);
		});

		it('should return false for finalizing phase', () => {
			const agentState: AgentProcessingState = {
				status: 'processing',
				messageId: 'msg-123',
				phase: 'finalizing',
			};

			expect(sessionBridge.isTerminalState(agentState)).toBe(false);
		});
	});

	describe('getBridgeInfo', () => {
		it('should return bridge info for active bridge', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockMessageHub.request.mockResolvedValue(
				createMockSessionState('worker-session-def', { status: 'idle' })
			);

			await sessionBridge.startBridge('pair-123');

			const info = sessionBridge.getBridgeInfo('pair-123');

			expect(info).not.toBeNull();
			expect(info?.pairId).toBe('pair-123');
			expect(info?.roomId).toBe('room-456');
			expect(info?.workerSessionId).toBe('worker-session-def');
			expect(info?.managerSessionId).toBe('manager-session-abc');
			expect(info?.lastWorkerMessageTimestamp).toBeDefined();
			expect(info?.lastManagerMessageTimestamp).toBeDefined();
		});

		it('should return null for non-existent bridge', () => {
			const info = sessionBridge.getBridgeInfo('non-existent');

			expect(info).toBeNull();
		});
	});

	describe('handleWorkerStateChange - message forwarding', () => {
		it('should forward messages to manager on terminal state', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);

			// Set up request mock to handle both state.session and message.send
			mockMessageHub.request.mockImplementation(async (method: string) => {
				if (method === 'state.session') {
					return createMockSessionState('worker-session-def', {
						status: 'processing',
						messageId: 'msg-1',
						phase: 'thinking',
					});
				}
				return { success: true };
			});

			await sessionBridge.startBridge('pair-123');

			// Simulate assistant messages from worker
			mockSDKMessageRepo.getSDKMessages.mockReturnValue([
				{ type: 'assistant', message: { content: 'Worker response' } },
			]);

			// Get the worker state change handler
			const workerHandler = mockMessageHub.onEvent.mock.calls[0][1];

			// Simulate worker reaching terminal state
			// Note: handler doesn't await inner promise, so we need to wait
			const terminalState = createMockSessionState('worker-session-def', { status: 'idle' });
			workerHandler(terminalState);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mockDaemonHub.emit).toHaveBeenCalledWith('bridge.workerTerminal', {
				sessionId: 'worker-session-def',
				pairId: 'pair-123',
				agentState: { status: 'idle' },
			});

			expect(mockMessageHub.request).toHaveBeenCalledWith('message.send', {
				sessionId: 'manager-session-abc',
				content: '[Worker Update]\n\nWorker response',
			});
		});

		it('should detect error state and handle worker crash', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockSessionPairManager.updatePairStatus.mockReturnValue(pair);

			// Set up agent session with recovery context (no retries yet)
			mockSessionManager.getSession.mockReturnValue({
				session: {
					metadata: {
						recoveryContext: { retryCount: 0 },
					},
				},
			});

			// Set up request mock to handle both state.session and message.send
			mockMessageHub.request.mockImplementation(async (method: string) => {
				if (method === 'state.session') {
					return createMockSessionState('worker-session-def', { status: 'idle' });
				}
				return { success: true };
			});

			await sessionBridge.startBridge('pair-123');

			// Get the worker state change handler
			const workerHandler = mockMessageHub.onEvent.mock.calls[0][1];

			// Simulate worker crash with error
			const errorState = createMockSessionState(
				'worker-session-def',
				{ status: 'idle' },
				{
					message: 'Worker crashed',
					occurredAt: Date.now(),
				}
			);
			workerHandler(errorState);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should notify manager about crash (via message.send)
			expect(mockMessageHub.request).toHaveBeenCalledWith('message.send', {
				sessionId: 'manager-session-abc',
				content: expect.stringContaining('Worker session encountered an error'),
			});
		});

		it('should escalate after max retries exceeded', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);
			mockSessionPairManager.updatePairStatus.mockReturnValue(pair);

			// Set up agent session with max retries
			mockSessionManager.getSession.mockReturnValue({
				session: {
					metadata: {
						recoveryContext: { retryCount: 3 },
					},
				},
			});

			// Set up request mock to handle both state.session and message.send
			mockMessageHub.request.mockImplementation(async (method: string) => {
				if (method === 'state.session') {
					return createMockSessionState('worker-session-def', { status: 'idle' });
				}
				return { success: true };
			});

			await sessionBridge.startBridge('pair-123');

			// Get the worker state change handler
			const workerHandler = mockMessageHub.onEvent.mock.calls[0][1];

			// Simulate worker crash with error
			const errorState = createMockSessionState(
				'worker-session-def',
				{ status: 'idle' },
				{
					message: 'Worker crashed again',
					occurredAt: Date.now(),
				}
			);
			workerHandler(errorState);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should notify manager about failure (via message.send)
			expect(mockMessageHub.request).toHaveBeenCalledWith('message.send', {
				sessionId: 'manager-session-abc',
				content: expect.stringContaining('could not be recovered'),
			});

			// Bridge should be stopped (stopBridge is called in handleWorkerCrash)
			expect(sessionBridge.isBridgeActive('pair-123')).toBe(false);
		});
	});

	describe('handleManagerStateChange - message forwarding', () => {
		it('should forward messages to worker on terminal state', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);

			// Set up request mock to handle both state.session and message.send
			mockMessageHub.request.mockImplementation(async (method: string) => {
				if (method === 'state.session') {
					return createMockSessionState('manager-session-abc', {
						status: 'processing',
						messageId: 'msg-1',
						phase: 'thinking',
					});
				}
				return { success: true };
			});

			await sessionBridge.startBridge('pair-123');

			// Simulate assistant messages from manager
			mockSDKMessageRepo.getSDKMessages.mockReturnValue([
				{ type: 'assistant', message: { content: 'Manager response' } },
			]);

			// Get the manager state change handler (second onEvent call)
			const managerHandler = mockMessageHub.onEvent.mock.calls[1][1];

			// Simulate manager reaching terminal state
			// Note: handler doesn't await inner promise, so we need to wait
			const terminalState = createMockSessionState('manager-session-abc', { status: 'idle' });
			managerHandler(terminalState);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mockDaemonHub.emit).toHaveBeenCalledWith('bridge.managerTerminal', {
				sessionId: 'manager-session-abc',
				pairId: 'pair-123',
				agentState: { status: 'idle' },
			});

			expect(mockMessageHub.request).toHaveBeenCalledWith('message.send', {
				sessionId: 'worker-session-def',
				content: '[Manager Response]\n\nManager response',
			});
		});

		it('should not forward messages when no assistant messages available', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);

			// Set up request mock to handle both state.session and message.send
			mockMessageHub.request.mockImplementation(async (method: string) => {
				if (method === 'state.session') {
					return createMockSessionState('manager-session-abc', {
						status: 'processing',
						messageId: 'msg-1',
						phase: 'thinking',
					});
				}
				return { success: true };
			});

			await sessionBridge.startBridge('pair-123');

			// Simulate no assistant messages
			mockSDKMessageRepo.getSDKMessages.mockReturnValue([
				{ type: 'user', message: { content: 'User message' } },
			]);

			// Get the manager state change handler
			const managerHandler = mockMessageHub.onEvent.mock.calls[1][1];

			// Track calls before handler invocation
			const callsBefore = mockMessageHub.request.mock.calls.length;

			// Simulate manager reaching terminal state
			// Note: handler doesn't await inner promise, so we need to wait
			const terminalState = createMockSessionState('manager-session-abc', { status: 'idle' });
			managerHandler(terminalState);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should not call message.send (no assistant messages)
			// Only the initial state.session calls should exist (no new message.send calls)
			const callsAfter = mockMessageHub.request.mock.calls.length;
			const newCalls = mockMessageHub.request.mock.calls.slice(callsBefore);
			const messageSendCalls = newCalls.filter((call) => call[0] === 'message.send');
			expect(messageSendCalls.length).toBe(0);
		});
	});

	describe('message formatting', () => {
		it('should format assistant messages with text blocks correctly', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);

			// Set up request mock to handle both state.session and message.send
			mockMessageHub.request.mockImplementation(async (method: string) => {
				if (method === 'state.session') {
					return createMockSessionState('worker-session-def', {
						status: 'processing',
						messageId: 'msg-1',
						phase: 'thinking',
					});
				}
				return { success: true };
			});

			await sessionBridge.startBridge('pair-123');

			// Simulate assistant messages with content blocks
			mockSDKMessageRepo.getSDKMessages.mockReturnValue([
				{
					type: 'assistant',
					message: {
						content: [
							{ type: 'text', text: 'First block' },
							{ type: 'text', text: 'Second block' },
						],
					},
				},
			]);

			// Get the worker state change handler
			const workerHandler = mockMessageHub.onEvent.mock.calls[0][1];

			// Note: handler doesn't await inner promise, so we need to wait
			workerHandler(createMockSessionState('worker-session-def', { status: 'idle' }));
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Check that message content was formatted
			const messageSendCalls = mockMessageHub.request.mock.calls.filter(
				(call) => call[0] === 'message.send'
			);
			expect(messageSendCalls.length).toBeGreaterThan(0);
			expect(messageSendCalls[0][1].content).toContain('First block');
			expect(messageSendCalls[0][1].content).toContain('Second block');
		});

		it('should handle mixed content types gracefully', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);

			// Set up request mock to handle both state.session and message.send
			mockMessageHub.request.mockImplementation(async (method: string) => {
				if (method === 'state.session') {
					return createMockSessionState('worker-session-def', {
						status: 'processing',
						messageId: 'msg-1',
						phase: 'thinking',
					});
				}
				return { success: true };
			});

			await sessionBridge.startBridge('pair-123');

			// Simulate assistant messages with mixed content
			mockSDKMessageRepo.getSDKMessages.mockReturnValue([
				{
					type: 'assistant',
					message: {
						content: [
							{ type: 'text', text: 'Text block' },
							{ type: 'tool_use', name: 'some_tool' }, // Non-text block
							{ type: 'text', text: 'Another text block' },
						],
					},
				},
			]);

			// Get the worker state change handler
			const workerHandler = mockMessageHub.onEvent.mock.calls[0][1];

			// Note: handler doesn't await inner promise, so we need to wait
			workerHandler(createMockSessionState('worker-session-def', { status: 'idle' }));
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Check that only text blocks were included
			const messageSendCalls = mockMessageHub.request.mock.calls.filter(
				(call) => call[0] === 'message.send'
			);
			expect(messageSendCalls.length).toBeGreaterThan(0);
			expect(messageSendCalls[0][1].content).toContain('Text block');
			expect(messageSendCalls[0][1].content).toContain('Another text block');
		});
	});

	describe('event emission', () => {
		it('should emit messagesForwarded event after forwarding', async () => {
			const pair = createMockSessionPair();
			mockSessionPairManager.getPair.mockReturnValue(pair);

			// Pre-set up the SDK messages mock BEFORE starting bridge
			const mockMessages = [
				{ type: 'assistant', message: { content: 'Response' } },
				{ type: 'assistant', message: { content: 'Another response' } },
			];

			// Create a fresh mock for this test
			const freshMockSDKMessageRepo = {
				getSDKMessages: mock(() => mockMessages),
			};

			// Create a fresh SessionBridge with the new mock
			const freshSessionBridge = new SessionBridge(
				mockMessageHub as unknown as MessageHub,
				mockDaemonHub as unknown as DaemonHub,
				mockSessionPairManager as unknown as SessionPairManager,
				mockSessionManager as unknown as SessionManager,
				freshMockSDKMessageRepo as unknown as SDKMessageRepository
			);

			// Set up request mock to handle both state.session and message.send
			mockMessageHub.request.mockImplementation(async (method: string) => {
				if (method === 'state.session') {
					return createMockSessionState('worker-session-def', {
						status: 'processing',
						messageId: 'msg-1',
						phase: 'thinking',
					});
				}
				// message.send just returns success
				return { success: true };
			});

			await freshSessionBridge.startBridge('pair-123');

			// Get the worker state change handler
			const workerHandler = mockMessageHub.onEvent.mock.calls[0][1];

			// Call the handler - note: the handler doesn't await the inner promise,
			// so we need to wait for the async operations to complete
			const terminalState = createMockSessionState('worker-session-def', { status: 'idle' });
			workerHandler(terminalState);

			// Wait for async operations to complete
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify getSDKMessages was called
			expect(freshMockSDKMessageRepo.getSDKMessages).toHaveBeenCalled();

			// Verify the messagesForwarded event was emitted
			expect(mockDaemonHub.emit).toHaveBeenCalledWith('bridge.messagesForwarded', {
				sessionId: 'worker-session-def',
				pairId: 'pair-123',
				direction: 'worker-to-manager',
				count: 2,
			});
		});
	});
});
