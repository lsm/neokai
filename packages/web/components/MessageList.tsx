import type { Message } from "@liuboer/shared";
import MessageItem from "./MessageItem.tsx";

interface MessageListProps {
  messages: Message[];
  streamingContent?: string;
  isStreaming?: boolean;
}

export default function MessageList({
  messages,
  streamingContent,
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
    <div class="max-w-4xl mx-auto">
      {messages.map((message) => <MessageItem key={message.id} message={message} />)}

      {/* Streaming message */}
      {isStreaming && streamingContent && (
        <div class="group flex items-start gap-4 p-6 bg-dark-900/30 animate-fadeIn">
          {/* Avatar */}
          <div class="flex-shrink-0">
            <div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center text-white text-sm font-semibold">
              🤖
            </div>
          </div>

          {/* Content */}
          <div class="flex-1 min-w-0">
            <div class="mb-2">
              <span class="font-semibold text-sm text-gray-100">Claude</span>
            </div>
            <div class="prose text-gray-200">
              {streamingContent}
              <span class="inline-block w-1.5 h-4 bg-purple-500 ml-1 animate-pulse rounded-sm" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
