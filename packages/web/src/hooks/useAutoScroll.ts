/**
 * useAutoScroll Hook
 *
 * Manages auto-scroll behavior for chat containers.
 * Handles scroll position detection, scroll button visibility,
 * and automatic scrolling when new content arrives.
 *
 * @example
 * ```typescript
 * const messagesContainerRef = useRef<HTMLDivElement>(null);
 * const messagesEndRef = useRef<HTMLDivElement>(null);
 *
 * const { showScrollButton, scrollToBottom } = useAutoScroll({
 *   containerRef: messagesContainerRef,
 *   endRef: messagesEndRef,
 *   enabled: autoScroll,
 *   messageCount: messages.length,
 *   isInitialLoad,
 * });
 * ```
 */

import type { RefObject } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";

export interface UseAutoScrollOptions {
  /** Ref to the scrollable container element */
  containerRef: RefObject<HTMLDivElement>;
  /** Ref to the element at the end of the content (for scrollIntoView) */
  endRef: RefObject<HTMLDivElement>;
  /** Whether auto-scroll is enabled */
  enabled: boolean;
  /** Current message count (used to detect new messages) */
  messageCount: number;
  /** Whether this is the initial load (always scrolls on initial load) */
  isInitialLoad?: boolean;
  /** Whether older messages are being loaded (prevents scroll during load) */
  loadingOlder?: boolean;
  /** Distance from bottom to consider "near bottom" (default: 200px) */
  nearBottomThreshold?: number;
}

export interface UseAutoScrollResult {
  /** Whether to show the scroll-to-bottom button */
  showScrollButton: boolean;
  /** Scroll to the bottom of the container */
  scrollToBottom: (smooth?: boolean) => void;
  /** Whether the user is near the bottom of the scroll container */
  isNearBottom: boolean;
}

/**
 * Hook for managing auto-scroll behavior in chat containers
 */
export function useAutoScroll({
  containerRef,
  endRef,
  enabled,
  messageCount,
  isInitialLoad = false,
  loadingOlder = false,
  nearBottomThreshold = 200,
}: UseAutoScrollOptions): UseAutoScrollResult {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const prevMessageCountRef = useRef<number>(0);
  const hasScrolledOnInitialLoad = useRef(false);

  // Scroll to bottom function - instant by default during streaming, smooth when user clicks
  const scrollToBottom = useCallback(
    (smooth = false) => {
      endRef.current?.scrollIntoView({
        behavior: smooth ? "smooth" : "instant",
      });
    },
    [endRef],
  );

  // Detect scroll position to show/hide scroll button
  useEffect(() => {
    // Try to get container, with a fallback check after a brief delay if not immediately available
    let container = containerRef.current;

    if (!container) {
      // Schedule a retry after a brief moment to allow the ref to be populated
      const timeoutId = setTimeout(() => {
        container = containerRef.current;
        if (container) {
          setupScrollDetection(container);
        }
      }, 50);
      return () => clearTimeout(timeoutId);
    }

    function setupScrollDetection(container: HTMLDivElement) {
      const handleScroll = () => {
        const { scrollTop, scrollHeight, clientHeight } = container;
        const nearBottom =
          scrollHeight - scrollTop - clientHeight < nearBottomThreshold;
        setIsNearBottom(nearBottom);
        setShowScrollButton(!nearBottom);
      };

      // Initial check
      handleScroll();

      // Use passive event listener for better scroll performance
      container.addEventListener("scroll", handleScroll, { passive: true });

      // Use ResizeObserver to update when content size changes
      const resizeObserver = new ResizeObserver(() => {
        handleScroll();
      });
      resizeObserver.observe(container);

      // Return cleanup function
      return () => {
        container.removeEventListener("scroll", handleScroll);
        resizeObserver.disconnect();
      };
    }

    return setupScrollDetection(container);
  }, [nearBottomThreshold, messageCount]);

  // Auto-scroll on new messages
  useEffect(() => {
    const hasNewContent = messageCount > prevMessageCountRef.current;

    // Always scroll on initial load when first messages arrive
    if (
      isInitialLoad &&
      messageCount > 0 &&
      !hasScrolledOnInitialLoad.current
    ) {
      scrollToBottom();
      hasScrolledOnInitialLoad.current = true;
      prevMessageCountRef.current = messageCount;
      return;
    }

    // Only auto-scroll for new messages if enabled and not loading older
    if (enabled && !loadingOlder && hasNewContent) {
      scrollToBottom();
    }

    prevMessageCountRef.current = messageCount;
  }, [messageCount, isInitialLoad, loadingOlder, enabled, scrollToBottom]);

  // Reset initial load flag when it changes
  useEffect(() => {
    if (isInitialLoad) {
      hasScrolledOnInitialLoad.current = false;
    }
  }, [isInitialLoad]);

  return {
    showScrollButton,
    scrollToBottom,
    isNearBottom,
  };
}
