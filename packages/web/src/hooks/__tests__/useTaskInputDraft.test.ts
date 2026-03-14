// @ts-nocheck
/**
 * Tests for useTaskInputDraft Hook
 *
 * Tests draft persistence via localStorage, debounced saving, task switching,
 * draft restoration, stale draft cleanup, and content management.
 *
 * NOTE: The global vitest setup mocks localStorage with a no-op implementation.
 * These tests override that with a real in-memory implementation so
 * localStorage reads/writes actually work.
 */

import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTaskInputDraft } from '../useTaskInputDraft.ts';

/**
 * Create a real in-memory localStorage that supports Object.keys() enumeration.
 * The global mock from vitest.setup.ts doesn't actually store values.
 */
function createRealLocalStorage(): Storage {
	const store: Record<string, string> = {};

	return new Proxy(
		{
			getItem: (key: string) => store[key] ?? null,
			setItem: (key: string, value: string) => {
				store[key] = String(value);
			},
			removeItem: (key: string) => {
				delete store[key];
			},
			clear: () => {
				for (const k of Object.keys(store)) {
					delete store[k];
				}
			},
			get length() {
				return Object.keys(store).length;
			},
			key: (index: number) => Object.keys(store)[index] ?? null,
		},
		{
			// Make Object.keys(localStorage) return stored item keys
			ownKeys() {
				return Object.keys(store);
			},
			getOwnPropertyDescriptor(_target, prop) {
				if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(store, prop)) {
					return { value: store[prop], writable: true, enumerable: true, configurable: true };
				}
				// Expose the method names too
				return { value: undefined, writable: true, enumerable: true, configurable: true };
			},
			get(target, prop) {
				if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(store, prop)) {
					return store[prop];
				}
				return Reflect.get(target, prop);
			},
		}
	) as unknown as Storage;
}

