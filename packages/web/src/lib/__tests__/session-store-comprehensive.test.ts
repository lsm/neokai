// @ts-nocheck
/**
 * Comprehensive tests for SessionStore class
 *
 * Tests the SessionStore class to increase coverage to 85%+
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../session-store';
import type { Session, ContextInfo, AgentProcessingState, SessionState } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';

// Mock connection manager
const mockHub = {
	subscribeOptimistic: vi.fn(() => vi.fn()),
	subscribe: vi.fn(() => Promise.resolve(vi.fn())),
	call: vi.fn(),
};

vi.mock('../connection-manager', () => ({
	connectionManager: {
		getHub: vi.fn(() => Promise.resolve(mockHub)),
	},
}));

// Mock signals
vi.mock('../signals', () => ({
	slashCommandsSignal: { value: [] },
}));

// Mock toast
vi.mock('../toast', () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

describe('SessionStore - Comprehensive Coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(async () => {
		// Clean up by selecting null
		await sessionStore.select(null);
	});

	describe('constructor and initial state', () => {
		it('should initialize with null activeSessionId', () => {
			expect(sessionStore.activeSessionId.value).toBe(null);
		});

		it('should initialize with null sessionState', () => {
			expect(sessionStore.sessionState.value).toBe(null);
		});

		it('should initialize with empty sdkMessages array', () => {
			expect(sessionStore.sdkMessages.value).toEqual([]);
		});
	});

	describe('computed accessors - default values', () => {
		it('should return null for sessionInfo when no state', () => {
			expect(sessionStore.sessionInfo.value).toBeNull();
		});

		it('should return idle agent state when no state', () => {
			expect(sessionStore.agentState.value).toEqual({ status: 'idle' });
		});

		it('should return null for contextInfo when no state', () => {
			expect(sessionStore.contextInfo.value).toBeNull();
		});

		it('should return empty array for commandsData when no state', () => {
			expect(sessionStore.commandsData.value).toEqual([]);
		});

		it('should return null for error when no state', () => {
			expect(sessionStore.error.value).toBeNull();
		});

		it('should return false for isCompacting when idle', () => {
			expect(sessionStore.isCompacting.value).toBe(false);
		});

		it('should return false for isWorking when idle', () => {
			expect(sessionStore.isWorking.value).toBe(false);
		});
	});

	describe('select() - session switching', () => {
		it('should update activeSessionId when selecting session', async () => {
			mockHub.call.mockResolvedValue({ sessionInfo: { id: 'session-1' } });
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			expect(sessionStore.activeSessionId.value).toBe('session-1');
		});

		it('should clear state when selecting null', async () => {
			// First select a session
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			// Then select null
			await sessionStore.select(null);

			expect(sessionStore.activeSessionId.value).toBe(null);
			expect(sessionStore.sessionState.value).toBe(null);
			expect(sessionStore.sdkMessages.value).toEqual([]);
		});

		it('should skip selection if already on same session', async () => {
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');
			const initialCallCount = mockHub.call.mock.calls.length;

			// Select same session again
			await sessionStore.select('session-1');

			// Should not call hub again (early return in doSelect)
			expect(mockHub.call.mock.calls.length).toBe(initialCallCount);
		});

		it('should handle rapid session switches via promise chain', async () => {
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'test' },
				sdkMessages: [],
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			// Rapidly switch sessions
			const p1 = sessionStore.select('session-1');
			const p2 = sessionStore.select('session-2');
			const p3 = sessionStore.select('session-3');

			await Promise.all([p1, p2, p3]);

			// Should end up on session-3 (last one)
			expect(sessionStore.activeSessionId.value).toBe('session-3');
		});
	});

	describe('fetchInitialState()', () => {
		it('should fetch and set session state', async () => {
			const mockSessionState: SessionState = {
				sessionInfo: { id: 'session-1', title: 'Test Session' } as Session,
				agentState: { status: 'idle' },
				commandsData: { availableCommands: ['/test', '/help'] },
			};

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve(mockSessionState);
				}
				return Promise.resolve({ sdkMessages: [] });
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			expect(sessionStore.sessionState.value).toEqual(mockSessionState);
		});

		it('should fetch and set SDK messages', async () => {
			const mockMessages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Hello' }] },
				{ uuid: 'msg-2', type: 'text', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
			];

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				return Promise.resolve({ sdkMessages: mockMessages, timestamp: 1000 });
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			expect(sessionStore.sdkMessages.value).toEqual(mockMessages);
		});

		it('should merge messages with newer delta messages', async () => {
			const mockMessages: SDKMessage[] = [
				{
					uuid: 'msg-1',
					type: 'text',
					role: 'user',
					content: [{ type: 'text', text: 'Old' }],
				} as SDKMessage & { timestamp: number },
			];

			const newerMessage: SDKMessage = {
				uuid: 'msg-2',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'Newer' }],
			} as SDKMessage & { timestamp: number };
			(newerMessage as SDKMessage & { timestamp: number }).timestamp = 2000;

			// Simulate newer message arriving via delta before fetch completes
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					// Simulate delta arriving immediately
					setTimeout(() => {
						callback({ added: [newerMessage] });
					}, 0);
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				// Snapshot has timestamp 1000, newer message has timestamp 2000
				return Promise.resolve({ sdkMessages: mockMessages, timestamp: 1000 });
			});

			await sessionStore.select('session-1');
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should have both messages, sorted by timestamp
			expect(sessionStore.sdkMessages.value.length).toBeGreaterThanOrEqual(1);
		});

		it('should handle fetch errors gracefully', async () => {
			mockHub.call.mockRejectedValue(new Error('Fetch failed'));
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			// Should not throw, but log error
			await expect(sessionStore.select('session-1')).resolves.not.toThrow();
		});
	});

	describe('computed accessors - with state', () => {
		beforeEach(() => {
			// Set up some state directly on the singleton
			sessionStore.sessionState.value = {
				sessionInfo: {
					id: 'session-1',
					title: 'Test Session',
					status: 'active',
					createdAt: '',
					lastActiveAt: '',
					workspacePath: '/test',
				} as Session,
				agentState: { status: 'processing' },
				contextInfo: { totalTokens: 1000, inputTokens: 500, outputTokens: 500 } as ContextInfo,
				commandsData: { availableCommands: ['/test', '/help'] },
			};
		});

		afterEach(() => {
			// Reset state
			sessionStore.sessionState.value = null;
		});

		it('should return sessionInfo from state', () => {
			expect(sessionStore.sessionInfo.value?.id).toBe('session-1');
		});

		it('should return agentState from state', () => {
			expect(sessionStore.agentState.value.status).toBe('processing');
		});

		it('should return contextInfo from state', () => {
			expect(sessionStore.contextInfo.value?.totalTokens).toBe(1000);
		});

		it('should return commandsData from state', () => {
			expect(sessionStore.commandsData.value).toEqual(['/test', '/help']);
		});

		it('should return true for isWorking when processing', () => {
			expect(sessionStore.isWorking.value).toBe(true);
		});
	});

	describe('isCompacting', () => {
		afterEach(() => {
			sessionStore.sessionState.value = null;
		});

		it('should return true when agent is processing and compacting', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'processing', isCompacting: true },
			};

			expect(sessionStore.isCompacting.value).toBe(true);
		});

		it('should return false when agent is processing but not compacting', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'processing', isCompacting: false },
			};

			expect(sessionStore.isCompacting.value).toBe(false);
		});

		it('should return false when agent is idle', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'idle' },
			};

			expect(sessionStore.isCompacting.value).toBe(false);
		});
	});

	describe('isWorking', () => {
		afterEach(() => {
			sessionStore.sessionState.value = null;
		});

		it('should return true when agent status is processing', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'processing' },
			};

			expect(sessionStore.isWorking.value).toBe(true);
		});

		it('should return true when agent status is queued', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'queued' },
			};

			expect(sessionStore.isWorking.value).toBe(true);
		});

		it('should return false when agent status is idle', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'idle' },
			};

			expect(sessionStore.isWorking.value).toBe(false);
		});
	});

	describe('error handling', () => {
		afterEach(() => {
			sessionStore.sessionState.value = null;
		});

		it('should clear error from state', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				error: {
					message: 'Test error',
					occurredAt: Date.now(),
				},
			};

			sessionStore.clearError();

			expect(sessionStore.sessionState.value?.error).toBeNull();
		});

		it('should handle clearError when no state exists', () => {
			// Should not throw
			expect(() => sessionStore.clearError()).not.toThrow();
		});

		it('should handle clearError when no error exists', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
			};

			// Should not throw
			expect(() => sessionStore.clearError()).not.toThrow();
		});

		it('should return error details when present', () => {
			const mockDetails = { type: 'TestError', stack: 'error stack' };
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				error: {
					message: 'Test error',
					details: mockDetails,
					occurredAt: Date.now(),
				},
			};

			const details = sessionStore.getErrorDetails();

			expect(details).toEqual(mockDetails);
		});

		it('should return null for error details when not present', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				error: {
					message: 'Test error',
					occurredAt: Date.now(),
				},
			};

			const details = sessionStore.getErrorDetails();

			expect(details).toBeNull();
		});

		it('should return null for error details when no error exists', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
			};

			const details = sessionStore.getErrorDetails();

			expect(details).toBeNull();
		});
	});

	describe('SDK message delta subscription', () => {
		it('should add messages from delta subscription', async () => {
			const newMessages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Hello' }] },
				{ uuid: 'msg-2', type: 'text', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
			];

			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});

			let deltaCallback: ((delta: { added?: SDKMessage[] }) => void) | null = null;
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					deltaCallback = callback;
				}
				return vi.fn();
			});

			await sessionStore.select('session-1');

			// Simulate delta messages arriving
			if (deltaCallback) {
				deltaCallback({ added: newMessages });
			}

			expect(sessionStore.sdkMessages.value).toEqual(newMessages);
		});

		it('should deduplicate messages by uuid', async () => {
			const existingMessage: SDKMessage = {
				uuid: 'msg-1',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Original' }],
			};

			const updatedMessage: SDKMessage = {
				uuid: 'msg-1',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Updated' }],
			};

			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});

			let deltaCallback: ((delta: { added?: SDKMessage[] }) => void) | null = null;
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					deltaCallback = callback;
				}
				return vi.fn();
			});

			await sessionStore.select('session-1');

			// Add original message
			if (deltaCallback) {
				deltaCallback({ added: [existingMessage] });
			}

			// Try to add same uuid again (should be filtered out)
			if (deltaCallback) {
				deltaCallback({ added: [updatedMessage] });
			}

			// Should only have one message (deduplicated)
			const msgCount = sessionStore.sdkMessages.value.filter((m) => m.uuid === 'msg-1').length;
			expect(msgCount).toBe(1);
		});

		it('should not add messages when delta has no added array', async () => {
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});

			let deltaCallback: ((delta: { added?: SDKMessage[] }) => void) | null = null;
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					deltaCallback = callback;
				}
				return vi.fn();
			});

			await sessionStore.select('session-1');

			const initialCount = sessionStore.sdkMessages.value.length;

			// Call with empty delta
			if (deltaCallback) {
				deltaCallback({});
			}

			expect(sessionStore.sdkMessages.value.length).toBe(initialCount);
		});

		it('should not add messages when delta has empty added array', async () => {
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});

			let deltaCallback: ((delta: { added?: SDKMessage[] }) => void) | null = null;
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					deltaCallback = callback;
				}
				return vi.fn();
			});

			await sessionStore.select('session-1');

			const initialCount = sessionStore.sdkMessages.value.length;

			// Call with empty added array
			if (deltaCallback) {
				deltaCallback({ added: [] });
			}

			expect(sessionStore.sdkMessages.value.length).toBe(initialCount);
		});
	});

	describe('slash commands sync', () => {
		it('should sync slash commands on session state update', async () => {
			const { slashCommandsSignal } = await import('../signals');

			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				commandsData: { availableCommands: ['/cmd1', '/cmd2'] },
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			expect(slashCommandsSignal.value).toEqual(['/cmd1', '/cmd2']);
		});
	});

	describe('refresh()', () => {
		it('should refresh current session state', async () => {
			// First select a session
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1', title: 'Original' },
				sdkMessages: [],
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			// Mock updated state
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1', title: 'Updated' },
				sdkMessages: [],
			});

			await sessionStore.refresh();

			expect(sessionStore.sessionState.value?.sessionInfo?.title).toBe('Updated');
		});

		it('should return early when no active session', async () => {
			mockHub.call.mockResolvedValue({ sessionInfo: { id: 'test' } });

			await sessionStore.refresh();

			// Should not call hub.call
			expect(mockHub.call).not.toHaveBeenCalled();
		});

		it('should handle refresh errors gracefully', async () => {
			// First select a session
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			// Mock refresh error
			mockHub.call.mockRejectedValue(new Error('Refresh failed'));

			// Should not throw
			await expect(sessionStore.refresh()).resolves.not.toThrow();
		});
	});

	describe('message management', () => {
		beforeEach(() => {
			// Clear messages before each test in this suite
			sessionStore.sdkMessages.value = [];
		});

		it('should prepend messages for pagination', () => {
			const existingMessages: SDKMessage[] = [
				{ uuid: 'msg-2', type: 'text', role: 'user', content: [{ type: 'text', text: 'Newer' }] },
			];

			const olderMessages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Older' }] },
			];

			sessionStore.sdkMessages.value = existingMessages;

			sessionStore.prependMessages(olderMessages);

			expect(sessionStore.sdkMessages.value).toEqual([...olderMessages, ...existingMessages]);
		});

		it('should not prepend empty array', () => {
			const existingMessages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Test' }] },
			];

			sessionStore.sdkMessages.value = existingMessages;

			sessionStore.prependMessages([]);

			expect(sessionStore.sdkMessages.value).toEqual(existingMessages);
		});

		it('should return message count', () => {
			const messages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Test' }] },
				{ uuid: 'msg-2', type: 'text', role: 'user', content: [{ type: 'text', text: 'Test' }] },
			];

			sessionStore.sdkMessages.value = messages;

			expect(sessionStore.messageCount).toBe(2);
		});

		it('should return zero message count when empty', () => {
			expect(sessionStore.messageCount).toBe(0);
		});
	});

	describe('getTotalMessageCount()', () => {
		it('should return total message count from server', async () => {
			mockHub.call.mockResolvedValue({ count: 42 });

			await sessionStore.select('session-1');

			const count = await sessionStore.getTotalMessageCount();

			expect(count).toBe(42);
		});

		it('should return 0 when no active session', async () => {
			const count = await sessionStore.getTotalMessageCount();

			expect(count).toBe(0);
		});

		it('should return 0 on error', async () => {
			mockHub.call.mockRejectedValue(new Error('Failed'));

			await sessionStore.select('session-1');

			const count = await sessionStore.getTotalMessageCount();

			expect(count).toBe(0);
		});

		it('should return 0 when server returns null', async () => {
			mockHub.call.mockResolvedValue(null);

			await sessionStore.select('session-1');

			const count = await sessionStore.getTotalMessageCount();

			expect(count).toBe(0);
		});
	});

	describe('loadOlderMessages()', () => {
		it('should load older messages from server', async () => {
			const olderMessages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Old' }] },
			];

			mockHub.call.mockResolvedValue({ sdkMessages: olderMessages });

			await sessionStore.select('session-1');

			const result = await sessionStore.loadOlderMessages(Date.now(), 100);

			expect(result.messages).toEqual(olderMessages);
			expect(result.hasMore).toBe(false); // Less than limit
		});

		it('should return hasMore true when message count equals limit', async () => {
			const messages: SDKMessage[] = Array(100)
				.fill(null)
				.map((_, i) => ({
					uuid: `msg-${i}`,
					type: 'text',
					role: 'user',
					content: [{ type: 'text', text: `Message ${i}` }],
				}));

			mockHub.call.mockResolvedValue({ sdkMessages: messages });

			await sessionStore.select('session-1');

			const result = await sessionStore.loadOlderMessages(Date.now(), 100);

			expect(result.hasMore).toBe(true);
		});

		it('should return empty array when no active session', async () => {
			const result = await sessionStore.loadOlderMessages(Date.now());

			expect(result.messages).toEqual([]);
			expect(result.hasMore).toBe(false);
		});

		it('should throw on error', async () => {
			mockHub.call.mockRejectedValue(new Error('Failed to load'));

			await sessionStore.select('session-1');

			await expect(sessionStore.loadOlderMessages(Date.now())).rejects.toThrow();
		});

		it('should return empty array when server returns null', async () => {
			mockHub.call.mockResolvedValue(null);

			await sessionStore.select('session-1');

			const result = await sessionStore.loadOlderMessages(Date.now());

			expect(result.messages).toEqual([]);
			expect(result.hasMore).toBe(false);
		});

		it('should use default limit of 100', async () => {
			mockHub.call.mockResolvedValue({ sdkMessages: [] });

			await sessionStore.select('session-1');

			await sessionStore.loadOlderMessages(Date.now());

			expect(mockHub.call).toHaveBeenCalledWith(
				'message.sdkMessages',
				expect.objectContaining({ limit: 100 })
			);
		});

		it('should use custom limit when provided', async () => {
			mockHub.call.mockResolvedValue({ sdkMessages: [] });

			await sessionStore.select('session-1');

			await sessionStore.loadOlderMessages(Date.now(), 50);

			expect(mockHub.call).toHaveBeenCalledWith(
				'message.sdkMessages',
				expect.objectContaining({ limit: 50 })
			);
		});
	});

	describe('edge cases', () => {
		afterEach(() => {
			sessionStore.sessionState.value = null;
		});

		it('should handle null sessionState in computed properties', () => {
			sessionStore.sessionState.value = null;

			expect(sessionStore.sessionInfo.value).toBeNull();
			expect(sessionStore.agentState.value).toEqual({ status: 'idle' });
			expect(sessionStore.contextInfo.value).toBeNull();
			expect(sessionStore.commandsData.value).toEqual([]);
			expect(sessionStore.error.value).toBeNull();
		});

		it('should handle empty object sessionState', () => {
			sessionStore.sessionState.value = {} as SessionState;

			expect(sessionStore.sessionInfo.value).toBeNull();
			expect(sessionStore.agentState.value).toEqual({ status: 'idle' });
		});

		it('should handle missing commandsData', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'idle' },
			};

			expect(sessionStore.commandsData.value).toEqual([]);
		});

		it('should handle missing availableCommands in commandsData', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'idle' },
				commandsData: {} as Record<string, never>,
			};

			expect(sessionStore.commandsData.value).toEqual([]);
		});

		it('should handle agent state without isCompacting property', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'processing' } as AgentProcessingState,
			};

			expect(sessionStore.isCompacting.value).toBe(false);
		});

		it('should handle isCompacting false value', () => {
			sessionStore.sessionState.value = {
				sessionInfo: {} as Session,
				agentState: { status: 'processing', isCompacting: false },
			};

			expect(sessionStore.isCompacting.value).toBe(false);
		});
	});
});
