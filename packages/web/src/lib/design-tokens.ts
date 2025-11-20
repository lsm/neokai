/**
 * Design Tokens
 *
 * Centralized design system tokens for consistent spacing, sizing, and styling
 * across all components.
 */

/**
 * Message Spacing Tokens
 * Defines standardized padding and spacing for message bubbles
 */
export const messageSpacing = {
  /**
   * User message bubble padding
   * Mobile: 12px horizontal, 8px vertical (px-3 py-2)
   * Desktop: 16px horizontal, 10px vertical (px-4 py-2.5)
   */
  user: {
    bubble: {
      mobile: "px-3 py-2",
      desktop: "md:px-4 md:py-2.5",
      combined: "px-3 py-2 md:px-4 md:py-2.5"
    },
    container: {
      mobile: "px-4 py-2",
      desktop: "md:px-6",
      combined: "py-2 px-4 md:px-6"
    }
  },

  /**
   * Assistant message bubble padding
   * Mobile: 12px horizontal, 8px vertical (px-3 py-2)
   * Desktop: 16px horizontal, 10px vertical (px-4 py-2.5)
   */
  assistant: {
    bubble: {
      mobile: "px-3 py-2",
      desktop: "md:px-4 md:py-2.5",
      combined: "px-3 py-2 md:px-4 md:py-2.5"
    },
    container: {
      mobile: "py-2",
      desktop: "",
      combined: "py-2"
    }
  },

  /**
   * Actions row spacing (below message bubble)
   * Spacing between message bubble and action buttons
   */
  actions: {
    marginTop: "mt-2",
    gap: "gap-2",
    padding: "px-1"
  }
} as const;

/**
 * Border Radius Tokens
 */
export const borderRadius = {
  message: {
    bubble: "rounded-2xl", // 16px
    tool: "rounded-lg"     // 8px
  }
} as const;

/**
 * Typography Tokens
 */
export const typography = {
  message: {
    text: "text-gray-200",
    timestamp: "text-xs text-gray-500"
  }
} as const;

/**
 * Helper function to combine design token classes
 */
export function cn(...classes: (string | undefined | false)[]): string {
  return classes.filter(Boolean).join(' ');
}
