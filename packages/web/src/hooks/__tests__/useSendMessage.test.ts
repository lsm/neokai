// @ts-nocheck
/**
 * Tests for useSendMessage Hook
 *
 * Tests message sending with timeout, validation, and error handling.
 * Note: Tests that require connection mocking are limited due to module initialization order.
 */

import { renderHook, act } from '@testing-library/preact';
import type { Session } from '@liuboer/shared';
import { useSendMessage } from '../useSendMessage.ts';

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

	describe('initialization', () => {
		it('should provide sendMessage function', () => {
			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(() => {}),
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
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
					onSendStart: vi.fn(() => {}),
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
				})
			);

			expect(typeof result.current.clearSendTimeout).toBe('function');
		});
	});

	describe('sendMessage validation', () => {
		it('should not send empty message', async () => {
			const onSendStart = vi.fn(() => {});

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
				})
			);

			await act(async () => {
				await result.current.sendMessage('');
			});

			expect(onSendStart).not.toHaveBeenCalled();
		});

		it('should not send whitespace-only message', async () => {
			const onSendStart = vi.fn(() => {});

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
				})
			);

			await act(async () => {
				await result.current.sendMessage('   ');
			});

			expect(onSendStart).not.toHaveBeenCalled();
		});

		it('should not send if already sending', async () => {
			const onSendStart = vi.fn(() => {});

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: true,
					onSendStart,
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
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

			const onSendStart = vi.fn(() => {});

			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: archivedSession,
					isSending: false,
					onSendStart,
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
				})
			);

			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			// Should not have started sending (toast.error is called instead)
			expect(onSendStart).not.toHaveBeenCalled();
		});
	});

	describe('clearSendTimeout', () => {
		it('should be callable without throwing', () => {
			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: defaultSession,
					isSending: false,
					onSendStart: vi.fn(() => {}),
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
				})
			);

			// Should not throw
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
					onSendStart: vi.fn(() => {}),
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
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
					onSendStart: vi.fn(() => {}),
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
				})
			);

			const firstClearSendTimeout = result.current.clearSendTimeout;

			rerender();

			expect(result.current.clearSendTimeout).toBe(firstClearSendTimeout);
		});
	});

	describe('null session handling', () => {
		it('should handle null session', async () => {
			const { result } = renderHook(() =>
				useSendMessage({
					sessionId: 'session-1',
					session: null,
					isSending: false,
					onSendStart: vi.fn(() => {}),
					onSendComplete: vi.fn(() => {}),
					onError: vi.fn(() => {}),
				})
			);

			// Should not throw
			await act(async () => {
				await result.current.sendMessage('Hello');
			});

			expect(true).toBe(true);
		});
	});

	describe('sessionId changes', () => {
		it('should handle sessionId change', () => {
			const { result, rerender } = renderHook(
				({ sessionId }) =>
					useSendMessage({
						sessionId,
						session: defaultSession,
						isSending: false,
						onSendStart: vi.fn(() => {}),
						onSendComplete: vi.fn(() => {}),
						onError: vi.fn(() => {}),
					}),
				{ initialProps: { sessionId: 'session-1' } }
			);

			expect(typeof result.current.sendMessage).toBe('function');

			rerender({ sessionId: 'session-2' });

			expect(typeof result.current.sendMessage).toBe('function');
		});
	});
});
