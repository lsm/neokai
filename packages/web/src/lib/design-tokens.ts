/**
 * Design Tokens
 *
 * Centralized design system tokens for consistent spacing, sizing, and styling
 * across all components.
 */

/**
 * Message Spacing Tokens
 * Defines standardized padding and spacing for message bubbles
 * Based on real iMessage design
 */
export const messageSpacing = {
  /**
   * User message bubble padding
   * Mobile: 12px horizontal, 6px vertical (px-3 py-1.5)
   * Desktop: 14px horizontal, 8px vertical (px-3.5 py-2)
   */
  user: {
    bubble: {
      mobile: "px-3 py-1.5",
      desktop: "md:px-3.5 md:py-2",
      combined: "px-3 py-1.5 md:px-3.5 md:py-2"
    },
    container: {
      mobile: "px-4 py-2",
      desktop: "md:px-6",
      combined: "py-2 px-4 md:px-6"
    }
  },

  /**
   * Assistant message bubble padding
   * Same as user for consistency
   */
  assistant: {
    bubble: {
      mobile: "px-3 py-1.5",
      desktop: "md:px-3.5 md:py-2",
      combined: "px-3 py-1.5 md:px-3.5 md:py-2"
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
 * iMessage-style corner radius - 20px for that signature Apple look
 */
export const borderRadius = {
  message: {
    bubble: "rounded-[20px]", // 20px - matches Apple iMessage
    tool: "rounded-lg"        // 8px
  }
} as const;

/**
 * Color Tokens
 * iMessage-style color scheme - exact colors from real iMessage
 */
export const messageColors = {
  /**
   * User message colors (blue bubble like iMessage)
   */
  user: {
    background: "bg-blue-500",
    text: "text-white"
  },
  /**
   * Assistant message colors (dark gray bubble)
   * Using exact iMessage color #3b3b3d
   */
  assistant: {
    background: "bg-[#3b3b3d]",
    text: "text-white"
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
