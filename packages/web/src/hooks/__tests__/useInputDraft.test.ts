// @ts-nocheck
/**
 * Tests for useInputDraft Hook
 *
 * Tests draft persistence, debounced saving, and content management.
 * Uses Preact Signals internally to prevent lost keystrokes.
 * Note: Tests that require connection mocking are limited due to module initialization order.
 */

import './setup';
import { renderHook, act } from '@testing-library/preact';
import { useInputDraft } from '../useInputDraft.ts';

describe('useInputDraft', () => {
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
});
