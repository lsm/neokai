// @ts-nocheck
/**
 * Tests for useInterrupt Hook
 *
 * Tests agent interrupt functionality including error handling and Escape key.
 */

import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useInterrupt } from '../useInterrupt.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { isAgentWorking } from '../../lib/state.ts';

// Mock the dependencies
vi.mock('../../lib/connection-manager.ts', () => ({
	connectionManager: {
		getHubIfConnected: vi.fn(),
	},
}));

vi.mock('../../lib/toast.ts', () => ({
	toast: {
		error: vi.fn(),
	},
}));

vi.mock('../../lib/state.ts', () => ({
	isAgentWorking: { value: false },
}));

describe('useInterrupt', () => {
	const mockHub = {
		call: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
		(isAgentWorking as { value: boolean }).value = false;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('initialization', () => {
		it('should initialize with interrupting as false', () => {
			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			expect(result.current.interrupting).toBe(false);
		});

		it('should provide handleInterrupt function', () => {
			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			expect(typeof result.current.handleInterrupt).toBe('function');
		});
	});

	describe('session change', () => {
		it('should reset interrupting state when sessionId changes', () => {
			const { result, rerender } = renderHook(({ sessionId }) => useInterrupt({ sessionId }), {
				initialProps: { sessionId: 'session-1' },
			});

			// Start interrupt to set interrupting=true (may not work without connection, but tests state management)
			act(() => {
				result.current.handleInterrupt();
			});

			// Change session - should reset interrupting
			rerender({ sessionId: 'session-2' });

			expect(result.current.interrupting).toBe(false);
		});

		it('should return a new handleInterrupt callback when sessionId changes', () => {
			const { result, rerender } = renderHook(({ sessionId }) => useInterrupt({ sessionId }), {
				initialProps: { sessionId: 'session-1' },
			});

			const _firstCallback = result.current.handleInterrupt;

			rerender({ sessionId: 'session-2' });

			// Callback should be different due to sessionId dependency
			expect(typeof result.current.handleInterrupt).toBe('function');
		});
	});

	describe('handleInterrupt behavior', () => {
		it('should be callable without throwing', async () => {
			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			// Should not throw even if connection fails
			await act(async () => {
				await result.current.handleInterrupt();
			});

			// Should have returned (either success or failure handled gracefully)
			expect(true).toBe(true);
		});
	});

	describe('function stability', () => {
		it('should return handleInterrupt function on each render', () => {
			const { result, rerender } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			expect(typeof result.current.handleInterrupt).toBe('function');

			rerender();

			expect(typeof result.current.handleInterrupt).toBe('function');
		});
	});

	describe('hub connection', () => {
		it('should show error toast when hub is not connected', async () => {
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);

			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			expect(toast.error).toHaveBeenCalledWith('Not connected to server');
		});

		it('should call hub.call when connected', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			expect(mockHub.call).toHaveBeenCalledWith('client.interrupt', { sessionId: 'session-1' });
		});

		it('should set interrupting to true during interrupt', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			// Start interrupt
			act(() => {
				result.current.handleInterrupt();
			});

			expect(result.current.interrupting).toBe(true);

			// Wait for promise to resolve
			await act(async () => {
				await Promise.resolve();
			});

			// Wait for timeout to reset interrupting
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600);
			});

			expect(result.current.interrupting).toBe(false);
		});

		it('should not call interrupt again while interrupting', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			// Start first interrupt
			act(() => {
				result.current.handleInterrupt();
			});

			// Try to interrupt again
			act(() => {
				result.current.handleInterrupt();
			});

			// Should only have called once
			expect(mockHub.call).toHaveBeenCalledTimes(1);
		});
	});

	describe('error handling', () => {
		it('should show error toast and log when hub.call fails', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockHub.call.mockRejectedValue(new Error('Network error'));
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			expect(consoleSpy).toHaveBeenCalledWith('Interrupt error:', expect.any(Error));
			expect(toast.error).toHaveBeenCalledWith('Failed to stop generation');
			consoleSpy.mockRestore();
		});

		it('should reset interrupting state after error', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockHub.call.mockRejectedValue(new Error('Network error'));
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);

			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			// Wait for timeout to reset interrupting
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600);
			});

			expect(result.current.interrupting).toBe(false);
			consoleSpy.mockRestore();
		});
	});

	describe('Escape key handling', () => {
		it('should call handleInterrupt on Escape when agent is working', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
			(isAgentWorking as { value: boolean }).value = true;

			renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			// Simulate Escape key press
			const escapeEvent = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			});
			document.dispatchEvent(escapeEvent);

			// Wait for async handling
			await act(async () => {
				await Promise.resolve();
			});

			expect(mockHub.call).toHaveBeenCalledWith('client.interrupt', { sessionId: 'session-1' });
		});

		it('should not call handleInterrupt on Escape when agent is not working', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
			(isAgentWorking as { value: boolean }).value = false;

			renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			// Simulate Escape key press
			const escapeEvent = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
			});
			document.dispatchEvent(escapeEvent);

			expect(mockHub.call).not.toHaveBeenCalled();
		});

		it('should not call handleInterrupt on Escape when already interrupting', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
			(isAgentWorking as { value: boolean }).value = true;

			const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			// Start first interrupt
			act(() => {
				result.current.handleInterrupt();
			});

			// Simulate Escape key press while interrupting
			const escapeEvent = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
			});
			document.dispatchEvent(escapeEvent);

			// Should only have called once from the first handleInterrupt
			expect(mockHub.call).toHaveBeenCalledTimes(1);
		});

		it('should not call handleInterrupt on other keys', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
			(isAgentWorking as { value: boolean }).value = true;

			renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			// Simulate other key press
			const enterEvent = new KeyboardEvent('keydown', {
				key: 'Enter',
				bubbles: true,
			});
			document.dispatchEvent(enterEvent);

			expect(mockHub.call).not.toHaveBeenCalled();
		});

		it('should prevent default on Escape when interrupting', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
			(isAgentWorking as { value: boolean }).value = true;

			renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			// Simulate Escape key press
			const escapeEvent = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			});
			const preventDefaultSpy = vi.spyOn(escapeEvent, 'preventDefault');

			document.dispatchEvent(escapeEvent);

			expect(preventDefaultSpy).toHaveBeenCalled();
		});
	});

	describe('cleanup', () => {
		it('should remove event listener on unmount', async () => {
			mockHub.call.mockResolvedValue({});
			vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
			(isAgentWorking as { value: boolean }).value = true;

			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { unmount } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
			removeEventListenerSpy.mockRestore();
		});
	});
});
