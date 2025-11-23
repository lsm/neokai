/**
 * StatusIndicator Component
 *
 * Shows daemon connection and processing status above the message input
 * - Idle: Green dot + "Online" or Red dot + "Offline"
 * - Processing: Pulsing purple dot + dynamic verb (e.g., "Reading files...", "Thinking...")
 * - Shows context usage percentage on the right
 */

import { useState, useRef, useEffect } from "preact/hooks";
import type { ContextInfo, ContextAPIUsage } from "@liuboer/shared";

/**
 * Extended context usage that includes both ContextInfo and basic API usage fallback
 */
interface ContextUsage extends Partial<ContextInfo> {
  // Basic API usage (fallback when accurate context info is not available)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface StatusIndicatorProps {
  isConnected: boolean;
  isProcessing: boolean;
  currentAction?: string;
  contextUsage?: ContextUsage;
  maxContextTokens?: number;
  onSendMessage?: (message: string) => void;
}

export default function StatusIndicator({
  isConnected,
  isProcessing,
  currentAction,
  contextUsage,
  maxContextTokens = 200000, // Default to Sonnet 4.5's 200k context window
  onSendMessage,
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

  // Use accurate context info if available, otherwise fall back to API response
  const hasAccurateContextInfo = contextUsage?.totalUsed !== undefined;
  const totalTokens = hasAccurateContextInfo
    ? (contextUsage?.totalUsed || 0)
    : (() => {
        // Calculate from API response
        // According to Anthropic docs: Total input tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
        const totalInputTokens = (contextUsage?.inputTokens || 0) +
                                 (contextUsage?.cacheCreationTokens || 0) +
                                 (contextUsage?.cacheReadTokens || 0);
        return totalInputTokens + (contextUsage?.outputTokens || 0);
      })();

  const contextCapacity = hasAccurateContextInfo
    ? (contextUsage?.totalCapacity || maxContextTokens)
    : maxContextTokens;

  const contextPercentage = hasAccurateContextInfo && contextUsage?.percentUsed !== undefined
    ? contextUsage.percentUsed
    : (totalTokens / contextCapacity) * 100;

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

  /**
   * Get color for a specific context category
   */
  const getCategoryColor = (category: string): { bg: string; text: string; dot: string } => {
    const normalizedCategory = category.toLowerCase();

    if (normalizedCategory.includes('system prompt')) {
      return { bg: 'bg-purple-500', text: 'text-purple-400', dot: 'bg-purple-400' };
    }
    if (normalizedCategory.includes('system tools')) {
      return { bg: 'bg-blue-500', text: 'text-blue-400', dot: 'bg-blue-400' };
    }
    if (normalizedCategory.includes('messages')) {
      return { bg: 'bg-green-500', text: 'text-green-400', dot: 'bg-green-400' };
    }
    if (normalizedCategory.includes('autocompact buffer')) {
      return { bg: 'bg-amber-700', text: 'text-amber-600', dot: 'bg-amber-600' };
    }
    if (normalizedCategory.includes('free space')) {
      return { bg: 'bg-gray-700', text: 'text-gray-500', dot: 'bg-gray-500' };
    }
    // Default color for unknown categories
    return { bg: 'bg-indigo-500', text: 'text-indigo-400', dot: 'bg-indigo-400' };
  };

  /**
   * Get sort order for context categories
   */
  const getCategorySortOrder = (category: string): number => {
    const normalizedCategory = category.toLowerCase();

    if (normalizedCategory.includes('system prompt')) return 1;
    if (normalizedCategory.includes('system tools')) return 2;
    if (normalizedCategory.includes('autocompact buffer')) return 3;
    if (normalizedCategory.includes('messages')) return 4;
    if (normalizedCategory.includes('free space')) return 5;

    return 99; // Unknown categories go last
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
              <div class="w-24 sm:w-32 h-2 bg-dark-700 rounded-full overflow-hidden flex">
                {hasAccurateContextInfo && contextUsage?.breakdown ? (
                  // Show stacked bar with category colors
                  <>
                    {Object.entries(contextUsage.breakdown)
                      .sort(([categoryA], [categoryB]) => getCategorySortOrder(categoryA) - getCategorySortOrder(categoryB))
                      .map(([category, data]) => {
                        const { bg } = getCategoryColor(category);
                        const percentage = (data.tokens / contextCapacity) * 100;
                        return (
                          <div
                            key={category}
                            class={`h-full transition-all duration-300 ${bg}`}
                            style={{ width: `${percentage}%` }}
                            title={`${category}: ${data.tokens.toLocaleString()} tokens`}
                          />
                        );
                      })}
                  </>
                ) : (
                  // Fallback to single color bar
                  <div
                    class={`h-full transition-all duration-300 ${getContextBarColor()}`}
                    style={{ width: `${Math.min(contextPercentage, 100)}%` }}
                  />
                )}
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
                        <span class="text-xs text-gray-400">
                          {hasAccurateContextInfo ? "Context Window" : "Total (API)"}
                        </span>
                        <span class={`text-xs font-semibold ${getContextColor()}`}>
                          {contextPercentage.toFixed(1)}%
                        </span>
                      </div>
                      <div class="w-full h-2.5 bg-dark-600 rounded-full overflow-hidden flex">
                        {hasAccurateContextInfo && contextUsage?.breakdown ? (
                          // Show stacked bar with category colors
                          <>
                            {Object.entries(contextUsage.breakdown)
                              .sort(([categoryA], [categoryB]) => getCategorySortOrder(categoryA) - getCategorySortOrder(categoryB))
                              .map(([category, data]) => {
                                const { bg } = getCategoryColor(category);
                                const percentage = (data.tokens / contextCapacity) * 100;
                                return (
                                  <div
                                    key={category}
                                    class={`h-full transition-all duration-300 ${bg}`}
                                    style={{ width: `${percentage}%` }}
                                    title={`${category}: ${data.tokens.toLocaleString()} tokens`}
                                  />
                                );
                              })}
                          </>
                        ) : (
                          // Fallback to single color bar
                          <div
                            class={`h-full transition-all duration-300 ${getContextBarColor()}`}
                            style={{ width: `${Math.min(contextPercentage, 100)}%` }}
                          />
                        )}
                      </div>
                      <div class="text-xs text-gray-500 mt-1">
                        {totalTokens.toLocaleString()} / {contextCapacity.toLocaleString()}
                      </div>
                    </div>

                    {/* Token Breakdown */}
                    <div class="space-y-1.5">
                      <h4 class="text-xs font-medium text-gray-300">Breakdown</h4>

                      {hasAccurateContextInfo && contextUsage?.breakdown ? (
                        // Show accurate breakdown from /context command
                        <>
                          {Object.entries(contextUsage.breakdown)
                            .sort(([categoryA], [categoryB]) => getCategorySortOrder(categoryA) - getCategorySortOrder(categoryB))
                            .map(([category, data]) => {
                              const { dot, text } = getCategoryColor(category);
                              const percentage = data.percent !== null ? data.percent : ((data.tokens / contextCapacity) * 100);
                              return (
                                <div key={category} class="flex justify-between items-center text-xs">
                                  <div class="flex items-center gap-2">
                                    <div class={`w-2 h-2 rounded-full ${dot}`} />
                                    <span class="text-gray-400">{category}</span>
                                  </div>
                                  <div class="flex items-center gap-2">
                                    <span class={text}>{percentage.toFixed(1)}%</span>
                                    <span class="text-gray-200 font-mono">{data.tokens.toLocaleString()}</span>
                                  </div>
                                </div>
                              );
                            })}
                        </>
                      ) : (
                        // Show basic API response breakdown
                        <>
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
                              <span class="text-green-400">{(contextUsage?.cacheReadTokens || 0).toLocaleString()}</span>
                            </div>
                          )}

                          {(contextUsage?.cacheCreationTokens || 0) > 0 && (
                            <div class="flex justify-between text-xs">
                              <span class="text-gray-400">Cache Creation</span>
                              <span class="text-blue-400">{(contextUsage?.cacheCreationTokens || 0).toLocaleString()}</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    {/* Accuracy Note */}
                    {!hasAccurateContextInfo && (
                      <div class="pt-3 border-t border-dark-700">
                        <p class="text-xs text-gray-500">
                          Note: Showing API response tokens. Accurate context info with system prompts, tools, and cache breakdown will appear automatically after each response.
                        </p>
                      </div>
                    )}

                    {/* Status indicator for accurate data */}
                    {hasAccurateContextInfo && (
                      <div class="pt-3 border-t border-dark-700">
                        <div class="flex items-center gap-2 text-xs text-green-400">
                          <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                          </svg>
                          <span>Showing accurate SDK context data</span>
                        </div>
                      </div>
                    )}
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
