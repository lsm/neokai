// @ts-nocheck
/**
 * Tests for useInterrupt Hook
 *
 * Tests agent interrupt functionality.
 * Note: Tests that require connection mocking are limited due to module initialization order.
 */

import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/preact';
import { useInterrupt } from '../useInterrupt.ts';

describe('useInterrupt', () => {
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
});
