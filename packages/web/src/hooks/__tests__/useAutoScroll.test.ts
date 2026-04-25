// @ts-nocheck
/**
 * Tests for useAutoScroll Hook
 *
 * Tests auto-scroll behavior, scroll button visibility,
 * and automatic scrolling when new content arrives.
 */

import { renderHook, act } from '@testing-library/preact';
import type { RefObject } from 'preact';

// Import after mocking (no external dependencies to mock)
import { useAutoScroll } from '../useAutoScroll.ts';

// Helper to create mock refs
function createMockRefs() {
	const scrollIntoViewMock = vi.fn(() => {});
	const addEventListenerMock = vi.fn(() => {});
	const removeEventListenerMock = vi.fn(() => {});

	const containerRef = {
		current: {
			scrollTop: 0,
			scrollHeight: 1000,
			clientHeight: 500,
			addEventListener: addEventListenerMock,
			removeEventListener: removeEventListenerMock,
		} as unknown as HTMLDivElement,
	} as RefObject<HTMLDivElement>;

	const endRef = {
		current: {
			scrollIntoView: scrollIntoViewMock,
		} as unknown as HTMLDivElement,
	} as RefObject<HTMLDivElement>;

	return {
		containerRef,
		endRef,
		scrollIntoViewMock,
		addEventListenerMock,
		removeEventListenerMock,
	};
}

// Store ResizeObserver instances for testing
let resizeObserverInstances: MockResizeObserver[] = [];

// Mock ResizeObserver
class MockResizeObserver {
	callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		resizeObserverInstances.push(this);
	}
	observe() {}
	unobserve() {}
	disconnect() {}
	// Helper to trigger resize callback
	triggerResize() {
		this.callback([], this as unknown as ResizeObserver);
	}
}

// Set up global mock
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

