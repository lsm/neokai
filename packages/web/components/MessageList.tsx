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
      <div class="flex items-center justify-center h-full text-gray-400">
        <div class="text-center">
          <p class="text-lg mb-2">No messages yet</p>
          <p class="text-sm">Start a conversation with Claude</p>
        </div>
      </div>
    );
  }

  return (
    <div class="max-w-4xl mx-auto py-6 px-4 space-y-6">
      {messages.map((message) => <MessageItem key={message.id} message={message} />)}

      {isStreaming && streamingContent && (
        <div class="flex items-start space-x-3">
          <div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-medium flex-shrink-0">
            AI
          </div>
          <div class="flex-1 bg-white rounded-lg p-4 shadow-sm">
            <div class="prose prose-sm max-w-none">
              {streamingContent}
              <span class="inline-block w-2 h-4 bg-gray-400 ml-1 animate-pulse"></span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
