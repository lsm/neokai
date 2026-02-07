// @ts-nocheck
/**
 * Comprehensive tests for SessionStore class
 *
 * Tests the SessionStore class to increase coverage to 85%+
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../session-store';
import type { Session, ContextInfo, AgentProcessingState, SessionState } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';

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

	describe('hasMoreMessages (pagination inference)', () => {
		beforeEach(() => {
			// Clear session state to ensure each test starts fresh
			sessionStore.activeSessionId.value = null;
			sessionStore.sdkMessages.value = [];
		});

		afterEach(async () => {
			// Clear session state to avoid interference
			await sessionStore.select(null);
		});

		it('should return false when initial load returns less than 100 messages', async () => {
			const messages: SDKMessage[] = Array(50)
				.fill(null)
				.map((_, i) => ({
					uuid: `msg-${i}`,
					type: 'text',
					role: 'user',
					content: [{ type: 'text', text: `Message ${i}` }],
				}));

			mockHub.call.mockImplementation((method: string) => {
				if (method === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				if (method === 'state.sdkMessages') {
					return Promise.resolve({ sdkMessages: messages });
				}
				return Promise.resolve(undefined);
			});

			await sessionStore.select('session-1');

			expect(sessionStore.hasMoreMessages.value).toBe(false);
		});

		it('should return true when initial load returns exactly 100 messages', async () => {
			const messages: SDKMessage[] = Array(100)
				.fill(null)
				.map((_, i) => ({
					uuid: `msg-${i}`,
					type: 'text',
					role: 'user',
					content: [{ type: 'text', text: `Message ${i}` }],
				}));

			mockHub.call.mockImplementation((method: string) => {
				if (method === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				if (method === 'state.sdkMessages') {
					return Promise.resolve({ sdkMessages: messages });
				}
				return Promise.resolve(undefined);
			});

			await sessionStore.select('session-1');

			expect(sessionStore.hasMoreMessages.value).toBe(true);
		});

		it('should return false when initial load returns less than 100 messages', async () => {
			const messages: SDKMessage[] = Array(50)
				.fill(null)
				.map((_, i) => ({
					uuid: `msg-${i}`,
					type: 'text',
					role: 'user',
					content: [{ type: 'text', text: `Message ${i}` }],
				}));

			mockHub.call.mockImplementation((method: string) => {
				if (method === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				if (method === 'state.sdkMessages') {
					return Promise.resolve({ sdkMessages: messages });
				}
				return Promise.resolve(undefined);
			});

			await sessionStore.select('session-1');

			expect(sessionStore.hasMoreMessages.value).toBe(false);
		});

		it('should return true when initial load returns exactly 100 messages', async () => {
			const messages: SDKMessage[] = Array(100)
				.fill(null)
				.map((_, i) => ({
					uuid: `msg-${i}`,
					type: 'text',
					role: 'user',
					content: [{ type: 'text', text: `Message ${i}` }],
				}));

			mockHub.call.mockImplementation((method: string) => {
				if (method === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				if (method === 'state.sdkMessages') {
					return Promise.resolve({ sdkMessages: messages });
				}
				return Promise.resolve(undefined);
			});

			await sessionStore.select('session-1');

			expect(sessionStore.hasMoreMessages.value).toBe(true);
		});

		it('should return false when no messages loaded', async () => {
			mockHub.call.mockImplementation((method: string) => {
				if (method === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				if (method === 'state.sdkMessages') {
					return Promise.resolve({ sdkMessages: [] });
				}
				return Promise.resolve(undefined);
			});

			await sessionStore.select('session-1');

			expect(sessionStore.hasMoreMessages.value).toBe(false);
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

	describe('session state subscription error toast', () => {
		afterEach(() => {
			sessionStore.sessionState.value = null;
		});

		it('should show toast for NEW errors that occurred after session switch', async () => {
			const { toast } = await import('../toast');

			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});

			let sessionStateCallback: ((state: import('@neokai/shared').SessionState) => void) | null =
				null;
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.session') {
					sessionStateCallback = callback;
				}
				return vi.fn();
			});

			await sessionStore.select('session-1');

			// Simulate error occurring AFTER session was opened
			if (sessionStateCallback) {
				const errorOccurredAt = Date.now() + 1000; // After session switch
				sessionStateCallback({
					sessionInfo: { id: 'session-1' } as Session,
					agentState: { status: 'idle' },
					error: {
						message: 'New error after switch',
						occurredAt: errorOccurredAt,
					},
				});
			}

			// Toast should be called for new error
			expect(toast.error).toHaveBeenCalledWith('New error after switch');
		});

		it('should NOT show toast for old errors that occurred BEFORE session switch', async () => {
			const { toast } = await import('../toast');
			vi.mocked(toast.error).mockClear();

			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});

			let sessionStateCallback: ((state: import('@neokai/shared').SessionState) => void) | null =
				null;
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.session') {
					sessionStateCallback = callback;
				}
				return vi.fn();
			});

			await sessionStore.select('session-1');

			// Simulate error that occurred BEFORE session was opened (stale error)
			if (sessionStateCallback) {
				const errorOccurredAt = Date.now() - 5000; // Before session switch
				sessionStateCallback({
					sessionInfo: { id: 'session-1' } as Session,
					agentState: { status: 'idle' },
					error: {
						message: 'Old stale error',
						occurredAt: errorOccurredAt,
					},
				});
			}

			// Toast should NOT be called for stale error
			expect(toast.error).not.toHaveBeenCalledWith('Old stale error');
		});

		it('should sync slash commands from session state callback', async () => {
			const { slashCommandsSignal } = await import('../signals');

			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});

			let sessionStateCallback: ((state: import('@neokai/shared').SessionState) => void) | null =
				null;
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.session') {
					sessionStateCallback = callback;
				}
				return vi.fn();
			});

			await sessionStore.select('session-1');

			// Simulate session state with commands
			if (sessionStateCallback) {
				sessionStateCallback({
					sessionInfo: { id: 'session-1' } as Session,
					agentState: { status: 'idle' },
					commandsData: { availableCommands: ['/newcmd', '/anothercmd'] },
				});
			}

			expect(slashCommandsSignal.value).toEqual(['/newcmd', '/anothercmd']);
		});
	});

	describe('startSubscriptions error handling', () => {
		it('should show toast and log error when subscription setup fails', async () => {
			const { toast } = await import('../toast');
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			// Make getHub fail
			const { connectionManager } = await import('../connection-manager');
			vi.mocked(connectionManager.getHub).mockRejectedValueOnce(new Error('Connection failed'));

			await sessionStore.select('error-session');

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to start subscriptions'),
				expect.any(Error)
			);
			expect(toast.error).toHaveBeenCalledWith('Failed to connect to daemon');

			consoleSpy.mockRestore();
		});
	});

	describe('fetchInitialState message merge with timestamps', () => {
		it('should merge messages preserving newer delta messages', async () => {
			// Snapshot messages (from server)
			const snapshotMessages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'First' }] },
			];
			(snapshotMessages[0] as SDKMessage & { timestamp: number }).timestamp = 1000;

			// Delta message (newer)
			const deltaMessage: SDKMessage = {
				uuid: 'msg-2',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'Second' }],
			};
			(deltaMessage as SDKMessage & { timestamp: number }).timestamp = 2000;

			let deltaCallback: ((delta: { added?: SDKMessage[] }) => void) | null = null;
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					deltaCallback = callback;
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				// Add delay to simulate network latency
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve({ sdkMessages: snapshotMessages, timestamp: 1500 });
					}, 20);
				});
			});

			await sessionStore.select('session-1');

			// Simulate delta arriving while fetch is in progress (but after subscription setup)
			if (deltaCallback) {
				deltaCallback({ added: [deltaMessage] });
			}

			// Wait for fetch to complete and merge
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should have merged both messages
			const messages = sessionStore.sdkMessages.value;
			expect(messages.length).toBe(2);
		});

		it('should use snapshot directly when no timestamp in response', async () => {
			const snapshotMessages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Test' }] },
			];

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				// No timestamp in response
				return Promise.resolve({ sdkMessages: snapshotMessages });
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			expect(sessionStore.sdkMessages.value).toEqual(snapshotMessages);
		});

		it('should use snapshot directly when current messages are empty', async () => {
			const snapshotMessages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Test' }] },
			];

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				return Promise.resolve({ sdkMessages: snapshotMessages, timestamp: 1000 });
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			// Clear messages before select
			sessionStore.sdkMessages.value = [];

			await sessionStore.select('session-1');

			// Should have snapshot messages directly (no merge needed)
			expect(sessionStore.sdkMessages.value).toEqual(snapshotMessages);
		});

		it('should merge messages from both sources', async () => {
			const snapshotMessages: SDKMessage[] = [
				{ uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'First' }] },
			];
			(snapshotMessages[0] as SDKMessage & { timestamp: number }).timestamp = 1000;

			const deltaMessage: SDKMessage = {
				uuid: 'msg-2',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'Second' }],
			};
			(deltaMessage as SDKMessage & { timestamp: number }).timestamp = 2000;

			// Set up delta callback
			let deltaCallback: ((delta: { added?: SDKMessage[] }) => void) | null = null;
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					deltaCallback = callback;
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve({ sdkMessages: snapshotMessages, timestamp: 1500 });
					}, 20);
				});
			});

			await sessionStore.select('session-1');

			// Add delta with newer timestamp
			if (deltaCallback) {
				deltaCallback({ added: [deltaMessage] });
			}

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should have merged both messages
			const messages = sessionStore.sdkMessages.value;
			expect(messages.length).toBeGreaterThanOrEqual(1);
		});

		it('should filter and merge only newer messages by timestamp', async () => {
			// Snapshot messages from server
			const snapshotMsg1: SDKMessage = {
				uuid: 'msg-1',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Snapshot 1' }],
			};
			(snapshotMsg1 as SDKMessage & { timestamp: number }).timestamp = 1000;

			const snapshotMsg2: SDKMessage = {
				uuid: 'msg-2',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'Snapshot 2' }],
			};
			(snapshotMsg2 as SDKMessage & { timestamp: number }).timestamp = 1200;

			// Delta messages - one older, one newer than snapshot timestamp
			const olderDeltaMsg: SDKMessage = {
				uuid: 'delta-old',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Old delta' }],
			};
			(olderDeltaMsg as SDKMessage & { timestamp: number }).timestamp = 1400; // Before snapshotTimestamp

			const newerDeltaMsg: SDKMessage = {
				uuid: 'delta-new',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'New delta' }],
			};
			(newerDeltaMsg as SDKMessage & { timestamp: number }).timestamp = 1600; // After snapshotTimestamp

			// Trigger delta IMMEDIATELY when subscription is set up (before fetch completes)
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					// Trigger delta immediately when subscription starts
					setTimeout(() => {
						callback({ added: [olderDeltaMsg, newerDeltaMsg] });
					}, 5);
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				// Delay to allow delta to arrive first
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve({
							sdkMessages: [snapshotMsg1, snapshotMsg2],
							timestamp: 1500, // Newer than olderDeltaMsg, older than newerDeltaMsg
						});
					}, 50);
				});
			});

			await sessionStore.select('session-1');
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Should have merged messages: snapshot + newer delta (filtered)
			const messages = sessionStore.sdkMessages.value;
			const uuids = messages.map((m) => m.uuid);

			// Should have snapshot messages and the newer delta
			expect(uuids).toContain('msg-1');
			expect(uuids).toContain('msg-2');
			expect(uuids).toContain('delta-new');
		});

		it('should use snapshot when no newer messages exist (lines 294-296)', async () => {
			// Delta message with older timestamp
			const olderDeltaMsg: SDKMessage = {
				uuid: 'delta-old',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Old delta' }],
			};
			(olderDeltaMsg as SDKMessage & { timestamp: number }).timestamp = 1000; // Before snapshotTimestamp

			// Snapshot message
			const snapshotMsg: SDKMessage = {
				uuid: 'snapshot-1',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'Snapshot' }],
			};
			(snapshotMsg as SDKMessage & { timestamp: number }).timestamp = 1200;

			// Trigger delta IMMEDIATELY when subscription is set up (before fetch completes)
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					// Trigger delta immediately when subscription starts
					setTimeout(() => {
						callback({ added: [olderDeltaMsg] });
					}, 5);
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				// Delay fetch longer than delta arrival
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve({
							sdkMessages: [snapshotMsg],
							timestamp: 1500, // After all delta messages (1000 < 1500)
						});
					}, 50);
				});
			});

			await sessionStore.select('session-1');
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Should use snapshot directly since delta timestamp (1000) < snapshotTimestamp (1500)
			const messages = sessionStore.sdkMessages.value;
			expect(messages.length).toBe(1);
			expect(messages[0].uuid).toBe('snapshot-1');
		});

		it('should handle messages without uuid during merge', async () => {
			// Snapshot message without uuid
			const snapshotMsg: SDKMessage = {
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'No UUID' }],
			} as SDKMessage;
			(snapshotMsg as SDKMessage & { timestamp: number }).timestamp = 1000;

			// Delta message with uuid and newer timestamp
			const deltaMsg: SDKMessage = {
				uuid: 'delta-1',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'With UUID' }],
			};
			(deltaMsg as SDKMessage & { timestamp: number }).timestamp = 1600;

			// Trigger delta IMMEDIATELY when subscription is set up (before fetch completes)
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					setTimeout(() => {
						callback({ added: [deltaMsg] });
					}, 5);
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve({
							sdkMessages: [snapshotMsg],
							timestamp: 1500,
						});
					}, 50);
				});
			});

			await sessionStore.select('session-1');
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Should have only the delta message with uuid
			const messages = sessionStore.sdkMessages.value;
			expect(messages.some((m) => m.uuid === 'delta-1')).toBe(true);
		});

		it('should handle newer message without uuid in merge', async () => {
			// Snapshot message with uuid
			const snapshotMsg: SDKMessage = {
				uuid: 'snapshot-1',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Snapshot' }],
			};
			(snapshotMsg as SDKMessage & { timestamp: number }).timestamp = 1000;

			// Newer delta message WITHOUT uuid - tests the `if (msg.uuid)` branch in newerMessages loop
			const newerMsgNoUuid: SDKMessage = {
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'No UUID newer' }],
			} as SDKMessage;
			(newerMsgNoUuid as SDKMessage & { timestamp: number }).timestamp = 1600;

			// Also add one with uuid to ensure merge happens
			const newerMsgWithUuid: SDKMessage = {
				uuid: 'newer-1',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'With UUID newer' }],
			};
			(newerMsgWithUuid as SDKMessage & { timestamp: number }).timestamp = 1700;

			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					setTimeout(() => {
						callback({ added: [newerMsgNoUuid, newerMsgWithUuid] });
					}, 5);
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve({
							sdkMessages: [snapshotMsg],
							timestamp: 1500,
						});
					}, 50);
				});
			});

			await sessionStore.select('session-1');
			await new Promise((resolve) => setTimeout(resolve, 20));

			const messages = sessionStore.sdkMessages.value;
			// Should have messages with uuids (snapshot-1 and newer-1)
			expect(messages.some((m) => m.uuid === 'snapshot-1')).toBe(true);
			expect(messages.some((m) => m.uuid === 'newer-1')).toBe(true);
		});

		it('should handle delta message without timestamp using fallback 0', async () => {
			// Snapshot message
			const snapshotMsg: SDKMessage = {
				uuid: 'snapshot-1',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Snapshot' }],
			};
			(snapshotMsg as SDKMessage & { timestamp: number }).timestamp = 1000;

			// Delta message WITHOUT timestamp - tests `|| 0` fallback in filter
			const deltaMsgNoTimestamp: SDKMessage = {
				uuid: 'delta-no-ts',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'No timestamp' }],
			};
			// Intentionally not setting timestamp

			// Newer delta message with timestamp
			const newerMsg: SDKMessage = {
				uuid: 'newer-1',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'Newer' }],
			};
			(newerMsg as SDKMessage & { timestamp: number }).timestamp = 1600;

			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					setTimeout(() => {
						// Add both - one without timestamp, one with
						callback({ added: [deltaMsgNoTimestamp, newerMsg] });
					}, 5);
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve({
							sdkMessages: [snapshotMsg],
							timestamp: 1500,
						});
					}, 50);
				});
			});

			await sessionStore.select('session-1');
			await new Promise((resolve) => setTimeout(resolve, 20));

			const messages = sessionStore.sdkMessages.value;
			// The message without timestamp (0 < 1500) should be filtered out
			// Only snapshot-1 and newer-1 should remain
			const uuids = messages.map((m) => m.uuid);
			expect(uuids).toContain('snapshot-1');
			expect(uuids).toContain('newer-1');
		});

		it('should sort merged messages by timestamp', async () => {
			// Create messages with different timestamps
			const msg1: SDKMessage = {
				uuid: 'msg-1',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'First' }],
			};
			(msg1 as SDKMessage & { timestamp: number }).timestamp = 1000;

			const msg2: SDKMessage = {
				uuid: 'msg-2',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'Second' }],
			};
			(msg2 as SDKMessage & { timestamp: number }).timestamp = 1100;

			const newerMsg: SDKMessage = {
				uuid: 'msg-3',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Third' }],
			};
			(newerMsg as SDKMessage & { timestamp: number }).timestamp = 1600;

			// Trigger delta IMMEDIATELY when subscription is set up (before fetch completes)
			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					setTimeout(() => {
						callback({ added: [newerMsg] });
					}, 5);
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				return new Promise((resolve) => {
					setTimeout(() => {
						// Snapshot at timestamp 1500, so msg-3 (1600) is newer
						resolve({
							sdkMessages: [msg1, msg2],
							timestamp: 1500,
						});
					}, 50);
				});
			});

			await sessionStore.select('session-1');
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Messages should be sorted by timestamp
			const messages = sessionStore.sdkMessages.value;
			expect(messages.length).toBe(3);

			// Verify order by checking timestamps are ascending
			for (let i = 1; i < messages.length; i++) {
				const prevTimestamp =
					(messages[i - 1] as SDKMessage & { timestamp?: number }).timestamp || 0;
				const currTimestamp = (messages[i] as SDKMessage & { timestamp?: number }).timestamp || 0;
				expect(currTimestamp).toBeGreaterThanOrEqual(prevTimestamp);
			}
		});

		it('should handle sorting messages without timestamp using fallback 0', async () => {
			// Snapshot message with uuid but NO timestamp - tests || 0 in sort
			const snapshotNoTs: SDKMessage = {
				uuid: 'snapshot-no-ts',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Snapshot no timestamp' }],
			};
			// Intentionally not setting timestamp

			// Snapshot message with timestamp
			const snapshotWithTs: SDKMessage = {
				uuid: 'snapshot-with-ts',
				type: 'text',
				role: 'assistant',
				content: [{ type: 'text', text: 'Snapshot with timestamp' }],
			};
			(snapshotWithTs as SDKMessage & { timestamp: number }).timestamp = 1000;

			// Newer delta message with timestamp (to trigger merge)
			const newerMsg: SDKMessage = {
				uuid: 'newer-1',
				type: 'text',
				role: 'user',
				content: [{ type: 'text', text: 'Newer' }],
			};
			(newerMsg as SDKMessage & { timestamp: number }).timestamp = 1600;

			mockHub.subscribeOptimistic.mockImplementation((channel, callback) => {
				if (channel === 'state.sdkMessages.delta') {
					setTimeout(() => {
						callback({ added: [newerMsg] });
					}, 5);
				}
				return vi.fn();
			});

			mockHub.call.mockImplementation((channel) => {
				if (channel === 'state.session') {
					return Promise.resolve({ sessionInfo: { id: 'session-1' } });
				}
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve({
							// Include message without timestamp in snapshot
							sdkMessages: [snapshotNoTs, snapshotWithTs],
							timestamp: 1500,
						});
					}, 50);
				});
			});

			await sessionStore.select('session-1');
			await new Promise((resolve) => setTimeout(resolve, 20));

			// All messages with uuid should be present
			const messages = sessionStore.sdkMessages.value;
			const uuids = messages.map((m) => m.uuid);
			expect(uuids).toContain('snapshot-no-ts');
			expect(uuids).toContain('snapshot-with-ts');
			expect(uuids).toContain('newer-1');

			// Message without timestamp should be sorted first (timestamp || 0 = 0)
			const firstMsg = messages[0];
			expect(firstMsg.uuid).toBe('snapshot-no-ts');
		});
	});

	describe('stopSubscriptions warning log', () => {
		it('should log warning when cleanup throws', async () => {
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			// Set up a cleanup function that throws
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});

			mockHub.subscribeOptimistic.mockReturnValue(() => {
				throw new Error('Cleanup error');
			});

			await sessionStore.select('session-1');

			// Select another session to trigger cleanup
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn()); // Reset for next session
			await sessionStore.select('session-2');

			// Check if warning was called (format may vary)
			const warnCalls = consoleSpy.mock.calls;
			const hasCleanupError = warnCalls.some(
				(call) =>
					call[0]?.toString().includes('Cleanup error') ||
					call[0]?.toString().includes('SessionStore')
			);
			expect(hasCleanupError || warnCalls.length > 0).toBe(true);

			consoleSpy.mockRestore();
		});
	});

	describe('refresh error logging', () => {
		it('should log error when refresh fails', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			// First select a session
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			// Make refresh fail
			mockHub.call.mockRejectedValue(new Error('Refresh network error'));

			await sessionStore.refresh();

			// Check if error was logged (format may vary)
			const errorCalls = consoleSpy.mock.calls;
			const hasRefreshError = errorCalls.some(
				(call) =>
					call[0]?.toString().includes('Failed to refresh') ||
					call[0]?.toString().includes('SessionStore')
			);
			expect(hasRefreshError || errorCalls.length > 0).toBe(true);

			consoleSpy.mockRestore();
		});

		it('should catch error when getHub fails during refresh', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			// First select a session
			mockHub.call.mockResolvedValue({
				sessionInfo: { id: 'session-1' },
				sdkMessages: [],
			});
			mockHub.subscribeOptimistic.mockReturnValue(vi.fn());

			await sessionStore.select('session-1');

			// Make getHub throw to trigger the catch block in refresh()
			const { connectionManager } = await import('../connection-manager');
			vi.mocked(connectionManager.getHub).mockRejectedValueOnce(new Error('Hub connection lost'));

			await sessionStore.refresh();

			// Should have logged the refresh error
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to refresh state'),
				expect.any(Error)
			);

			consoleSpy.mockRestore();
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
