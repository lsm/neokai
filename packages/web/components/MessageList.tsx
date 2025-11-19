import type { Message, ToolCall } from "@liuboer/shared";
import MessageItem from "./MessageItem.tsx";

interface MessageListProps {
  messages: Message[];
  streamingContent?: string;
  streamingThinking?: string;
  streamingToolCalls?: ToolCall[];
  isStreaming?: boolean;
}

export default function MessageList({
  messages,
  streamingContent,
  streamingThinking,
  streamingToolCalls,
  isStreaming,
}: MessageListProps) {
  if (messages.length === 0 && !isStreaming) {
    return (
      <div class="flex items-center justify-center h-full px-6">
        <div class="text-center">
          <div class="text-5xl mb-4">💬</div>
          <p class="text-lg text-gray-300 mb-2">No messages yet</p>
          <p class="text-sm text-gray-500">
            Start a conversation with Claude to see the magic happen
          </p>
        </div>
      </div>
    );
  }

  return (
    <div class="max-w-4xl mx-auto w-full px-4 md:px-6">
      {messages.map((message) => <MessageItem key={message.id} message={message} />)}

      {/* Streaming message */}
      {isStreaming && (streamingContent || streamingThinking) && (
        <div class="group flex items-start gap-3 md:gap-4 p-4 md:p-6 bg-dark-900/30 animate-fadeIn">
          {/* Avatar */}
          <div class="flex-shrink-0">
            <div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center text-white text-sm font-semibold">
              🤖
            </div>
          </div>

          {/* Content */}
          <div class="flex-1 min-w-0 overflow-hidden">
            <div class="mb-2">
              <span class="font-semibold text-sm text-gray-100">Claude</span>
            </div>

            {/* Streaming thinking */}
            {streamingThinking && (
              <div class="mb-3 bg-dark-850/50 rounded-lg px-4 py-2">
                <div class="flex items-center gap-2 text-sm text-gray-400 mb-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width={2}
                      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                    />
                  </svg>
                  <span class="font-medium">Thinking</span>
                </div>
                <div class="text-sm text-gray-300 whitespace-pre-wrap">
                  {streamingThinking}
                  <span class="inline-block w-1.5 h-4 bg-purple-500 ml-1 animate-pulse rounded-sm" />
                </div>
              </div>
            )}

            {/* Streaming tool calls */}
            {streamingToolCalls && streamingToolCalls.length > 0 && (
              <div class="mb-3 space-y-2">
                {streamingToolCalls.map((toolCall) => (
                  <div key={toolCall.id} class="bg-dark-850/50 rounded-lg px-4 py-2">
                    <div class="flex items-center gap-2 text-sm">
                      <span
                        class={`w-2 h-2 rounded-full ${
                          toolCall.status === "success"
                            ? "bg-green-500"
                            : toolCall.status === "error"
                            ? "bg-red-500"
                            : "bg-yellow-500 animate-pulse"
                        }`}
                      />
                      <span class="font-medium text-gray-300">{toolCall.tool}</span>
                      {toolCall.status === "pending" && (
                        <span class="text-xs text-gray-500 ml-auto">Running...</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Streaming content */}
            {streamingContent && (
              <div class="prose text-gray-200 max-w-full">
                {streamingContent}
                <span class="inline-block w-1.5 h-4 bg-purple-500 ml-1 animate-pulse rounded-sm" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
