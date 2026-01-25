// @ts-nocheck
/**
 * Tests for useSendMessage Hook
 *
 * Tests message sending with timeout, validation, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { Session } from '@liuboer/shared';
import { useSendMessage } from '../useSendMessage.ts';

// Mock connection state
const mockConnectionState = signal<'connected' | 'disconnected' | 'connecting'>('connected');

vi.mock('../../lib/state', () => ({
	connectionState: {
		get value() {
			return mockConnectionState.value;
		},
	},
}));

// Mock the connection manager
const mockCall = vi.fn();
const mockGetHubIfConnected = vi.fn();

vi.mock('../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: () => mockGetHubIfConnected(),
	},
}));

// Mock toast
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../lib/toast', () => ({
	toast: {
		success: (msg: string) => mockToastSuccess(msg),
		error: (msg: string) => mockToastError(msg),
	},
}));

describe('useSendMessage', () => {
	const defaultSession: Session = {
		id: 'session-1',
		title: 'Test Session',
		status: 'active',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		workspacePath: '/test',
		config: {},
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockConnectionState.value = 'connected';
		mockGetHubIfConnected.mockReturnValue({ call: mockCall });
		mockCall.mockResolvedValue({});
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('initialization', () => {
		it('should provide sendMessage function', () => {
			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(),
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			expect(typeof result.current.sendMessage).toBe('function');
		});

		it('should provide clearSendTimeout function', () => {
			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(),
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			expect(typeof result.current.clearSendTimeout).toBe('function');
		});
	});

	describe('sendMessage validation', () => {
		it('should not send empty message', async () => {
			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('');
			});

			expect(onSendStart).not.toHaveBeenCalled();
			expect(mockCall).not.toHaveBeenCalled();
		});

		it('should not send whitespace-only message', async () => {
			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('   ');
			});

			expect(onSendStart).not.toHaveBeenCalled();
		});

		it('should not send if already sending', async () => {
			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: true,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			expect(onSendStart).not.toHaveBeenCalled();
		});
	});

	describe('archived session handling', () => {
		it('should not send to archived session', async () => {
			const archivedSession: Session = {
				...defaultSession,
				status: 'archived',
			};

			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: archivedSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			expect(onSendStart).not.toHaveBeenCalled();
			expect(mockToastError).toHaveBeenCalledWith('Cannot send messages to archived sessions');
		});
	});

	describe('connection state handling', () => {
		it('should not send when disconnected', async () => {
			mockConnectionState.value = 'disconnected';

			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			expect(onSendStart).not.toHaveBeenCalled();
			expect(mockToastError).toHaveBeenCalledWith('Connection lost. Please refresh the page.');
		});

		it('should not send when connecting', async () => {
			mockConnectionState.value = 'connecting';

			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			expect(onSendStart).not.toHaveBeenCalled();
			expect(mockToastError).toHaveBeenCalledWith('Connection lost. Please refresh the page.');
		});
	});

	describe('successful message sending', () => {
		it('should send message successfully', async () => {
			const onSendStart = vi.fn();
			const onSendComplete = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete,
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			expect(onSendStart).toHaveBeenCalled();
			expect(mockCall).toHaveBeenCalledWith('message.send', {
				sessionId: 'session-1',
				content: 'Hello',
				images: undefined,
			});
		});

		it('should send message with images', async () => {
			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			const images = [{ type: 'base64' as const, mediaType: 'image/png' as const, data: 'abc123' }];

			await act(async () => {
				await result.current.sendMessage('Hello with image', images);
			});

			expect(mockCall).toHaveBeenCalledWith('message.send', {
				sessionId: 'session-1',
				content: 'Hello with image',
				images,
			});
		});
	});

	describe('hub connection handling', () => {
		it('should handle no hub connection', async () => {
			mockGetHubIfConnected.mockReturnValue(null);

			const onSendStart = vi.fn();
			const onSendComplete = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete,
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			expect(onSendStart).toHaveBeenCalled();
			expect(mockToastError).toHaveBeenCalledWith('Connection lost.');
			expect(onSendComplete).toHaveBeenCalled();
		});
	});

	describe('error handling', () => {
		it('should handle send error', async () => {
			mockCall.mockRejectedValue(new Error('Network error'));

			const onError = vi.fn();
			const onSendComplete = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(),
					onSendComplete,
					onError,
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			expect(onError).toHaveBeenCalledWith('Network error');
			expect(mockToastError).toHaveBeenCalledWith('Network error');
			expect(onSendComplete).toHaveBeenCalled();
		});

		it('should handle non-Error exception', async () => {
			mockCall.mockRejectedValue('Unknown error');

			const onError = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(),
					onSendComplete: vi.fn(),
					onError,
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			expect(onError).toHaveBeenCalledWith('Failed to send message');
		});
	});

	describe('timeout handling', () => {
		it('should set timeout on send', async () => {
			let resolveCall: (value: unknown) => void;
			const callPromise = new Promise((resolve) => {
				resolveCall = resolve;
			});
			mockCall.mockImplementation(() => callPromise);

			const onError = vi.fn();
			const onSendComplete = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(),
					onSendComplete,
					onError,
				})
			);

			act(() => {
				result.current.sendMessage('Hello');
			});

			// Advance timer to trigger timeout (15 seconds)
			await act(async () => {
				vi.advanceTimersByTime(15000);
			});

			expect(onSendComplete).toHaveBeenCalled();
			expect(onError).toHaveBeenCalledWith('Message send timed out.');
			expect(mockToastError).toHaveBeenCalledWith('Message send timed out.');

			// Resolve the promise to clean up
			resolveCall!({});
		});

		it('should clear timeout on successful send', async () => {
			const onError = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(),
					onSendComplete: vi.fn(),
					onError,
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			// Advance timer past timeout
			await act(async () => {
				vi.advanceTimersByTime(20000);
			});

			// Error should not have been called because timeout was cleared
			expect(onError).not.toHaveBeenCalled();
		});
	});

	describe('clearSendTimeout', () => {
		it('should be callable without throwing', () => {
			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(),
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			act(() => {
				result.current.clearSendTimeout();
			});

			expect(true).toBe(true);
		});

		it('should be callable multiple times', () => {
			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(),
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			act(() => {
				result.current.clearSendTimeout();
				result.current.clearSendTimeout();
				result.current.clearSendTimeout();
			});

			expect(true).toBe(true);
		});
	});

	describe('function stability', () => {
		it('should return stable clearSendTimeout reference', () => {
			const { result, rerender } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(),
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			const firstClearSendTimeout = result.current.clearSendTimeout;

			rerender();

			expect(result.current.clearSendTimeout).toBe(firstClearSendTimeout);
		});
	});

	describe('null session handling', () => {
		it('should handle null session - allow non-archived check to pass', async () => {
			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: null,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			// Null session doesn't have status 'archived', so it should proceed
			expect(onSendStart).toHaveBeenCalled();
		});
	});

	describe('sessionId changes', () => {
		it('should update sendMessage when sessionId changes', () => {
			const { result, rerender } = renderHook(
				({ sessionId }) =>
					useSendMessage({
						sessionId,
						session: defaultSession,
						isSending: false,
						onSendStart: vi.fn(),
						onSendComplete: vi.fn(),
						onError: vi.fn(),
					}),
				{ initialProps: { sessionId: 'session-1' } }
			);

			const firstSendMessage = result.current.sendMessage;

			rerender({ sessionId: 'session-2' });

			expect(result.current.sendMessage).not.toBe(firstSendMessage);
		});
	});

	describe('message content handling', () => {
		it('should handle message with leading/trailing whitespace', async () => {
			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('  Hello  ');
			});

			// Message with whitespace around it should still be sent
			expect(onSendStart).toHaveBeenCalled();
			expect(mockCall).toHaveBeenCalled();
		});

		it('should handle message with newlines only', async () => {
			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('\n\n\n');
			});

			expect(onSendStart).not.toHaveBeenCalled();
		});

		it('should handle message with tabs only', async () => {
			const onSendStart = vi.fn();

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(),
					onError: vi.fn(),
				})
			);

			await act(async () => {
				await result.current.sendMessage('\t\t\t');
			});

			expect(onSendStart).not.toHaveBeenCalled();
		});
	});
});
