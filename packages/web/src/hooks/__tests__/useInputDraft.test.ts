// @ts-nocheck
/**
 * Tests for useInputDraft Hook
 *
 * Tests draft persistence, debounced saving, and content management.
 * Uses Preact Signals internally to prevent lost keystrokes.
 * Note: Tests that require connection mocking are limited due to module initialization order.
 */

import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useInputDraft } from '../useInputDraft.ts';
import { connectionManager } from '../../lib/connection-manager.ts';

// Mock the connection manager
vi.mock('../../lib/connection-manager.ts', () => ({
	connectionManager: {
		getHubIfConnected: vi.fn(),
	},
}));

describe('useInputDraft', () => {
	const mockHub = {
		call: vi.fn(),
	};

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		// Default: no hub connected
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('initialization', () => {
		it('should initialize with empty content', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			expect(result.current.content).toBe('');
		});

		it('should provide setContent function', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			expect(typeof result.current.setContent).toBe('function');
		});

		it('should provide clear function', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			expect(typeof result.current.clear).toBe('function');
		});
	});

	describe('setContent', () => {
		it('should update content synchronously', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			act(() => {
				result.current.setContent('Hello world');
			});

			expect(result.current.content).toBe('Hello world');
		});

		it('should handle multiple rapid updates', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			act(() => {
				result.current.setContent('H');
				result.current.setContent('He');
				result.current.setContent('Hel');
				result.current.setContent('Hell');
				result.current.setContent('Hello');
			});

			expect(result.current.content).toBe('Hello');
		});

		it('should handle special characters', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			act(() => {
				result.current.setContent('Hello <world> & "friends"');
			});

			expect(result.current.content).toBe('Hello <world> & "friends"');
		});

		it('should handle multiline content', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			act(() => {
				result.current.setContent('Line 1\nLine 2\nLine 3');
			});

			expect(result.current.content).toBe('Line 1\nLine 2\nLine 3');
		});
	});

	describe('clear', () => {
		it('should clear content', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			act(() => {
				result.current.setContent('Some content');
			});

			expect(result.current.content).toBe('Some content');

			act(() => {
				result.current.clear();
			});

			expect(result.current.content).toBe('');
		});

		it('should work when content is already empty', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			// Should not throw
			act(() => {
				result.current.clear();
			});

			expect(result.current.content).toBe('');
		});
	});

	describe('session switching', () => {
		it('should clear content when switching sessions', () => {
			const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
				initialProps: { sessionId: 'session-1' },
			});

			act(() => {
				result.current.setContent('Content for session 1');
			});

			expect(result.current.content).toBe('Content for session 1');

			// Switch session
			rerender({ sessionId: 'session-2' });

			// Content should be cleared immediately
			expect(result.current.content).toBe('');
		});

		it('should handle empty sessionId', () => {
			const { result } = renderHook(() => useInputDraft(''));

			expect(result.current.content).toBe('');
		});

		it('should handle rapid session switches', () => {
			const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
				initialProps: { sessionId: 'session-1' },
			});

			// Rapid switches
			rerender({ sessionId: 'session-2' });
			rerender({ sessionId: 'session-3' });
			rerender({ sessionId: 'session-4' });

			// Content should be empty after rapid switches
			expect(result.current.content).toBe('');
		});
	});

	describe('function stability', () => {
		it('should return stable setContent reference', () => {
			const { result, rerender } = renderHook(() => useInputDraft('session-1'));

			const firstSetContent = result.current.setContent;

			rerender();

			expect(result.current.setContent).toBe(firstSetContent);
		});

		it('should return stable clear reference', () => {
			const { result, rerender } = renderHook(() => useInputDraft('session-1'));

			const firstClear = result.current.clear;

			rerender();

			expect(result.current.clear).toBe(firstClear);
		});
	});

	describe('custom debounce delay', () => {
		it('should accept custom debounce delay parameter', () => {
			// Should not throw
			const { result } = renderHook(() => useInputDraft('session-1', 500));

			expect(result.current.content).toBe('');
		});
	});

	describe('content getter behavior', () => {
		it('should return current content value', () => {
			const { result } = renderHook(() => useInputDraft('session-1'));

			act(() => {
				result.current.setContent('Test');
			});

			// Accessing content multiple times should return same value
			expect(result.current.content).toBe('Test');
			expect(result.current.content).toBe('Test');
		});
	});

	describe('draft loading', () => {
		it('should load draft from session when hub is connected', async () => {
			mockHub.call.mockResolvedValue({
				session: { metadata: { inputDraft: 'Saved draft' } },
			});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1'));

			// Wait for async draft loading
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(mockHub.call).toHaveBeenCalledWith('session.get', { sessionId: 'session-1' });
			expect(result.current.content).toBe('Saved draft');
		});

		it('should not load draft when hub is not connected', async () => {
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);

			const { result } = renderHook(() => useInputDraft('session-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(mockHub.call).not.toHaveBeenCalled();
			expect(result.current.content).toBe('');
		});

		it('should handle load error gracefully', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockHub.call.mockRejectedValue(new Error('Network error'));
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(consoleSpy).toHaveBeenCalledWith('Failed to load draft:', expect.any(Error));
			expect(result.current.content).toBe('');
			consoleSpy.mockRestore();
		});

		it('should handle session with no draft metadata', async () => {
			mockHub.call.mockResolvedValue({
				session: { metadata: {} },
			});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('');
		});

		it('should handle session with null metadata', async () => {
			mockHub.call.mockResolvedValue({
				session: {},
			});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('');
		});
	});

	describe('debounced saving', () => {
		it('should save draft after debounce delay', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1', 100));

			// Wait for initial effects to run
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Clear mock calls from initialization
			mockHub.call.mockClear();

			act(() => {
				result.current.setContent('New content');
			});

			// Should not save immediately (need to check specifically for this content)
			const callsBeforeDebounce = mockHub.call.mock.calls.filter(
				(call) => call[0] === 'session.update' && call[1]?.metadata?.inputDraft === 'New content'
			);
			expect(callsBeforeDebounce.length).toBe(0);

			// Advance timer past debounce delay
			await act(async () => {
				await vi.advanceTimersByTimeAsync(150);
			});

			expect(mockHub.call).toHaveBeenCalledWith('session.update', {
				sessionId: 'session-1',
				metadata: { inputDraft: 'New content' },
			});
		});

		it('should clear draft immediately when content is empty', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1'));

			act(() => {
				result.current.setContent('Some content');
			});

			// Clear content
			act(() => {
				result.current.setContent('');
			});

			// Should save immediately with undefined (no debounce for clearing)
			expect(mockHub.call).toHaveBeenCalledWith('session.update', {
				sessionId: 'session-1',
				metadata: { inputDraft: undefined },
			});
		});

		it('should handle save error gracefully', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockHub.call.mockRejectedValue(new Error('Save error'));
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1', 100));

			act(() => {
				result.current.setContent('Content');
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(150);
			});

			expect(consoleSpy).toHaveBeenCalledWith('Failed to save draft:', expect.any(Error));
			consoleSpy.mockRestore();
		});

		it('should cancel pending save when new content is set', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1', 100));

			act(() => {
				result.current.setContent('First');
			});

			// Advance partially
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			act(() => {
				result.current.setContent('Second');
			});

			// Advance past original debounce
			await act(async () => {
				await vi.advanceTimersByTimeAsync(150);
			});

			// Should only have saved 'Second'
			expect(mockHub.call).toHaveBeenCalledWith('session.update', {
				sessionId: 'session-1',
				metadata: { inputDraft: 'Second' },
			});
		});

		it('should trim content before saving', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1', 100));

			act(() => {
				result.current.setContent('  Content with spaces  ');
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(150);
			});

			expect(mockHub.call).toHaveBeenCalledWith('session.update', {
				sessionId: 'session-1',
				metadata: { inputDraft: 'Content with spaces' },
			});
		});

		it('should clear draft when content is only whitespace', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1'));

			act(() => {
				result.current.setContent('   ');
			});

			// Should clear immediately
			expect(mockHub.call).toHaveBeenCalledWith('session.update', {
				sessionId: 'session-1',
				metadata: { inputDraft: undefined },
			});
		});

		it('should handle clear error gracefully', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockHub.call.mockRejectedValue(new Error('Clear error'));
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInputDraft('session-1'));

			act(() => {
				result.current.setContent('');
			});

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(consoleSpy).toHaveBeenCalledWith('Failed to clear draft:', expect.any(Error));
			consoleSpy.mockRestore();
		});
	});

	describe('session switch behavior', () => {
		it('should call session.update when switching sessions', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId, 100), {
				initialProps: { sessionId: 'session-1' },
			});

			// Wait for initial effects to run
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				result.current.setContent('Content for session 1');
			});

			// Switch session
			rerender({ sessionId: 'session-2' });

			// Should have made session.update calls (flush and/or clear)
			const updateCalls = mockHub.call.mock.calls.filter((call) => call[0] === 'session.update');
			expect(updateCalls.length).toBeGreaterThan(0);
		});

		it('should handle flush error gracefully', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockHub.call.mockRejectedValue(new Error('Error'));
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
				initialProps: { sessionId: 'session-1' },
			});

			rerender({ sessionId: 'session-2' });

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Should have logged an error (could be flush or clear or load error)
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('should not call hub when not connected', async () => {
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);

			const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
				initialProps: { sessionId: 'session-1' },
			});

			act(() => {
				result.current.setContent('Content');
			});

			rerender({ sessionId: 'session-2' });

			expect(mockHub.call).not.toHaveBeenCalled();
		});

		it('should clear content when session changes', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result, rerender } = renderHook(({ sessionId }) => useInputDraft(sessionId), {
				initialProps: { sessionId: 'session-1' },
			});

			// Wait for initial effects to run
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				result.current.setContent('Content');
			});

			expect(result.current.content).toBe('Content');

			rerender({ sessionId: 'session-2' });

			// Content should be cleared on session switch
			expect(result.current.content).toBe('');
		});
	});

	describe('cleanup', () => {
		it('should cleanup timeouts on unmount', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result, unmount } = renderHook(() => useInputDraft('session-1', 100));

			act(() => {
				result.current.setContent('Content');
			});

			// Unmount before debounce fires
			unmount();

			// Advance timers - should not throw or save
			await act(async () => {
				await vi.advanceTimersByTimeAsync(150);
			});

			// Should not have saved (was unmounted)
			expect(mockHub.call).not.toHaveBeenCalledWith('session.update', {
				sessionId: 'session-1',
				metadata: { inputDraft: 'Content' },
			});
		});
	});
});
