/**
 * ScrollToBottomButton Component
 *
 * Floating button that appears when user scrolls up from bottom.
 * Clicking scrolls smoothly to the bottom of the container.
 * Extracted from ChatContainer.tsx for better separation of concerns.
 */

import { borderColors } from "../lib/design-tokens";

export interface ScrollToBottomButtonProps {
  onClick: () => void;
}

export function ScrollToBottomButton({ onClick }: ScrollToBottomButtonProps) {
  return (
    <div class="absolute bottom-36 left-1/2 -translate-x-1/2 z-20">
      <button
        onClick={onClick}
        class={`w-10 h-10 rounded-full bg-dark-800 hover:bg-dark-700 text-gray-300 hover:text-gray-100 shadow-lg border ${borderColors.ui.secondary} flex items-center justify-center transition-all duration-150 animate-slideIn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
        title="Scroll to bottom"
        aria-label="Scroll to bottom"
      >
        <svg
          class="w-5 h-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>
    </div>
  );
}
