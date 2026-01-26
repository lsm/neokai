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
		it('should call scrollIntoView with instant behavior by default', () => {
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

			expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'instant' });
		});

		it('should call scrollIntoView with smooth behavior when specified', () => {
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

			expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth' });
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
		it('should reset hasScrolledOnInitialLoad when isInitialLoad changes to true', () => {
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

			// Trigger ResizeObserver callback
			act(() => {
				resizeObserverInstances[0]?.triggerResize();
			});

			// Should now be near bottom
			expect(result.current.isNearBottom).toBe(true);
			expect(result.current.showScrollButton).toBe(false);
		});
	});
});
