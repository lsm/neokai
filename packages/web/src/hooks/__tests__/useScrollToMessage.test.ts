// @ts-nocheck
/**
 * Tests for useScrollToMessage Hook
 *
 * Verifies that:
 * - Scrolls the matching `data-message-id` element into view (instant) and
 *   applies the amber highlight classes.
 * - No-ops when `messageId` is falsy or `isInitialLoad` is true.
 * - Cleanup on unmount removes the highlight and clears timers.
 * - Re-runs and re-anchors when `messageCount` changes (streaming).
 */

import { renderHook, act } from '@testing-library/preact';
import type { RefObject } from 'preact';
import { useScrollToMessage } from '../useScrollToMessage.ts';

const HIGHLIGHT_CLASS = 'ring-amber-400/70';

function createTargetEl(id: string) {
	const scrollIntoViewMock = vi.fn();
	const classList = {
		_set: new Set<string>(),
		add(...names: string[]) {
			for (const n of names) this._set.add(n);
		},
		remove(...names: string[]) {
			for (const n of names) this._set.delete(n);
		},
		contains(name: string) {
			return this._set.has(name);
		},
	};
	const el = {
		scrollIntoView: scrollIntoViewMock,
		classList,
		dataset: { messageId: id },
	} as unknown as HTMLElement;
	return { el, scrollIntoViewMock, classList };
}

function createContainer(target: HTMLElement | null) {
	const querySelector = vi.fn((sel: string) => {
		// Pretend it found the element if the selector matches by id
		return target;
	});
	const container = {
		querySelector,
	} as unknown as HTMLElement;
	return {
		ref: { current: container } as RefObject<HTMLElement>,
		querySelector,
	};
}

describe('useScrollToMessage', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('scrolls target into view and applies highlight classes', () => {
		const { el, scrollIntoViewMock, classList } = createTargetEl('msg-1');
		const { ref } = createContainer(el);

		renderHook(() =>
			useScrollToMessage({
				containerRef: ref,
				messageId: 'msg-1',
				messageCount: 3,
				isInitialLoad: false,
			})
		);

		expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
		expect(classList.contains(HIGHLIGHT_CLASS)).toBe(true);
	});

	it('does not scroll while isInitialLoad=true, then fires once it flips false', () => {
		const { el, scrollIntoViewMock } = createTargetEl('msg-1');
		const { ref } = createContainer(el);

		const { rerender } = renderHook(
			({ isInitialLoad }) =>
				useScrollToMessage({
					containerRef: ref,
					messageId: 'msg-1',
					messageCount: 3,
					isInitialLoad,
				}),
			{ initialProps: { isInitialLoad: true } }
		);

		expect(scrollIntoViewMock).not.toHaveBeenCalled();

		rerender({ isInitialLoad: false });
		expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
	});

	it('does nothing when messageId is empty/undefined', () => {
		const { el, scrollIntoViewMock } = createTargetEl('msg-1');
		const { ref } = createContainer(el);

		renderHook(() =>
			useScrollToMessage({
				containerRef: ref,
				messageId: undefined,
				messageCount: 3,
				isInitialLoad: false,
			})
		);

		expect(scrollIntoViewMock).not.toHaveBeenCalled();
	});

	it('removes the highlight ring after the configured duration', () => {
		const { el, classList } = createTargetEl('msg-1');
		const { ref } = createContainer(el);

		renderHook(() =>
			useScrollToMessage({
				containerRef: ref,
				messageId: 'msg-1',
				messageCount: 3,
				isInitialLoad: false,
				highlightDurationMs: 5000,
			})
		);

		expect(classList.contains(HIGHLIGHT_CLASS)).toBe(true);

		act(() => {
			vi.advanceTimersByTime(4999);
		});
		expect(classList.contains(HIGHLIGHT_CLASS)).toBe(true);

		act(() => {
			vi.advanceTimersByTime(2);
		});
		expect(classList.contains(HIGHLIGHT_CLASS)).toBe(false);
	});

	it('re-anchors during settling window to absorb layout shifts', () => {
		const { el, scrollIntoViewMock } = createTargetEl('msg-1');
		const { ref } = createContainer(el);

		renderHook(() =>
			useScrollToMessage({
				containerRef: ref,
				messageId: 'msg-1',
				messageCount: 3,
				isInitialLoad: false,
				settleWindowMs: 250,
			})
		);

		// Initial anchor.
		expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

		// Two re-anchors at ~16ms and ~64ms inside the settle window, plus one at
		// the end of the window (250ms).
		act(() => {
			vi.advanceTimersByTime(20);
		});
		expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(scrollIntoViewMock).toHaveBeenCalledTimes(3);

		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(scrollIntoViewMock).toHaveBeenCalledTimes(4);
	});

	it('does not re-anchor after the settling window ends', () => {
		const { el, scrollIntoViewMock } = createTargetEl('msg-1');
		const { ref } = createContainer(el);

		renderHook(() =>
			useScrollToMessage({
				containerRef: ref,
				messageId: 'msg-1',
				messageCount: 3,
				isInitialLoad: false,
				settleWindowMs: 250,
			})
		);

		act(() => {
			vi.advanceTimersByTime(2000);
		});

		const callsAtT2s = scrollIntoViewMock.mock.calls.length;

		act(() => {
			vi.advanceTimersByTime(2000);
		});

		// No further scroll calls after the settle window — only the fade timer
		// (which doesn't scroll) might still be pending.
		expect(scrollIntoViewMock.mock.calls.length).toBe(callsAtT2s);
	});

	it('cleans up highlight + timers on unmount', () => {
		const { el, classList } = createTargetEl('msg-1');
		const { ref } = createContainer(el);

		const { unmount } = renderHook(() =>
			useScrollToMessage({
				containerRef: ref,
				messageId: 'msg-1',
				messageCount: 3,
				isInitialLoad: false,
				highlightDurationMs: 5000,
			})
		);

		expect(classList.contains(HIGHLIGHT_CLASS)).toBe(true);

		unmount();

		expect(classList.contains(HIGHLIGHT_CLASS)).toBe(false);
	});

	it('re-runs when messageCount changes (streaming case)', () => {
		const { el, scrollIntoViewMock } = createTargetEl('msg-1');
		const { ref } = createContainer(el);

		const { rerender } = renderHook(
			({ messageCount }) =>
				useScrollToMessage({
					containerRef: ref,
					messageId: 'msg-1',
					messageCount,
					isInitialLoad: false,
				}),
			{ initialProps: { messageCount: 3 } }
		);

		const callsAfterInitial = scrollIntoViewMock.mock.calls.length;

		// New message streams in — hook should re-anchor in case the target was
		// only just rendered.
		rerender({ messageCount: 4 });

		expect(scrollIntoViewMock.mock.calls.length).toBeGreaterThan(callsAfterInitial);
	});

	it('does not throw when target is missing from the DOM', () => {
		const { ref } = createContainer(null);

		expect(() =>
			renderHook(() =>
				useScrollToMessage({
					containerRef: ref,
					messageId: 'no-such-id',
					messageCount: 3,
					isInitialLoad: false,
				})
			)
		).not.toThrow();
	});
});
