/**
 * StatusIndicator Component
 *
 * Shows daemon connection and processing status above the message input
 * - Idle: Green dot + "Online" or Red dot + "Offline"
 * - Processing: Pulsing purple dot + dynamic verb (e.g., "Reading files...", "Thinking...")
 * - Shows context usage percentage on the right
 */

import { useState, useRef, useEffect } from "preact/hooks";

interface StatusIndicatorProps {
  isConnected: boolean;
  isProcessing: boolean;
  currentAction?: string;
  contextUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  maxContextTokens?: number;
}

export default function StatusIndicator({
  isConnected,
  isProcessing,
  currentAction,
  contextUsage,
  maxContextTokens = 200000, // Default to Sonnet 4.5's 200k context window
}: StatusIndicatorProps) {
  const [showContextDetails, setShowContextDetails] = useState(false);
  const [dropdownBottom, setDropdownBottom] = useState(96); // Default 24*4px = 96px
  const indicatorRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Calculate dropdown position dynamically when it opens
  useEffect(() => {
    if (showContextDetails && indicatorRef.current && dropdownRef.current) {
      const indicatorRect = indicatorRef.current.getBoundingClientRect();
      const dropdownHeight = dropdownRef.current.offsetHeight;

      // Calculate space needed: height of dropdown + some padding (16px)
      const spaceNeeded = dropdownHeight + 16;

      // Position dropdown above the indicator with proper spacing
      const bottomPosition = window.innerHeight - indicatorRect.top + 8;

      setDropdownBottom(bottomPosition);
    }
  }, [showContextDetails]);

  const getStatus = () => {
    if (isProcessing && currentAction) {
      return {
        dotClass: "bg-purple-500 animate-pulse",
        text: currentAction,
        textClass: "text-purple-400",
      };
    }

    if (isConnected) {
      return {
        dotClass: "bg-green-500",
        text: "Online",
        textClass: "text-green-400",
      };
    }

    return {
      dotClass: "bg-gray-500",
      text: "Offline",
      textClass: "text-gray-500",
    };
  };

  const status = getStatus();


  // Calculate context percentage
  // According to Anthropic docs: Total input tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
  const totalInputTokens = (contextUsage?.inputTokens || 0) +
                           (contextUsage?.cacheCreationTokens || 0) +
                           (contextUsage?.cacheReadTokens || 0);
  const totalTokens = totalInputTokens + (contextUsage?.outputTokens || 0);
  const contextPercentage = (totalTokens / maxContextTokens) * 100;

  // Determine color based on usage - green for lower usage
  const getContextColor = () => {
    if (contextPercentage >= 90) return "text-red-400";
    if (contextPercentage >= 70) return "text-yellow-400";
    if (contextPercentage >= 50) return "text-blue-400";
    return "text-green-400";
  };

  const getContextBarColor = () => {
    if (contextPercentage >= 90) return "bg-red-500";
    if (contextPercentage >= 70) return "bg-yellow-500";
    if (contextPercentage >= 50) return "bg-blue-500";
    return "bg-green-500";
  };

  return (
    <>
      <div ref={indicatorRef} class="px-4 pb-2">
        <div class="max-w-4xl mx-auto flex items-center gap-2 justify-between">
          {/* Status indicator */}
          <div class="flex items-center gap-2">
            <div class={`w-2 h-2 rounded-full ${status.dotClass}`} />
            <span class={`text-xs font-medium ${status.textClass}`}>
              {status.text}
            </span>
          </div>

          {/* Context usage indicator */}
          {totalTokens > 0 && (
            <div
              class="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => setShowContextDetails(!showContextDetails)}
              title="Click for context details"
            >
              <span class={`text-xs font-medium ${getContextColor()}`}>
                {contextPercentage.toFixed(1)}%
              </span>
              <div class="w-16 h-1.5 bg-dark-700 rounded-full overflow-hidden">
                <div
                  class={`h-full transition-all duration-300 ${getContextBarColor()}`}
                  style={{ width: `${Math.min(contextPercentage, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Context Details Dropdown */}
      {showContextDetails && totalTokens > 0 && (
        <>
          {/* Backdrop to close dropdown */}
          <div
            class="fixed inset-0 z-40"
            onClick={() => setShowContextDetails(false)}
          />

          {/* Dropdown positioned above the indicator */}
          <div class="fixed right-0 px-4 pointer-events-none" style={{ bottom: `${dropdownBottom}px` }}>
            <div class="max-w-4xl mx-auto flex justify-end">
              <div ref={dropdownRef} class="z-50 pointer-events-auto">
                <div class="bg-dark-800 border border-dark-600 rounded-lg p-4 w-72 shadow-xl">
                  <div class="flex items-center justify-between mb-3">
                    <h3 class="text-sm font-semibold text-gray-200">
                      Context Usage
                    </h3>
                    <button
                      class="text-gray-400 hover:text-gray-200 transition-colors"
                      onClick={() => setShowContextDetails(false)}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </div>

                  <div class="space-y-3">
                    {/* Total Usage */}
                    <div class="bg-dark-700 rounded-lg p-2.5">
                      <div class="flex justify-between items-center mb-1.5">
                        <span class="text-xs text-gray-400">Total</span>
                        <span class={`text-xs font-semibold ${getContextColor()}`}>
                          {contextPercentage.toFixed(1)}%
                        </span>
                      </div>
                      <div class="w-full h-1.5 bg-dark-600 rounded-full overflow-hidden">
                        <div
                          class={`h-full transition-all duration-300 ${getContextBarColor()}`}
                          style={{ width: `${Math.min(contextPercentage, 100)}%` }}
                        />
                      </div>
                      <div class="text-xs text-gray-500 mt-1">
                        {totalTokens.toLocaleString()} / {maxContextTokens.toLocaleString()}
                      </div>
                    </div>

                    {/* Token Breakdown */}
                    <div class="space-y-1.5">
                      <h4 class="text-xs font-medium text-gray-300">Breakdown</h4>

                      <div class="flex justify-between text-xs">
                        <span class="text-gray-400">Input</span>
                        <span class="text-gray-200">{(contextUsage?.inputTokens || 0).toLocaleString()}</span>
                      </div>

                      <div class="flex justify-between text-xs">
                        <span class="text-gray-400">Output</span>
                        <span class="text-gray-200">{(contextUsage?.outputTokens || 0).toLocaleString()}</span>
                      </div>

                      {(contextUsage?.cacheReadTokens || 0) > 0 && (
                        <div class="flex justify-between text-xs">
                          <span class="text-gray-400">Cache Read</span>
                          <span class="text-green-400">{(contextUsage.cacheReadTokens).toLocaleString()}</span>
                        </div>
                      )}

                      {(contextUsage?.cacheCreationTokens || 0) > 0 && (
                        <div class="flex justify-between text-xs">
                          <span class="text-gray-400">Cache Creation</span>
                          <span class="text-blue-400">{(contextUsage.cacheCreationTokens).toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
