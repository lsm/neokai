// @ts-nocheck
/**
 * Tests for useModelSwitcher Hook
 *
 * Tests model information loading and switching for a session.
 * Note: Tests that require connection mocking are limited due to module initialization order.
 */

import './setup';
import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/preact';
import { useModelSwitcher, MODEL_FAMILY_ICONS } from '../useModelSwitcher.ts';

describe('useModelSwitcher', () => {
	describe('initialization', () => {
		it('should initialize with empty model state', () => {
			const { result } = renderHook(() => useModelSwitcher('session-1'));

			// Initial state before loading completes
			expect(result.current.currentModel).toBe('');
			expect(result.current.currentModelInfo).toBeNull();
			expect(result.current.availableModels).toEqual([]);
			expect(result.current.switching).toBe(false);
		});

		it('should provide required functions', () => {
			const { result } = renderHook(() => useModelSwitcher('session-1'));

			expect(typeof result.current.reload).toBe('function');
			expect(typeof result.current.switchModel).toBe('function');
		});

		it('should initialize loading state', () => {
			const { result } = renderHook(() => useModelSwitcher('session-1'));

			expect(typeof result.current.loading).toBe('boolean');
		});
	});

	describe('MODEL_FAMILY_ICONS', () => {
		it('should have icons for all model families', () => {
			expect(MODEL_FAMILY_ICONS.opus).toBeDefined();
			expect(MODEL_FAMILY_ICONS.sonnet).toBeDefined();
			expect(MODEL_FAMILY_ICONS.haiku).toBeDefined();
		});

		it('should have emoji icons', () => {
			expect(typeof MODEL_FAMILY_ICONS.opus).toBe('string');
			expect(typeof MODEL_FAMILY_ICONS.sonnet).toBe('string');
			expect(typeof MODEL_FAMILY_ICONS.haiku).toBe('string');
		});
	});

	describe('sessionId changes', () => {
		it('should handle sessionId change', () => {
			const { result, rerender } = renderHook(({ sessionId }) => useModelSwitcher(sessionId), {
				initialProps: { sessionId: 'session-1' },
			});

			expect(typeof result.current.switchModel).toBe('function');

			rerender({ sessionId: 'session-2' });

			// Should still have a valid state after session change
			expect(typeof result.current.switchModel).toBe('function');
		});
	});

	describe('switchModel behavior', () => {
		it('should be callable without throwing', async () => {
			const { result } = renderHook(() => useModelSwitcher('session-1'));

			// Should not throw even if connection fails
			await act(async () => {
				await result.current.switchModel('claude-opus-4-5');
			});

			// Should have returned (either success or failure handled gracefully)
			expect(true).toBe(true);
		});
	});

	describe('reload behavior', () => {
		it('should be callable without throwing', async () => {
			const { result } = renderHook(() => useModelSwitcher('session-1'));

			// Should not throw even if connection fails
			await act(async () => {
				await result.current.reload();
			});

			// Should have returned (either success or failure handled gracefully)
			expect(true).toBe(true);
		});
	});

	describe('function stability', () => {
		it('should return reload function on each render', () => {
			const { result, rerender } = renderHook(() => useModelSwitcher('session-1'));

			const firstReload = result.current.reload;

			rerender();

			// reload should be stable (useCallback with sessionId dependency)
			expect(result.current.reload).toBe(firstReload);
		});
	});
});
