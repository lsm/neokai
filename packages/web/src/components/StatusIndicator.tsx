/**
 * StatusIndicator Component
 *
 * Shows daemon connection and processing status above the message input
 * - Idle: Green dot + "Online" or Red dot + "Offline"
 * - Processing: Pulsing purple dot + dynamic verb (e.g., "Reading files...", "Thinking...")
 * - Shows context usage percentage on the right
 */

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

  // Determine color based on usage
  const getContextColor = () => {
    if (contextPercentage >= 90) return "text-red-400";
    if (contextPercentage >= 70) return "text-yellow-400";
    return "text-gray-400";
  };

  return (
    <div class="px-4 pb-2">
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
          <div class="flex items-center gap-2">
            <span class={`text-xs font-medium ${getContextColor()}`} title={`${totalTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens`}>
              Context: {contextPercentage.toFixed(1)}%
            </span>
            <div class="w-16 h-1.5 bg-dark-700 rounded-full overflow-hidden" title={`${totalTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens`}>
              <div
                class={`h-full transition-all duration-300 ${
                  contextPercentage >= 90 ? "bg-red-500" :
                  contextPercentage >= 70 ? "bg-yellow-500" :
                  "bg-blue-500"
                }`}
                style={{ width: `${Math.min(contextPercentage, 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
