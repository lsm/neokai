/**
 * StatusIndicator Component
 *
 * Shows daemon connection and processing status above the message input
 * - Idle: Green dot + "Online" or Red dot + "Offline"
 * - Processing: Pulsing purple dot + dynamic verb (e.g., "Reading files...", "Thinking...")
 */

interface StatusIndicatorProps {
  isConnected: boolean;
  isProcessing: boolean;
  currentAction?: string;
}

export default function StatusIndicator({
  isConnected,
  isProcessing,
  currentAction
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

  return (
    <div class="px-4 pb-2">
      <div class="max-w-4xl mx-auto flex items-center gap-2">
        <div class={`w-2 h-2 rounded-full ${status.dotClass}`} />
        <span class={`text-xs font-medium ${status.textClass}`}>
          {status.text}
        </span>
      </div>
    </div>
  );
}
