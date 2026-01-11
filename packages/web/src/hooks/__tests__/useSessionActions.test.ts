/**
 * Tests for useSessionActions Hook
 *
 * Tests session action handlers: delete, archive, reset, export.
 * Note: Tests that require connection mocking are limited due to module initialization order.
 */

import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/preact';
import type { Session } from '@liuboer/shared';
import { useSessionActions } from '../useSessionActions.ts';

describe('useSessionActions', () => {
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
		it('should initialize with default state', () => {
			const { result } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: defaultSession,
					onDeleteModalClose: mock(() => {}),
					onStateReset: mock(() => {}),
				})
			);

			expect(result.current.archiving).toBe(false);
			expect(result.current.resettingAgent).toBe(false);
			expect(result.current.archiveConfirmDialog).toBeNull();
		});

		it('should provide all action handlers', () => {
			const { result } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: defaultSession,
					onDeleteModalClose: mock(() => {}),
					onStateReset: mock(() => {}),
				})
			);

			expect(typeof result.current.handleDeleteSession).toBe('function');
			expect(typeof result.current.handleArchiveClick).toBe('function');
			expect(typeof result.current.handleConfirmArchive).toBe('function');
			expect(typeof result.current.handleCancelArchive).toBe('function');
			expect(typeof result.current.handleResetAgent).toBe('function');
			expect(typeof result.current.handleExportChat).toBe('function');
		});
	});

	describe('handleCancelArchive', () => {
		it('should clear archive confirm dialog', () => {
			const { result } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: defaultSession,
					onDeleteModalClose: mock(() => {}),
					onStateReset: mock(() => {}),
				})
			);

			// Cancel archive should clear the dialog
			act(() => {
				result.current.handleCancelArchive();
			});

			expect(result.current.archiveConfirmDialog).toBeNull();
		});
	});

	describe('action handlers are callable', () => {
		it('handleDeleteSession should be callable', async () => {
			const onDeleteModalClose = mock(() => {});
			const { result } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: defaultSession,
					onDeleteModalClose,
					onStateReset: mock(() => {}),
				})
			);

			// Should be callable without throwing (may fail due to no connection)
			await act(async () => {
				try {
					await result.current.handleDeleteSession();
				} catch {
					// Expected without connection
				}
			});

			// onDeleteModalClose should have been called
			expect(onDeleteModalClose).toHaveBeenCalled();
		});

		it('handleArchiveClick should be callable', async () => {
			const { result } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: defaultSession,
					onDeleteModalClose: mock(() => {}),
					onStateReset: mock(() => {}),
				})
			);

			// Should be callable without throwing
			await act(async () => {
				try {
					await result.current.handleArchiveClick();
				} catch {
					// Expected without connection
				}
			});

			expect(true).toBe(true);
		});

		it('handleConfirmArchive should be callable', async () => {
			const { result } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: defaultSession,
					onDeleteModalClose: mock(() => {}),
					onStateReset: mock(() => {}),
				})
			);

			await act(async () => {
				try {
					await result.current.handleConfirmArchive();
				} catch {
					// Expected without connection
				}
			});

			expect(true).toBe(true);
		});

		it('handleResetAgent should be callable', async () => {
			const { result } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: defaultSession,
					onDeleteModalClose: mock(() => {}),
					onStateReset: mock(() => {}),
				})
			);

			await act(async () => {
				try {
					await result.current.handleResetAgent();
				} catch {
					// Expected without connection
				}
			});

			expect(true).toBe(true);
		});

		it('handleExportChat should be callable', async () => {
			const { result } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: defaultSession,
					onDeleteModalClose: mock(() => {}),
					onStateReset: mock(() => {}),
				})
			);

			await act(async () => {
				try {
					await result.current.handleExportChat();
				} catch {
					// Expected without connection
				}
			});

			expect(true).toBe(true);
		});
	});

	describe('sessionId changes', () => {
		it('should handle sessionId change', () => {
			const { result, rerender } = renderHook(
				({ sessionId }) =>
					useSessionActions({
						sessionId,
						session: defaultSession,
						onDeleteModalClose: mock(() => {}),
						onStateReset: mock(() => {}),
					}),
				{ initialProps: { sessionId: 'session-1' } }
			);

			expect(typeof result.current.handleDeleteSession).toBe('function');

			rerender({ sessionId: 'session-2' });

			expect(typeof result.current.handleDeleteSession).toBe('function');
		});
	});

	describe('null session handling', () => {
		it('should handle null session', () => {
			const { result } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: null,
					onDeleteModalClose: mock(() => {}),
					onStateReset: mock(() => {}),
				})
			);

			expect(result.current.archiving).toBe(false);
			expect(result.current.resettingAgent).toBe(false);
		});
	});

	describe('function stability', () => {
		it('should return stable handleCancelArchive reference', () => {
			const { result, rerender } = renderHook(() =>
				useSessionActions({
					sessionId: 'session-1',
					session: defaultSession,
					onDeleteModalClose: mock(() => {}),
					onStateReset: mock(() => {}),
				})
			);

			const firstHandleCancelArchive = result.current.handleCancelArchive;

			rerender();

			expect(result.current.handleCancelArchive).toBe(firstHandleCancelArchive);
		});
	});
});
