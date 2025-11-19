/**
 * SDKToolProgressMessage Renderer
 *
 * Displays real-time tool execution progress with elapsed time
 */

import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";

type ToolProgressMessage = Extract<SDKMessage, { type: "tool_progress" }>;

interface Props {
  message: ToolProgressMessage;
}

export function SDKToolProgressMessage({ message }: Props) {
  return (
    <div class="py-2 px-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 flex items-center gap-3">
      {/* Animated spinner */}
      <div class="flex-shrink-0">
        <svg
          class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      </div>

      {/* Tool info */}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-mono text-sm font-medium text-blue-900 dark:text-blue-100">
            {message.tool_name}
          </span>
          <span class="text-xs text-blue-600 dark:text-blue-400">
            {message.elapsed_time_seconds.toFixed(1)}s
          </span>
        </div>

        <div class="text-xs text-blue-700 dark:text-blue-300 truncate">
          Tool ID: {message.tool_use_id.slice(0, 12)}...
          {message.parent_tool_use_id && (
            <span class="ml-2">
              (parent: {message.parent_tool_use_id.slice(0, 8)}...)
            </span>
          )}
        </div>
      </div>

      {/* Progress indicator */}
      <div class="flex-shrink-0">
        <div class="flex gap-1">
          <div class="w-1.5 h-1.5 bg-blue-600 dark:bg-blue-400 rounded-full animate-pulse" style="animation-delay: 0ms" />
          <div class="w-1.5 h-1.5 bg-blue-600 dark:bg-blue-400 rounded-full animate-pulse" style="animation-delay: 150ms" />
          <div class="w-1.5 h-1.5 bg-blue-600 dark:bg-blue-400 rounded-full animate-pulse" style="animation-delay: 300ms" />
        </div>
      </div>
    </div>
  );
}
