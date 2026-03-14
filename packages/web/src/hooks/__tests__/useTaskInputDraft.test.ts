// @ts-nocheck
/**
 * Tests for useTaskInputDraft Hook
 *
 * Tests draft persistence via server-side RPC (task.get / task.updateDraft),
 * debounced saving, task switching, draft restoration, and content management.
 */

import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTaskInputDraft } from '../useTaskInputDraft.ts';
import { connectionManager } from '../../lib/connection-manager.ts';

// Mock the connection manager
vi.mock('../../lib/connection-manager.ts', () => ({
	connectionManager: {
		getHubIfConnected: vi.fn(),
	},
}));

describe('useTaskInputDraft', () => {
	const mockHub = {
		request: vi.fn().mockResolvedValue({ task: {} }),
		event: vi.fn(),
		onRequest: vi.fn().mockReturnValue(() => {}),
		onEvent: vi.fn().mockReturnValue(() => {}),
		joinRoom: vi.fn(),
		leaveRoom: vi.fn(),
		isConnected: vi.fn().mockReturnValue(true),
		onConnection: vi.fn().mockReturnValue(() => {}),
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

	// ── Initialization ────────────────────────────────────────────────────────

	describe('initialization', () => {
		it('should initialize with empty content', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			expect(result.current.content).toBe('');
		});

		it('should provide setContent function', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			expect(typeof result.current.setContent).toBe('function');
		});

		it('should provide clear function', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			expect(typeof result.current.clear).toBe('function');
		});

		it('should initialize draftRestored as false when no draft exists', async () => {
			mockHub.request.mockResolvedValue({ task: {} });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.draftRestored).toBe(false);
		});

		it('should restore existing draft on mount when hub is connected', async () => {
			mockHub.request.mockResolvedValue({ task: { inputDraft: 'Saved draft' } });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(mockHub.request).toHaveBeenCalledWith('task.get', {
				roomId: 'room-1',
				taskId: 'task-1',
			});
			expect(result.current.content).toBe('Saved draft');
			expect(result.current.draftRestored).toBe(true);
		});

		it('should not restore draft when hub is not connected', async () => {
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('');
			expect(result.current.draftRestored).toBe(false);
		});

		it('should handle load error gracefully', async () => {
			mockHub.request.mockRejectedValue(new Error('Network error'));
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('');
			expect(result.current.draftRestored).toBe(false);
		});

		it('should handle task with null inputDraft', async () => {
			mockHub.request.mockResolvedValue({ task: { inputDraft: null } });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('');
			expect(result.current.draftRestored).toBe(false);
		});

		it('should handle empty roomId or taskId', () => {
			const { result } = renderHook(() => useTaskInputDraft('', ''));

			expect(result.current.content).toBe('');
			expect(result.current.draftRestored).toBe(false);
		});
	});

	// ── setContent ────────────────────────────────────────────────────────────

	describe('setContent', () => {
		it('should update content synchronously', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			act(() => {
				result.current.setContent('Hello world');
			});

			expect(result.current.content).toBe('Hello world');
		});

		it('should handle multiple rapid updates', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			act(() => {
				result.current.setContent('H');
				result.current.setContent('He');
				result.current.setContent('Hel');
				result.current.setContent('Hell');
				result.current.setContent('Hello');
			});

			expect(result.current.content).toBe('Hello');
		});

		it('should handle special characters and emoji', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			act(() => {
				result.current.setContent('Hello <world> & "friends" 🎉');
			});

			expect(result.current.content).toBe('Hello <world> & "friends" 🎉');
		});

		it('should handle multiline content', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			act(() => {
				result.current.setContent('Line 1\nLine 2\nLine 3');
			});

			expect(result.current.content).toBe('Line 1\nLine 2\nLine 3');
		});

		it('should dismiss draftRestored when content is updated', async () => {
			mockHub.request.mockResolvedValue({ task: { inputDraft: 'Saved draft' } });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.draftRestored).toBe(true);

			act(() => {
				result.current.setContent('New content');
			});

			expect(result.current.draftRestored).toBe(false);
		});
	});

	// ── Auto-save via task.updateDraft ────────────────────────────────────────

	describe('auto-save to server', () => {
		it('should save draft after debounce delay', async () => {
			mockHub.request.mockResolvedValue({ task: {}, success: true });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 500));

			// Wait for initial effects to flush
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			mockHub.request.mockClear();

			act(() => {
				result.current.setContent('Draft message');
			});

			// Advance partially — should not have saved yet
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			const earlyUpdateCalls = mockHub.request.mock.calls.filter(
				(call) => call[0] === 'task.updateDraft' && call[1]?.draft === 'Draft message'
			);
			expect(earlyUpdateCalls.length).toBe(0);

			// Advance past debounce
			await act(async () => {
				await vi.advanceTimersByTimeAsync(400);
			});

			expect(mockHub.request).toHaveBeenCalledWith('task.updateDraft', {
				roomId: 'room-1',
				taskId: 'task-1',
				draft: 'Draft message',
			});
		});

		it('should debounce rapid typing — only save after last keystroke', async () => {
			mockHub.request.mockResolvedValue({ task: {}, success: true });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 500));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			mockHub.request.mockClear();

			act(() => {
				result.current.setContent('H');
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});
			act(() => {
				result.current.setContent('He');
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});
			act(() => {
				result.current.setContent('Hello');
			});

			// Not yet saved
			const earlyUpdateCalls = mockHub.request.mock.calls.filter(
				(call) => call[0] === 'task.updateDraft' && call[1]?.draft
			);
			expect(earlyUpdateCalls.length).toBe(0);

			// Advance past final debounce
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600);
			});

			const updateCalls = mockHub.request.mock.calls.filter(
				(call) => call[0] === 'task.updateDraft' && call[1]?.draft
			);
			expect(updateCalls).toHaveLength(1);
			expect(updateCalls[0][1].draft).toBe('Hello');
		});

		it('should clear draft immediately when content is emptied', async () => {
			mockHub.request.mockResolvedValue({ task: {}, success: true });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 500));

			await act(async () => {
				await vi.runAllTimersAsync();
			});
			mockHub.request.mockClear();

			act(() => {
				result.current.setContent('Some content');
			});

			// Now clear it — should call updateDraft immediately with null
			act(() => {
				result.current.setContent('');
			});

			expect(mockHub.request).toHaveBeenCalledWith('task.updateDraft', {
				roomId: 'room-1',
				taskId: 'task-1',
				draft: null,
			});
		});

		it('should not save whitespace-only content', async () => {
			mockHub.request.mockResolvedValue({ task: {}, success: true });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 500));

			await act(async () => {
				await vi.runAllTimersAsync();
			});
			mockHub.request.mockClear();

			act(() => {
				result.current.setContent('   ');
			});

			// Whitespace-only is treated as empty — immediate clear with null
			expect(mockHub.request).toHaveBeenCalledWith('task.updateDraft', {
				roomId: 'room-1',
				taskId: 'task-1',
				draft: null,
			});
		});

		it('should trim content before saving', async () => {
			mockHub.request.mockResolvedValue({ task: {}, success: true });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 100));

			await act(async () => {
				await vi.runAllTimersAsync();
			});
			mockHub.request.mockClear();

			act(() => {
				result.current.setContent('  Content with spaces  ');
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			expect(mockHub.request).toHaveBeenCalledWith('task.updateDraft', {
				roomId: 'room-1',
				taskId: 'task-1',
				draft: 'Content with spaces',
			});
		});

		it('should handle save error gracefully', async () => {
			mockHub.request.mockRejectedValue(new Error('Save error'));
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 100));

			act(() => {
				result.current.setContent('Content');
			});

			// Should not throw
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});
		});

		it('should not call hub when not connected', async () => {
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 100));

			act(() => {
				result.current.setContent('Content');
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			expect(mockHub.request).not.toHaveBeenCalled();
		});
	});

	// ── clear ─────────────────────────────────────────────────────────────────

	describe('clear', () => {
		it('should clear content', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			act(() => {
				result.current.setContent('Some content');
			});
			expect(result.current.content).toBe('Some content');

			act(() => {
				result.current.clear();
			});

			expect(result.current.content).toBe('');
		});

		it('should call task.updateDraft with null when hub is connected', () => {
			mockHub.request.mockResolvedValue({ success: true });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			act(() => {
				result.current.setContent('Some content');
			});
			mockHub.request.mockClear();

			act(() => {
				result.current.clear();
			});

			expect(mockHub.request).toHaveBeenCalledWith('task.updateDraft', {
				roomId: 'room-1',
				taskId: 'task-1',
				draft: null,
			});
		});

		it('should reset draftRestored flag', async () => {
			mockHub.request.mockResolvedValue({ task: { inputDraft: 'Saved draft' } });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.draftRestored).toBe(true);

			act(() => {
				result.current.clear();
			});

			expect(result.current.draftRestored).toBe(false);
		});

		it('should work when content is already empty', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			// Should not throw
			act(() => {
				result.current.clear();
			});

			expect(result.current.content).toBe('');
		});
	});

	// ── Task switching ────────────────────────────────────────────────────────

	describe('task switching', () => {
		it('should clear content immediately when switching tasks', () => {
			const { result, rerender } = renderHook(
				({ roomId, taskId }) => useTaskInputDraft(roomId, taskId),
				{ initialProps: { roomId: 'room-1', taskId: 'task-1' } }
			);

			act(() => {
				result.current.setContent('Content for task 1');
			});
			expect(result.current.content).toBe('Content for task 1');

			rerender({ roomId: 'room-1', taskId: 'task-2' });

			expect(result.current.content).toBe('');
		});

		it('should load draft for switched-to task when hub is connected', async () => {
			mockHub.request.mockImplementation((method, params) => {
				if (method === 'task.get' && params?.taskId === 'task-2') {
					return Promise.resolve({ task: { inputDraft: 'Task 2 draft' } });
				}
				return Promise.resolve({ task: {}, success: true });
			});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result, rerender } = renderHook(
				({ roomId, taskId }) => useTaskInputDraft(roomId, taskId),
				{ initialProps: { roomId: 'room-1', taskId: 'task-1' } }
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			rerender({ roomId: 'room-1', taskId: 'task-2' });

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('Task 2 draft');
			expect(result.current.draftRestored).toBe(true);
		});

		it('should handle empty taskId', () => {
			const { result } = renderHook(() => useTaskInputDraft('room-1', ''));

			expect(result.current.content).toBe('');
			expect(result.current.draftRestored).toBe(false);
		});

		it('should handle rapid task switches', () => {
			const { result, rerender } = renderHook(
				({ roomId, taskId }) => useTaskInputDraft(roomId, taskId),
				{ initialProps: { roomId: 'room-1', taskId: 'task-1' } }
			);

			rerender({ roomId: 'room-1', taskId: 'task-2' });
			rerender({ roomId: 'room-1', taskId: 'task-3' });
			rerender({ roomId: 'room-1', taskId: 'task-4' });

			expect(result.current.content).toBe('');
		});
	});

	// ── Flush on unmount ─────────────────────────────────────────────────────

	describe('flush on unmount', () => {
		it('should flush pending debounced save on unmount', async () => {
			mockHub.request.mockResolvedValue({ task: {}, success: true });
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result, unmount } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 500));

			await act(async () => {
				await vi.runAllTimersAsync();
			});
			mockHub.request.mockClear();

			act(() => {
				result.current.setContent('Unsaved content');
			});

			// Unmount before debounce fires
			unmount();

			expect(mockHub.request).toHaveBeenCalledWith('task.updateDraft', {
				roomId: 'room-1',
				taskId: 'task-1',
				draft: 'Unsaved content',
			});
		});

		it('should not flush on unmount when content is empty', async () => {
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);

			const { unmount } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 500));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			unmount();

			expect(mockHub.request).not.toHaveBeenCalledWith('task.updateDraft', expect.anything());
		});

		it('should handle flush error gracefully', async () => {
			mockHub.request.mockRejectedValue(new Error('Flush error'));
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result, unmount } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 500));

			act(() => {
				result.current.setContent('Content to flush');
			});

			// Should not throw when unmounted
			unmount();
		});
	});

	// ── Function stability ────────────────────────────────────────────────────

	describe('function stability', () => {
		it('should return stable setContent reference across rerenders', () => {
			const { result, rerender } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			const firstSetContent = result.current.setContent;
			rerender();
			expect(result.current.setContent).toBe(firstSetContent);
		});

		it('should return stable clear reference across rerenders', () => {
			const { result, rerender } = renderHook(() => useTaskInputDraft('room-1', 'task-1'));

			const firstClear = result.current.clear;
			rerender();
			expect(result.current.clear).toBe(firstClear);
		});

		it('should return stable clear reference across task switches', () => {
			const { result, rerender } = renderHook(
				({ roomId, taskId }) => useTaskInputDraft(roomId, taskId),
				{ initialProps: { roomId: 'room-1', taskId: 'task-1' } }
			);

			const firstClear = result.current.clear;
			rerender({ roomId: 'room-1', taskId: 'task-2' });

			// clear uses a taskIdRef internally, so its reference stays stable
			expect(result.current.clear).toBe(firstClear);
		});

		it('should target the current task after task switch when clearing', async () => {
			mockHub.request.mockImplementation((method, params) => {
				if (method === 'task.get' && params?.taskId === 'task-2') {
					return Promise.resolve({ task: { inputDraft: 'Task 2 draft' } });
				}
				return Promise.resolve({ task: {}, success: true });
			});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result, rerender } = renderHook(
				({ roomId, taskId }) => useTaskInputDraft(roomId, taskId),
				{ initialProps: { roomId: 'room-1', taskId: 'task-1' } }
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			rerender({ roomId: 'room-1', taskId: 'task-2' });

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('Task 2 draft');

			// Clear should target task-2 (current task)
			mockHub.request.mockClear();
			act(() => {
				result.current.clear();
			});

			expect(mockHub.request).toHaveBeenCalledWith('task.updateDraft', {
				roomId: 'room-1',
				taskId: 'task-2',
				draft: null,
			});
		});
	});

	// ── Custom debounce delay ─────────────────────────────────────────────────

	describe('custom debounce delay', () => {
		it('should accept custom debounce delay parameter', () => {
			// Should not throw
			const { result } = renderHook(() => useTaskInputDraft('room-1', 'task-1', 250));

			expect(result.current.content).toBe('');
		});
	});
});