describe('useAutoScroll', () => {
	beforeEach(() => {
		// Reset ResizeObserver instances
		resizeObserverInstances = [];
	});

	describe('initialization', () => {
		it('should initialize with default values', () => {
			const { containerRef, endRef } = createMockRefs();

			const { result } = renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 0,
				})
			);

			expect(typeof result.current.showScrollButton).toBe('boolean');
			expect(typeof result.current.scrollToBottom).toBe('function');
			expect(typeof result.current.isNearBottom).toBe('boolean');
		});

		it('should return stable function references', () => {
			const { containerRef, endRef } = createMockRefs();

			const { result, rerender } = renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 5,
				})
			);

			const firstScrollToBottom = result.current.scrollToBottom;

			rerender();

			expect(result.current.scrollToBottom).toBe(firstScrollToBottom);
		});
	});

	describe('scrollToBottom', () => {
		it('should call scrollIntoView with instant behavior and block: end by default', () => {
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { result } = renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 0,
				})
			);

			act(() => {
				result.current.scrollToBottom();
			});

			// block: 'end' combined with the container's scroll-padding-bottom keeps
			// the last message above the floating composer rather than behind it.
			expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'instant', block: 'end' });
		});

		it('should call scrollIntoView with smooth behavior and block: end when specified', () => {
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { result } = renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 0,
				})
			);

			act(() => {
				result.current.scrollToBottom(true);
			});

			expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' });
		});

		it('should handle null endRef gracefully', () => {
			const { containerRef } = createMockRefs();
			const nullEndRef = { current: null } as RefObject<HTMLDivElement>;

			const { result } = renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef: nullEndRef,
					enabled: true,
					messageCount: 0,
				})
			);

			// Should not throw
			act(() => {
				result.current.scrollToBottom();
			});
		});
	});

	describe('auto-scroll behavior', () => {
		it('should scroll on initial load when messages arrive', () => {
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			// Start with isInitialLoad=true and 0 messages
			const { rerender } = renderHook(
				({ messageCount, isInitialLoad }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: true,
						messageCount,
						isInitialLoad,
					}),
				{
					initialProps: { messageCount: 0, isInitialLoad: true },
				}
			);

			// Rerender with messages arriving
			rerender({ messageCount: 5, isInitialLoad: true });

			expect(scrollIntoViewMock).toHaveBeenCalled();
		});

		it('should scroll when new messages arrive and enabled', () => {
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ messageCount }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: true,
						messageCount,
						isInitialLoad: false,
					}),
				{
					initialProps: { messageCount: 5 },
				}
			);

			scrollIntoViewMock.mockClear();

			// Add new message
			rerender({ messageCount: 6 });

			expect(scrollIntoViewMock).toHaveBeenCalled();
		});

		it('should not scroll when new messages arrive but disabled', () => {
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ messageCount }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: false,
						messageCount,
						isInitialLoad: false,
					}),
				{
					initialProps: { messageCount: 5 },
				}
			);

			scrollIntoViewMock.mockClear();

			// Add new message
			rerender({ messageCount: 6 });

			expect(scrollIntoViewMock).not.toHaveBeenCalled();
		});

		it('should not scroll when loading older messages', () => {
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ messageCount, loadingOlder }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: true,
						messageCount,
						isInitialLoad: false,
						loadingOlder,
					}),
				{
					initialProps: { messageCount: 5, loadingOlder: true },
				}
			);

			scrollIntoViewMock.mockClear();

			// Add messages while loading older
			rerender({ messageCount: 10, loadingOlder: true });

			expect(scrollIntoViewMock).not.toHaveBeenCalled();
		});

		it('should not auto-scroll when loadingOlder transitions from true to false', () => {
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ messageCount, loadingOlder }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: true,
						messageCount,
						isInitialLoad: false,
						loadingOlder,
					}),
				{
					initialProps: { messageCount: 50, loadingOlder: false },
				}
			);

			scrollIntoViewMock.mockClear();

			// Start loading older — message count increases as hidden messages are revealed
			rerender({ messageCount: 55, loadingOlder: true });
			expect(scrollIntoViewMock).not.toHaveBeenCalled();

			// Finish loading older — message count stays at 55, loadingOlder flips to false.
			// This should NOT trigger auto-scroll because the count increase came from
			// revealing older messages, not from genuinely new messages.
			rerender({ messageCount: 55, loadingOlder: false });
			expect(scrollIntoViewMock).not.toHaveBeenCalled();
		});

		it('should not auto-scroll across a load-older transition where messageCount also increases', () => {
			// Reproduces the production load-older flow more faithfully: the
			// daemon batches `setMessages(M+older)` and `setLoadingOlder(false)`
			// into a single render after the await resolves. With auto-scroll
			// running as a useLayoutEffect, an ordinary useEffect-based
			// `prevMessageCountRef` update would race and let the auto-scroll
			// effect see a stale `prev`, scrolling the user to the bottom and
			// clobbering ChatContainer's scroll-position restore. The
			// loadingOlder-tracker therefore also runs as a useLayoutEffect
			// declared first.
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ messageCount, loadingOlder }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: true,
						messageCount,
						isInitialLoad: false,
						loadingOlder,
					}),
				{
					initialProps: { messageCount: 200, loadingOlder: false },
				}
			);

			scrollIntoViewMock.mockClear();

			// User clicks "Load more" — loadingOlder flips on first.
			rerender({ messageCount: 200, loadingOlder: true });
			expect(scrollIntoViewMock).not.toHaveBeenCalled();

			// Older messages prepended AND loadingOlder cleared in the same
			// render (post-await batching): messageCount jumps from 200 → 250.
			rerender({ messageCount: 250, loadingOlder: false });
			expect(scrollIntoViewMock).not.toHaveBeenCalled();
		});

		it('should scroll on first non-empty messageCount even when isInitialLoad is already false', () => {
			// Reproduces the navigate-back-to-cached-session bug: preact
			// batches the signal-driven `setIsInitialLoad(false)` and
			// `setMessages(M)` updates so by the time messageCount first
			// becomes non-zero, isInitialLoad has already flipped to false.
			// The hook must still scroll on this first non-empty render —
			// otherwise the user lands somewhere mid-conversation instead of
			// at the latest messages.
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ messageCount, isInitialLoad }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: true,
						messageCount,
						isInitialLoad,
					}),
				{
					// Mount with messages=0 AND isInitialLoad already false —
					// this is the cached-session navigation case: the store's
					// signals have already flipped the parent's `isInitialLoad`
					// state by the time this hook first runs.
					initialProps: { messageCount: 0, isInitialLoad: false },
				}
			);

			scrollIntoViewMock.mockClear();

			// Messages arrive in the next render. Even though isInitialLoad
			// stays false, the hook should scroll because this is the first
			// non-empty messageCount on this mount.
			rerender({ messageCount: 12, isInitialLoad: false });
			expect(scrollIntoViewMock).toHaveBeenCalled();
		});

		it('should scroll on first non-empty messageCount even when enabled is false', () => {
			// Initial-mount scroll is a "navigation/visit" scroll, not an
			// auto-scroll-on-new-content. The user's autoScroll preference
			// only governs SUBSEQUENT scrolling, mirroring the existing
			// initial-load behavior.
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ messageCount }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: false,
						messageCount,
						isInitialLoad: false,
					}),
				{
					initialProps: { messageCount: 0 },
				}
			);

			scrollIntoViewMock.mockClear();

			rerender({ messageCount: 8 });
			expect(scrollIntoViewMock).toHaveBeenCalled();

			scrollIntoViewMock.mockClear();

			// Subsequent new content with enabled=false must NOT scroll.
			rerender({ messageCount: 9 });
			expect(scrollIntoViewMock).not.toHaveBeenCalled();
		});

		it('should only scroll once on mount, even after multiple message updates', () => {
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ messageCount }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: false,
						messageCount,
						isInitialLoad: false,
					}),
				{
					initialProps: { messageCount: 0 },
				}
			);

			scrollIntoViewMock.mockClear();

			rerender({ messageCount: 5 });
			expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

			scrollIntoViewMock.mockClear();

			// Re-renders with same messageCount: should not re-scroll.
			rerender({ messageCount: 5 });
			expect(scrollIntoViewMock).not.toHaveBeenCalled();
		});

		it('should reset mount-scroll latch when isInitialLoad flips back to true', () => {
			// Preserves the existing reset semantic — a parent can signal
			// "treat the next non-empty messageCount as a fresh load" by
			// toggling the prop. Used for in-place session swaps that don't
			// remount the hook.
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ messageCount, isInitialLoad }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: false,
						messageCount,
						isInitialLoad,
					}),
				{
					initialProps: { messageCount: 5, isInitialLoad: false },
				}
			);

			// Initial mount-scroll fires (messageCount > 0).
			expect(scrollIntoViewMock).toHaveBeenCalled();
			scrollIntoViewMock.mockClear();

			// Parent signals "fresh session" by toggling isInitialLoad back to
			// true with a fresh (empty) messageCount.
			rerender({ messageCount: 0, isInitialLoad: true });
			rerender({ messageCount: 0, isInitialLoad: false });

			// New session's messages arrive — should scroll again because the
			// mount-scroll latch was reset by the isInitialLoad → true edge.
			rerender({ messageCount: 7, isInitialLoad: false });
			expect(scrollIntoViewMock).toHaveBeenCalled();
		});
	});

	describe('scroll position detection', () => {
		it('should report near bottom when close to scroll bottom', () => {
			const { containerRef, endRef, addEventListenerMock } = createMockRefs();

			// Position near bottom
			containerRef.current!.scrollTop = 400;
			containerRef.current!.scrollHeight = 1000;
			containerRef.current!.clientHeight = 500;
			// scrollHeight(1000) - scrollTop(400) - clientHeight(500) = 100 < 200 threshold

			renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 5,
				})
			);

			// Should have set up scroll listener
			expect(addEventListenerMock).toHaveBeenCalled();
		});

		it('should use custom nearBottomThreshold', () => {
			const { containerRef, endRef, addEventListenerMock } = createMockRefs();

			// Position that would be near bottom with 200 threshold but not with 50
			containerRef.current!.scrollTop = 350;
			containerRef.current!.scrollHeight = 1000;
			containerRef.current!.clientHeight = 500;
			// scrollHeight(1000) - scrollTop(350) - clientHeight(500) = 150

			renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 5,
					nearBottomThreshold: 50, // Custom threshold
				})
			);

			expect(addEventListenerMock).toHaveBeenCalled();
		});
	});

	describe('null ref handling', () => {
		it('should handle null containerRef', () => {
			const { endRef } = createMockRefs();
			const nullContainerRef = { current: null } as RefObject<HTMLDivElement>;

			// Should not throw
			const { result } = renderHook(() =>
				useAutoScroll({
					containerRef: nullContainerRef,
					endRef,
					enabled: true,
					messageCount: 0,
				})
			);

			expect(result.current.showScrollButton).toBe(false);
		});
	});

	describe('initial load reset', () => {
		it('should reset mount-scroll latch when isInitialLoad changes to true', () => {
			const { containerRef, endRef, scrollIntoViewMock } = createMockRefs();

			const { rerender } = renderHook(
				({ isInitialLoad, messageCount }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: true,
						messageCount,
						isInitialLoad,
					}),
				{
					initialProps: { isInitialLoad: true, messageCount: 0 },
				}
			);

			// Initial load with messages
			rerender({ isInitialLoad: true, messageCount: 5 });
			expect(scrollIntoViewMock).toHaveBeenCalled();

			scrollIntoViewMock.mockClear();

			// Switch to not initial load
			rerender({ isInitialLoad: false, messageCount: 5 });

			// Back to initial load (simulating new session)
			rerender({ isInitialLoad: true, messageCount: 0 });

			// New messages arrive
			rerender({ isInitialLoad: true, messageCount: 3 });
			expect(scrollIntoViewMock).toHaveBeenCalled();
		});
	});

	describe('cleanup', () => {
		it('should clean up event listeners on unmount', () => {
			const { containerRef, endRef, removeEventListenerMock } = createMockRefs();

			const { unmount } = renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 5,
				})
			);

			unmount();

			expect(removeEventListenerMock).toHaveBeenCalled();
		});
	});

	describe('delayed ref setup', () => {
		it('should set up scroll detection after timeout when containerRef is initially null', async () => {
			vi.useFakeTimers();

			const { endRef } = createMockRefs();
			const addEventListenerMock = vi.fn();
			const removeEventListenerMock = vi.fn();

			// Start with null containerRef
			const containerRef = { current: null } as RefObject<HTMLDivElement>;

			const { unmount } = renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 0,
				})
			);

			// Now set the containerRef (simulating delayed DOM mounting)
			containerRef.current = {
				scrollTop: 0,
				scrollHeight: 1000,
				clientHeight: 500,
				addEventListener: addEventListenerMock,
				removeEventListener: removeEventListenerMock,
			} as unknown as HTMLDivElement;

			// Advance timers to trigger the delayed setup
			await vi.advanceTimersByTimeAsync(50);

			// Should have set up scroll listener after timeout
			expect(addEventListenerMock).toHaveBeenCalledWith('scroll', expect.any(Function), {
				passive: true,
			});

			unmount();
			vi.useRealTimers();
		});

		it('should cleanup timeout when unmounted before delay completes', () => {
			vi.useFakeTimers();

			const { endRef } = createMockRefs();
			const nullContainerRef = { current: null } as RefObject<HTMLDivElement>;

			const { unmount } = renderHook(() =>
				useAutoScroll({
					containerRef: nullContainerRef,
					endRef,
					enabled: true,
					messageCount: 0,
				})
			);

			// Unmount before timeout fires
			unmount();

			// Advance timers - should not throw
			vi.advanceTimersByTime(100);

			vi.useRealTimers();
		});
	});

	describe('content-growth re-anchor', () => {
		it('should re-pin to bottom when content grows while user is near bottom', () => {
			// Reproduces the "lands somewhere random" symptom: an initial
			// scroll-to-bottom fires, but then async content (markdown,
			// syntax highlighting, image loads) grows the scrollHeight after
			// the scroll, leaving the last messages stranded above the actual
			// bottom. The ResizeObserver path catches the growth and re-pins.
			const { containerRef, endRef } = createMockRefs();

			// Container is initially at bottom.
			containerRef.current!.scrollTop = 500;
			containerRef.current!.scrollHeight = 1000;
			containerRef.current!.clientHeight = 500;

			renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 5,
				})
			);

			// Simulate async content rendering: scrollHeight grows past the
			// container's previous bottom, but scrollTop hasn't been adjusted.
			containerRef.current!.scrollHeight = 1500;
			// scrollTop stays at 500 → user no longer at bottom. The
			// ResizeObserver should snap them back to the new bottom.

			vi.useFakeTimers();
			act(() => {
				resizeObserverInstances[0]?.triggerResize();
				vi.advanceTimersByTime(16);
			});
			vi.useRealTimers();

			// Container should have been scrolled to the new bottom.
			expect(containerRef.current!.scrollTop).toBe(1500);
		});

		it('should NOT re-pin to bottom when user has scrolled away from bottom', () => {
			// User intentionally scrolled up to read older content. Even if
			// content grows, we must not yank them back to the bottom.
			const { containerRef, endRef } = createMockRefs();

			// User is well above the bottom.
			containerRef.current!.scrollTop = 0;
			containerRef.current!.scrollHeight = 1000;
			containerRef.current!.clientHeight = 500;
			// scrollHeight - scrollTop - clientHeight = 500 > 200 threshold

			renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 5,
				})
			);

			// Content grows.
			containerRef.current!.scrollHeight = 1500;

			vi.useFakeTimers();
			act(() => {
				resizeObserverInstances[0]?.triggerResize();
				vi.advanceTimersByTime(16);
			});
			vi.useRealTimers();

			// Container scrollTop must NOT have been touched.
			expect(containerRef.current!.scrollTop).toBe(0);
		});

		it('should NOT re-pin to bottom while older messages are being loaded', () => {
			// During load-older, ChatContainer's own useLayoutEffect is
			// preserving the user's anchored read position. The auto-scroll
			// hook must keep its hands off.
			const { containerRef, endRef } = createMockRefs();

			containerRef.current!.scrollTop = 500;
			containerRef.current!.scrollHeight = 1000;
			containerRef.current!.clientHeight = 500;

			const { rerender } = renderHook(
				({ loadingOlder }) =>
					useAutoScroll({
						containerRef,
						endRef,
						enabled: true,
						messageCount: 5,
						loadingOlder,
					}),
				{ initialProps: { loadingOlder: false } }
			);

			rerender({ loadingOlder: true });

			containerRef.current!.scrollHeight = 2000;

			vi.useFakeTimers();
			act(() => {
				resizeObserverInstances[0]?.triggerResize();
				vi.advanceTimersByTime(16);
			});
			vi.useRealTimers();

			expect(containerRef.current!.scrollTop).toBe(500);
		});
	});

	describe('ResizeObserver callback', () => {
		it('should update scroll state when ResizeObserver fires', () => {
			const { containerRef, endRef } = createMockRefs();

			// Position not near bottom initially
			containerRef.current!.scrollTop = 0;
			containerRef.current!.scrollHeight = 1000;
			containerRef.current!.clientHeight = 500;

			const { result } = renderHook(() =>
				useAutoScroll({
					containerRef,
					endRef,
					enabled: true,
					messageCount: 5,
				})
			);

			// Initially not near bottom (scrollHeight - scrollTop - clientHeight = 500 > 200)
			expect(result.current.showScrollButton).toBe(true);

			// Simulate content size change where user is now near bottom
			containerRef.current!.scrollTop = 400;
			// scrollHeight(1000) - scrollTop(400) - clientHeight(500) = 100 < 200 threshold

			// Trigger ResizeObserver callback (uses rAF internally for batching)
			vi.useFakeTimers();
			act(() => {
				resizeObserverInstances[0]?.triggerResize();
				// Flush the requestAnimationFrame scheduled by the ResizeObserver callback
				vi.advanceTimersByTime(16);
			});
			vi.useRealTimers();

			// Should now be near bottom
			expect(result.current.isNearBottom).toBe(true);
			expect(result.current.showScrollButton).toBe(false);
		});
	});
});