describe('useTaskInputDraft', () => {
	let ls: Storage;

	beforeEach(() => {
		vi.useFakeTimers();
		ls = createRealLocalStorage();
		vi.stubGlobal('localStorage', ls);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	// ── Initialization ────────────────────────────────────────────────────────

	describe('initialization', () => {
		it('should initialize with empty content when no draft exists', () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			expect(result.current.content).toBe('');
		});

		it('should provide setContent function', () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			expect(typeof result.current.setContent).toBe('function');
		});

		it('should provide clear function', () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			expect(typeof result.current.clear).toBe('function');
		});

		it('should initialize draftRestored as false when no draft', () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			expect(result.current.draftRestored).toBe(false);
		});

		it('should restore existing draft on mount', () => {
			// Pre-seed localStorage with a draft
			ls.setItem(
				'neokai_task_draft_task-1',
				JSON.stringify({ taskId: 'task-1', message: 'Saved draft', timestamp: Date.now() })
			);

			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			// Draft is loaded synchronously during hook initialization
			expect(result.current.content).toBe('Saved draft');
			expect(result.current.draftRestored).toBe(true);
		});

		it('should not restore expired draft (> 7 days)', () => {
			const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
			ls.setItem(
				'neokai_task_draft_task-1',
				JSON.stringify({ taskId: 'task-1', message: 'Old draft', timestamp: oldTimestamp })
			);

			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			expect(result.current.content).toBe('');
			expect(result.current.draftRestored).toBe(false);
			// Should have cleaned up the stale draft
			expect(ls.getItem('neokai_task_draft_task-1')).toBeNull();
		});

		it('should handle invalid JSON in localStorage gracefully', () => {
			ls.setItem('neokai_task_draft_task-1', 'not valid json{{{');

			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			expect(result.current.content).toBe('');
			expect(result.current.draftRestored).toBe(false);
			// Should remove the invalid entry
			expect(ls.getItem('neokai_task_draft_task-1')).toBeNull();
		});
	});

	// ── setContent ────────────────────────────────────────────────────────────

	describe('setContent', () => {
		it('should update content synchronously', () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			act(() => {
				result.current.setContent('Hello world');
			});

			expect(result.current.content).toBe('Hello world');
		});

		it('should handle multiple rapid updates', () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

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
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			act(() => {
				result.current.setContent('Hello <world> & "friends" 🎉');
			});

			expect(result.current.content).toBe('Hello <world> & "friends" 🎉');
		});

		it('should handle multiline content', () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			act(() => {
				result.current.setContent('Line 1\nLine 2\nLine 3');
			});

			expect(result.current.content).toBe('Line 1\nLine 2\nLine 3');
		});

		it('should dismiss draftRestored when content is updated', () => {
			ls.setItem(
				'neokai_task_draft_task-1',
				JSON.stringify({ taskId: 'task-1', message: 'Saved draft', timestamp: Date.now() })
			);

			const { result } = renderHook(() => useTaskInputDraft('task-1'));
			expect(result.current.draftRestored).toBe(true);

			act(() => {
				result.current.setContent('New content');
			});

			expect(result.current.draftRestored).toBe(false);
		});
	});

	// ── Auto-save to localStorage ─────────────────────────────────────────────

	describe('auto-save to localStorage', () => {
		it('should save draft after debounce delay', async () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1', 500));

			// Wait for initial effects to flush
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				result.current.setContent('Draft message');
			});

			// Not saved yet (debounce hasn't fired)
			expect(ls.getItem('neokai_task_draft_task-1')).toBeNull();

			// Advance past debounce
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});

			const stored = JSON.parse(ls.getItem('neokai_task_draft_task-1')!);
			expect(stored.message).toBe('Draft message');
			expect(stored.taskId).toBe('task-1');
			expect(typeof stored.timestamp).toBe('number');
		});

		it('should debounce rapid typing — only save after last keystroke', async () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1', 500));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

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

			// Still before last debounce expires
			expect(ls.getItem('neokai_task_draft_task-1')).toBeNull();

			// Advance past final debounce
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});

			const stored = JSON.parse(ls.getItem('neokai_task_draft_task-1')!);
			expect(stored.message).toBe('Hello');
		});

		it('should clear localStorage immediately when content is emptied', async () => {
			ls.setItem(
				'neokai_task_draft_task-1',
				JSON.stringify({ taskId: 'task-1', message: 'Saved draft', timestamp: Date.now() })
			);

			const { result } = renderHook(() => useTaskInputDraft('task-1', 500));

			// Content is restored synchronously
			expect(result.current.content).toBe('Saved draft');

			act(() => {
				result.current.setContent('');
			});

			// Should be removed immediately (no debounce for empty)
			expect(ls.getItem('neokai_task_draft_task-1')).toBeNull();
		});

		it('should not save whitespace-only content', async () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1', 500));

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			act(() => {
				result.current.setContent('   ');
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});

			expect(ls.getItem('neokai_task_draft_task-1')).toBeNull();
		});
	});

	// ── clear ─────────────────────────────────────────────────────────────────

	describe('clear', () => {
		it('should clear content', () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			act(() => {
				result.current.setContent('Some content');
			});

			expect(result.current.content).toBe('Some content');

			act(() => {
				result.current.clear();
			});

			expect(result.current.content).toBe('');
		});

		it('should remove draft from localStorage', () => {
			ls.setItem(
				'neokai_task_draft_task-1',
				JSON.stringify({ taskId: 'task-1', message: 'Saved draft', timestamp: Date.now() })
			);

			const { result } = renderHook(() => useTaskInputDraft('task-1'));

			expect(result.current.content).toBe('Saved draft');

			act(() => {
				result.current.clear();
			});

			expect(ls.getItem('neokai_task_draft_task-1')).toBeNull();
		});

		it('should reset draftRestored flag', () => {
			ls.setItem(
				'neokai_task_draft_task-1',
				JSON.stringify({ taskId: 'task-1', message: 'Saved draft', timestamp: Date.now() })
			);

			const { result } = renderHook(() => useTaskInputDraft('task-1'));
			expect(result.current.draftRestored).toBe(true);

			act(() => {
				result.current.clear();
			});

			expect(result.current.draftRestored).toBe(false);
		});

		it('should work when content is already empty', () => {
			const { result } = renderHook(() => useTaskInputDraft('task-1'));

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
			const { result, rerender } = renderHook(({ taskId }) => useTaskInputDraft(taskId), {
				initialProps: { taskId: 'task-1' },
			});

			act(() => {
				result.current.setContent('Content for task 1');
			});

			expect(result.current.content).toBe('Content for task 1');

			// Switch task — content should clear immediately
			rerender({ taskId: 'task-2' });

			expect(result.current.content).toBe('');
		});

		it('should restore draft for switched-to task', async () => {
			ls.setItem(
				'neokai_task_draft_task-2',
				JSON.stringify({ taskId: 'task-2', message: 'Task 2 draft', timestamp: Date.now() })
			);

			const { result, rerender } = renderHook(({ taskId }) => useTaskInputDraft(taskId), {
				initialProps: { taskId: 'task-1' },
			});

			rerender({ taskId: 'task-2' });

			// taskId change triggers useEffect for loading
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('Task 2 draft');
			expect(result.current.draftRestored).toBe(true);
		});

		it('should keep per-task drafts independent', async () => {
			// Seed drafts for two tasks
			ls.setItem(
				'neokai_task_draft_task-1',
				JSON.stringify({ taskId: 'task-1', message: 'Task 1 draft', timestamp: Date.now() })
			);
			ls.setItem(
				'neokai_task_draft_task-2',
				JSON.stringify({ taskId: 'task-2', message: 'Task 2 draft', timestamp: Date.now() })
			);

			const { result, rerender } = renderHook(({ taskId }) => useTaskInputDraft(taskId), {
				initialProps: { taskId: 'task-1' },
			});

			// Initial render loads task-1's draft synchronously
			expect(result.current.content).toBe('Task 1 draft');

			rerender({ taskId: 'task-2' });

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('Task 2 draft');

			rerender({ taskId: 'task-1' });

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(result.current.content).toBe('Task 1 draft');
		});

		it('should handle empty taskId', () => {
			const { result } = renderHook(() => useTaskInputDraft(''));

			expect(result.current.content).toBe('');
			expect(result.current.draftRestored).toBe(false);
		});

		it('should handle rapid task switches', () => {
			const { result, rerender } = renderHook(({ taskId }) => useTaskInputDraft(taskId), {
				initialProps: { taskId: 'task-1' },
			});

			rerender({ taskId: 'task-2' });
			rerender({ taskId: 'task-3' });
			rerender({ taskId: 'task-4' });

			expect(result.current.content).toBe('');
		});
	});

	// ── Stale draft cleanup ───────────────────────────────────────────────────

	describe('stale draft cleanup', () => {
		it('should clean up all drafts older than 7 days on mount', () => {
			const now = Date.now();
			const oldTs = now - 8 * 24 * 60 * 60 * 1000;

			ls.setItem(
				'neokai_task_draft_old-task',
				JSON.stringify({ taskId: 'old-task', message: 'Stale', timestamp: oldTs })
			);
			ls.setItem(
				'neokai_task_draft_recent-task',
				JSON.stringify({ taskId: 'recent-task', message: 'Fresh', timestamp: now })
			);
			// Unrelated key should not be touched
			ls.setItem('some_other_key', 'value');

			renderHook(() => useTaskInputDraft('task-1'));

			// Cleanup runs synchronously in hook body
			expect(ls.getItem('neokai_task_draft_old-task')).toBeNull();
			expect(ls.getItem('neokai_task_draft_recent-task')).not.toBeNull();
			expect(ls.getItem('some_other_key')).toBe('value');
		});

		it('should remove corrupt entries during cleanup', () => {
			ls.setItem('neokai_task_draft_corrupt', 'not-json');

			renderHook(() => useTaskInputDraft('task-1'));

			expect(ls.getItem('neokai_task_draft_corrupt')).toBeNull();
		});
	});

	// ── Function stability ────────────────────────────────────────────────────

	describe('function stability', () => {
		it('should return stable setContent reference across rerenders', () => {
			const { result, rerender } = renderHook(() => useTaskInputDraft('task-1'));

			const firstSetContent = result.current.setContent;
			rerender();
			expect(result.current.setContent).toBe(firstSetContent);
		});

		it('should return stable clear reference across rerenders', () => {
			const { result, rerender } = renderHook(() => useTaskInputDraft('task-1'));

			const firstClear = result.current.clear;
			rerender();
			expect(result.current.clear).toBe(firstClear);
		});
	});
});
